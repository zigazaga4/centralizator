/**
 * POST /extract-and-price — accept N images (1 AWB + 1..N invoices),
 * return both the raw extracted fields and the computed pricing
 * breakdown.
 *
 * The pricing is derived deterministically from the AWB-side fields, so
 * the caller can re-run only the pricing step via POST /price after the
 * user edits anything by hand.
 */

import type { FastifyInstance } from "fastify";
import { type ImageInput } from "../gemini.js";
import { calculatePrice, type PricingBreakdown } from "../pricing.js";
import { type Service } from "../tariffs.js";
import { extractAndPrice, PipelineError, todayFilingDay } from "../pipeline.js";
import {
  PricingRequestSchema,
  type Extracted,
  type Routing,
} from "../schema.js";

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Hard cap on images per pair. Generous enough for any realistic AWB
 *  (one of our biggest in practice has been a handful of invoices on
 *  one waybill); keeps a runaway upload from blowing up the vision
 *  call's token budget. */
const MAX_IMAGES = 12;

export interface ExtractResponse {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
  /** Origin store + the routed distance the price was built from. */
  routing: Routing;
}

export default async function extractRoutes(app: FastifyInstance) {
  app.post("/extract-and-price", async (req, reply) => {
    const parts = req.parts();

    // The client now sends N unordered image parts (any field name).
    // Exactly one of them is the AWB; the rest are invoices. The
    // vision model picks the AWB based on visible content, so we
    // don't care about ordering or labelling here.
    const images: ImageInput[] = [];

    for await (const part of parts) {
      if (part.type !== "file") continue;
      const mimeType = part.mimetype.toLowerCase();
      if (!ACCEPTED_MIME.has(mimeType)) {
        return reply.code(415).send({ error: `Unsupported MIME type: ${mimeType}` });
      }
      const buf = await part.toBuffer();
      images.push({ data: buf, mimeType });
      if (images.length > MAX_IMAGES) {
        return reply.code(413).send({
          error: `Too many images: cap is ${MAX_IMAGES} per pair (1 AWB + up to ${MAX_IMAGES - 1} invoices).`,
        });
      }
    }

    if (images.length < 1) {
      // ONE image is valid: a combined photo (label clipped onto its
      // invoice) carries both documents. The model splits the halves.
      return reply.code(400).send({
        error:
          "Send at least ONE image part. " +
          "Field names and order do not matter; the model identifies the AWB.",
      });
    }

    try {
      const { extracted, resolvedService, serviceFallback, breakdown, routing } =
        await extractAndPrice(images, todayFilingDay());
      const body: ExtractResponse = { extracted, resolvedService, serviceFallback, breakdown, routing };
      return reply.send(body);
    } catch (err) {
      if (err instanceof PipelineError && err.stage === "pricing") {
        req.log.error({ err, extracted: err.extracted }, "Pricing failed");
        return reply.code(422).send({ error: err.message, extracted: err.extracted });
      }
      req.log.error({ err }, "Vision extraction failed");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Live re-pricing for UI edits. No AI, no I/O — pure math.
  app.post("/price", async (req, reply) => {
    const parsed = PricingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    const {
      service, weight_kg, distance_km, num_deliveries, delivery_date,
      bulky_units, has_other_products, unloading_units, unloading_manual_extra,
      macara_on_awb, macara_on_invoice, macara_pallets, macara_runs, macara_store,
      macara_force_normal, macara_force_on, force_weekend,
    } = parsed.data;
    try {
      const breakdown = calculatePrice({
        service,
        weightKg: weight_kg,
        distanceKm: distance_km,
        numDeliveries: num_deliveries,
        deliveryDate: delivery_date,
        bulkyUnits: bulky_units,
        hasOtherProducts: has_other_products,
        unloadingUnits: unloading_units,
        unloadingManualExtra: unloading_manual_extra,
        macaraOnAwb: macara_on_awb,
        macaraOnInvoice: macara_on_invoice,
        macaraPallets: macara_pallets,
        macaraRuns: macara_runs,
        macaraStore: macara_store,
        macaraForceNormal: macara_force_normal,
        macaraForceOn: macara_force_on,
        forceWeekend: force_weekend,
      });
      return reply.send({ breakdown });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });
}

/**
 * POST /extract-and-price — accept AWB + invoice images, return both the
 * raw extracted fields and the computed pricing breakdown.
 *
 * The pricing is derived deterministically from the extracted fields, so
 * the caller can re-run only the pricing step via POST /price after the
 * user edits anything by hand.
 */

import type { FastifyInstance } from "fastify";
import { extractFromImages } from "../gemini.js";
import { calculatePrice, type PricingBreakdown } from "../pricing.js";
import { SERVICE_TEXT_MAP, type Service } from "../tariffs.js";
import {
  PricingRequestSchema,
  type Extracted,
} from "../schema.js";

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/**
 * Best-effort map from the AWB's free-text `Serviciu` field to one of the
 * three pricing services. Falls back to Express with `serviceFallback=true`
 * on the response so the UI can show a warning + a dropdown override.
 */
function resolveService(serviceText: string): { service: Service; serviceFallback: boolean } {
  const key = serviceText.trim().toLowerCase();
  const mapped = SERVICE_TEXT_MAP[key];
  if (mapped) return { service: mapped, serviceFallback: false };
  // Try a softer match (substring) — useful for things like "Standard cu confirmare".
  for (const [needle, svc] of Object.entries(SERVICE_TEXT_MAP)) {
    if (key.includes(needle)) return { service: svc, serviceFallback: false };
  }
  return { service: "Express", serviceFallback: true };
}

export interface ExtractResponse {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
}

export default async function extractRoutes(app: FastifyInstance) {
  app.post("/extract-and-price", async (req, reply) => {
    const parts = req.parts();

    // The client now sends two unordered image parts (any field name).
    // The vision model decides which one is the AWB and which is the
    // invoice based on visible content, so we don't care about ordering
    // or labelling here.
    const images: { data: Buffer; mimeType: string }[] = [];

    for await (const part of parts) {
      if (part.type !== "file") continue;
      const mimeType = part.mimetype.toLowerCase();
      if (!ACCEPTED_MIME.has(mimeType)) {
        return reply.code(415).send({ error: `Unsupported MIME type: ${mimeType}` });
      }
      const buf = await part.toBuffer();
      images.push({ data: buf, mimeType });
    }

    const [first, second] = images;
    if (!first || !second) {
      return reply.code(400).send({
        error: "Send exactly TWO image parts (any field name, any order; the model identifies AWB vs invoice).",
      });
    }

    let extracted: Extracted;
    try {
      // Extra parts beyond the first two (if any) are ignored.
      extracted = await extractFromImages(first, second);
    } catch (err) {
      req.log.error({ err }, "Vision extraction failed");
      return reply.code(502).send({ error: (err as Error).message });
    }

    const { service, serviceFallback } = resolveService(extracted.service_text);

    let breakdown: PricingBreakdown;
    try {
      breakdown = calculatePrice({
        service,
        weightKg: extracted.weight_kg,
        distanceKm: extracted.distance_extra_km,
        numDeliveries: extracted.num_deliveries ?? 1,
        deliveryDate: extracted.delivery_date,
      });
    } catch (err) {
      req.log.error({ err, extracted }, "Pricing failed");
      return reply.code(422).send({ error: (err as Error).message, extracted });
    }

    const body: ExtractResponse = { extracted, resolvedService: service, serviceFallback, breakdown };
    return reply.send(body);
  });

  // Live re-pricing for UI edits. No AI, no I/O — pure math.
  app.post("/price", async (req, reply) => {
    const parsed = PricingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    const { service, weight_kg, distance_km, num_deliveries, delivery_date } = parsed.data;
    try {
      const breakdown = calculatePrice({
        service,
        weightKg: weight_kg,
        distanceKm: distance_km,
        numDeliveries: num_deliveries,
        deliveryDate: delivery_date,
      });
      return reply.send({ breakdown });
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });
}

/**
 * The shared extract + price pipeline.
 *
 * This is the single code path that turns one pair's images (1 AWB +
 * 1..N invoices) into a fully-priced result. It used to live inline in
 * routes/extract.ts; it now lives here so BOTH callers share it:
 *
 *   • POST /extract-and-price  — the desktop app's one-pair-at-a-time flow.
 *   • POST /scan-batch         — the phone's many-images-at-once flow,
 *                                after the grouping step has split the
 *                                upload into individual pairs.
 *
 * Keeping it in one place means the batch path inherits every future
 * fix to service mapping, bulky aggregation, and pricing for free —
 * no second implementation to drift.
 */

import { extractFromImages, type ImageInput } from "./gemini.js";
import { calculatePrice, type PricingBreakdown } from "./pricing.js";
import { SERVICE_TEXT_MAP, type Service } from "./tariffs.js";
import type { Extracted } from "./schema.js";

export type { ImageInput } from "./gemini.js";

export interface ExtractAndPriceResult {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
}

/**
 * Pipeline failure that remembers WHICH stage broke. The sync route maps
 * this to distinct HTTP codes (vision → 502, pricing → 422 with the
 * partial extraction attached); the async batch path just records the
 * message on the pair's error status.
 */
export class PipelineError extends Error {
  constructor(
    public readonly stage: "vision" | "pricing",
    message: string,
    public readonly extracted?: Extracted,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * Best-effort map from the AWB's free-text `Serviciu` field to one of the
 * three pricing services. Falls back to Express with `serviceFallback=true`
 * so the UI can show a warning + a dropdown override.
 */
export function resolveService(serviceText: string): { service: Service; serviceFallback: boolean } {
  const key = serviceText.trim().toLowerCase();
  const mapped = SERVICE_TEXT_MAP[key];
  if (mapped) return { service: mapped, serviceFallback: false };
  // Try a softer match (substring) — useful for things like "Standard cu confirmare".
  for (const [needle, svc] of Object.entries(SERVICE_TEXT_MAP)) {
    if (key.includes(needle)) return { service: svc, serviceFallback: false };
  }
  return { service: "Express", serviceFallback: true };
}

/**
 * Roll the per-line `is_bulky` flags up across every invoice on the AWB
 * into the two scalars the pricing engine needs: the total count of
 * bulky-but-light units (polystyrene / mineral wool) and whether any
 * non-bulky product also rides on the shipment. Aggregated per AWB
 * (one physical delivery), since the truck-volume constraint is physical.
 */
export function summariseBulky(extracted: Extracted): { bulkyUnits: number; hasOtherProducts: boolean } {
  let bulkyUnits = 0;
  let hasOtherProducts = false;
  for (const invoice of extracted.invoices) {
    for (const item of invoice.items) {
      if (item.is_bulky) bulkyUnits += item.quantity;
      else hasOtherProducts = true;
    }
  }
  return { bulkyUnits: Math.round(bulkyUnits), hasOtherProducts };
}

/**
 * Run the full extract + price pipeline over one pair's images.
 *
 * Throws on a vision failure or a pricing failure; the caller decides
 * how to surface it (an HTTP code on the sync route, an "error" pair
 * status on the async batch path).
 */
export async function extractAndPrice(images: ImageInput[]): Promise<ExtractAndPriceResult> {
  let extracted: Extracted;
  try {
    extracted = await extractFromImages(images);
  } catch (err) {
    throw new PipelineError("vision", (err as Error).message);
  }

  const { service, serviceFallback } = resolveService(extracted.awb.service_text);
  const { bulkyUnits, hasOtherProducts } = summariseBulky(extracted);

  let breakdown: PricingBreakdown;
  try {
    breakdown = calculatePrice({
      service,
      weightKg: extracted.awb.weight_kg,
      distanceKm: extracted.awb.distance_extra_km,
      numDeliveries: extracted.awb.num_deliveries ?? 1,
      deliveryDate: extracted.awb.delivery_date,
      bulkyUnits,
      hasOtherProducts,
    });
  } catch (err) {
    throw new PipelineError("pricing", (err as Error).message, extracted);
  }

  return { extracted, resolvedService: service, serviceFallback, breakdown };
}

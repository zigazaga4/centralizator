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
import { resolveRouting, type Routing } from "./routing.js";
import type { Extracted } from "./schema.js";

export type { ImageInput } from "./gemini.js";

export interface ExtractAndPriceResult {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
  /** Origin store + the distance the price was built from (Mapbox-routed,
   *  store → delivery, or the AWB's printed km on any fallback). */
  routing: Routing;
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
/**
 * Resolve the count of standard unloading fees ("descărcare") on the
 * shipment. The vision model marks qualifying invoice lines (billed at the
 * standard 177.69 net / 210 gross fee) via each invoice's `unloading_count`;
 * we sum them across invoices. If none are on the invoices but the AWB's
 * `Serviciu` field reads "standard descărcare", that itself signals one
 * unloading. The >1200 kg multiplier is applied later by the pricing engine.
 */
export function summariseUnloading(extracted: Extracted): number {
  const fromInvoices = extracted.invoices.reduce(
    (sum, inv) => sum + Math.max(0, Math.floor(inv.unloading_count ?? 0)),
    0,
  );
  if (fromInvoices > 0) return fromInvoices;
  // Fallback: the AWB service text names unloading even with no invoice line.
  const service = (extracted.awb.service_text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return /descarcare/.test(service) ? 1 : 0;
}

/**
 * Resolve the macara (crane delivery) signals for the shipment. Two
 * independent sources, mirroring the operator's rule:
 *   • `onAwb`     — the AWB "Serviciu" field names macara (the legitimate
 *                   signal; no warning is raised).
 *   • `onInvoice` — a macara line was found on an invoice (any line named
 *                   "macara", or an invoice that reported `macara_pallets > 0`).
 * `pallets` sums the paleți read across invoices (drives the per-palet fee;
 * the engine falls back to 1 when macara is detected but no count was read).
 * The pricing engine turns "macara on the invoice but not on the AWB" into a
 * separate warning.
 */
export function summariseMacara(
  extracted: Extracted,
): { onAwb: boolean; onInvoice: boolean; pallets: number } {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const onAwb = /macara/.test(norm(extracted.awb.service_text));
  let pallets = 0;
  let hasMacaraItem = false;
  for (const inv of extracted.invoices) {
    pallets += Math.max(0, Math.floor(inv.macara_pallets ?? 0));
    if (inv.items.some((it) => /macara/.test(norm(it.name)))) hasMacaraItem = true;
  }
  const onInvoice = pallets > 0 || hasMacaraItem;
  return { onAwb, onInvoice, pallets };
}

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
  const unloadingUnits = summariseUnloading(extracted);
  const macara = summariseMacara(extracted);

  // Resolve the origin store + the routed delivery distance. This OVERWRITES
  // the AWB's printed km with the Mapbox shortest-road distance (store →
  // delivery) when available, so the price — and everything the UI shows and
  // edits — is built on the same authoritative number. On any Mapbox failure
  // it leaves the AWB's printed km in place (resolveRouting never throws).
  const routing = await resolveRouting(extracted);
  extracted.awb.distance_extra_km = routing.distanceKm;

  let breakdown: PricingBreakdown;
  try {
    breakdown = calculatePrice({
      service,
      weightKg: extracted.awb.weight_kg,
      distanceKm: routing.distanceKm,
      numDeliveries: extracted.awb.num_deliveries ?? 1,
      deliveryDate: extracted.awb.delivery_date,
      bulkyUnits,
      hasOtherProducts,
      unloadingUnits,
      macaraOnAwb: macara.onAwb,
      macaraOnInvoice: macara.onInvoice,
      macaraPallets: macara.pallets,
      // Macara rate table is per dispatch site; use the store the routing
      // step resolved (null falls back to the default table in the engine).
      macaraStore: routing.store,
    });
  } catch (err) {
    throw new PipelineError("pricing", (err as Error).message, extracted);
  }

  return { extracted, resolvedService: service, serviceFallback, breakdown, routing };
}

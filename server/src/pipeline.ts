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
import { calculatePrice, type PricingBreakdown, type PricingInput } from "./pricing.js";
import { SERVICE_TEXT_MAP, MACARA_PALLETS_PER_RUN, type Service } from "./tariffs.js";
import { resolveRouting, type Routing } from "./routing.js";
import { ExtractedSchema, type Extracted } from "./schema.js";

export type { ImageInput } from "./gemini.js";

/**
 * Today's working day in the operator's timezone (YYYY-MM-DD). en-CA formats
 * as ISO. This is the default "delivery day" used for the weekend surcharge
 * when a caller doesn't supply the pair's filing day explicitly.
 */
export function todayFilingDay(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.CENTRALIZATOR_TZ ?? "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
 *
 * `pallets` is the number of paleți the per-palet macara unload fee multiplies
 * by. We read it, in order of preference, from the invoice's "DESCĂRCARE
 * PALET" line(s), then the "GARANȚIE … PALEȚI / EUROPALEȚI" line(s) (one
 * guarantee per palet handled), then the model's macara_pallets. NOT the
 * macara *delivery* line quantity (usually 1, e.g. "LIVRARE MACARA 5-8
 * PALETI" × 1).
 *
 * `runs` is how many crane trucks the run takes. A truck carries 1-8 paleți,
 * so runs scales the delivery price + per-km. We take it directly from the
 * count of "LIVRARE MACARA …" lines on the invoice(s) (each line is one crane
 * delivery — an invoice may carry several, e.g. a "5-8 PALETI" line AND a
 * "1-4 PALETI" line = 2 runs), and never below ceil(pallets / 8). Pure code
 * from the line wording — no extra burden on the vision model.
 *
 * The pricing engine turns "macara on the invoice but not on the AWB" into a
 * separate warning.
 */
export function summariseMacara(
  extracted: Extracted,
): { onAwb: boolean; onInvoice: boolean; pallets: number; runs: number } {
  const norm = (s: string | null | undefined): string =>
    (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const onAwb = /macara/.test(norm(extracted.awb.service_text));
  let macaraPalletsRead = 0;
  let descarcarePalets = 0;
  let garantiePalets = 0;
  let macaraDeliveryLines = 0;
  let hasMacaraItem = false;
  for (const inv of extracted.invoices) {
    macaraPalletsRead += Math.max(0, Math.floor(inv.macara_pallets ?? 0));
    for (const it of inv.items) {
      const name = norm(it.name);
      const qty = Math.max(0, Math.floor(it.quantity ?? 0));
      if (/macara/.test(name)) {
        hasMacaraItem = true;
        // Each "LIVRARE MACARA …" line is ONE crane truck delivery. Count the
        // line itself, NOT its quantity — the palet range lives in the
        // description ("5-8 PALETI"), the qty is the service count (≈1). This
        // keeps a stray qty from inflating the macara charge.
        if (/livrare/.test(name)) macaraDeliveryLines += 1;
      }
      // Paleți count signals (for the per-palet unload fee). We pick ONE of
      // these below (never add them), so an invoice carrying BOTH a descărcare
      // line AND garanție-paleți lines never double-counts the paleți.
      if (/descarcare/.test(name) && /palet/.test(name)) descarcarePalets += qty;
      if (/garantie/.test(name) && /palet/.test(name)) garantiePalets += qty;
    }
  }
  const onInvoice = macaraPalletsRead > 0 || hasMacaraItem;
  const isMacara = onAwb || onInvoice;
  // Paleți for the unload fee: descărcare line wins, then garanție paleți,
  // then whatever the model read. Only meaningful on a macara run.
  const pallets = isMacara
    ? descarcarePalets > 0
      ? descarcarePalets
      : garantiePalets > 0
        ? garantiePalets
        : macaraPalletsRead
    : 0;
  // Crane truck runs: the count of macara delivery lines, never below what the
  // palet count alone demands (8 per truck). The engine clamps to >=1.
  const runs = isMacara
    ? Math.max(macaraDeliveryLines, Math.ceil(pallets / MACARA_PALLETS_PER_RUN))
    : 0;
  return { onAwb, onInvoice, pallets, runs };
}

/**
 * The store's own service/charge lines (its LIVRARE delivery fee, DESCARCARE
 * unloading, manipulare/încărcare handling) are NOT physical goods on the
 * truck, so they must not count as "another product" for the bulky
 * base-transport rule. Same name-based signal the macara path uses for
 * "LIVRARE …" lines. Diacritics are stripped before the test.
 * NB: "montaj" is deliberately NOT here — "DIBLU MONTAJ PERCUTIE" is a real
 * product line, not a mounting service.
 */
const SERVICE_LINE_RE = /livrare|transport|manipulare|descarcare|incarcare/;

export function summariseBulky(extracted: Extracted): { bulkyUnits: number; hasOtherProducts: boolean } {
  let bulkyUnits = 0;
  let hasOtherProducts = false;
  for (const invoice of extracted.invoices) {
    for (const item of invoice.items) {
      if (item.is_bulky) {
        bulkyUnits += item.quantity;
        continue;
      }
      const name = (item.name ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "");
      // Skip the store's delivery/unloading/handling lines: a pure-polystyrene
      // shipment whose only other line is its own LIVRARE charge is still
      // "only bulky", and must keep its base-transport credit.
      if (SERVICE_LINE_RE.test(name)) continue;
      hasOtherProducts = true;
    }
  }
  return { bulkyUnits: Math.round(bulkyUnits), hasOtherProducts };
}

/**
 * Assemble the calculatePrice input for an extraction. The ONE place the
 * extraction-to-pricing mapping lives — shared by the live pipeline and the
 * offline reprice script so the two can never drift (the script once passed
 * a stale subset and silently dropped macara / mis-applied the weekend).
 *
 * The caller supplies the three context values that do NOT come from the
 * extraction itself:
 *   • distanceKm   — the authoritative billed km (routed, or as persisted)
 *   • weekendBasis — the filing day that drives the weekend surcharge
 *   • macaraStore  — the resolved dispatch store (picks the macara table)
 */
export function buildPricingInput(
  extracted: Extracted,
  service: Service,
  opts: {
    distanceKm: number;
    weekendBasis: string;
    macaraStore: PricingInput["macaraStore"];
    /** Operator's per-day weekend override (force the surcharge ON). */
    forceWeekend?: boolean;
  },
): PricingInput {
  const { bulkyUnits, hasOtherProducts } = summariseBulky(extracted);
  const macara = summariseMacara(extracted);
  return {
    service,
    weightKg: extracted.awb.weight_kg,
    distanceKm: opts.distanceKm,
    numDeliveries: extracted.awb.num_deliveries ?? 1,
    deliveryDate: opts.weekendBasis,
    forceWeekend: opts.forceWeekend,
    bulkyUnits,
    hasOtherProducts,
    unloadingUnits: summariseUnloading(extracted),
    macaraOnAwb: macara.onAwb,
    macaraOnInvoice: macara.onInvoice,
    macaraPallets: macara.pallets,
    macaraRuns: macara.runs,
    macaraStore: opts.macaraStore,
  };
}

/**
 * Run the full extract + price pipeline over one pair's images.
 *
 * Throws on a vision failure or a pricing failure; the caller decides
 * how to surface it (an HTTP code on the sync route, an "error" pair
 * status on the async batch path).
 */
export async function extractAndPrice(
  images: ImageInput[],
  filingDay?: string,
  forceWeekend?: boolean,
): Promise<ExtractAndPriceResult> {
  let extracted: Extracted;
  try {
    extracted = await extractFromImages(images);
  } catch (err) {
    throw new PipelineError("vision", (err as Error).message);
  }
  return priceExtracted(extracted, filingDay, forceWeekend);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Assemble an `Extracted` from the per-image readings (the raw arguments
 * of the report_awb / report_invoice function calls).
 *
 * The model is never forced to produce fields it cannot see — code fills
 * the schema's required slots with NEUTRAL defaults instead (empty
 * strings, zeros, the filing day), which the UI shows as missing values
 * the operator can correct. Unknown keys are stripped by the Zod schema.
 */
export function assembleExtracted(
  awbRaw: Record<string, unknown> | null,
  invoiceRaws: Array<Record<string, unknown>>,
  filingDay?: string,
): Extracted {
  const day = filingDay ?? todayFilingDay();
  const a = awbRaw ?? {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const date = (v: unknown): string => (typeof v === "string" && ISO_DATE.test(v) ? v : day);

  const awb = {
    ...a,
    awb_number: typeof a.awb_number === "string" ? a.awb_number : "",
    delivery_date: date(a.delivery_date),
    service_text: typeof a.service_text === "string" ? a.service_text : "",
    weight_kg: num(a.weight_kg) ?? 0,
    distance_extra_km: num(a.distance_extra_km) ?? 0,
    num_deliveries: num(a.num_deliveries) ?? 1,
  };
  // Dedupe by printed identity: two readings sharing an invoice number or
  // comandă are the SAME invoice photographed twice — keeping both would
  // double-count unloading/macara/bulky and the totals.
  const seenKeys = new Set<string>();
  const invoices: Array<Record<string, unknown>> = [];
  for (const inv of invoiceRaws) {
    const keys: string[] = [];
    const invNum = String(inv.invoice_number ?? "").replace(/\D/g, "");
    if (invNum.length >= 6) keys.push(`i${invNum}`);
    const ord = String(inv.order_number ?? "").replace(/\D/g, "");
    if (ord.length >= 4) keys.push(`o${ord}`);
    if (keys.some((k) => seenKeys.has(k))) continue;
    for (const k of keys) seenKeys.add(k);
    invoices.push({
      ...inv,
      invoice_number: typeof inv.invoice_number === "string" ? inv.invoice_number : "",
      invoice_date: date(inv.invoice_date),
      items: Array.isArray(inv.items) ? inv.items : [],
    });
  }

  const parsed = ExtractedSchema.safeParse({ awb, invoices });
  if (!parsed.success) {
    throw new PipelineError("vision", `Assembled readings failed schema validation:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

/**
 * Price + route ALREADY-extracted data. The scan-batch path assembles
 * `Extracted` in code from the per-image readings (no second vision
 * pass), then runs the rest of the pipeline through here — identical to
 * what the desktop flow gets after its extraction call.
 */
export async function priceExtracted(
  extracted: Extracted,
  filingDay?: string,
  forceWeekend?: boolean,
): Promise<ExtractAndPriceResult> {
  const { service, serviceFallback } = resolveService(extracted.awb.service_text);

  // Resolve the origin store + the routed delivery distance. This OVERWRITES
  // the AWB's printed km with the Mapbox shortest-road distance (store →
  // delivery) when available, so the price — and everything the UI shows and
  // edits — is built on the same authoritative number. On any Mapbox failure
  // it leaves the AWB's printed km in place (resolveRouting never throws).
  const routing = await resolveRouting(extracted);
  extracted.awb.distance_extra_km = routing.distanceKm;

  // Weekend surcharge keys off the DELIVERY working day, NOT the AWB's printed
  // timestamp. That timestamp is the AWB *creation* date, which is routinely a
  // day or two before the actual delivery (an order placed Saturday/Sunday is
  // delivered Monday). Using it wrongly tags Monday deliveries as weekend runs.
  // The pair's filing day (the day the operator processes the deliveries) is
  // the right proxy; fall back to today, then to the AWB date as a last resort.
  const weekendBasis = filingDay ?? todayFilingDay() ?? extracted.awb.delivery_date;

  let breakdown: PricingBreakdown;
  try {
    breakdown = calculatePrice(
      buildPricingInput(extracted, service, {
        distanceKm: routing.distanceKm,
        weekendBasis,
        // Macara rate table is per dispatch site; use the store the routing
        // step resolved (null falls back to the default table in the engine).
        macaraStore: routing.store ?? null,
        // Per-day operator override: when the filing day is marked a weekend,
        // every pair priced under it carries the surcharge regardless of date.
        forceWeekend,
      }),
    );
  } catch (err) {
    throw new PipelineError("pricing", (err as Error).message, extracted);
  }

  return { extracted, resolvedService: service, serviceFallback, breakdown, routing };
}

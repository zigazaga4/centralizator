/**
 * Zod schemas — the contract between the vision model and the rest of
 * the server. Gemini's function call returns JSON; we parse it here,
 * and only validated values reach the pricing engine.
 *
 * Shape of `Extracted` since the multi-invoice refactor:
 *
 *     Extracted = {
 *       awb:      Awb,          // the single AWB (pricing source)
 *       invoices: Invoice[],    // one or more invoices riding on that AWB
 *     }
 *
 * One AWB can carry several invoices. Pricing depends only on the
 * AWB-side scalars (weight, distance, deliveries, service, date), so
 * the engine doesn't see invoices at all — they're attached docs that
 * the UI lists per pair.
 *
 * Two shapes live in this file:
 *   1. `ExtractedSchema`  — the raw output of the Gemini function call
 *   2. `PricingRequestSchema` — what the UI can send to /price for live
 *      recalculation after the user edits the AWB-side fields by hand.
 */

import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO YYYY-MM-DD");

/** A single line item from an invoice table. */
export const InvoiceItemSchema = z.object({
  name: z.string(),
  ean: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  quantity: z.number(),
  unit_price_net: z.number(),
  value_net: z.number(),
  vat_rate: z.number().optional().nullable(),
  vat_amount: z.number().optional().nullable(),
  /**
   * True when this line is bulky-but-light insulation — polystyrene
   * (polistiren EPS/XPS) or mineral/glass/basalt wool (vată). These take
   * up a full truck regardless of weight, so they drive the extra-transport
   * surcharge (one extra transport per 24 units). The vision model sets it
   * per line; everything else is false.
   */
  is_bulky: z.boolean().optional().default(false),
  /**
   * Physical size of ONE unit of this product as printed on the invoice
   * line — length × width × thickness, diameter, etc. WITH its unit, e.g.
   * "10 x 100 x 50 cm" or "Ø 50 mm". The vision model reads it from the
   * product name/description or a dedicated size column. Null when the
   * line states no physical size. Area (m²) and volume (l) are NOT a
   * size. Cross-checked against the matched leroymerlin.ro product.
   */
  dimensions: z.string().optional().nullable(),
});
export type InvoiceItem = z.infer<typeof InvoiceItemSchema>;

/**
 * One invoice (factură) attached to a pair. Multiple invoices may
 * share the same AWB — same delivery, several billable documents.
 */
export const InvoiceSchema = z.object({
  invoice_number: z.string(),
  invoice_date: isoDate,
  invoice_is_duplicate: z.boolean().optional().default(false),
  supplier_name: z.string().optional().nullable(),
  supplier_cui: z.string().optional().nullable(),
  buyer_name: z.string().optional().nullable(),
  buyer_cui: z.string().optional().nullable(),
  order_number: z.string().optional().nullable(),
  /**
   * How many STANDARD unloading fees ("descărcare") this invoice bills —
   * counted ONLY for lines whose amount is the standard unloading fee
   * (177.69 RON without VAT / 210 RON with VAT). A "descărcare" line with
   * any other amount is a different service and must NOT be counted. The
   * vision model sets this per invoice; 0 when there is no such line.
   */
  unloading_count: z.number().int().nonnegative().optional().default(0),
  /**
   * How many paleți this invoice delivers by crane ("macara") — set >0 ONLY
   * when the invoice carries a macara service/line; read the palet count
   * (1-8) from the macara line or the AWB. If macara is present but the count
   * is unclear, the value is 1. 0 when there is no macara line. The presence
   * of macara on the invoice (this > 0 OR a line literally named "macara")
   * drives the separate macara breakdown + warning.
   */
  macara_pallets: z.number().int().nonnegative().optional().default(0),
  items: z.array(InvoiceItemSchema).default([]),
  invoice_total_net: z.number().optional().nullable(),
  invoice_total_vat: z.number().optional().nullable(),
  invoice_total_gross: z.number().optional().nullable(),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * The AWB side. Every pricing-relevant field lives here — `pricing.ts`
 * reads exclusively from this struct (via `Extracted.awb`). The contact
 * + content fields are display-only but extracted so the detail page
 * can show the full waybill picture.
 */
export const AwbSchema = z.object({
  awb_number: z.string(),
  delivery_date: isoDate, // from AWB header timestamp
  service_text: z.string().describe("Raw 'Serviciu' field from the AWB, e.g. 'Standard'."),
  shipment_type: z.string().optional().nullable().describe("AWB 'Expediţie' field, e.g. 'Colet'."),
  weight_kg: z.number().nonnegative(),
  distance_extra_km: z.number().nonnegative()
    .describe("Hub-to-recipient km from the AWB's 'Distanţă extra (km)' field."),
  num_deliveries: z.number().int().positive().default(1)
    .describe("How many stops/parcels this AWB covers. Default 1; bump only if AWB shows e.g. 2/3 written as boxes."),
  content_code: z.string().optional().nullable(),
  hub_destination: z.string().optional().nullable(),
  sender_name: z.string().optional().nullable(),
  sender_phone: z.string().optional().nullable(),
  sender_address: z.string().optional().nullable(),
  recipient_name: z.string().optional().nullable(),
  recipient_phone: z.string().optional().nullable(),
  recipient_address: z.string().optional().nullable(),
});
export type Awb = z.infer<typeof AwbSchema>;

/**
 * The full shape Gemini must return. Unknown/illegible fields are
 * returned as null so the UI can prompt for them. `invoices` is an
 * ordered list — the order on disk matches the order of the dropped
 * images (after the AWB), so the user's mental model "image 2 = first
 * invoice, image 3 = second invoice, …" stays intact through the
 * round-trip.
 */
export const ExtractedSchema = z.object({
  awb: AwbSchema,
  invoices: z.array(InvoiceSchema).min(1).describe(
    "At least one invoice. Order matches the non-AWB image order from the request.",
  ),
});
export type Extracted = z.infer<typeof ExtractedSchema>;

/* ──────────────────────────────────────────────────────────────────────
 * Product verification (Leroy Merlin cross-check)
 *
 * After extraction, each invoice line's product code is resolved on
 * leroymerlin.ro and the site's size + weight are compared against the
 * invoice. The warning icon fires ONLY on a size or weight mismatch;
 * everything else (found/not-found, name, brand, price, link) is shown
 * in the dialog but never raises the alarm.
 *
 * This schema is the contract for both the /verify response and the
 * `verification` field persisted on a "ready" pair. It is intentionally
 * tolerant (`.passthrough()` on the envelope) so additive tweaks on the
 * client don't break round-trips.
 * ────────────────────────────────────────────────────────────────────── */

/** match | mismatch | unknown (not comparable — no data on one side). */
const CheckStatusSchema = z.enum(["match", "mismatch", "unknown"]);

export const ItemCheckSchema = z.object({
  /** Which invoice (index) and which line within it this check is for. */
  invoiceIndex: z.number().int().nonnegative(),
  itemIndex: z.number().int().nonnegative(),
  /** Invoice-side facts (echoed so the dialog needs no cross-lookup). */
  name: z.string(),
  query: z.string().nullable(),
  invoiceDimsMm: z.array(z.number()).default([]),
  quantity: z.number().default(0),
  unit: z.string().nullable().optional(),
  /** Site-side facts. `found=false` ⇒ the code resolved to no product. */
  found: z.boolean(),
  url: z.string().nullable().optional(),
  siteName: z.string().nullable().optional(),
  brand: z.string().nullable().optional(),
  priceBuc: z.number().nullable().optional(),
  weightKg: z.number().nullable().optional(),
  siteDimsMm: z.array(z.number()).default([]),
  /** Verdict for THIS line's size. Only "mismatch" raises a warning. */
  sizeStatus: CheckStatusSchema,
});
export type ItemCheck = z.infer<typeof ItemCheckSchema>;

export const VerificationSchema = z
  .object({
    checkedAt: z.number(),
    items: z.array(ItemCheckSchema).default([]),
    /** AWB declared weight vs. the sum of catalog weights × quantity. */
    awbWeightKg: z.number(),
    estimatedWeightKg: z.number().nullable(),
    /** full = every line weighable; partial/none otherwise. The weight
     *  warning only fires on "full" coverage to avoid false positives. */
    weightCoverage: z.enum(["full", "partial", "none"]),
    weightStatus: CheckStatusSchema,
    /** = any item size mismatch OR a weight mismatch. Drives the icon. */
    hasWarning: z.boolean(),
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type Verification = z.infer<typeof VerificationSchema>;

/* ──────────────────────────────────────────────────────────────────────
 * Origin store + routed distance
 *
 * Every shipment leaves from ONE Leroy Merlin store. That store is the
 * centralizator the pair is filed under AND the route origin for the
 * Mapbox km. `Routing` is the contract carried on a ready pair: the store,
 * the distance the price was built from, and where that distance came
 * from (a live Mapbox route or the AWB's printed km on any fallback).
 * ────────────────────────────────────────────────────────────────────── */

/** The four dispatch-store keys — identical to the pricing City keys. */
export const StoreKeySchema = z.enum(["Ploiesti", "IasiTudor", "IasiERA", "Constanta"]);
export type StoreKey = z.infer<typeof StoreKeySchema>;

export const RoutingSchema = z
  .object({
    /** Origin store / centralizator bucket. Null when undetermined. */
    store: StoreKeySchema.nullable(),
    /** How the store was decided. */
    storeSource: z.enum(["expeditor", "nearest", "none"]),
    /** Km the price was built from. */
    distanceKm: z.number(),
    /** Whether `distanceKm` is a live Mapbox route or the AWB's printed km. */
    source: z.enum(["mapbox", "awb"]),
    /** Km printed on the AWB ('Distanță extra'), kept for reference. */
    awbKm: z.number(),
    /** Mapbox-routed km when computed; null on any fallback. */
    mapboxKm: z.number().nullable(),
    /** Signed difference (mapboxKm − awbKm) when both are known; null on
     *  any fallback. Positive ⇒ our route is longer than the AWB printed. */
    kmDiff: z.number().nullable().optional(),
    /** True when the Mapbox-routed km differs from the AWB's printed km.
     *  Surfaces in the warning component just like a product discrepancy. */
    kmWarning: z.boolean().optional(),
    /** Delivery address text that was geocoded. */
    deliveryAddress: z.string().nullable(),
    /** True only when geocode + route both succeeded. */
    resolved: z.boolean(),
    /** Short Romanian note explaining a fallback, for the UI. */
    note: z.string().nullable(),
  })
  .passthrough();
export type Routing = z.infer<typeof RoutingSchema>;

/**
 * The shape the UI POSTs to /price for live recalculation when the
 * user edits one of the four pricing-relevant fields. Lean on purpose:
 * the pricing engine ignores everything else.
 */
export const PricingRequestSchema = z.object({
  service: z.enum(["Express", "Premium", "Prestabilita"]),
  weight_kg: z.number().nonnegative(),
  distance_km: z.number().nonnegative(),
  num_deliveries: z.number().int().positive().default(1),
  delivery_date: isoDate,
  /**
   * Bulky-but-light unit count (polystyrene / mineral wool) across the
   * shipment, and whether non-bulky products ride along. Optional so the
   * current client (which does not send them) still reprices; they default
   * to "no bulky goods" and the surcharge is simply absent on that path.
   */
  bulky_units: z.number().int().nonnegative().default(0),
  has_other_products: z.boolean().default(false),
  /**
   * Count of standard unloading fees ("descărcare", 177.69 net / 210 gross)
   * on the shipment. Optional so the current client still reprices; defaults
   * to 0 (no unloading tax) on that path. The >1200 kg multiplier is applied
   * by the engine, not here.
   */
  unloading_units: z.number().int().nonnegative().default(0),
  /**
   * Macara (crane delivery) signals, preserved across live edits so the
   * separate macara breakdown survives a re-price. `macara_on_awb` = the AWB
   * Serviciu names macara; `macara_on_invoice` = a macara line is on an
   * invoice; `macara_pallets` = paleți read off the invoice/AWB. All optional
   * (default "no macara") so the current client still reprices.
   */
  macara_on_awb: z.boolean().default(false),
  macara_on_invoice: z.boolean().default(false),
  macara_pallets: z.number().int().nonnegative().default(0),
  /** Crane truck runs (count of "LIVRARE MACARA" lines). Scales the macara
   *  delivery price + per-km. Optional; the engine derives ceil(paleți / 8)
   *  when omitted. */
  macara_runs: z.number().int().nonnegative().default(0),
  /** Dispatch store the macara run leaves from — selects the macara rate
   *  table (Iași Tudor + Constanța vs. Ploiești + Iași ERA). Null = default
   *  table. */
  macara_store: StoreKeySchema.nullable().default(null),
});
export type PricingRequest = z.infer<typeof PricingRequestSchema>;

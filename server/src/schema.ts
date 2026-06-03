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
});
export type PricingRequest = z.infer<typeof PricingRequestSchema>;

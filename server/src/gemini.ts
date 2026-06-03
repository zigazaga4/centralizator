/**
 * Vision + forced tool calling via OpenRouter (OpenAI-compatible API).
 *
 * Model: `google/gemini-3.5-flash` by default — override via OPENROUTER_MODEL.
 * Auth:  OPENROUTER_API_KEY (sk-or-v1-…).
 *
 * Caller hands in N images (1 AWB + 1..N invoices) and we force a
 * single tool call: `extract_shipment_data`. The tool's JSON-Schema
 * mirrors the Zod schema's `Extracted = { awb, invoices: Invoice[] }`,
 * so the validation round-trip is mechanical and any drift surfaces
 * immediately.
 */

import OpenAI from "openai";
import { ExtractedSchema, type Extracted } from "./schema.js";

const MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-3.5-flash";
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

if (!API_KEY) {
  console.warn("[llm] OPENROUTER_API_KEY is not set — vision calls will fail.");
}

const client = new OpenAI({
  apiKey: API_KEY ?? "",
  baseURL: BASE_URL,
  defaultHeaders: {
    // OpenRouter recommends these so requests are attributable & rate-limited
    // against your account rather than the anonymous bucket.
    "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "http://localhost:5173",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Centralizator",
  },
});

/**
 * OpenAI/JSON-Schema function tool — keep field names identical to the
 * Zod schema's so the parse step is mechanical.
 *
 * Shape mirrors `ExtractedSchema` exactly:
 *   { awb: { … AWB scalars … },
 *     invoices: [ { … one invoice … }, … ] }
 */
const invoiceItemSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Product description." },
    ean: { type: "string" },
    reference: { type: "string", description: "Internal SKU / referinta column." },
    unit: { type: "string", description: "Unit of measure, e.g. 'buc'." },
    quantity: { type: "number" },
    unit_price_net: { type: "number" },
    value_net: { type: "number", description: "quantity × unit_price_net." },
    vat_rate: { type: "number", description: "VAT percent (e.g. 21)." },
    vat_amount: { type: "number" },
  },
  required: ["name", "quantity", "unit_price_net", "value_net"],
} as const;

const invoiceSchema = {
  type: "object",
  description: "One invoice (factură) attached to this AWB.",
  properties: {
    invoice_number: { type: "string", description: "Full invoice number (e.g. 'I26 M007 0072600052396')." },
    invoice_date: { type: "string", description: "Invoice date, ISO YYYY-MM-DD." },
    invoice_is_duplicate: { type: "boolean", description: "True if invoice is marked DUPLICAT." },
    supplier_name: { type: "string" },
    supplier_cui: { type: "string" },
    buyer_name: { type: "string" },
    buyer_cui: { type: "string" },
    order_number: { type: "string", description: "'Comandă' / order number on the invoice." },
    items: {
      type: "array",
      description: "Invoice line items.",
      items: invoiceItemSchema,
    },
    invoice_total_net: { type: "number" },
    invoice_total_vat: { type: "number" },
    invoice_total_gross: { type: "number" },
  },
  required: ["invoice_number", "invoice_date"],
} as const;

const awbSchema = {
  type: "object",
  description: "The single AWB (waybill) for this pair.",
  properties: {
    awb_number: { type: "string", description: "AWB barcode number (e.g. '007209914')." },
    delivery_date: { type: "string", description: "AWB date, ISO YYYY-MM-DD." },
    service_text: { type: "string", description: "Raw 'Serviciu' value from the AWB ('Standard', 'Express', etc)." },
    shipment_type: { type: "string", description: "AWB 'Expediţie' value, e.g. 'Colet'." },
    weight_kg: { type: "number", description: "AWB 'Greutate (kg)' value." },
    distance_extra_km: { type: "number", description: "AWB 'Distanţă extra (km)' — total km from hub to recipient." },
    num_deliveries: { type: "integer", description: "Number of stops/parcels in this AWB (default 1; only larger when AWB shows e.g. '2/2')." },
    content_code: { type: "string", description: "AWB 'Continut' code (e.g. 'L07-26-63018')." },
    hub_destination: { type: "string", description: "AWB 'Hub destinatie' value." },
    sender_name: { type: "string" },
    sender_phone: { type: "string" },
    sender_address: { type: "string" },
    recipient_name: { type: "string" },
    recipient_phone: { type: "string" },
    recipient_address: { type: "string" },
  },
  required: [
    "awb_number",
    "delivery_date",
    "service_text",
    "weight_kg",
    "distance_extra_km",
  ],
} as const;

const extractTool = {
  type: "function" as const,
  function: {
    name: "extract_shipment_data",
    description:
      "Extract structured fields from the AWB (waybill) image and the matching invoice image(s). " +
      "One AWB plus one or more invoices share a pair. Use null (or omit) for fields that are not visible or illegible. " +
      "Dates must be ISO YYYY-MM-DD. All monetary values are in RON without thousand separators.",
    parameters: {
      type: "object",
      properties: {
        awb: awbSchema,
        invoices: {
          type: "array",
          description: "One entry per invoice image. Always at least one. Order matches the non-AWB image order from the request.",
          items: invoiceSchema,
          minItems: 1,
        },
      },
      required: ["awb", "invoices"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_INSTRUCTION =
  "You are an OCR and structured-extraction assistant. " +
  "You will receive N images (N >= 2). Exactly ONE of them is a Romanian courier waybill (AWB); " +
  "every OTHER image is a Romanian fiscal invoice (factură) attached to that AWB. " +
  "The caller does NOT tell you which image is which — you must decide.\n" +
  "Heuristics:\n" +
  "  - AWB: portrait-oriented printed shipping label; barcode; fields like 'AWB', 'Hub destinație', " +
  "    'Greutate (kg)', 'Distanță extra (km)', 'Serviciu', 'Continut', 'Expeditor', 'Destinatar'.\n" +
  "  - Invoice: A4 landscape or portrait; header reads 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT'); " +
  "    has a Furnizor + Cumpărător block, a line-items table, and totals (Total fără TVA / TVA / Total).\n" +
  "After identifying the AWB, extract every visible field from it into `awb`. For EACH invoice image, " +
  "extract every visible field into its own entry in `invoices` (one array element per invoice image, " +
  "in the same order the invoice images appeared in the request). Then call extract_shipment_data ONCE " +
  "with the combined data. Never reply in prose. Always call the tool. If a field is illegible or not " +
  "present, omit it (or use null).\n" +
  "Important rules:\n" +
  "• If the user accidentally sends two AWBs, treat the clearer one as the AWB and ignore the duplicate; " +
  "still emit at least one invoice entry (use nulls if no invoice is readable).\n" +
  "• num_deliveries defaults to 1. Only set it higher when there is a clearly PRINTED field on the AWB " +
  "indicating multiple deliveries (e.g. 'Numar livrari: 3'). Ignore handwritten marks like '2/2' or '1/2' — " +
  "those are package-of-N annotations, not delivery counts.\n" +
  "• invoice_number: strip OCR fragments like 'FACTURA', 'JRA', 'URA' from the front; keep only the actual " +
  "invoice number tokens (e.g. 'I26 M007 0072600052396').\n" +
  "• Dates must be ISO YYYY-MM-DD. Romanian invoices write dates as DD.MM.YYYY — convert correctly.";

export interface ImageInput {
  data: Buffer;
  mimeType: string;
}

/**
 * Run the vision call against N images. Exactly one of the images is
 * the AWB; the rest are invoices. The model identifies which is which
 * based on visible content (see SYSTEM_INSTRUCTION heuristics) and
 * returns one `Extracted` with the AWB plus one invoice entry per
 * non-AWB image.
 *
 * Returns the validated, typed extraction. Throws with a useful message
 * if the model fails to call the tool or if schema validation fails.
 */
export async function extractFromImages(
  images: ImageInput[],
): Promise<Extracted> {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  if (images.length < 2) {
    throw new Error(`extractFromImages needs at least 2 images (1 AWB + 1 invoice), got ${images.length}.`);
  }

  // Build one "Image N:" text part + image_url part per image. The
  // ordering passes through to the model so it can emit invoice
  // entries in the same order the caller dropped them.
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const url = `data:${img.mimeType};base64,${img.data.toString("base64")}`;
    userContent.push({ type: "text", text: `Image ${i + 1}:` });
    userContent.push({ type: "image_url", image_url: { url } });
  }
  userContent.push({
    type: "text",
    text:
      `You received ${images.length} images. ` +
      "Decide which ONE is the AWB (waybill); every other image is an invoice (factură). " +
      "Then call extract_shipment_data ONCE with: the AWB's fields under `awb`, and one entry per " +
      "invoice image under `invoices` (preserving the order in which the invoice images appeared above).",
  });

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.05,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: userContent },
    ],
    tools: [extractTool],
    tool_choice: {
      type: "function",
      function: { name: "extract_shipment_data" },
    },
  });

  const choice = completion.choices[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function.name !== "extract_shipment_data") {
    throw new Error(
      `Model did not call extract_shipment_data. Got: ${JSON.stringify(choice?.message)}`,
    );
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    throw new Error(
      `Tool call arguments were not valid JSON:\n${toolCall.function.arguments}\n\n${(err as Error).message}`,
    );
  }

  const parsed = ExtractedSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(
      `Model output failed schema validation:\n${parsed.error.toString()}\n\nRaw args:\n${JSON.stringify(rawArgs, null, 2)}`,
    );
  }
  return parsed.data;
}

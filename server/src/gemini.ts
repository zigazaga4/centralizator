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
import { cropRegion } from "./imagezoom.js";

const MODEL = process.env.OPENROUTER_MODEL ?? "google/gemini-3.5-flash";
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** OpenRouter unified reasoning control. Default "low": a small thinking
 *  budget keeps extraction sharp without high's multi-minute latency.
 *  CRITICAL: the effort budget is carved out of max_tokens, so an explicit
 *  max_tokens MUST ride along — unbounded thinking once consumed the whole
 *  output allowance and starved the forced tool call (probed live
 *  2026-06-11). 65535 is the model's maximum output, giving the answer
 *  guaranteed room.
 *  Set OPENROUTER_REASONING_EFFORT=off to disable entirely. */
const REASONING_EFFORT = process.env.OPENROUTER_REASONING_EFFORT ?? "low";
const REASONING =
  REASONING_EFFORT === "off"
    ? {}
    : {
        reasoning: { effort: REASONING_EFFORT },
        max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 65_535),
      };

/**
 * Total ceiling on a single vision extraction, in ms. Deliberately HUGE
 * (24h ≈ effectively unlimited): we do NOT want to kill a call that is slow
 * but still actively working on a hard image (a small AWB label on an
 * invoice, a dense multi-page invoice). A genuinely STUCK call — a severed
 * or hung connection — throws a connection error (ECONNRESET / socket hang
 * up / APIConnectionError) which is NOT swallowed here and still flips the
 * pair to an error. So in practice the pair only errors when it is actually
 * stuck, never merely because it took a while. Override with
 * EXTRACT_TIMEOUT_MS (set a small value to re-introduce a hard cap).
 */
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS ?? 86_400_000);

/** How many zoom crops the model may request in one extraction before we
 *  force it to answer. Bounds cost + wall-clock; a handful is plenty to
 *  read a tiny AWB label. Override with EXTRACT_MAX_ZOOMS. */
const MAX_ZOOMS = Number(process.env.EXTRACT_MAX_ZOOMS ?? 5);
/** How many times a failed-validation extraction may be handed back to the
 *  model to correct (e.g. it dropped a required field like invoice_number).
 *  Self-heals the cheap extractor's occasional misses instead of erroring the
 *  whole pair. Override with EXTRACT_MAX_FIXES. */
const MAX_EXTRACT_FIXES = Number(process.env.EXTRACT_MAX_FIXES ?? 3);
/** Total model round-trips (final extract + zoom rounds + correction rounds). */
const MAX_ROUNDS = MAX_ZOOMS + 2 + MAX_EXTRACT_FIXES;

if (!API_KEY) {
  console.warn("[llm] OPENROUTER_API_KEY is not set — vision calls will fail.");
}

const client = new OpenAI({
  apiKey: API_KEY ?? "",
  baseURL: BASE_URL,
  // Per-attempt timeout matches the hard ceiling; maxRetries kept low so
  // a genuine stall can't silently multiply into a 6-minute wait. The
  // AbortSignal on the call below is the real total-time guarantee.
  timeout: EXTRACT_TIMEOUT_MS,
  maxRetries: 1,
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
    ean: { type: "string", description: "Do NOT fill this. Leave empty — the EAN barcode is not the product code we want." },
    reference: { type: "string", description: "The product code from the invoice 'Referință' column (column 2, e.g. '10814685', '11604796'). This is THE product code — NOT the 'EAN :' barcode printed under the product name." },
    unit: { type: "string", description: "Unit of measure, e.g. 'buc'." },
    quantity: { type: "number" },
    unit_price_net: { type: "number" },
    value_net: { type: "number", description: "quantity × unit_price_net." },
    vat_rate: { type: "number", description: "VAT percent (e.g. 21)." },
    vat_amount: { type: "number" },
    is_bulky: {
      type: "boolean",
      description:
        "TRUE only when this line is polystyrene (polistiren — EPS/XPS, expandat/extrudat) " +
        "or mineral/glass/basalt wool (vată minerală/bazaltică/de sticlă) — light but bulky " +
        "insulation that fills truck volume. FALSE for every other product.",
    },
    dimensions: {
      type: "string",
      description:
        "Physical size of ONE unit of this product WITH its unit — length × width × " +
        "thickness, or diameter, e.g. '10 x 100 x 50 cm' or 'Ø 50 mm'. Read it from the " +
        "product name/description or a dedicated size column. Copy the size token exactly " +
        "(keep the unit). OMIT when the line states no physical size. Area (e.g. '2.5 m²') " +
        "and volume (e.g. '5 l') are NOT a size — never put them here.",
    },
  },
  required: ["name", "quantity", "unit_price_net", "value_net"],
} as const;

export const invoiceSchema = {
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
    unloading_count: {
      type: "integer",
      description:
        "How many STANDARD unloading fees ('descărcare') this invoice bills. Count a line ONLY when " +
        "its description is 'descărcare'/'descarcare' AND its amount is the standard unloading fee: " +
        "177.69 RON without VAT (value_net ≈ 177.69) or 210 RON with VAT. Use the line quantity if it " +
        "is greater than 1. A 'descărcare' line billed at any OTHER amount is a different service — do " +
        "NOT count it. 0 when there is no qualifying line.",
    },
    macara_pallets: {
      type: "integer",
      description:
        "How many paleți this invoice delivers by crane ('macara'). Set >0 ONLY when the invoice has a " +
        "macara service/line (a line whose description contains 'macara'). Read the palet count (1-8) " +
        "from that line's quantity or from the AWB. If macara is present but the palet count is unclear, " +
        "set 1. Set 0 when there is no macara line on this invoice.",
    },
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

export const awbSchema = {
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
          description:
            "One entry per invoice VISIBLE in the images, in image order. Return an EMPTY array when no " +
            "invoice page is visible — NEVER invent a dummy invoice to satisfy the schema.",
          items: invoiceSchema,
        },
      },
      required: ["awb", "invoices"],
      additionalProperties: false,
    },
  },
};

/**
 * Zoom tool — lets the model magnify a region of any image to read small or
 * blurry text (a tiny AWB label, a faint km/weight field) BEFORE it commits
 * to the final extraction. Coordinates are normalised 0..1 (fractions of the
 * frame) because the model does not know each image's pixel size. The server
 * crops + upscales and feeds the magnified region back as a new image.
 */
const zoomTool = {
  type: "function" as const,
  function: {
    name: "zoom_region",
    description:
      "Magnify a rectangular region of ONE image to read text that is too small, faint, or " +
      "blurry to read at full-frame scale (e.g. a small AWB label, the Greutate/Distanță/AWB " +
      "number). The cropped, upscaled region is returned to you as a new image. Use this BEFORE " +
      "calling extract_shipment_data whenever a needed field is hard to read. Do not overuse it.",
    parameters: {
      type: "object",
      properties: {
        image_index: { type: "integer", description: "1-based image number to zoom into (as labelled 'Image N')." },
        x0: { type: "number", description: "Left edge of the region, 0..1 (fraction of width)." },
        y0: { type: "number", description: "Top edge of the region, 0..1 (fraction of height)." },
        x1: { type: "number", description: "Right edge of the region, 0..1 (must be > x0)." },
        y1: { type: "number", description: "Bottom edge of the region, 0..1 (must be > y0)." },
        reason: { type: "string", description: "Briefly, which field you are trying to read." },
      },
      required: ["image_index", "x0", "y0", "x1", "y1"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_INSTRUCTION =
  "You are an OCR and structured-extraction assistant. " +
  "You will receive N images (N >= 2). ONE of them carries the Romanian courier waybill (AWB) — " +
  "usually on its own page, but SOMETIMES as a small label laid or taped on TOP of an invoice in the " +
  "same photo. Every other image is a Romanian fiscal invoice (factură) attached to that AWB. " +
  "The caller does NOT tell you which image is which — you must decide.\n" +
  "Heuristics:\n" +
  "  - AWB: portrait-oriented printed shipping label; barcode; fields like 'AWB', 'Hub destinație', " +
  "    'Greutate (kg)', 'Distanță extra (km)', 'Serviciu', 'Continut', 'Expeditor', 'Destinatar', " +
  "    and often a courier brand such as 'couriermanager'.\n" +
  "  - Invoice: A4 landscape or portrait; header reads 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT'); " +
  "    has a Furnizor + Cumpărător block, a line-items table, and totals (Total fără TVA / TVA / Total).\n" +
  "  - The AWB label may be SMALL, rotated, photographed at an angle, partly wet/blurry, or laid ON TOP " +
  "    of an invoice so it covers only a corner of the photo. If a single photo shows BOTH a courier " +
  "    label AND invoice content, the courier label IS the AWB: read every AWB field from that label " +
  "    (awb number, Greutate, Distanță extra, Serviciu, Hub destinatie, Expeditor/Destinatar) and treat " +
  "    the rest of that photo as invoice content. Locate the AWB by its markers, not by which is bigger. " +
  "    Do NOT stall or loop deciding which is which — pick the best candidate, extract whatever is " +
  "    legible, use null for the rest, and call extract_shipment_data EXACTLY ONCE.\n" +
  "After identifying the AWB, extract every visible field from it into `awb`. For EACH invoice image, " +
  "extract every visible field into its own entry in `invoices` (one array element per invoice image, " +
  "in the same order the invoice images appeared in the request). If NO invoice page is visible in any " +
  "image, return invoices: [] — NEVER fabricate an invoice entry just to fill the array. Then call " +
  "extract_shipment_data ONCE with the combined data. Never reply in prose. Always call the tool. If a " +
  "field is illegible or not present, omit it (or use null).\n" +
  "Important rules:\n" +
  "• If the user accidentally sends two AWBs, treat the clearer one as the AWB and ignore the duplicate; " +
  "still emit at least one invoice entry (use nulls if no invoice is readable).\n" +
  "• num_deliveries defaults to 1. Only set it higher when there is a clearly PRINTED field on the AWB " +
  "indicating multiple deliveries (e.g. 'Numar livrari: 3'). Ignore handwritten marks like '2/2' or '1/2' — " +
  "those are package-of-N annotations, not delivery counts.\n" +
  "• invoice_number: strip OCR fragments like 'FACTURA', 'JRA', 'URA' from the front; keep only the actual " +
  "invoice number tokens (e.g. 'I26 M007 0072600052396').\n" +
  "• Dates must be ISO YYYY-MM-DD. Romanian invoices write dates as DD.MM.YYYY — convert correctly.\n" +
  "• is_bulky: on EACH invoice line item, set is_bulky=true ONLY when the product is polystyrene " +
  "(polistiren — EPS/XPS, expandat/extrudat) or mineral/glass/basalt wool (vată minerală/bazaltică/de sticlă). " +
  "These are light but bulky and are billed per extra transport. Every other product is is_bulky=false.\n" +
  "• unloading_count (per invoice): set it to how many STANDARD unloading fees ('descărcare') the " +
  "invoice bills. A line counts ONLY if its description is descărcare/descarcare AND its amount is the " +
  "standard fee — 177.69 RON without VAT (value_net ≈ 177.69) or 210 RON with VAT (use the line's " +
  "quantity if > 1). A 'descărcare' line at any OTHER amount is a different service and must NOT be " +
  "counted. Set 0 when there is no qualifying line. This is also implied when the AWB 'Serviciu' field " +
  "reads 'Standard descărcare'.\n" +
  "• macara_pallets (per invoice): set it to how many paleți are delivered by crane ('macara') on this " +
  "invoice. Set >0 ONLY when a line/service named 'macara' is present; read the palet count (1-8) from " +
  "that line's quantity or the AWB, and set 1 if a macara line exists but the count is unclear. Set 0 " +
  "when there is no macara line. Macara may instead be named on the AWB 'Serviciu' field — still extract " +
  "service_text verbatim there so the server can reconcile the AWB against the invoice.\n" +
  "• product code (per invoice line): the product code is the value in the invoice 'Referință' column " +
  "(the SKU column — column 2 of the line-items table, e.g. '10814685', '11604796', '12138483'). Put " +
  "that value in `reference`. Do NOT extract or output the EAN: the 'EAN : …' barcode printed on a " +
  "sub-line under each product name is NOT the product code — leave `ean` empty. Only the 'Referință' " +
  "value identifies the product.\n" +
  "• dimensions: on EACH invoice line, copy the product's physical SIZE token verbatim with its unit " +
  "(e.g. '10 x 100 x 50 cm', '2000 x 1000 mm', 'Ø 50 mm') from the product name/description or a size " +
  "column. This is cross-checked against the leroymerlin.ro product page, so accuracy matters. Do NOT " +
  "put area (m²) or volume (l) here, and omit the field entirely when the line states no physical size.\n" +
  "ZOOM: if any AWB field (the AWB number, Greutate, Distanță extra, Serviciu) or an invoice code/size " +
  "is too small or blurry to read confidently, call zoom_region on that area FIRST (normalised 0..1 " +
  "coordinates) and read the magnified crop that comes back, then continue. Prefer one or two precise " +
  "zooms over guessing. When everything needed is legible, call extract_shipment_data — exactly once.";

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

  type Part = OpenAI.Chat.Completions.ChatCompletionContentPart;
  type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

  // Build one "Image N:" text part + image_url part per image. `detail:
  // "high"` asks the model to inspect at full resolution (tiles the image)
  // rather than a downscaled thumbnail — the cheapest single win for small
  // AWB labels. Ordering passes through so invoice entries come back in the
  // order the caller dropped them.
  const initialContent: Part[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i]!;
    const url = `data:${img.mimeType};base64,${img.data.toString("base64")}`;
    initialContent.push({ type: "text", text: `Image ${i + 1}:` });
    initialContent.push({ type: "image_url", image_url: { url, detail: "high" } });
  }
  initialContent.push({
    type: "text",
    text:
      `You received ${images.length} images. ` +
      "Decide which ONE is the AWB (waybill); every other image is an invoice (factură). " +
      "If any field you need is too small or blurry, call zoom_region first to magnify it, then read " +
      "the crop that comes back. When everything needed is legible, call extract_shipment_data ONCE " +
      "with: the AWB's fields under `awb`, and one entry per invoice image under `invoices` " +
      "(preserving the order in which the invoice images appeared above).",
  });

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_INSTRUCTION },
    { role: "user", content: initialContent },
  ];

  // ONE hard deadline for the whole agentic loop (every model round + every
  // zoom). Each call gets the remaining budget as its AbortSignal, so a stall
  // anywhere still fails fast instead of multiplying the wait.
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS;
  const timeoutError = () =>
    new Error(
      `Vision extraction timed out after ${Math.round(EXTRACT_TIMEOUT_MS / 1000)}s. ` +
        "The image is likely hard to read — e.g. a small AWB label laid on top of an invoice, " +
        "or a blurry/angled photo. Re-shoot the AWB clearly (ideally on its own) and retry.",
    );

  let zoomsUsed = 0;
  let extractFixes = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const left = deadline - Date.now();
    if (left <= 0) throw timeoutError();

    // Force the final answer once the zoom budget is spent, on the last round,
    // OR while we're correcting a rejected extraction (resubmit, don't chat).
    const forceExtract = zoomsUsed >= MAX_ZOOMS || extractFixes > 0 || round === MAX_ROUNDS - 1;

    let completion;
    try {
      completion = await client.chat.completions.create(
        {
          // No temperature or other sampling overrides: the model runs at
          // its provider-tuned defaults. Forcing temperature down on Gemini
          // thinking models degrades output (garbage characters observed
          // live in invoice fields).
          model: MODEL,
          messages,
          tools: forceExtract ? [extractTool] : [extractTool, zoomTool],
          tool_choice: forceExtract
            ? { type: "function", function: { name: "extract_shipment_data" } }
            : "auto",
          ...REASONING,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(left) },
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const aborted =
        e?.name === "APIUserAbortError" ||
        e?.name === "APIConnectionTimeoutError" ||
        e?.name === "AbortError" ||
        e?.name === "TimeoutError" ||
        /abort|timed?\s*out|timeout/i.test(e?.message ?? "");
      if (aborted) throw timeoutError();
      throw err;
    }

    // `choices` itself can be ABSENT when the gateway returns an error-shaped
    // 200 body (another high-thinking transient, observed live 2026-06-11) —
    // an undefined message falls through to the no-tool-call nudge below.
    const message = completion.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    // The final extraction wins, even if the model also asked to zoom this turn.
    const extractCall = toolCalls.find((t) => t.function.name === "extract_shipment_data");
    if (extractCall) {
      let rawArgs: unknown;
      try {
        rawArgs = JSON.parse(extractCall.function.arguments);
      } catch (err) {
        // High-effort thinking can truncate the forced tool call's JSON
        // mid-stream (observed live 2026-06-11). Treat it like a rejected
        // extraction — answer the tool calls, ask for a clean resubmit —
        // instead of failing the whole pair on a transient cut.
        if (extractFixes < MAX_EXTRACT_FIXES) {
          extractFixes += 1;
          messages.push(message as Msg);
          for (const tc of toolCalls) {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "Arguments arrived truncated / invalid JSON — resubmit the full extraction.",
            });
          }
          messages.push({
            role: "user",
            content:
              "Your extract_shipment_data call arrived as truncated or invalid JSON. Call extract_shipment_data " +
              "ONCE more with the FULL, complete struct.",
          });
          continue;
        }
        throw new Error(
          `Tool call arguments were not valid JSON:\n${extractCall.function.arguments.slice(0, 500)}\n\n${(err as Error).message}`,
        );
      }
      const parsed = ExtractedSchema.safeParse(rawArgs);
      if (parsed.success) return parsed.data;

      // Self-heal: the model returned an almost-right struct but missed or
      // mistyped a required field (the cheap extractor occasionally drops e.g.
      // invoices[].invoice_number). Hand the exact problems back and let it
      // resubmit, a bounded number of times, before giving up.
      if (extractFixes < MAX_EXTRACT_FIXES) {
        extractFixes += 1;
        const issues = parsed.error.issues
          .map((i) => `• ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        // Protocol: record the assistant turn that issued the tool_calls, and
        // answer EVERY tool_call with a tool message, before the next turn.
        messages.push(message as Msg);
        for (const tc of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: tc.id === extractCall.id ? "Validation failed — see correction." : "Superseded; resubmit the full extraction.",
          });
        }
        messages.push({
          role: "user",
          content:
            "Your extract_shipment_data call was REJECTED. These fields are invalid:\n" +
            issues +
            "\n\nRead those values off the images (zoom is no longer available — use your best reading) and call " +
            "extract_shipment_data ONCE more with the FULL struct corrected. Required string fields — especially each " +
            "invoice's invoice_number, read from the 'FACTURĂ … <number>' header — must be a real string, never null and " +
            "never omitted. Only if a required value is genuinely unreadable, put an empty string \"\" for that one field (never null).",
        });
        continue;
      }

      throw new Error(
        `Model output failed schema validation after ${MAX_EXTRACT_FIXES} correction attempts:\n${parsed.error.toString()}\n\nRaw args:\n${JSON.stringify(rawArgs, null, 2)}`,
      );
    }

    const zoomCalls = toolCalls.filter((t) => t.function.name === "zoom_region");
    if (zoomCalls.length === 0) {
      // No tool call (prose, or empty). Record it and nudge toward the tools.
      if (message) messages.push(message as Msg);
      messages.push({
        role: "user",
        content: "Call extract_shipment_data now (or zoom_region first if a field is unreadable).",
      });
      continue;
    }

    // Record the assistant turn that issued the zoom calls. EVERY tool_call
    // must be answered with a tool message before the next assistant turn,
    // then the magnified crops ride in as a fresh user image turn.
    messages.push(message as Msg);
    const cropParts: Part[] = [];
    for (const zc of zoomCalls) {
      let note: string;
      if (zoomsUsed >= MAX_ZOOMS) {
        note = "Zoom budget exhausted — call extract_shipment_data now with your best reading.";
      } else {
        try {
          const a = JSON.parse(zc.function.arguments) as {
            image_index?: number; x0?: number; y0?: number; x1?: number; y1?: number; reason?: string;
          };
          const idx = Math.round(Number(a.image_index ?? 0)) - 1;
          const src = images[idx];
          if (!src) {
            note = `No image ${a.image_index} exists (there are ${images.length}). Use 1..${images.length}.`;
          } else {
            const crop = await cropRegion(src.data, {
              x0: Number(a.x0), y0: Number(a.y0), x1: Number(a.x1), y1: Number(a.y1),
            });
            zoomsUsed += 1;
            console.info(`[llm] zoom #${zoomsUsed}: image ${idx + 1} → ${crop.width}x${crop.height}${a.reason ? ` (${a.reason})` : ""}`);
            cropParts.push({
              type: "text",
              text: `Zoom of Image ${idx + 1}${a.reason ? ` — ${a.reason}` : ""} (${crop.width}x${crop.height}):`,
            });
            cropParts.push({ type: "image_url", image_url: { url: crop.dataUrl, detail: "high" } });
            note = `Zoom of image ${idx + 1} ready — see the magnified image that follows.`;
          }
        } catch (err) {
          note = `Zoom failed: ${(err as Error).message}. Read at full frame or pick another region.`;
        }
      }
      messages.push({ role: "tool", tool_call_id: zc.id, content: note });
    }
    if (cropParts.length > 0) {
      messages.push({ role: "user", content: cropParts });
    }
  }

  throw new Error(
    "Vision extraction did not produce a result after the allotted zoom rounds. " +
      "Re-shoot the AWB clearly (ideally on its own) and retry.",
  );
}

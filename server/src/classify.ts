/**
 * Per-image document reading — stage one of the scan-batch flow.
 *
 * One model, one image per call, every call independent, all in
 * parallel. The model does NO classification judgement — it simply
 * reports the facts it can see through two function tools:
 *
 *   • report_awb     — once PER courier label visible in the photo
 *                      (a stray label from the pile is marked stray);
 *   • report_invoice — once when an invoice (FACTURĂ) page is visible.
 *
 * A photo of a label calls report_awb. A photo of an invoice calls
 * report_invoice. A photo of a label clipped onto its invoice calls
 * BOTH. The deterministic linker (linker.ts) then joins one AWB to its
 * N invoices using what is printed on the paper: the recipient name
 * (the label's Destinatar equals the invoice's Cumpărător) and scan
 * adjacency for anything unreadable.
 *
 * A single failed read NEVER fails the batch: it degrades to "unknown"
 * and the linker files the photo by adjacency.
 */

import OpenAI from "openai";
import { z } from "zod";
import type { ImageInput } from "./gemini.js";
import type { DocInfo, DocType } from "./linker.js";

const MODEL = process.env.OPENROUTER_GROUPING_MODEL ?? process.env.OPENROUTER_MODEL ?? "google/gemini-3.5-flash";
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** OpenRouter unified reasoning control. Default "low": reading one image
 *  is easy — a small thinking budget keeps the field reads sharp without
 *  latency. The explicit max_tokens MUST ride along (effort is carved out
 *  of it; unbounded thinking once starved the forced tool call).
 *  Set OPENROUTER_REASONING_EFFORT=off to disable entirely. */
const REASONING_EFFORT = process.env.OPENROUTER_REASONING_EFFORT ?? "low";
const REASONING =
  REASONING_EFFORT === "off"
    ? {}
    : {
        reasoning: { effort: REASONING_EFFORT },
        max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 65_535),
      };

/** Per-image call ceiling. One photo is a small request; 120s is generous. */
const CLASSIFY_TIMEOUT_MS = Number(process.env.CLASSIFY_TIMEOUT_MS ?? 120_000);

/** How many single-image calls fly at once. The pool keeps a 100-image
 *  batch from slamming OpenRouter in one burst; retries absorb any 429s. */
const CLASSIFY_CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY ?? 32);

const client = new OpenAI({
  apiKey: API_KEY ?? "",
  baseURL: BASE_URL,
  timeout: CLASSIFY_TIMEOUT_MS,
  maxRetries: 1,
  defaultHeaders: {
    "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "http://localhost:5173",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Centralizator",
  },
});

const awbTool = {
  type: "function" as const,
  function: {
    name: "report_awb",
    description:
      "Report ONE courier waybill label visible in the photo. Call once per label you can see.",
    parameters: {
      type: "object",
      properties: {
        awb_number: {
          type: ["string", "null"],
          description:
            "The label's number (printed large with the barcode, 9 digits, e.g. 007211172). EXACTLY the digits you can see — a partial read like '0900' is valuable, but NEVER guess rotated/blurred/hidden digits: a wrong digit is far worse than null.",
        },
        confident: {
          type: "boolean",
          description:
            "true ONLY if the digits are upright, sharp and fully visible. false if rotated, upside down, blurred, partially hidden, or you are unsure of any digit.",
        },
        stray: {
          type: "boolean",
          description:
            "true when this label does NOT belong to the photo's main document: it peeks in at the frame edge, sits upside down relative to the main page, or lies on a different sheet in the pile. A label clipped/stapled/laid squarely ON the main invoice is NOT stray.",
        },
        recipient_name: {
          type: ["string", "null"],
          description: "The label's 'Destinatar' name, as printed. null if unreadable.",
        },
        recipient_address: {
          type: ["string", "null"],
          description: "The label's Destinatar street + locality. null if unreadable.",
        },
      },
      required: ["awb_number", "confident", "stray"],
      additionalProperties: false,
    },
  },
};

const invoiceTool = {
  type: "function" as const,
  function: {
    name: "report_invoice",
    description:
      "Report the invoice (FACTURĂ) page visible in the photo. Call once when an invoice is the photo's main document (possibly with a label clipped on it).",
    parameters: {
      type: "object",
      properties: {
        invoice_number: {
          type: ["string", "null"],
          description: "The number in the FACTURĂ header (13 digits, e.g. 0072600055360). null if unreadable.",
        },
        order_number: {
          type: ["string", "null"],
          description: "The 'Comandă' number (e.g. 480746). null if unreadable.",
        },
        buyer_name: {
          type: ["string", "null"],
          description:
            "The 'Cumparator' name — the BUYER person or company ONLY. NEVER the Furnizor (the store, e.g. Leroy Merlin), NEVER the courier company, NEVER a numeric code (a CNP of zeros is not a name). null if unreadable.",
        },
        buyer_address: {
          type: ["string", "null"],
          description: "The buyer's 'Sediul' address. null when unreadable or printed as N/A.",
        },
      },
      required: ["invoice_number", "order_number", "buyer_name"],
      additionalProperties: false,
    },
  },
};

const unreadableTool = {
  type: "function" as const,
  function: {
    name: "report_unreadable",
    description: "Call ONLY when the photo shows neither a readable courier label nor a readable invoice.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const SYSTEM_INSTRUCTION =
  "You are a document reader for a Romanian courier back office. You receive exactly ONE photo of paperwork " +
  "from a courier's van — usually a courier waybill label (AWB), a fiscal invoice (FACTURĂ), or a label clipped " +
  "onto its invoice. The photo is shot over a PILE of documents, so stray sheets and labels from OTHER " +
  "shipments often peek into the frame, usually upside down relative to the main document.\n" +
  "What things look like:\n" +
  "  • AWB label: barcode + a 9-digit number (007…), 'Expeditor', 'Destinatar', 'Serviciu', 'Greutate (kg)', " +
  "often branded 'couriermanager'.\n" +
  "  • Invoice: an A4 page headed 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT') with Furnizor + Cumparator " +
  "blocks, a 'Comandă' number, a 13-digit header number, line items and totals.\n" +
  "Documents may be ROTATED or UPSIDE DOWN — orient each one mentally before reading it.\n" +
  "Report the facts with the tools:\n" +
  "  • call report_awb once for EACH courier label you can see (mark stray=true for labels that do not belong " +
  "to the main document);\n" +
  "  • call report_invoice once when an invoice page is the photo's main document;\n" +
  "  • a label clipped on its invoice → call BOTH report_awb (stray=false) AND report_invoice;\n" +
  "  • nothing readable → call report_unreadable.\n" +
  "Read ONLY what is printed. NEVER guess digits you cannot clearly see — a wrong digit creates a phantom " +
  "shipment downstream; return null or only the certain digits, with confident=false. The 13-digit FACTURĂ " +
  "header number is never an awb_number. Names: only the actual person/company, never the store or the courier.\n" +
  "Reply ONLY with tool calls, never in prose.";

const nullableStr = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? null : String(v)),
  z.string().nullable(),
);

const AwbArgsSchema = z.object({
  awb_number: nullableStr.default(null),
  confident: z.coerce.boolean().default(false),
  stray: z.coerce.boolean().default(false),
  recipient_name: nullableStr.default(null),
  recipient_address: nullableStr.default(null),
});

const InvoiceArgsSchema = z.object({
  invoice_number: nullableStr.default(null),
  order_number: nullableStr.default(null),
  buyer_name: nullableStr.default(null),
  buyer_address: nullableStr.default(null),
});

const UNKNOWN: Omit<DocInfo, "index"> = {
  type: "unknown",
  awbNumber: null,
  awbConfident: false,
  extraAwbNumbers: [],
  recipientName: null,
  recipientAddress: null,
  invoiceNumber: null,
  orderNumber: null,
};

/** Fold one response's tool calls into a DocInfo. Returns null when the
 *  response carried no valid tool call (the retry loop continues). */
function readingFromToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): Omit<DocInfo, "index"> | null {
  if (!toolCalls || toolCalls.length === 0) return null;

  const awbs: z.infer<typeof AwbArgsSchema>[] = [];
  let invoice: z.infer<typeof InvoiceArgsSchema> | null = null;
  let sawValidCall = false;

  for (const call of toolCalls) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      continue; // truncated JSON on one call — others may still be good
    }
    if (call.function.name === "report_awb") {
      const parsed = AwbArgsSchema.safeParse(args);
      if (parsed.success) {
        awbs.push(parsed.data);
        sawValidCall = true;
      }
    } else if (call.function.name === "report_invoice") {
      const parsed = InvoiceArgsSchema.safeParse(args);
      if (parsed.success) {
        invoice = parsed.data;
        sawValidCall = true;
      }
    } else if (call.function.name === "report_unreadable") {
      sawValidCall = true;
    }
  }
  if (!sawValidCall) return null;

  // The photo's own label: prefer a confident non-stray read, then any
  // non-stray. Stray labels (and surplus non-stray reads) are diagnostics.
  const own = awbs.filter((a) => !a.stray);
  own.sort((a, b) => Number(b.confident) - Number(a.confident));
  const main = own[0] ?? null;
  const extras = awbs
    .filter((a) => a !== main && a.awb_number !== null)
    .map((a) => a.awb_number!);

  const type: DocType =
    main !== null && invoice !== null ? "combined" : main !== null ? "awb" : invoice !== null ? "invoice" : "unknown";

  return {
    type,
    awbNumber: main?.awb_number ?? null,
    awbConfident: main?.confident ?? false,
    extraAwbNumbers: extras,
    recipientName: main?.recipient_name ?? invoice?.buyer_name ?? null,
    recipientAddress: main?.recipient_address ?? invoice?.buyer_address ?? null,
    invoiceNumber: invoice?.invoice_number ?? null,
    orderNumber: invoice?.order_number ?? null,
  };
}

/**
 * Read one image. Returns the reading, or the "unknown" fallback after the
 * retries are exhausted — a single stubborn photo must never sink a batch.
 */
export async function classifyImage(image: ImageInput): Promise<Omit<DocInfo, "index">> {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");

  const url = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
  const MAX_TRIES = 4;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create(
        {
          // No temperature or other sampling overrides: the model runs at
          // its provider-tuned defaults (OpenRouter passes absent params
          // through). Forcing temperature down on Gemini thinking models
          // degrades output quality.
          model: MODEL,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url } },
                {
                  type: "text",
                  text: "Report this photo's documents: report_awb per visible label, report_invoice if an invoice page is present, report_unreadable if neither.",
                },
              ],
            },
          ],
          tools: [awbTool, invoiceTool, unreadableTool],
          tool_choice: "required",
          ...REASONING,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS) },
      );

      // Bad RESPONSES (no tool calls, truncated JSON, absent choices on an
      // error-shaped 200) retry exactly like bad connections.
      const reading = readingFromToolCalls(completion.choices?.[0]?.message?.tool_calls);
      if (reading !== null) return reading;
    } catch {
      // connection error / timeout — fall through to retry
    }
    if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return UNKNOWN;
}

/** Run async `fn` over `items` with a fixed concurrency ceiling. */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Read a whole stack: one independent call per image, pooled. Volume only
 * widens the fan-out — 10 images or 100, each call stays trivially small.
 */
export async function classifyImages(images: ImageInput[]): Promise<DocInfo[]> {
  const readings = await mapPool(images, CLASSIFY_CONCURRENCY, (img) => classifyImage(img));
  return readings.map((r, index) => ({ index, ...r }));
}

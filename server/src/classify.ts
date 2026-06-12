/**
 * Per-image document reading — THE single AI stage of the scan-batch flow.
 *
 * One model, one image per call, every call independent, all in parallel.
 * The model is given exactly TWO reporting tools and NO forced schema:
 *
 *   • report_awb     — the full waybill fields; called once per courier
 *                      label visible (stray pile-neighbours marked);
 *   • report_invoice — the full invoice fields; called when an invoice
 *                      page is visible.
 *
 * A label photo calls report_awb. An invoice photo calls report_invoice.
 * A label clipped onto its invoice calls BOTH. Nothing is required — the
 * model reports only what it actually sees, and code fills any schema
 * gaps with neutral defaults later (pipeline.assembleExtracted).
 *
 * There is NO second extraction pass: these readings carry every field
 * the pricing pipeline needs. linker.ts pairs one AWB with its N
 * invoices using what is printed on the paper (Destinatar = Cumpărător,
 * scan adjacency as the fallback), and the raw readings ride along to be
 * assembled into the pair's data.
 *
 * A single failed read NEVER fails the batch: it degrades to "unknown"
 * and the linker files the photo by adjacency.
 */

import OpenAI from "openai";
import type { ImageInput } from "./gemini.js";
import { awbSchema, invoiceSchema } from "./gemini.js";
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

/** report_awb = the full AWB field set + the two photo-context flags.
 *  NOTHING is required except the flags — the model reports what it sees. */
const awbTool = {
  type: "function" as const,
  function: {
    name: "report_awb",
    description:
      "Report ONE courier waybill label visible in the photo, with every field you can read. Call once per label.",
    parameters: {
      type: "object",
      properties: {
        ...awbSchema.properties,
        confident: {
          type: "boolean",
          description:
            "true ONLY if the awb_number digits are upright, sharp and fully visible. false if rotated, upside down, blurred, partially hidden, or you are unsure of any digit.",
        },
        stray: {
          type: "boolean",
          description:
            "true when this label does NOT belong to the photo's main document: it peeks in at the frame edge, sits upside down relative to the main page, or lies on a different sheet in the pile. A label clipped/stapled/laid squarely ON the main invoice is NOT stray.",
        },
      },
      required: ["confident", "stray"],
    },
  },
};

/** report_invoice = the full invoice field set (+ buyer_address for the
 *  linker). Nothing required — report what is printed, skip the rest. */
const invoiceTool = {
  type: "function" as const,
  function: {
    name: "report_invoice",
    description:
      "Report the invoice (FACTURĂ) page visible in the photo, with every field you can read. Call once when an invoice is the photo's main document (possibly with a label clipped on it).",
    parameters: {
      type: "object",
      properties: {
        ...invoiceSchema.properties,
        buyer_address: {
          type: "string",
          description: "The buyer's 'Sediul' address, as printed. Omit when unreadable or printed as N/A.",
        },
      },
      required: [],
    },
  },
};

const unreadableTool = {
  type: "function" as const,
  function: {
    name: "report_unreadable",
    description: "Call ONLY when the photo shows neither a readable courier label nor a readable invoice.",
    parameters: { type: "object", properties: {} },
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
  "  • call report_awb once for EACH courier label you can see, filling every field you can read (mark " +
  "stray=true for labels that do not belong to the main document);\n" +
  "  • call report_invoice once when an invoice page is the photo's main document, filling every field and " +
  "line item you can read;\n" +
  "  • a label clipped on its invoice → call BOTH report_awb (stray=false) AND report_invoice;\n" +
  "  • nothing readable → call report_unreadable.\n" +
  "Report ONLY what is printed — no field is mandatory, never fill a field you cannot see. NEVER guess digits: " +
  "a wrong digit creates a phantom shipment downstream; report only the certain digits with confident=false, " +
  "or omit the number. The 13-digit FACTURĂ header number is never an awb_number. recipient_name/buyer_name is " +
  "the actual person or company receiving/buying — never the Furnizor store, never the courier, never numeric " +
  "codes. Dates ISO YYYY-MM-DD (Romanian DD.MM.YYYY converts). Amounts in RON without thousand separators.\n" +
  "Reply ONLY with tool calls, never in prose.";

const UNKNOWN: Omit<DocInfo, "index"> = {
  type: "unknown",
  awbNumber: null,
  awbConfident: false,
  extraAwbNumbers: [],
  recipientName: null,
  recipientAddress: null,
  invoiceNumber: null,
  orderNumber: null,
  awbRaw: null,
  invoiceRaw: null,
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Fold one response's tool calls into a reading. Returns null when the
 *  response carried no valid tool call (the retry loop continues). */
function readingFromToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): Omit<DocInfo, "index"> | null {
  if (!toolCalls || toolCalls.length === 0) return null;

  const awbs: Array<Record<string, unknown>> = [];
  let invoice: Record<string, unknown> | null = null;
  let sawValidCall = false;

  for (const call of toolCalls) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      continue; // truncated JSON on one call — others may still be good
    }
    if (typeof args !== "object" || args === null) continue;
    if (call.function.name === "report_awb") {
      awbs.push(args as Record<string, unknown>);
      sawValidCall = true;
    } else if (call.function.name === "report_invoice") {
      invoice = args as Record<string, unknown>;
      sawValidCall = true;
    } else if (call.function.name === "report_unreadable") {
      sawValidCall = true;
    }
  }
  if (!sawValidCall) return null;

  // The photo's own label: prefer a confident non-stray read, then any
  // non-stray. Stray labels are diagnostics only — never an identity.
  const own = awbs.filter((a) => a.stray !== true);
  own.sort((a, b) => Number(b.confident === true) - Number(a.confident === true));
  const main = own[0] ?? null;
  const extras = awbs
    .filter((a) => a !== main)
    .map((a) => str(a.awb_number))
    .filter((n): n is string => n !== null);

  const type: DocType =
    main !== null && invoice !== null ? "combined" : main !== null ? "awb" : invoice !== null ? "invoice" : "unknown";

  return {
    type,
    awbNumber: main ? str(main.awb_number) : null,
    awbConfident: main?.confident === true,
    extraAwbNumbers: extras,
    recipientName: (main ? str(main.recipient_name) : null) ?? (invoice ? str(invoice.buyer_name) : null),
    recipientAddress: (main ? str(main.recipient_address) : null) ?? (invoice ? str(invoice.buyer_address) : null),
    invoiceNumber: invoice ? str(invoice.invoice_number) : null,
    orderNumber: invoice ? str(invoice.order_number) : null,
    awbRaw: main,
    invoiceRaw: invoice,
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
          // its provider-tuned defaults.
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

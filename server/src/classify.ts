/**
 * Per-image document reading — stage one of the scan-batch flow.
 *
 * One AI call per image, every call independent, all of them in parallel.
 * This is the volume-proof replacement for the grouping agent: a model
 * reading ONE photo cannot drop the tail of a stack, cannot confuse two
 * shipments, and needs no thinking budget to compare images it never
 * sees. The cross-image work (which photos form a shipment, which are
 * duplicates) moves into deterministic code — see linker.ts.
 *
 * Each call answers two things about its single photo:
 *   • WHAT it is: a courier label (awb), an invoice page, a combined
 *     label-on-invoice photo, or unreadable;
 *   • the LINK FIELDS printed on it: AWB number, recipient (Destinatar /
 *     Cumparator), address, invoice and order numbers — exactly the keys
 *     the linker joins on.
 *
 * A single failed read NEVER fails the batch: after the retries it
 * degrades to type "unknown" and the linker files the photo by scan
 * adjacency, which is what the old system effectively did for unreadable
 * images anyway.
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

const classifyTool = {
  type: "function" as const,
  function: {
    name: "classify_document",
    description:
      "Report what this single photo shows and the identifying fields printed on it.",
    parameters: {
      type: "object",
      properties: {
        doc_type: {
          type: "string",
          enum: ["awb", "invoice", "combined", "unknown"],
          description:
            "awb = courier label is the MAIN subject; invoice = FACTURĂ page; combined = a courier label clipped/stapled/laid ON the invoice page, both belonging together; unknown = neither/unreadable.",
        },
        awb_number: {
          type: ["string", "null"],
          description:
            "The number of THIS document's courier label only: the label that is the photo's subject (awb) or is clipped onto the invoice (combined). NEVER the FACTURĂ header number, and NEVER a stray label from another document peeking into the frame — those go in extra_awb_numbers. Return EXACTLY the digits you can see; a partial read like '0900' is valuable, but NEVER guess rotated/blurred/hidden digits: a wrong digit is far worse than null.",
        },
        awb_number_confident: {
          type: "boolean",
          description:
            "true ONLY if the AWB digits are upright, sharp and fully visible. false if the label is upside down, rotated, blurred, partially hidden, or you are unsure of any digit.",
        },
        extra_awb_numbers: {
          type: "array",
          items: { type: "string" },
          description:
            "Numbers of OTHER courier labels visible in the frame that do NOT belong to this document: a label at the frame's edge, upside down relative to the main document, or on a different sheet in the pile beneath. Empty array when none. Only digits you can actually read.",
        },
        recipient_name: {
          type: ["string", "null"],
          description:
            "AWB label: the 'Destinatar' name. Invoice: the 'Cumparator' name. As printed.",
        },
        recipient_address: {
          type: ["string", "null"],
          description:
            "AWB label: the Destinatar street + locality. Invoice: the 'Sediul' under Cumparator (null when it reads N/A).",
        },
        invoice_number: {
          type: ["string", "null"],
          description: "The number in the FACTURĂ header (e.g. 0072600055360). null on labels.",
        },
        order_number: {
          type: ["string", "null"],
          description: "The invoice's 'Comandă' number (e.g. 480746). null on labels.",
        },
      },
      required: ["doc_type"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_INSTRUCTION =
  "You are a document reader for a Romanian courier back office. You receive exactly ONE photo. " +
  "It shows either a courier waybill label (AWB), a fiscal invoice (FACTURĂ), or both together.\n" +
  "What each looks like:\n" +
  "  • AWB label: a printed shipping label with a barcode, a large number under or near it, and fields like " +
  "'Expeditor', 'Destinatar', 'Serviciu', 'Greutate (kg)', 'Hub destinatie', often branded 'couriermanager'.\n" +
  "  • Invoice: an A4 page headed 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT'), with Furnizor + Cumparator " +
  "blocks, a 'Comandă' number, a line-items table and totals.\n" +
  "  • combined: a small AWB label clipped, stapled or laid ON the invoice page — the label BELONGS to that invoice.\n" +
  "The photos are shot over a PILE of documents, so a frame often catches MORE than the main document: a stray " +
  "label or sheet from the next shipment peeking in at the edge, usually upside down relative to the main " +
  "document. A stray label is NOT this document's AWB — report its digits (if readable) in extra_awb_numbers, " +
  "never in awb_number. The clipped label of a combined photo IS this document's AWB.\n" +
  "Photos are taken in a hurry: documents may be ROTATED or UPSIDE DOWN — orient the page mentally before " +
  "reading anything.\n" +
  "Read ONLY what is printed — never invent or complete fields. If part of the AWB number is covered or cut " +
  "off, return exactly the digits you can see (a partial number is useful). NEVER guess at digits you cannot " +
  "clearly see — reading rotated digits wrong creates phantom shipments downstream; return null or the certain " +
  "digits only, and set awb_number_confident=false. The number in the FACTURĂ header is the invoice_number and " +
  "must NEVER be reported as awb_number. Use null for anything you cannot read. For a combined photo fill BOTH " +
  "the label fields and the invoice fields.\n" +
  "Call classify_document EXACTLY ONCE. Never reply in prose.";

const nullableStr = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? null : String(v)),
  z.string().nullable(),
);

const ClassifyArgsSchema = z.object({
  doc_type: z.enum(["awb", "invoice", "combined", "unknown"]),
  awb_number: nullableStr.default(null),
  awb_number_confident: z.coerce.boolean().default(false),
  extra_awb_numbers: z.array(z.coerce.string()).default([]),
  recipient_name: nullableStr.default(null),
  recipient_address: nullableStr.default(null),
  invoice_number: nullableStr.default(null),
  order_number: nullableStr.default(null),
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

/**
 * Read one image. Returns the reading, or the "unknown" fallback after the
 * retries are exhausted — a single stubborn photo must never sink a batch
 * (the linker files unknowns by scan adjacency).
 */
export async function classifyImage(image: ImageInput): Promise<Omit<DocInfo, "index">> {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");

  const url = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
  const MAX_TRIES = 4;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create(
        {
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url } },
                { type: "text", text: "Classify this photo and read its fields, then call classify_document once." },
              ],
            },
          ],
          tools: [classifyTool],
          tool_choice: { type: "function", function: { name: "classify_document" } },
          ...REASONING,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS) },
      );

      // Bad RESPONSES (no tool call, truncated JSON, absent choices on an
      // error-shaped 200) retry exactly like bad connections.
      const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];
      if (toolCall && toolCall.function.name === "classify_document") {
        const parsed = ClassifyArgsSchema.safeParse(JSON.parse(toolCall.function.arguments));
        if (parsed.success) {
          const d = parsed.data;
          return {
            type: d.doc_type as DocType,
            awbNumber: d.awb_number,
            awbConfident: d.awb_number_confident,
            extraAwbNumbers: d.extra_awb_numbers,
            recipientName: d.recipient_name,
            recipientAddress: d.recipient_address,
            invoiceNumber: d.invoice_number,
            orderNumber: d.order_number,
          };
        }
      }
    } catch {
      // connection error / timeout / invalid JSON — fall through to retry
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

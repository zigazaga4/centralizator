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
 *  Set OPENROUTER_REASONING_EFFORT=off to disable entirely.
 *
 *  OPENROUTER_GROUPING_REASONING_EFFORT overrides the effort for THIS stage
 *  only (like OPENROUTER_GROUPING_MODEL splits the model): the classify read
 *  is where a stray background label must be reasoned out geometrically, so
 *  it can be dialled up independently of the extraction pass. Falls back to
 *  the shared OPENROUTER_REASONING_EFFORT, then "low". */
const REASONING_EFFORT =
  process.env.OPENROUTER_GROUPING_REASONING_EFFORT ?? process.env.OPENROUTER_REASONING_EFFORT ?? "low";
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
            "Own-vs-stray is decided by GEOMETRY, not by whether an invoice is nearby. true when this " +
            "label is a stray from the pile: it is rotated or upside down RELATIVE TO the photo's main " +
            "document, and/or its label box is cut off by the frame edge so you cannot see the whole " +
            "label. Such a label belongs to another shipment that slipped into the shot — mark stray=true " +
            "and do NOT complete or guess the digits that run off the frame. A label is the photo's OWN " +
            "(stray=false) ONLY when it is upright with the main document, its WHOLE box is inside the " +
            "frame, and it is a main subject of the photo. The AWB's big printed NUMBER and barcode are " +
            "the anchor: if that number/barcode is not fully visible AND upright, the label is stray " +
            "(stray=true) even when its Expeditor/Destinatar text happens to be readable — never " +
            "fabricate the missing digits. A courier label clipped/stapled/laid squarely ON its invoice, " +
            "upright with its whole number+barcode visible, is the classic OWN label and is NOT stray.",
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
  "shipments often peek into the frame, usually upside down relative to the main document. An invoice " +
  "that fills the frame very often has NO courier label of its own in the same photo — do NOT attach an " +
  "edge label to it just because they share the frame; that shipment's real label may have been " +
  "photographed separately.\n" +
  "What things look like:\n" +
  "  • AWB label: barcode + a 9-digit number (007…), 'Expeditor', 'Destinatar', 'Serviciu', 'Greutate (kg)', " +
  "often branded 'couriermanager'.\n" +
  "  • Invoice: an A4 page headed 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT') with Furnizor + Cumparator " +
  "blocks, a 'Comandă' number, a 13-digit header number, line items and totals.\n" +
  "Documents may be ROTATED or UPSIDE DOWN — orient each one mentally before reading it.\n" +
  "Report the facts with the tools:\n" +
  "  • call report_awb once for EACH courier label you can see, filling every field you can read. Decide " +
  "own-vs-stray by GEOMETRY: a label is the photo's OWN (stray=false) only when it is UPRIGHT with the " +
  "main document, its WHOLE box is inside the frame, and it is a main subject of the photo (the classic " +
  "own label is a courier label clipped/laid squarely on its invoice, fully visible). Mark stray=true for " +
  "any label that is rotated or upside down relative to the main document, or whose box is cut off by the " +
  "frame edge — that is a background label from another shipment, not this photo's AWB;\n" +
  "  • call report_invoice once when an invoice page is the photo's main document, filling every field and " +
  "line item you can read;\n" +
  "  • a label clipped on its invoice → call BOTH report_awb (stray=false) AND report_invoice;\n" +
  "  • nothing readable → call report_unreadable.\n" +
  "Report ONLY what is printed — no field is mandatory, never fill a field you cannot see. NEVER guess digits: " +
  "a wrong digit creates a phantom shipment downstream; report only the certain digits with confident=false, " +
  "or omit the number. In particular, NEVER complete a number whose digits run off the frame or are hidden by a " +
  "curl/fold — a partly-off-frame label is a stray background label (stray=true), not this photo's AWB. A photo " +
  "has AT MOST ONE own label: the one whose big AWB number+barcode is upright and fully inside the frame. If no " +
  "label's number is fully and uprightly visible, the photo has NO own label — report only the invoice. " +
  "The 13-digit FACTURĂ header number is never an awb_number. recipient_name/buyer_name is " +
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
                // detail:"high" makes the model inspect the photo at full
                // resolution (tiled) instead of a downscaled thumbnail — the
                // single cheapest win for reading a small AWB label's number,
                // Greutate and Distanță, which a thumbnail loses.
                { type: "image_url", image_url: { url, detail: "high" } },
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

/* ──────────────────────────────────────────────────────────────────────
 * AI pair SUGGESTIONS — the human-override companion to the linker.
 *
 * The deterministic linker refuses to guess; what it could not pair sits
 * in the "documente fără pereche" modal. There the operator can press a
 * button that sends ALL the orphan photos in ONE call to the model and
 * asks it to PROPOSE pairings from what it can actually see (shared
 * recipient/buyer name, address, order/AWB numbers printed across the
 * documents). These are SUGGESTIONS only: the human reviews, rearranges
 * them by drag-and-drop, and only then sends the groups to OCR — nothing
 * here touches the database or the pricing pipeline.
 * ────────────────────────────────────────────────────────────────────── */

/** One AI-suggested shipment: pool indices (0-based, validated) of the
 *  AWB photo and its invoice photo(s), plus the printed evidence the
 *  model cited — shown to the operator under the group. */
export interface PairSuggestionIdx {
  awbIndex: number;
  invoiceIndices: number[];
  evidence: string | null;
}

/** Hard ceiling on photos per suggestion call — one request carries every
 *  image, so the cap keeps the payload sane. Route-level validation reuses
 *  it so the limit lives in exactly one place. */
export const SUGGEST_MAX_IMAGES = Number(process.env.SUGGEST_MAX_IMAGES ?? 40);

/** All-images-in-one-call ceiling — wider than the per-image read. */
const SUGGEST_TIMEOUT_MS = Number(process.env.SUGGEST_TIMEOUT_MS ?? 180_000);

const suggestPairTool = {
  type: "function" as const,
  function: {
    name: "suggest_pair",
    description:
      "Propose ONE shipment: the photo number of its AWB label plus the photo number(s) of its invoice page(s). " +
      "Call once per shipment you can match. Only pair photos linked by PRINTED evidence visible in both.",
    parameters: {
      type: "object",
      properties: {
        awb_image: {
          type: "integer",
          description: "Photo number (1-based, as captioned) of the AWB courier label.",
        },
        invoice_images: {
          type: "array",
          items: { type: "integer" },
          description: "Photo numbers (1-based) of the invoice page(s) belonging to the same shipment.",
        },
        evidence: {
          type: "string",
          description:
            "The printed evidence that links them — e.g. the shared recipient/buyer name, the shared address, or a matching order/AWB number. Short, in Romanian.",
        },
      },
      required: ["awb_image", "invoice_images"],
    },
  },
};

const noPairsTool = {
  type: "function" as const,
  function: {
    name: "no_pairs",
    description: "Call ONLY when no two photos share enough printed evidence to propose any pairing.",
    parameters: { type: "object", properties: {} },
  },
};

const SUGGEST_SYSTEM_INSTRUCTION =
  "You see N numbered photos of courier paperwork from a Romanian back office. An automatic matcher already " +
  "FAILED to pair them, so a human will review whatever you propose — your job is to suggest which photos " +
  "belong to the same shipment.\n" +
  "Each photo is one document: a courier waybill label (AWB: barcode, 9-digit 007… number, Destinatar block), " +
  "a fiscal invoice (FACTURĂ: Furnizor + Cumparator blocks, Comandă number, line items), or something unreadable. " +
  "Documents may be ROTATED or UPSIDE DOWN — orient each one mentally before reading it.\n" +
  "Pair an AWB label with its invoice(s) using PRINTED evidence only:\n" +
  "  • the AWB's Destinatar matches the invoice's Cumparator (name or company);\n" +
  "  • the delivery address matches the buyer address;\n" +
  "  • an order/AWB number printed on one document appears on the other.\n" +
  "Rules: call suggest_pair once per matched shipment; one AWB may take several invoices; each photo may appear " +
  "in AT MOST one suggestion; never pair photos that share no visible evidence — leave them out; if nothing " +
  "matches, call no_pairs. NEVER pair by photo order or by guessing. Reply ONLY with tool calls, never in prose.";

const toIdx = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) ? n - 1 : null; // model speaks 1-based, code 0-based
};

/** Fold one response's suggest_pair calls into validated suggestions.
 *  Returns null when no valid tool call arrived (the retry loop continues).
 *  Validation is pure set math: every index in range, every photo used at
 *  most once across ALL suggestions (first claim wins), AWB ∉ invoices. */
function suggestionsFromToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
  count: number,
): PairSuggestionIdx[] | null {
  if (!toolCalls || toolCalls.length === 0) return null;

  const used = new Set<number>();
  const out: PairSuggestionIdx[] = [];
  let sawValidCall = false;

  for (const call of toolCalls) {
    if (call.function.name === "no_pairs") {
      sawValidCall = true;
      continue;
    }
    if (call.function.name !== "suggest_pair") continue;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      continue; // truncated JSON on one call — others may still be good
    }
    if (typeof args !== "object" || args === null) continue;
    sawValidCall = true;

    const a = args as Record<string, unknown>;
    const awb = toIdx(a.awb_image);
    if (awb === null || awb < 0 || awb >= count || used.has(awb)) continue;
    const invoices = (Array.isArray(a.invoice_images) ? a.invoice_images : [])
      .map(toIdx)
      .filter((i): i is number => i !== null && i >= 0 && i < count && i !== awb && !used.has(i))
      .filter((i, pos, arr) => arr.indexOf(i) === pos);
    if (invoices.length === 0) continue;

    used.add(awb);
    for (const i of invoices) used.add(i);
    out.push({ awbIndex: awb, invoiceIndices: invoices, evidence: str(a.evidence) });
  }
  return sawValidCall ? out : null;
}

/**
 * Send the whole orphan pool to the model in ONE call and collect its
 * pairing proposals. Throws after the retries are exhausted — the caller
 * surfaces the failure to the operator (unlike classifyImage, there is no
 * sane "unknown" fallback for a whole-pool suggestion).
 */
export async function suggestPairs(images: ImageInput[]): Promise<PairSuggestionIdx[]> {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  if (images.length < 2) return [];

  // Interleave "Photo k:" captions with the images — the captions are the
  // coordinate system the tool calls answer in.
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = images.flatMap((img, i) => [
    { type: "text" as const, text: `Photo ${i + 1}:` },
    {
      type: "image_url" as const,
      // Full-resolution read here too — pairing leans on the printed
      // recipient/buyer name and order/AWB numbers, all small text.
      image_url: { url: `data:${img.mimeType};base64,${img.data.toString("base64")}`, detail: "high" },
    },
  ]);
  content.push({
    type: "text" as const,
    text: `These are the ${images.length} unpaired photos. Propose pairings with suggest_pair (or no_pairs).`,
  });

  const MAX_TRIES = 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const completion = await client.chat.completions.create(
        {
          // No temperature or other sampling overrides: the model runs at
          // its provider-tuned defaults.
          model: MODEL,
          messages: [
            { role: "system", content: SUGGEST_SYSTEM_INSTRUCTION },
            { role: "user", content },
          ],
          tools: [suggestPairTool, noPairsTool],
          tool_choice: "required",
          ...REASONING,
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS) },
      );
      const suggestions = suggestionsFromToolCalls(
        completion.choices?.[0]?.message?.tool_calls,
        images.length,
      );
      if (suggestions !== null) return suggestions;
      lastError = new Error("model returned no valid tool calls");
    } catch (err) {
      lastError = err as Error;
    }
    if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`AI pair suggestion failed: ${lastError?.message ?? "unknown error"}`);
}

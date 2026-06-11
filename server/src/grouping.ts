/**
 * Document grouping — stage one of the phone scan-batch flow.
 *
 * The phone uploads a flat, ordered stack of photos covering SEVERAL
 * shipments at once (e.g. 12 images = 4 AWBs + their invoices, all mixed
 * together in scan order). Before anything can be extracted we must split
 * that stack into individual pairs, where each pair is exactly ONE AWB
 * plus the invoice(s) that belong to it.
 *
 * This module does ONLY that split. It is a deliberately cheap, separate
 * AI call from the extraction:
 *   • it returns INDICES only (which image numbers form each group),
 *     never extracted fields, so there is almost nothing to get wrong and
 *     the token cost is tiny;
 *   • a failure here fails fast and cleanly, before we spend extraction
 *     budget on a mis-split batch.
 *
 * The grouping rule (from the operator): the AWB anchors a group. The
 * invoices touching an AWB ride with it, whether they were scanned just
 * BEFORE it or just AFTER it. The stack may start with either an AWB or
 * an invoice. The model uses both the image content (AWB vs invoice) and
 * the scan order to bind each AWB to its invoices.
 *
 * Provider: same OpenRouter vision model as gemini.ts. We keep a small,
 * self-contained client here rather than reaching into gemini.ts so the
 * two stages stay independently tunable (model, temperature, timeout).
 */

import OpenAI from "openai";
import { z } from "zod";
import type { ImageInput } from "./gemini.js";

const MODEL = process.env.OPENROUTER_GROUPING_MODEL ?? process.env.OPENROUTER_MODEL ?? "google/gemini-3.5-flash";
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

/** Total wall-clock ceiling for the grouping call (incl. the one retry).
 *  Generous by default: one call can now cover a whole day's stack (dozens
 *  of images), and a big multi-image vision request is legitimately slow. */
const GROUP_TIMEOUT_MS = Number(process.env.GROUP_TIMEOUT_MS ?? 600_000);

const client = new OpenAI({
  apiKey: API_KEY ?? "",
  baseURL: BASE_URL,
  timeout: GROUP_TIMEOUT_MS,
  maxRetries: 1,
  defaultHeaders: {
    "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "http://localhost:5173",
    "X-Title": process.env.OPENROUTER_APP_TITLE ?? "Centralizator",
  },
});

/** Ceiling on how many images ride in ONE grouping call. One 83-image call
 *  reproducibly dropped the tail of the stack (the model stops assigning
 *  near the end — observed twice, deterministically, 2026-06-11), while
 *  per-session calls of ~4-16 images group flawlessly. Override with
 *  MAX_GROUPING_CHUNK. */
const MAX_GROUPING_CHUNK = Number(process.env.MAX_GROUPING_CHUNK ?? 24);

/** One pair, expressed as 0-based indices into the uploaded image array. */
export interface DocumentGroup {
  /** Index of the AWB image, or null when the model found no AWB for this run. */
  awbIndex: number | null;
  /** Indices of the invoice images bound to that AWB, in scan order. */
  invoiceIndices: number[];
}

const groupTool = {
  type: "function" as const,
  function: {
    name: "group_documents",
    description:
      "Split the numbered images into shipment groups. Each group is exactly ONE AWB " +
      "(courier waybill) plus the invoice(s) that belong to it.",
    parameters: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          description:
            "One entry per shipment, in the order the shipments appear in the stack.",
          items: {
            type: "object",
            properties: {
              awb_image: {
                type: "integer",
                description:
                  "The 1-based image number that is the AWB (waybill) for this group.",
              },
              invoice_images: {
                type: "array",
                description:
                  "The 1-based image numbers of the invoices belonging to this AWB, " +
                  "in scan order. At least one.",
                items: { type: "integer" },
              },
            },
            required: ["awb_image", "invoice_images"],
          },
        },
      },
      required: ["groups"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_INSTRUCTION =
  "You are a document-sorting assistant for a Romanian courier back office. " +
  "You receive N numbered images. Each image is EITHER a courier waybill (AWB) OR a fiscal invoice (factură). " +
  "Your ONLY job is to group them into shipments. You do NOT read or extract any field values.\n" +
  "What each looks like:\n" +
  "  • AWB: a printed shipping label, portrait, with a barcode and fields like 'AWB', 'Hub destinație', " +
  "'Greutate (kg)', 'Distanță extra (km)', 'Serviciu', 'Expeditor', 'Destinatar', often a brand like 'couriermanager'. " +
  "An AWB may be a small label laid on top of an invoice — if a photo shows a courier label, that photo is an AWB.\n" +
  "  • Invoice: an A4 page headed 'FACTURĂ' / 'FACTURA' (sometimes 'DUPLICAT'), with a Furnizor + Cumpărător block, " +
  "a line-items table, and totals.\n" +
  "Grouping rule:\n" +
  "  • Every group has EXACTLY ONE AWB plus the invoice(s) that belong to it.\n" +
  "  • The AWB is the anchor. The invoices that touch an AWB in the scan order belong to it, whether they come " +
  "JUST BEFORE the AWB or JUST AFTER it. The stack may start with an AWB or with an invoice.\n" +
  "  • Walk the images in order. Bind each run of invoices to its adjacent AWB. The boundary between two groups " +
  "is where the next AWB's shipment begins.\n" +
  "Duplicates & redundant photos (CRITICAL — the photographers are couriers in a hurry, they shoot carelessly):\n" +
  "  • The SAME physical document is often photographed more than once, or the same photo is sent twice: the same " +
  "AWB label twice, the same invoice twice, the same combined label-on-invoice photo twice — possibly at a " +
  "different angle, crop, blur, lighting, or with a hand in the frame. Those are DUPLICATES, not new shipments.\n" +
  "  • ONE SHIPMENT = ONE GROUP, always. NEVER output two groups for the same shipment. Two images showing the " +
  "same AWB number (or the same Destinatar + the same invoice/comandă) are the SAME shipment, no matter how many " +
  "times it was photographed.\n" +
  "  • For each real document keep only ONE image — the clearest, most complete one — and OMIT the duplicates " +
  "entirely. A duplicate must NOT appear in any group: not as an awb_image, not inside invoice_images.\n" +
  "  • You do NOT have to use every image. Leaving duplicate or redundant images unassigned is correct and expected.\n" +
  "  • Match duplicates by their CONTENT: same AWB barcode number, same recipient (Destinatar), same invoice/" +
  "comandă number, same product lines. If two photos clearly show the same shipment's same document, they are duplicates.\n" +
  "  • Combined photo: if ONE image shows BOTH an AWB label AND its invoice together (a small courier label laid on " +
  "the invoice page) and there is no other photo of that shipment's invoice, put that SAME image number in BOTH " +
  "awb_image AND invoice_images for that one group.\n" +
  "  • A duplicated COMBINED photo is the trap to avoid: two photos of the same label-on-invoice arrangement are " +
  "ONE shipment with ONE group — never anchor a second group on the duplicate copy.\n" +
  "Self-check before answering: scan the groups you are about to return; if any two groups rest on the same AWB " +
  "number or the same Destinatar+invoice, merge them and drop the duplicate images, THEN call the tool.\n" +
  "Examples (image:type):\n" +
  "  [1:invoice, 2:invoice, 3:AWB, 4:invoice, 5:AWB] → groups: {awb 3, invoices [1,2]}, {awb 5, invoices [4]}.\n" +
  "  [1:AWB, 2:invoice, 3:invoice, 4:AWB, 5:invoice] → groups: {awb 1, invoices [2,3]}, {awb 4, invoices [5]}.\n" +
  "  [1:AWB-X, 2:invoice-X, 3:invoice-X(duplicate of 2), 4:AWB-Y, 5:invoice-Y] → groups: {awb 1, invoices [2]}, " +
  "{awb 4, invoices [5]} (image 3 omitted as a duplicate).\n" +
  "  [1:combined AWB-Z+invoice-Z, 2:duplicate photo of the same combined document] → ONE group: {awb 1, " +
  "invoices [1]} (image 2 omitted — the same shipment photographed twice is still one shipment).\n" +
  "Rules:\n" +
  "  • Use 1-based image numbers exactly as labelled.\n" +
  "  • Assign each DISTINCT shipment to its own group; omit duplicate/redundant images. Do not invent images.\n" +
  "  • Call group_documents EXACTLY ONCE. Never reply in prose.";

const GroupArgsSchema = z.object({
  groups: z
    .array(
      z.object({
        awb_image: z.number().int(),
        invoice_images: z.array(z.number().int()).default([]),
      }),
    )
    .default([]),
});

/**
 * Group an ordered stack of images into shipment pairs.
 *
 * Returns one `DocumentGroup` per shipment, with 0-based indices into the
 * input array. Throws on a transport/timeout failure or when the model
 * fails to call the tool; the caller (the scan-batch route) treats that
 * as a batch-level failure.
 *
 * Index hygiene: out-of-range and duplicate indices are dropped so a
 * sloppy model response can never point the extractor at the wrong bytes.
 */
export async function groupImages(images: ImageInput[]): Promise<DocumentGroup[]> {
  if (!API_KEY) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  if (images.length === 0) return [];

  // Send the original full-resolution bytes to the grouping model so it can
  // read the small content code / comandă number that links an AWB to its
  // invoice. The retry loop below absorbs the occasional truncated upstream
  // body that a large payload can trigger.
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
      `You received ${images.length} images. Group them into shipments per the rule, then call ` +
      "group_documents ONCE. Use image numbers 1.." +
      String(images.length) +
      ". Assign each DISTINCT shipment to exactly ONE group — never two groups for the same AWB number — and " +
      "OMIT any duplicate or redundant images (do not force every image into a group).",
  });

  // A large multi-image grouping request (a whole day's stack) occasionally
  // comes back from the gateway with a truncated / empty body
  // ("Unexpected end of JSON input"), a 5xx, or a dropped connection. Those
  // are transient, so retry a few times with backoff before giving up. A
  // genuine timeout (the abort signal fired) is NOT retried — re-running a
  // multi-minute call several times would be pathological.
  //
  // The gateway can also cut a response mid-stream (finish_reason null, no
  // tool call, or truncated tool-call JSON) — observed live 2026-06-11. A
  // bad RESPONSE is therefore retried exactly like a bad CONNECTION — only
  // a clean, schema-valid tool call breaks the loop.
  const MAX_TRIES = 5;
  let parsedGroups: z.infer<typeof GroupArgsSchema> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        {
          model: MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_INSTRUCTION },
            { role: "user", content: userContent },
          ],
          tools: [groupTool],
          tool_choice: { type: "function", function: { name: "group_documents" } },
        },
        { signal: AbortSignal.timeout(GROUP_TIMEOUT_MS) },
      );
    } catch (err) {
      lastErr = err;
      const e = err as { name?: string; message?: string };
      const aborted =
        /abort|timed?\s*out|timeout/i.test(e?.message ?? "") ||
        ["APIUserAbortError", "APIConnectionTimeoutError", "AbortError", "TimeoutError"].includes(e?.name ?? "");
      if (aborted) {
        throw new Error(
          `Document grouping timed out after ${Math.round(GROUP_TIMEOUT_MS / 1000)}s. ` +
            "Re-send the batch, ideally with clearer photos.",
        );
      }
      if (attempt < MAX_TRIES) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      throw err;
    }

    // `choices` itself can be ABSENT on an error-shaped 200 body — same
    // transient class as a truncated stream, so it rides the same retry.
    const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function.name !== "group_documents") {
      lastErr = new Error(
        `Grouping model did not call group_documents (attempt ${attempt}/${MAX_TRIES}, ` +
          `finish=${completion.choices?.[0]?.finish_reason ?? "null"}).`,
      );
    } else {
      try {
        const rawArgs: unknown = JSON.parse(toolCall.function.arguments);
        const result = GroupArgsSchema.safeParse(rawArgs);
        if (result.success) {
          parsedGroups = result.data;
          break;
        }
        lastErr = new Error(`Grouping output failed schema validation:\n${result.error.toString()}`);
      } catch (err) {
        lastErr = new Error(
          `Grouping tool arguments were not valid JSON (attempt ${attempt}/${MAX_TRIES}):\n` +
            `${toolCall.function.arguments.slice(0, 500)}\n\n${(err as Error).message}`,
        );
      }
    }
    if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  if (!parsedGroups) throw lastErr ?? new Error("Grouping returned no response.");
  const parsed = { data: parsedGroups };

  // Normalise: 1-based → 0-based, drop out-of-range, and enforce that no
  // image lands in two DIFFERENT shipments. Images the model deliberately
  // omitted (duplicates) simply never appear here — that is the dedup.
  //
  // Two intentional exceptions to global dedup:
  //   • a combined photo may be BOTH this group's AWB and its invoice;
  //   • if a group ends up with an AWB but no invoice (a lone combined photo),
  //     we reuse the AWB image as the invoice so it still forms a valid pair
  //     rather than an "incomplete grouping" error.
  const n = images.length;
  const claimed = new Set<number>();
  const valid = (oneBased: number): number | null => {
    const idx = oneBased - 1;
    return Number.isInteger(idx) && idx >= 0 && idx < n ? idx : null;
  };

  const groups: DocumentGroup[] = [];
  for (const g of parsed.data.groups) {
    let awbIndex = valid(g.awb_image);
    if (awbIndex !== null && claimed.has(awbIndex)) awbIndex = null;
    if (awbIndex !== null) claimed.add(awbIndex);

    const invoiceIndices: number[] = [];
    for (const oneBased of g.invoice_images) {
      const idx = valid(oneBased);
      if (idx === null) continue;
      // Same image as this group's AWB → combined photo, allow it.
      if (idx === awbIndex) {
        if (!invoiceIndices.includes(idx)) invoiceIndices.push(idx);
        continue;
      }
      // Otherwise an invoice image can't be reused across shipments.
      if (claimed.has(idx)) continue;
      claimed.add(idx);
      invoiceIndices.push(idx);
    }

    // Lone combined photo (AWB shown, no separate invoice image): the same
    // image carries the invoice too.
    if (invoiceIndices.length === 0 && awbIndex !== null) {
      invoiceIndices.push(awbIndex);
    }

    if (awbIndex === null && invoiceIndices.length === 0) continue;
    groups.push({ awbIndex, invoiceIndices });
  }

  return groups;
}

/* ──────────────────────────────────────────────────────────────────────
 * Chunked grouping — one upload, several small model calls.
 *
 * The phone (and the operator's bulk re-runs) send a WHOLE DAY in one
 * POST. Shipments never straddle a photo session: the courier stops the
 * van, photographs one load, drives on. The session timestamp is right
 * in the WhatsApp filename ("… at 08.39.25.jpeg" → session "08.39"), so
 * splitting the stack at session boundaries is free, perfect structure —
 * each grouping call stays in the size range the model handles flawlessly,
 * and the calls run in PARALLEL, so the day groups in the time of the
 * slowest session instead of one fragile mega-call.
 * ────────────────────────────────────────────────────────────────────── */

/** Session key from a WhatsApp-style filename: "… at 08.39.25 (2).jpeg" →
 *  "08.39" (hour.minute — the seconds vary within one photo session).
 *  Null when the name doesn't carry the pattern. */
function sessionKeyOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = /\bat (\d{1,2}\.\d{2})\.\d{2}/.exec(name);
  return m ? m[1]! : null;
}

/** Split n indices into ceil(n/max) parts as even as possible (sizes differ
 *  by at most 1), preserving order. */
function evenSplit(indices: number[], max: number): number[][] {
  if (indices.length <= max) return [indices];
  const parts = Math.ceil(indices.length / max);
  const base = Math.floor(indices.length / parts);
  const extra = indices.length % parts;
  const out: number[][] = [];
  let at = 0;
  for (let p = 0; p < parts; p++) {
    const size = base + (p < extra ? 1 : 0);
    out.push(indices.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * Partition an ordered image stack into grouping chunks (arrays of 0-based
 * indices, order preserved).
 *
 * Rules:
 *   • consecutive images sharing a session key form one chunk;
 *   • an image with NO parseable session rides with the current chunk
 *     (adjacency is the next-best signal we have for it);
 *   • any chunk above `maxChunk` is hard-split into near-even parts, so a
 *     stack of unparseable names degrades to plain fixed-size chunking
 *     instead of recreating the one-giant-call failure.
 *
 * Pure — exported for tests.
 */
export function sessionChunks(
  names: (string | null | undefined)[],
  maxChunk: number = MAX_GROUPING_CHUNK,
): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let currentKey: string | null = null;
  for (let i = 0; i < names.length; i++) {
    const key = sessionKeyOf(names[i]);
    const startsNew = key !== null && currentKey !== null && key !== currentKey;
    if (startsNew && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(i);
    if (key !== null) currentKey = key;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.flatMap((c) => evenSplit(c, Math.max(1, maxChunk)));
}

/**
 * Group a whole day's stack by running `groupImages` once per session
 * chunk, ALL CHUNKS IN PARALLEL, then remapping each chunk's local image
 * indices back onto the full stack. Group shape and ordering match a
 * single `groupImages` call over the same stack.
 *
 * A failed chunk fails the whole batch (same contract as groupImages) —
 * better a loud retryable error than silently missing one van-load.
 */
export async function groupImagesChunked(
  images: ImageInput[],
  names: (string | null | undefined)[] = [],
  opts: { maxChunk?: number } = {},
): Promise<DocumentGroup[]> {
  if (images.length === 0) return [];
  const chunks = sessionChunks(
    images.map((_, i) => names[i] ?? null),
    opts.maxChunk ?? MAX_GROUPING_CHUNK,
  );
  if (chunks.length <= 1) return groupImages(images);

  const perChunk = await Promise.all(
    chunks.map(async (indices) => {
      const subset = indices.map((i) => images[i]!);
      const groups = await groupImages(subset);
      // Chunk-local index → global stack index.
      return groups.map((g) => ({
        awbIndex: g.awbIndex === null ? null : indices[g.awbIndex]!,
        invoiceIndices: g.invoiceIndices.map((idx) => indices[idx]!),
      }));
    }),
  );
  return perChunk.flat();
}

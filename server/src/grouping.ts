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

/** Total wall-clock ceiling for the grouping call (incl. the one retry). */
const GROUP_TIMEOUT_MS = Number(process.env.GROUP_TIMEOUT_MS ?? 120_000);

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
  "Examples (image:type):\n" +
  "  [1:invoice, 2:invoice, 3:AWB, 4:invoice, 5:AWB] → groups: {awb 3, invoices [1,2]}, {awb 5, invoices [4]}.\n" +
  "  [1:AWB, 2:invoice, 3:invoice, 4:AWB, 5:invoice] → groups: {awb 1, invoices [2,3]}, {awb 4, invoices [5]}.\n" +
  "Rules:\n" +
  "  • Use 1-based image numbers exactly as labelled.\n" +
  "  • Assign every image to exactly one group. Do not invent images.\n" +
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
      "group_documents ONCE. Every image number 1.." +
      String(images.length) +
      " must appear in exactly one group.",
  });

  let completion;
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
    throw err;
  }

  const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function.name !== "group_documents") {
    throw new Error(
      `Grouping model did not call group_documents. Got: ${JSON.stringify(completion.choices[0]?.message)}`,
    );
  }

  let rawArgs: unknown;
  try {
    rawArgs = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    throw new Error(`Grouping tool arguments were not valid JSON:\n${toolCall.function.arguments}\n\n${(err as Error).message}`);
  }

  const parsed = GroupArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(`Grouping output failed schema validation:\n${parsed.error.toString()}`);
  }

  // Normalise: 1-based → 0-based, drop out-of-range, dedupe across the
  // whole batch so no image lands in two groups.
  const n = images.length;
  const seen = new Set<number>();
  const inRange = (oneBased: number): number | null => {
    const idx = oneBased - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || seen.has(idx)) return null;
    seen.add(idx);
    return idx;
  };

  const groups: DocumentGroup[] = [];
  for (const g of parsed.data.groups) {
    const awbIndex = inRange(g.awb_image);
    const invoiceIndices = g.invoice_images
      .map(inRange)
      .filter((x): x is number => x !== null);
    if (awbIndex === null && invoiceIndices.length === 0) continue;
    groups.push({ awbIndex, invoiceIndices });
  }

  return groups;
}

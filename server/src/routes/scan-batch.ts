/**
 * POST /scan-batch — the phone scanner's one-shot upload.
 *
 * The phone captures a stack of photos covering SEVERAL shipments and
 * sends them all at once, in scan order. This endpoint is fire-and-forget
 * by design (the phone shows only "Sent ✓", never results):
 *
 *   1. Buffer every uploaded image, preserving order.
 *   2. Return 202 Accepted IMMEDIATELY with a batch id + image count.
 *      The phone is done at this point.
 *   3. In the BACKGROUND: group the images into pairs (grouping.ts),
 *      then run each pair through the shared extract + price pipeline
 *      (pipeline.ts) in parallel, persisting each as a pair so it shows
 *      up in the desktop app exactly like a hand-added one. Product
 *      verification (Leroy Merlin) runs after pricing when configured.
 *
 * Nothing here blocks the phone, and every downstream step reuses the
 * code the desktop flow already exercises.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { ImageInput } from "../gemini.js";
import { groupImages, type DocumentGroup } from "../grouping.js";
import { extractAndPrice } from "../pipeline.js";
import { verifyShipment } from "../verify.js";
import { scrapingdogConfigured } from "../scrapingdog.js";
import { insertPair, persistPairStatus, signalExtracting } from "../db.js";

const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Hard cap on a single batch upload. A courier's daily stack is well
 *  under this; the ceiling just stops a runaway upload from blowing the
 *  grouping call's token budget. Override with MAX_BATCH_IMAGES. */
const MAX_BATCH_IMAGES = Number(process.env.MAX_BATCH_IMAGES ?? 120);

/** How many pairs to extract+price+verify at once in the background.
 *  Keeps us from firing 12 multi-image vision calls at OpenRouter in the
 *  same instant. Override with SCAN_BATCH_CONCURRENCY. */
const BATCH_CONCURRENCY = Number(process.env.SCAN_BATCH_CONCURRENCY ?? 100);

/** One buffered upload: bytes for storage + the slim view the AI needs. */
interface BatchImage {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** Today's filing day in the operator's timezone (YYYY-MM-DD). en-CA
 *  formats as ISO, which is exactly the `day` bucket the queue uses. */
function todayBucket(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.CENTRALIZATOR_TZ ?? "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Run async `fn` over `items` with a fixed concurrency ceiling. */
async function runPool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]!, i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
}

/**
 * Process one grouped pair end to end: insert it (pending) so it appears
 * immediately, then extract + price, then verify. Each pair is isolated —
 * a failure on one becomes that pair's "error" status and never touches
 * the others.
 */
async function processGroup(group: DocumentGroup, all: BatchImage[], day: string, log: FastifyBaseLogger): Promise<void> {
  const id = randomUUID();

  // Order the stored images AWB-first, then invoices in scan order — the
  // same convention the desktop app uses, so the detail view reads right.
  const awb = group.awbIndex !== null ? all[group.awbIndex] : undefined;
  const invoices = group.invoiceIndices.map((i) => all[i]!).filter(Boolean);
  const ordered: BatchImage[] = [...(awb ? [awb] : []), ...invoices];

  insertPair({
    id,
    day,
    images: ordered.map((img) => ({
      name: img.name,
      mimeType: img.mimeType,
      size: img.bytes.length,
      bytes: img.bytes,
    })),
  });

  // A pair needs one AWB + at least one invoice to extract. Anything less
  // is a grouping gap — record it as an error pair the operator can see.
  if (!awb || invoices.length === 0) {
    persistPairStatus(id, {
      kind: "error",
      message: "Grupare incompletă: lipsește AWB-ul sau factura. Verifică pozele.",
    });
    return;
  }

  const aiImages: ImageInput[] = ordered.map((img) => ({ data: img.bytes, mimeType: img.mimeType }));

  // Live: flip the desktop row to its "se procesează" spinner while the
  // vision call is in flight. Emit-only (never persisted) — see db.ts.
  signalExtracting(id);

  try {
    const { extracted, resolvedService, serviceFallback, breakdown, routing } = await extractAndPrice(aiImages);
    persistPairStatus(id, {
      kind: "ready",
      service: resolvedService,
      serviceFallback,
      edits: extracted,
      breakdown,
      store: routing.store,
      routing,
    });

    // Product cross-check — best effort, never fails the pair.
    if (scrapingdogConfigured()) {
      try {
        const verification = await verifyShipment(extracted);
        persistPairStatus(id, {
          kind: "ready",
          service: resolvedService,
          serviceFallback,
          edits: extracted,
          breakdown,
          store: routing.store,
          routing,
          verification,
        });
      } catch (err) {
        log.warn({ err, pair: id }, "scan-batch: verification failed (kept pair without it)");
      }
    }
  } catch (err) {
    log.error({ err, pair: id }, "scan-batch: extract/price failed");
    persistPairStatus(id, { kind: "error", message: (err as Error).message });
  }
}

/** The background job: group, then fan the groups out to the pipeline. */
async function processBatch(batchId: string, images: BatchImage[], day: string, log: FastifyBaseLogger): Promise<void> {
  try {
    const aiImages: ImageInput[] = images.map((img) => ({ data: img.bytes, mimeType: img.mimeType }));
    const groups = await groupImages(aiImages);
    log.info({ batchId, images: images.length, groups: groups.length }, "scan-batch: grouped");

    if (groups.length === 0) {
      log.warn({ batchId }, "scan-batch: grouping produced no groups");
      return;
    }
    await runPool(groups, BATCH_CONCURRENCY, (g) => processGroup(g, images, day, log));
    log.info({ batchId }, "scan-batch: done");
  } catch (err) {
    log.error({ err, batchId }, "scan-batch: grouping failed — no pairs created");
  }
}

export default async function scanBatchRoutes(app: FastifyInstance) {
  app.post("/scan-batch", async (req, reply) => {
    const images: BatchImage[] = [];

    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const mimeType = part.mimetype.toLowerCase();
      if (!ACCEPTED_MIME.has(mimeType)) {
        return reply.code(415).send({ error: `Unsupported MIME type: ${mimeType}` });
      }
      const bytes = await part.toBuffer();
      images.push({ name: part.filename || `scan-${images.length + 1}`, mimeType, bytes });
      if (images.length > MAX_BATCH_IMAGES) {
        return reply.code(413).send({ error: `Too many images: cap is ${MAX_BATCH_IMAGES} per batch.` });
      }
    }

    if (images.length < 2) {
      return reply.code(400).send({
        error: "Send at least TWO images (the batch must contain at least one AWB and one invoice).",
      });
    }

    const batchId = randomUUID();
    const day = todayBucket();

    // Fire-and-forget: kick off the background job and answer the phone
    // right away. `void` documents that we intentionally don't await it.
    void processBatch(batchId, images, day, app.log);

    return reply.code(202).send({ batchId, imageCount: images.length, status: "processing" });
  });
}

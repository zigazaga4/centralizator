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
import { classifyImages } from "../classify.js";
import { linkDocuments, type DocInfo, type DocumentGroup } from "../linker.js";
import { dedupeByDhash } from "../dhash.js";
import { assembleExtracted, priceExtracted } from "../pipeline.js";
import { verifyShipment } from "../verify.js";
import { scrapingdogConfigured } from "../scrapingdog.js";
import { insertPair, persistPairStatus, signalExtracting, type UnpairedDocType } from "../db.js";
import { COLLABORATORS, type Collaborator } from "../tariffs.js";

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
async function processGroup(
  group: DocumentGroup,
  all: BatchImage[],
  docs: DocInfo[],
  day: string,
  collaborator: Collaborator | null,
  log: FastifyBaseLogger,
): Promise<void> {
  const id = randomUUID();

  // Order the stored images AWB-first, then invoices in scan order — the
  // same convention the desktop app uses, so the detail view reads right.
  // A combined photo (label clipped onto its own invoice) appears in the
  // group as BOTH halves (awbIndex inside invoiceIndices) but is ONE
  // photo — store it exactly once, never duplicated.
  const awb = group.awbIndex !== null ? all[group.awbIndex] : undefined;
  const selfPaired = group.awbIndex !== null && group.invoiceIndices.includes(group.awbIndex);
  const invoices = group.invoiceIndices
    .filter((i) => i !== group.awbIndex)
    .map((i) => all[i]!)
    .filter(Boolean);
  const ordered: BatchImage[] = [...(awb ? [awb] : []), ...invoices];

  // The linker guarantees only VALID pairs: an AWB plus ≥1 invoice —
  // possibly the SAME photo for a combined document. If that contract
  // ever breaks, skip — the app shows pairs, never fragments.
  if (!awb || (invoices.length === 0 && !selfPaired)) {
    log.warn({ group }, "scan-batch: linker emitted a non-pair — skipped (contract violation)");
    return;
  }

  insertPair({
    id,
    day,
    // The whole batch belongs to ONE collaborator — the courier picked it
    // in the scan flow, so every pair the batch produces inherits it.
    collaborator,
    images: ordered.map((img) => ({
      name: img.name,
      mimeType: img.mimeType,
      size: img.bytes.length,
      bytes: img.bytes,
    })),
  });

  // Live: flip the desktop row to its "se procesează" spinner while the
  // routing/pricing run. Emit-only (never persisted) — see db.ts.
  signalExtracting(id);

  try {
    // No second vision pass: the per-image readings already carry every
    // field. Assemble them into the pair's data and price it.
    const anchorDoc = group.awbIndex !== null ? docs[group.awbIndex] : undefined;
    const invoiceRaws = group.invoiceIndices
      .map((i) => docs[i]?.invoiceRaw)
      .filter((r): r is Record<string, unknown> => r != null);
    const assembled = assembleExtracted(anchorDoc?.awbRaw ?? null, invoiceRaws, day);
    const { extracted, resolvedService, serviceFallback, breakdown, routing } = await priceExtracted(assembled, day);
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

/** The background job: dedup, group, then fan the groups out to the pipeline. */
async function processBatch(
  batchId: string,
  allImages: BatchImage[],
  day: string,
  collaborator: Collaborator | null,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    // Perceptual dedup FIRST: the couriers re-shoot and re-send the same
    // photo; dHash drops near-identical copies deterministically so the
    // grouping model never sees them (and can never anchor a phantom
    // second group on a duplicate). Order is preserved.
    const { keptIndices, duplicates } = await dedupeByDhash(allImages.map((img) => img.bytes));
    if (duplicates.length > 0) {
      log.info(
        {
          batchId,
          dropped: duplicates.map((d) => ({
            name: allImages[d.index]!.name,
            duplicateOf: allImages[d.ofIndex]!.name,
            distance: d.distance,
          })),
        },
        "scan-batch: dHash dedup dropped near-duplicate photos",
      );
    }
    const images = keptIndices.map((i) => allImages[i]!);

    const aiImages: ImageInput[] = images.map((img) => ({ data: img.bytes, mimeType: img.mimeType }));
    // Classify-and-join: one tiny AI read per image (all in parallel —
    // volume-proof, no mega-call to overflow, no filenames to trust),
    // then deterministic code links the readings into shipments.
    const docs = await classifyImages(aiImages);
    // One compact line per image — the linker's entire input, so any
    // mis-grouping can be diagnosed from the log without re-running.
    log.info(
      {
        batchId,
        readings: docs.map((d) => ({
          name: images[d.index]!.name,
          type: d.type,
          awb: d.awbNumber,
          sure: d.awbConfident,
          extra: d.extraAwbNumbers.length > 0 ? d.extraAwbNumbers : undefined,
          who: d.recipientName,
        })),
      },
      "scan-batch: classified",
    );
    const { groups, droppedAnchors, droppedJunk, unpaired } = linkDocuments(docs);
    if (droppedJunk.length > 0) {
      log.info(
        { batchId, junk: droppedJunk.map((i) => images[i]!.name) },
        "scan-batch: dropped junk images (identify nothing — stray pile sheets)",
      );
    }
    // Documents the linker could not pair by name/address are NOT guessed
    // and NOT hidden: each becomes a visible "unpaired" row in the day so
    // a human resolves it (by command).
    if (unpaired.length > 0) {
      log.info(
        { batchId, unpaired: unpaired.map((i) => images[i]!.name) },
        "scan-batch: unpaired documents — shown in the app for manual pairing",
      );
      for (const i of unpaired) {
        const img = images[i]!;
        const d = docs[i];
        const docType: UnpairedDocType =
          d?.type === "invoice" ? "invoice" : d?.type === "unknown" || !d ? "unknown" : "awb";
        insertPair({
          id: randomUUID(),
          day,
          // Orphans keep the batch's collaborator too — when a human
          // manually pairs them later, the new pair inherits it.
          collaborator,
          status: { kind: "unpaired", docType },
          images: [{ name: img.name, mimeType: img.mimeType, size: img.bytes.length, bytes: img.bytes }],
        });
      }
    }
    if (droppedAnchors.length > 0) {
      log.info(
        {
          batchId,
          dropped: droppedAnchors.map((d) => ({
            name: images[d.index]!.name,
            duplicateOf: images[d.ofIndex]!.name,
            reason: d.reason,
          })),
        },
        "scan-batch: linker folded duplicate AWB photos",
      );
    }
    log.info({ batchId, images: images.length, groups: groups.length }, "scan-batch: linked");

    if (groups.length === 0) {
      log.warn({ batchId }, "scan-batch: grouping produced no groups");
      return;
    }
    await runPool(groups, BATCH_CONCURRENCY, (g) => processGroup(g, images, docs, day, collaborator, log));
    log.info({ batchId }, "scan-batch: done");
  } catch (err) {
    log.error({ err, batchId }, "scan-batch: grouping failed — no pairs created");
  }
}

export default async function scanBatchRoutes(app: FastifyInstance) {
  app.post("/scan-batch", async (req, reply) => {
    const images: BatchImage[] = [];
    // Optional `day` form field (ISO YYYY-MM-DD): the desktop app sends
    // the day tab the user dropped onto, so a drop on "tomorrow" files
    // under tomorrow. The phone never sends it → today's bucket.
    let requestedDay: string | null = null;
    // Optional `collaborator` form field: the partner the user picked in
    // the upload flow (phone modal / desktop modal). Validated against
    // the canonical roster; anything else (including "direct") → null.
    let collaborator: Collaborator | null = null;

    for await (const part of req.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "day" && typeof part.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(part.value)) {
          requestedDay = part.value;
        }
        if (
          part.fieldname === "collaborator" &&
          typeof part.value === "string" &&
          (COLLABORATORS as readonly string[]).includes(part.value)
        ) {
          collaborator = part.value as Collaborator;
        }
        continue;
      }
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

    // ONE image is a valid batch: a combined photo (label clipped onto
    // its invoice) is a complete shipment by itself, and a lone label or
    // invoice correctly surfaces as an unpaired row for manual pairing.
    if (images.length < 1) {
      return reply.code(400).send({ error: "Send at least one image." });
    }

    const batchId = randomUUID();
    const day = requestedDay ?? todayBucket();

    // Fire-and-forget: kick off the background job and answer the phone
    // right away. `void` documents that we intentionally don't await it.
    void processBatch(batchId, images, day, collaborator, app.log);

    return reply.code(202).send({ batchId, imageCount: images.length, status: "processing" });
  });
}

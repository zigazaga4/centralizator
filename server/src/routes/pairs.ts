/**
 * /pairs — REST surface over the SQLite pair queue.
 *
 * The Tauri client used to own the SQLite DB through `tauri-plugin-sql`,
 * which meant every queue mutation went straight to disk in the
 * WebView's host process. We moved storage to the server so the UI no
 * longer needs an OS-level DB plugin, and any future client (a phone
 * companion, a second Tauri window, a quick-look web view) talks to
 * the same authoritative queue without bolting another SQLite handle
 * onto it.
 *
 * Wire format: JSON with images carried as base64 strings. Two reasons:
 *   • base64 is JSON-friendly (no multipart parsing on every PATCH /
 *     hydrate), and the queue is small enough that the ~33% size tax
 *     is invisible against the network's actual bottleneck.
 *   • the client (browser File ↔ Uint8Array) already speaks base64,
 *     so the encode/decode happens at the natural boundary rather
 *     than splattering across the stack.
 *
 * Endpoints:
 *   GET    /pairs                — list (with images), insertion order.
 *   POST   /pairs                — insert a new pair (id, day, images).
 *   PUT    /pairs/:id/status     — replace the status (ready | error |
 *                                  pending; "extracting" is a no-op).
 *   DELETE /pairs/:id            — drop a single pair (images cascade).
 *   DELETE /pairs                — clear the entire queue.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deleteAllPairs,
  deletePair,
  insertPair,
  listAllPairs,
  persistPairStatus,
  type PairStatus,
} from "../db.js";
import { ExtractedSchema } from "../schema.js";

/* ──────────────────────────────────────────────────────────────────────
 * Request schemas
 *
 * Zod gives us two wins here: (1) precise 400s with the exact bad
 * field, instead of a TypeError 200ms later in db.ts; (2) the inferred
 * types double as the contract the route handler reads from. We keep
 * these mirrored to the client's `Pair` shape but loose around the
 * edges (the client may send extra fields on a future iteration).
 * ────────────────────────────────────────────────────────────────────── */

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ImageWireSchema = z.object({
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  dataB64: z.string().min(1),
});

const NewPairSchema = z.object({
  id: z.string().min(1),
  day: isoDay,
  images: z.array(ImageWireSchema).min(1).max(4),
});

/**
 * Inbound status shape. Mirrors the server's internal `PairStatus`
 * discriminated union; we re-validate `edits` against the canonical
 * `ExtractedSchema` so a malformed UI edit can't poison the DB.
 *
 * "extracting" is accepted here for symmetry with the client model —
 * `persistPairStatus` silently no-ops on it.
 */
const PricingBreakdownSchema = z
  .object({
    weightBucket: z.string(),
    distanceBucket: z.string(),
    baseKey: z.string(),
    incrementKey: z.string(),
    extraKm: z.number(),
    weekend: z.boolean(),
    baseTariff: z.number(),
    extraKmCost: z.number(),
    incrementTariff: z.number(),
    incrementCost: z.number(),
    weekendSurcharge: z.number(),
    totalVat19: z.number(),
    net: z.number(),
    vat21: z.number(),
    totalVat21: z.number(),
  })
  .passthrough(); // tolerate forward-compatible additions

const StatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("extracting") }),
  z.object({
    kind: z.literal("ready"),
    service: z.enum(["Express", "Premium", "Prestabilita"]),
    serviceFallback: z.boolean(),
    edits: ExtractedSchema,
    breakdown: PricingBreakdownSchema,
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export default async function pairRoutes(app: FastifyInstance) {
  /* ── List ─────────────────────────────────────────────────────── */
  app.get("/pairs", async () => {
    const pairs = listAllPairs();
    return { pairs };
  });

  /* ── Create ───────────────────────────────────────────────────── */
  app.post("/pairs", async (req, reply) => {
    const parsed = NewPairSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    // Decode base64 once at the boundary. From here on the bytes are
    // real `Buffer`s — what better-sqlite3 wants for BLOB binding.
    const images = parsed.data.images.map((img) => ({
      name: img.name,
      mimeType: img.mimeType,
      size: img.size,
      bytes: Buffer.from(img.dataB64, "base64"),
    }));

    try {
      const pair = insertPair({
        id: parsed.data.id,
        day: parsed.data.day,
        images,
      });
      return reply.code(201).send({ pair });
    } catch (err) {
      // The only realistic failure path here is a duplicate id (PK
      // collision) — surface as 409 so the client can retry with a
      // fresh uuid instead of treating it as a transport error.
      const msg = (err as Error).message;
      if (/UNIQUE constraint/i.test(msg)) {
        return reply.code(409).send({ error: msg });
      }
      req.log.error({ err }, "insertPair failed");
      return reply.code(500).send({ error: msg });
    }
  });

  /* ── Status transition ────────────────────────────────────────── */
  app.put<{ Params: { id: string } }>("/pairs/:id/status", async (req, reply) => {
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    const ok = persistPairStatus(req.params.id, parsed.data as PairStatus);
    if (!ok) return reply.code(404).send({ error: `No pair ${req.params.id}.` });
    return reply.code(204).send();
  });

  /* ── Delete one ───────────────────────────────────────────────── */
  app.delete<{ Params: { id: string } }>("/pairs/:id", async (req, reply) => {
    const ok = deletePair(req.params.id);
    if (!ok) return reply.code(404).send({ error: `No pair ${req.params.id}.` });
    return reply.code(204).send();
  });

  /* ── Clear all ────────────────────────────────────────────────── */
  app.delete("/pairs", async (_req, reply) => {
    const removed = deleteAllPairs();
    return reply.send({ removed });
  });
}

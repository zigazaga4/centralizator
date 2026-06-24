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
 * Wire format: uploads (POST) carry images as base64 in JSON — the
 * client already speaks File ↔ base64 and one insert is small. The
 * READ side is split in two: the list returns image metadata only
 * (the table paints instantly), and each image's raw bytes stream
 * from their own immutable, cacheable GET.
 *
 * Endpoints:
 *   GET    /pairs                — light list (image metadata, no bytes).
 *   GET    /pairs/:id/images/:slot — one image, raw bytes, immutable cache.
 *   POST   /pairs                — insert a new pair (id, day, images).
 *   PUT    /pairs/:id/status     — replace the status (ready | error |
 *                                  pending; "extracting" is a no-op).
 *   DELETE /pairs/:id            — drop a single pair (images cascade).
 *   DELETE /pairs                — clear the entire queue.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deleteAllPairs,
  deletePair,
  deletePairsByDay,
  detachInvoiceImage,
  getPair,
  getPairImage,
  insertPair,
  listAllPairsLight,
  persistPairStatus,
  type PairStatus,
} from "../db.js";
import { suggestPairs, SUGGEST_MAX_IMAGES } from "../classify.js";
import { COLLABORATORS, type Collaborator } from "../tariffs.js";
import { ExtractedSchema, VerificationSchema, RoutingSchema, StoreKeySchema } from "../schema.js";
import type { Extracted, Routing } from "../schema.js";
import { buildPricingInput } from "../pipeline.js";
import { calculatePrice } from "../pricing.js";
import { verifyShipment } from "../verify.js";
import { scrapingdogConfigured } from "../scrapingdog.js";
import { STORES } from "../stores.js";
import {
  geocode,
  mapboxConfigured,
  shortestDrivingRoute,
  staticRouteMapUrl,
  type LngLat,
} from "../mapbox.js";

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

/**
 * Image cap matches `MAX_IMAGES` in routes/extract.ts: 1 AWB + up to
 * 11 invoices. `min(2)` is the floor because a pair without an
 * invoice makes no sense (the model needs one AWB and at least one
 * invoice to produce a valid Extracted struct).
 */
const NewPairSchema = z.object({
  id: z.string().min(1),
  day: isoDay,
  /** Upload-time collaborator assignment. The manual-pairing flow sends
   *  the orphan docs' inherited collaborator; omitted/null = direct. */
  collaborator: z
    .enum(COLLABORATORS as readonly [Collaborator, ...Collaborator[]])
    .nullable()
    .optional(),
  images: z.array(ImageWireSchema).min(2).max(12),
});

/**
 * Inbound status shape. Mirrors the server's internal `PairStatus`
 * discriminated union; we re-validate `edits` against the canonical
 * `ExtractedSchema` so a malformed UI edit can't poison the DB.
 *
 * "extracting" is accepted here for symmetry with the client model —
 * `persistPairStatus` silently no-ops on it.
 */
/**
 * Per-dispatch-site customer total. Mirrors `CityCommission` from
 * pricing.ts — the carrier subtotal grossed up by the city's
 * commission rate.
 */
const CityCommissionRowSchema = z.object({
  pct: z.number(),
  commission: z.number(),
  customerTotal: z.number(),
});

/**
 * Per-collaborator payout. Mirrors `CollaboratorPrice` from pricing.ts
 * — the carrier subtotal grossed up by the collaborator's bonus rate.
 */
const CollaboratorPriceRowSchema = z.object({
  pct: z.number(),
  bonus: z.number(),
  total: z.number(),
});

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
    carrierTotal: z.number(),
    /** All-in comparable total (carrier + unloading + macara). Optional so an
     *  older client that doesn't send it still validates; .passthrough()
     *  preserves it on round-trips either way. */
    grandTotal: z.number().optional(),
    /**
     * Per-dispatch-site customer totals. Four entries (Ploiești,
     * Iași Tudor, Iași ERA, Constanța) generated by the pricing
     * engine. `z.record` validates each entry against the row schema
     * without locking the key set — keeps it forward-compatible if a
     * fifth dispatch site is ever added.
     */
    cityCommissions: z.record(CityCommissionRowSchema),
    /**
     * Per-collaborator payouts. Five entries (Stalexone, EMV, Bitlo,
     * VicDinamicExpert, Tiberiu) — same forward-compatible posture
     * as cityCommissions above.
     */
    collaboratorPrices: z.record(CollaboratorPriceRowSchema),
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
    // Origin store (centralizator bucket) + how the distance was routed.
    // Optional so an older client that doesn't send them still persists.
    store: StoreKeySchema.nullable().optional(),
    routing: RoutingSchema.optional(),
    // Optional: arrives on a second persist after the Leroy Merlin
    // cross-check completes (the price persist has no verification yet).
    verification: VerificationSchema.optional(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

export default async function pairRoutes(app: FastifyInstance) {
  /* ── List (light) ─────────────────────────────────────────────── */
  // Image METADATA only. The old shape inlined every image as base64,
  // which grew the hydrate payload to ~26 MB and made the app stare at
  // a blank screen for the whole transfer. Now the table paints from a
  // few hundred KB of JSON and the client streams each image it needs
  // from the endpoint below.
  app.get("/pairs", async () => {
    const pairs = listAllPairsLight();
    return { pairs };
  });

  /* ── One image, raw bytes ─────────────────────────────────────── */
  // Lazy-fetch companion to the light list. Images are immutable per
  // (pair, slot) — written once at POST /pairs, never updated — so we
  // mark them `immutable` with a year-long max-age plus an ETag. The
  // WebView's HTTP cache (and the client's Cache Storage layer) then
  // serves repeat opens from disk without touching the network.
  app.get<{ Params: { id: string; slot: string } }>(
    "/pairs/:id/images/:slot",
    async (req, reply) => {
      const slot = Number(req.params.slot);
      if (!Number.isInteger(slot) || slot < 0) {
        return reply.code(400).send({ error: `Bad slot "${req.params.slot}".` });
      }
      const img = getPairImage(req.params.id, slot);
      if (!img) {
        return reply.code(404).send({ error: `No image ${req.params.id}/${slot}.` });
      }
      const etag = `"${req.params.id}-${slot}-${img.size}"`;
      if (req.headers["if-none-match"] === etag) {
        return reply.code(304).header("etag", etag).send();
      }
      return reply
        .header("content-type", img.mimeType || "application/octet-stream")
        .header("content-length", img.bytes.length)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("etag", etag)
        .header("x-image-name", encodeURIComponent(img.name))
        .send(img.bytes);
    },
  );

  /* ── Route map (store → delivery) ─────────────────────────────── */
  // A static Mapbox image of the routed road between the origin store and
  // the geocoded delivery point — what the operator opens from a km warning
  // to SEE the route the Mapbox km came from. The image is fetched
  // server-side and proxied as raw bytes so MAPBOX_TOKEN never reaches the
  // client. Prefers the dest point persisted at routing time (the exact
  // point the km was measured to); older pairs re-geocode the same address.
  app.get<{ Params: { id: string } }>("/pairs/:id/route-map", async (req, reply) => {
    const pair = getPair(req.params.id);
    if (!pair) return reply.code(404).send({ error: `No pair ${req.params.id}.` });
    if (pair.status.kind !== "ready") {
      return reply.code(422).send({ error: "Perechea nu este procesată încă." });
    }
    if (!mapboxConfigured()) {
      return reply.code(422).send({ error: "Mapbox neconfigurat pe server." });
    }
    const routing = pair.status.routing as Routing | undefined;
    const store = routing?.store ?? pair.status.store ?? null;
    if (!routing || !store) {
      return reply.code(422).send({ error: "Fără magazin de origine — nu se poate desena ruta." });
    }
    const origin: LngLat = { lng: STORES[store].lng, lat: STORES[store].lat };

    let dest: LngLat | null =
      routing.destLng != null && routing.destLat != null
        ? { lng: routing.destLng, lat: routing.destLat }
        : null;
    if (!dest && routing.deliveryAddress) {
      const g = await geocode(routing.deliveryAddress, { proximity: origin }).catch(() => null);
      if (g) dest = { lng: g.lng, lat: g.lat };
    }
    if (!dest) {
      return reply.code(422).send({ error: "Adresa de livrare nu a putut fi localizată." });
    }

    // Best effort on the polyline — markers alone still show the two ends.
    const route = await shortestDrivingRoute(origin, dest, { geometry: true }).catch(() => null);
    const url = staticRouteMapUrl(origin, dest, route?.polyline ?? null);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      req.log.error({ status: res.status }, "Mapbox static map fetch failed");
      return reply.code(502).send({ error: `Mapbox static map failed (${res.status}).` });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return reply
      .header("content-type", res.headers.get("content-type") ?? "image/png")
      .header("content-length", bytes.length)
      // Short private cache: the underlying routing can be refreshed.
      .header("cache-control", "private, max-age=300")
      .send(bytes);
  });

  /* ── AI pair suggestions over the unpaired pool ───────────────── */
  // The "Împerechere AI" button in the unpaired modal. Takes the ids of
  // the day's orphan rows, ships ALL their photos to the model in ONE
  // call and returns its pairing PROPOSALS — pure read, nothing is
  // created or deleted here. The operator rearranges the groups by
  // drag-and-drop and only the separate "send to OCR" step turns them
  // into real pairs (through the existing manual-pairing flow).
  app.post("/pairs/suggest", async (req, reply) => {
    const parsed = z
      .object({ ids: z.array(z.string().min(1)).min(2).max(SUGGEST_MAX_IMAGES) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }

    // Resolve each id to its single orphan photo. Rows that vanished or
    // are not unpaired (raced a delete / a manual pairing) are skipped —
    // the suggestion runs over whatever is still standing.
    const entries: Array<{ id: string; bytes: Buffer; mimeType: string }> = [];
    for (const id of parsed.data.ids) {
      const pair = getPair(id);
      if (!pair || pair.status.kind !== "unpaired") continue;
      const img = getPairImage(id, 0);
      if (!img) continue;
      entries.push({ id, bytes: img.bytes, mimeType: img.mimeType });
    }
    if (entries.length < 2) {
      return reply.code(422).send({
        error: "Mai puțin de două documente fără pereche valide — nu există ce împerechea.",
      });
    }

    try {
      const raw = await suggestPairs(
        entries.map((e) => ({ data: e.bytes, mimeType: e.mimeType })),
      );
      // Pool indices → pair ids: the wire shape the modal works with.
      const suggestions = raw.map((s) => ({
        awbId: entries[s.awbIndex]!.id,
        invoiceIds: s.invoiceIndices.map((i) => entries[i]!.id),
        evidence: s.evidence,
      }));
      req.log.info(
        { poolIds: entries.map((e) => e.id), suggestions },
        "pairs/suggest: AI proposals",
      );
      return reply.send({ suggestions });
    } catch (err) {
      req.log.error({ err }, "pairs/suggest failed");
      return reply.code(502).send({
        error: "AI-ul nu a putut sugera perechi acum — încearcă din nou.",
      });
    }
  });

  /* ── Detach a wrongly-matched invoice → back to the unpaired pool ─ */
  // The linker pairs invoices to an AWB by the recipient name/address on the
  // paper. When the operator disagrees with a match, this pulls ONE invoice
  // out of a ready pair: it becomes its own "unpaired" document (so it can be
  // re-paired later), and the source pair is re-priced + re-verified without
  // it. Pricing DOES depend on the invoices (macara / descărcare / voluminos
  // aggregate across them), so the re-price is mandatory, not cosmetic.
  app.post<{ Params: { id: string } }>("/pairs/:id/detach-invoice", async (req, reply) => {
    const parsed = z.object({ invoiceIndex: z.number().int().nonnegative() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.toString() });
    }
    const { invoiceIndex } = parsed.data;

    const pair = getPair(req.params.id);
    if (!pair) return reply.code(404).send({ error: `No pair ${req.params.id}.` });
    if (pair.status.kind !== "ready") {
      return reply.code(422).send({ error: "Doar perechile calculate au facturi de scos." });
    }
    const status = pair.status;
    const invoices = status.edits.invoices;
    if (invoices.length === 0) {
      return reply.code(422).send({ error: "Perechea nu are facturi." });
    }
    if (invoiceIndex >= invoices.length) {
      return reply.code(422).send({ error: `Index factură invalid (${invoiceIndex}).` });
    }

    // 1) Pull the invoice's image out (move when cleanly mapped, else copy).
    const detached = detachInvoiceImage(req.params.id, invoiceIndex, invoices.length);
    if (!detached) {
      return reply.code(422).send({ error: "Perechea nu are imagini — nimic de scos." });
    }

    // 2) Stand the pulled invoice up as its own unpaired document so the
    //    operator can re-pair it (or delete it) from the unpaired strip.
    const unpaired = insertPair({
      id: randomUUID(),
      day: pair.day,
      collaborator: pair.collaborator,
      status: { kind: "unpaired", docType: "invoice" },
      images: [
        {
          name: detached.name,
          mimeType: detached.mimeType,
          size: detached.size,
          bytes: detached.bytes,
        },
      ],
    });

    // 3) Re-price the source pair without that invoice. Reuse the already
    //    resolved routing (no new Mapbox call) and carry the macara→normal
    //    override forward so it survives the edit.
    const newExtracted: Extracted = {
      ...status.edits,
      invoices: invoices.filter((_, i) => i !== invoiceIndex),
    };
    const distanceKm = status.routing?.distanceKm ?? newExtracted.awb.distance_extra_km;
    const macaraStore = status.routing?.store ?? status.store ?? null;
    const breakdown = calculatePrice({
      ...buildPricingInput(newExtracted, status.service, {
        distanceKm,
        weekendBasis: pair.day,
        macaraStore,
      }),
      macaraForceNormal: status.breakdown.macara?.forcedNormal ?? false,
    });

    // 4) Re-verify the remaining invoices. The old verification indexed the
    //    now-removed invoice, so it would be stale — recompute when we can,
    //    otherwise drop it rather than show wrong item rows.
    let verification = status.verification;
    if (scrapingdogConfigured()) {
      try {
        verification = await verifyShipment(newExtracted);
      } catch (err) {
        req.log.warn({ err, pair: req.params.id }, "detach-invoice: re-verify failed — dropped stale verification");
        verification = undefined;
      }
    } else {
      verification = undefined;
    }

    persistPairStatus(req.params.id, {
      kind: "ready",
      service: status.service,
      serviceFallback: status.serviceFallback,
      edits: newExtracted,
      breakdown,
      store: status.store,
      routing: status.routing,
      verification,
    });

    req.log.info(
      { pair: req.params.id, invoiceIndex, moved: detached.moved, unpaired: unpaired.id },
      "detach-invoice: invoice sent back to the unpaired pool",
    );
    return reply.send({ pair: getPair(req.params.id), unpaired });
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
        collaborator: parsed.data.collaborator ?? null,
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

  /* ── Clear one filing day (all stores + collaborators + unpaired) ─ */
  app.delete<{ Params: { day: string } }>("/pairs/day/:day", async (req, reply) => {
    const { day } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: `Invalid day '${day}': expected YYYY-MM-DD.` });
    }
    const removed = deletePairsByDay(day);
    return reply.send({ removed });
  });

  /* ── Clear all ────────────────────────────────────────────────── */
  app.delete("/pairs", async (_req, reply) => {
    const removed = deleteAllPairs();
    return reply.send({ removed });
  });
}

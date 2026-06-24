/**
 * Server-side SQLite persistence for the pair queue.
 *
 * Until recently the queue lived in a `tauri-plugin-sql` DB tucked
 * inside the user's OS app-data directory. Moving it to the server
 * gives us four wins:
 *   • single source of truth (the same Node process owns the model
 *     state AND the storage), so a future second client — phone, web,
 *     another Tauri build — talks to the same queue.
 *   • real BLOB storage. `better-sqlite3` binds `Buffer` natively, so
 *     image bytes go in/out as proper SQLite BLOBs. No base64 padding
 *     tax on disk; the wire format with the client still uses base64
 *     for JSON friendliness, but the conversion happens at the route
 *     boundary, not in the storage layer.
 *   • synchronous API. The queue is tiny (dozens of pairs), so the
 *     blocking-IO cost is invisible and the code reads top-to-bottom
 *     instead of async-spaghetti.
 *   • portable backups. The whole DB is a single file under the repo
 *     so `cp centralizator.db backup-2026-06-02.db` and you're done.
 *
 * Storage shape:
 *   • `pairs`        — one row per pair, scalars + two JSON blobs
 *                      (the OCR-extracted struct and the pricing
 *                      breakdown), plus the `day` filing bucket.
 *   • `pair_images`  — N rows per pair (one per attached image, in the
 *                      order the user dropped them), each carrying the
 *                      original image bytes as a real BLOB so thumbnails
 *                      and the detail page survive restart. Conventionally
 *                      one of the slots is the AWB and the rest are
 *                      invoices, but the vision model decides which is
 *                      which from visible content — the DB stays
 *                      agnostic about role-per-slot.
 *
 * The "extracting" status is intentionally NOT persisted: any pair
 * that was mid-flight when the server died comes back as "pending"
 * so the user just hits Calculează again. Persisting "extracting"
 * would leave orphaned spinners forever.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { publishPairEvent } from "./events.js";
import type { Extracted, Verification, Routing, StoreKey } from "./schema.js";
import type { LmProduct } from "./leroymerlin.js";
import type { PricingBreakdown } from "./pricing.js";
import type { Collaborator, Service } from "./tariffs.js";

/* ──────────────────────────────────────────────────────────────────────
 * File location
 *   <repo>/server/src/db.ts → up 2 → <repo>/server/centralizator.db
 *
 * We keep the DB next to the server it serves rather than under the
 * repo root so a `cp -r server/ /backup/` snapshots everything the
 * server owns in one move.
 * ────────────────────────────────────────────────────────────────────── */
const DB_PATH =
  process.env.CENTRALIZATOR_DB_PATH ??
  resolve(import.meta.dirname, "../centralizator.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

/* ──────────────────────────────────────────────────────────────────────
 * Open + tune
 *
 * WAL mode keeps reads non-blocking while a write transaction is in
 * flight — essential once the route layer fans concurrent /pairs GETs
 * over the same handle. `synchronous=NORMAL` trades a microsecond of
 * fsync risk on power loss for a meaningful write-latency win, which
 * is the right call for a working-batch DB (the user can always
 * re-extract).
 * ────────────────────────────────────────────────────────────────────── */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

/* ──────────────────────────────────────────────────────────────────────
 * Migrations
 *
 * Tracked through SQLite's built-in `user_version` pragma so a single
 * integer round-trips the schema epoch. We design the table at its
 * final shape rather than replaying the v1→v2 BLOB-then-base64 saga
 * the Tauri plugin forced on us — that workaround was an artifact of
 * the plugin's broken sqlx binding and has no business on the server,
 * where `better-sqlite3` round-trips `Buffer` natively.
 *
 * Each migration is idempotent against its own version: append a new
 * entry, bump the version, ship.
 * ────────────────────────────────────────────────────────────────────── */
const MIGRATIONS: { version: number; up: string }[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS pairs (
        id               TEXT    PRIMARY KEY,
        day              TEXT    NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        status_kind      TEXT    NOT NULL,
        status_message   TEXT,
        service          TEXT,
        service_fallback INTEGER,
        edits_json       TEXT,
        breakdown_json   TEXT
      );
      CREATE TABLE IF NOT EXISTS pair_images (
        pair_id    TEXT    NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
        slot       INTEGER NOT NULL,
        name       TEXT    NOT NULL,
        mime_type  TEXT    NOT NULL,
        size       INTEGER NOT NULL,
        bytes      BLOB    NOT NULL,
        PRIMARY KEY (pair_id, slot)
      );
      CREATE INDEX IF NOT EXISTS pairs_created_at_idx ON pairs(created_at);
      CREATE INDEX IF NOT EXISTS pairs_day_idx        ON pairs(day);
    `,
  },
  {
    // v2 — Leroy Merlin product verification.
    //   • `pairs.verification_json` stores the cross-check report on a
    //     ready pair so the warning icon survives a reload.
    //   • `lm_products` is a persistent cache keyed by the invoice code:
    //     each unique code is scraped via ScrapingDog at most once (until
    //     its TTL lapses), so repeat products — the common case — cost
    //     zero credits. Negative hits (found=0) are cached too, on a
    //     shorter TTL enforced in the read path.
    version: 2,
    up: `
      ALTER TABLE pairs ADD COLUMN verification_json TEXT;
      CREATE TABLE IF NOT EXISTS lm_products (
        query      TEXT    PRIMARY KEY,
        found      INTEGER NOT NULL,
        url        TEXT,
        name       TEXT,
        brand      TEXT,
        price_buc  REAL,
        weight_kg  REAL,
        area_m2    REAL,
        dims_mm    TEXT,
        fetched_at INTEGER NOT NULL
      );
    `,
  },
  {
    // v3 — origin store + Mapbox-routed distance.
    //   • `pairs.store` is the dispatch store (centralizator bucket) the
    //     pair is filed under, derived from the AWB Expeditor. The desktop
    //     app's top dropdown filters the queue by this column.
    //   • `pairs.routing_json` stores the full Routing report (store source,
    //     Mapbox km vs AWB km, the geocoded delivery address, fallbacks) so
    //     the detail page can show how the distance was determined.
    version: 3,
    up: `
      ALTER TABLE pairs ADD COLUMN store        TEXT;
      ALTER TABLE pairs ADD COLUMN routing_json TEXT;
      CREATE INDEX IF NOT EXISTS pairs_store_idx ON pairs(store);
    `,
  },
  {
    // v4 — per-pair collaborator assignment.
    //   The collaborator is now chosen IN THE UPLOAD FLOW (phone scanner
    //   modal / desktop add-card modal) and stamped on every pair the
    //   batch produces, instead of being a display-only dropdown the
    //   desktop flips after the fact. One of the five Collaborator keys,
    //   or NULL = direct / legacy pair from before this column existed
    //   (legacy pairs show under every collaborator until re-filed).
    version: 4,
    up: `
      ALTER TABLE pairs ADD COLUMN collaborator TEXT;
      CREATE INDEX IF NOT EXISTS pairs_collaborator_idx ON pairs(collaborator);
    `,
  },
  {
    // v5 — per-day weekend override.
    //   The operator can mark a filing day as a "weekend" so every pair
    //   priced under it carries the +11,90 surcharge regardless of the
    //   calendar (a holiday, or a Saturday-rate run filed on a weekday).
    //   One row per forced day; the absence of a row = derive from the date.
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS day_flags (
        day           TEXT    PRIMARY KEY,
        force_weekend INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

/* ──────────────────────────────────────────────────────────────────────
 * Cache TTLs (ms). A found product is stable for a month; a miss is kept
 * far shorter so a code that gets indexed later gets a fresh chance soon.
 * ────────────────────────────────────────────────────────────────────── */
const LM_TTL_FOUND_MS = Number(process.env.LM_CACHE_TTL_FOUND_MS ?? 30 * 24 * 60 * 60 * 1000);
const LM_TTL_MISS_MS = Number(process.env.LM_CACHE_TTL_MISS_MS ?? 3 * 24 * 60 * 60 * 1000);

function runMigrations(): void {
  const current = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
      db.exec("COMMIT");
      console.info(`[db] migration v${m.version} applied.`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
runMigrations();
console.info(`[db] SQLite ready at ${DB_PATH}`);

/* ──────────────────────────────────────────────────────────────────────
 * Row shapes (DB ↔ TS) + wire model
 * ────────────────────────────────────────────────────────────────────── */

export type PairStatusKind = "pending" | "extracting" | "ready" | "error" | "unpaired";

/** What kind of document an unpaired row holds — drives the badge the
 *  app shows ("AWB fără factură" vs "Factură fără AWB"). */
export type UnpairedDocType = "awb" | "invoice" | "unknown";

/** What clients see in JSON responses. Discriminated union so the UI
 *  can pattern-match without runtime guesswork. */
export type PairStatus =
  | { kind: "pending" }
  | { kind: "extracting" }
  /** A document the scanner could NOT pair by name/address. One image,
   *  never priced — it sits in the day's "unpaired" strip until a human
   *  resolves (re-scans or deletes) it. */
  | { kind: "unpaired"; docType: UnpairedDocType }
  | {
      kind: "ready";
      service: Service;
      serviceFallback: boolean;
      edits: Extracted;
      breakdown: PricingBreakdown;
      /** Origin store = the centralizator bucket this pair is filed under
       *  (derived from the AWB Expeditor). Null when undetermined. */
      store?: StoreKey | null;
      /** How the distance + store were resolved (Mapbox route store →
       *  delivery, or AWB-printed km fallback). */
      routing?: Routing;
      /** Leroy Merlin cross-check. Optional + arrives after the price
       *  (a second persist), so a freshly-calculated pair may be "ready"
       *  with no verification yet. */
      verification?: Verification;
    }
  | { kind: "error"; message: string };

/** A single image, on the wire as base64. JSON-friendly, ~33% bigger
 *  than raw, but the queue is tiny and the conversion happens once. */
export interface PairImageWire {
  name: string;
  mimeType: string;
  size: number;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataB64: string;
}

export interface PairWire {
  id: string;
  day: string;
  createdAt: number;
  updatedAt: number;
  /** Collaborator this pair was filed to AT UPLOAD TIME (the courier picks
   *  one in the scan flow). `null` = direct / legacy pair. */
  collaborator: Collaborator | null;
  status: PairStatus;
  images: PairImageWire[];
}

/** Image METADATA only — what the light list carries instead of the
 *  base64 payload. The client lazily pulls the actual bytes from
 *  `GET /pairs/:id/images/:slot` when (and only when) it needs them. */
export interface PairImageMetaWire {
  slot: number;
  name: string;
  mimeType: string;
  size: number;
}

/** A pair without image bytes. The hydrate payload drops from ~26 MB
 *  of base64 to a few hundred KB of JSON — the UI renders instantly
 *  and images stream in afterwards, one HTTP request per image. */
export interface PairLightWire {
  id: string;
  day: string;
  createdAt: number;
  updatedAt: number;
  /** Same upload-time collaborator assignment as PairWire. */
  collaborator: Collaborator | null;
  status: PairStatus;
  images: PairImageMetaWire[];
}

interface PairRow {
  id: string;
  day: string;
  created_at: number;
  updated_at: number;
  status_kind: PairStatusKind;
  status_message: string | null;
  service: Service | null;
  service_fallback: number | null;
  edits_json: string | null;
  breakdown_json: string | null;
  verification_json: string | null;
  store: StoreKey | null;
  routing_json: string | null;
  collaborator: Collaborator | null;
}

interface ImageRow {
  pair_id: string;
  slot: number;
  name: string;
  mime_type: string;
  size: number;
  bytes: Buffer;
}

/* ──────────────────────────────────────────────────────────────────────
 * Prepared statements (cached)
 *
 * `better-sqlite3` caches the SQLite compile per statement; we cache
 * the JS wrappers here so we don't re-prepare on every call. Each
 * statement is a tiny, single-purpose query that names exactly what
 * it does.
 * ────────────────────────────────────────────────────────────────────── */
const stmt = {
  selectAllPairs: db.prepare<[], PairRow>(
    `SELECT id, day, created_at, updated_at, status_kind, status_message,
            service, service_fallback, edits_json, breakdown_json,
            verification_json, store, routing_json, collaborator
       FROM pairs
       ORDER BY created_at ASC`,
  ),
  selectAllImages: db.prepare<[], ImageRow>(
    `SELECT pair_id, slot, name, mime_type, size, bytes
       FROM pair_images
       ORDER BY pair_id, slot ASC`,
  ),
  selectImagesByPair: db.prepare<[string], ImageRow>(
    `SELECT pair_id, slot, name, mime_type, size, bytes
       FROM pair_images
       WHERE pair_id = ?
       ORDER BY slot ASC`,
  ),
  // Metadata-only sweep — deliberately does NOT touch the `bytes`
  // column, so SQLite never pages the ~20 MB of BLOBs into memory
  // just to render the queue list.
  selectAllImageMeta: db.prepare<[], Omit<ImageRow, "bytes">>(
    `SELECT pair_id, slot, name, mime_type, size
       FROM pair_images
       ORDER BY pair_id, slot ASC`,
  ),
  selectImage: db.prepare<[string, number], ImageRow>(
    `SELECT pair_id, slot, name, mime_type, size, bytes
       FROM pair_images
       WHERE pair_id = ? AND slot = ?`,
  ),
  selectPair: db.prepare<[string], PairRow>(
    `SELECT id, day, created_at, updated_at, status_kind, status_message,
            service, service_fallback, edits_json, breakdown_json,
            verification_json, store, routing_json, collaborator
       FROM pairs
       WHERE id = ?`,
  ),
  insertPair: db.prepare(
    `INSERT INTO pairs
       (id, day, created_at, updated_at, status_kind, status_message,
        collaborator, service, service_fallback, edits_json, breakdown_json)
     VALUES (@id, @day, @created_at, @updated_at, @status_kind, @status_message,
             @collaborator, NULL, NULL, NULL, NULL)`,
  ),
  insertImage: db.prepare(
    `INSERT INTO pair_images (pair_id, slot, name, mime_type, size, bytes)
     VALUES (@pair_id, @slot, @name, @mime_type, @size, @bytes)`,
  ),
  updateReady: db.prepare(
    `UPDATE pairs
        SET status_kind      = 'ready',
            status_message   = NULL,
            service          = @service,
            service_fallback = @service_fallback,
            edits_json       = @edits_json,
            breakdown_json   = @breakdown_json,
            verification_json = @verification_json,
            store            = @store,
            routing_json     = @routing_json,
            updated_at       = @updated_at
      WHERE id = @id`,
  ),
  updateError: db.prepare(
    `UPDATE pairs
        SET status_kind    = 'error',
            status_message = @message,
            updated_at     = @updated_at
      WHERE id = @id`,
  ),
  updatePending: db.prepare(
    `UPDATE pairs
        SET status_kind    = 'pending',
            status_message = NULL,
            updated_at     = @updated_at
      WHERE id = @id`,
  ),
  deleteImagesByPair: db.prepare(`DELETE FROM pair_images WHERE pair_id = ?`),
  deletePair: db.prepare(`DELETE FROM pairs WHERE id = ?`),
  deleteAllImages: db.prepare(`DELETE FROM pair_images`),
  deleteAllPairs: db.prepare(`DELETE FROM pairs`),
  selectDayPairIds: db.prepare<[string], { id: string }>(`SELECT id FROM pairs WHERE day = ?`),
  deleteDayImages: db.prepare(
    `DELETE FROM pair_images WHERE pair_id IN (SELECT id FROM pairs WHERE day = ?)`,
  ),
  deleteDayPairs: db.prepare(`DELETE FROM pairs WHERE day = ?`),
  selectWeekendDay: db.prepare<[string], { force_weekend: number }>(
    `SELECT force_weekend FROM day_flags WHERE day = ?`,
  ),
  selectWeekendDays: db.prepare<[], { day: string }>(
    `SELECT day FROM day_flags WHERE force_weekend = 1 ORDER BY day`,
  ),
  upsertWeekendDay: db.prepare(
    `INSERT INTO day_flags (day, force_weekend) VALUES (@day, @force)
       ON CONFLICT(day) DO UPDATE SET force_weekend = @force`,
  ),
  deleteWeekendDay: db.prepare(`DELETE FROM day_flags WHERE day = ?`),
  selectLmProduct: db.prepare<[string], LmProductRow>(
    `SELECT query, found, url, name, brand, price_buc, weight_kg, area_m2, dims_mm, fetched_at
       FROM lm_products WHERE query = ?`,
  ),
  upsertLmProduct: db.prepare(
    `INSERT INTO lm_products
       (query, found, url, name, brand, price_buc, weight_kg, area_m2, dims_mm, fetched_at)
     VALUES (@query, @found, @url, @name, @brand, @price_buc, @weight_kg, @area_m2, @dims_mm, @fetched_at)
     ON CONFLICT(query) DO UPDATE SET
       found=@found, url=@url, name=@name, brand=@brand, price_buc=@price_buc,
       weight_kg=@weight_kg, area_m2=@area_m2, dims_mm=@dims_mm, fetched_at=@fetched_at`,
  ),
};

interface LmProductRow {
  query: string;
  found: number;
  url: string | null;
  name: string | null;
  brand: string | null;
  price_buc: number | null;
  weight_kg: number | null;
  area_m2: number | null;
  dims_mm: string | null;
  fetched_at: number;
}

/* ──────────────────────────────────────────────────────────────────────
 * Row → status reconstruction
 *
 * "extracting" rows would only exist if a prior version persisted that
 * state; we coerce them to "pending" so the user can re-run instead of
 * staring at a stuck spinner. "ready" needs both JSON blobs + service
 * to round-trip; if any is missing (corruption / partial write) we
 * also demote to pending.
 * ────────────────────────────────────────────────────────────────────── */
function rowToStatus(r: PairRow): PairStatus {
  if (r.status_kind === "extracting" || r.status_kind === "pending") {
    return { kind: "pending" };
  }
  if (r.status_kind === "unpaired") {
    // The doc kind rides in status_message ("awb" / "invoice" / "unknown").
    const t = r.status_message;
    return {
      kind: "unpaired",
      docType: t === "awb" || t === "invoice" ? t : "unknown",
    };
  }
  if (r.status_kind === "error") {
    return { kind: "error", message: r.status_message ?? "Eroare necunoscută." };
  }
  if (
    r.status_kind === "ready" &&
    r.service &&
    r.edits_json &&
    r.breakdown_json
  ) {
    try {
      const edits = JSON.parse(r.edits_json) as Extracted;
      const breakdown = JSON.parse(r.breakdown_json) as PricingBreakdown;
      let verification: Verification | undefined;
      if (r.verification_json) {
        try {
          verification = JSON.parse(r.verification_json) as Verification;
        } catch {
          verification = undefined; // corrupt blob — drop it, keep the pair
        }
      }
      let routing: Routing | undefined;
      if (r.routing_json) {
        try {
          routing = JSON.parse(r.routing_json) as Routing;
        } catch {
          routing = undefined; // corrupt blob — drop it, keep the pair
        }
      }
      return {
        kind: "ready",
        service: r.service,
        serviceFallback: r.service_fallback === 1,
        edits,
        breakdown,
        store: r.store ?? routing?.store ?? null,
        routing,
        verification,
      };
    } catch {
      return { kind: "pending" };
    }
  }
  return { kind: "pending" };
}

function imageRowToWire(r: ImageRow): PairImageWire {
  return {
    name: r.name,
    mimeType: r.mime_type,
    size: r.size,
    dataB64: r.bytes.toString("base64"),
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * Public API — what the routes call
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Pull every pair (with its N images) ordered by insertion time so
 * the queue rebuilds in the exact order the user created it. We fetch
 * pairs and images in two queries and bucket images by `pair_id` in
 * a single pass — O(n) reconstruction, no N+1.
 */
export function listAllPairs(): PairWire[] {
  const pairRows = stmt.selectAllPairs.all();
  if (pairRows.length === 0) return [];
  const imageRows = stmt.selectAllImages.all();

  const byPair = new Map<string, ImageRow[]>();
  for (const r of imageRows) {
    const arr = byPair.get(r.pair_id) ?? [];
    arr.push(r);
    byPair.set(r.pair_id, arr);
  }

  return pairRows.map((r) => ({
    id: r.id,
    day: r.day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    collaborator: r.collaborator ?? null,
    status: rowToStatus(r),
    images: (byPair.get(r.id) ?? [])
      .sort((a, b) => a.slot - b.slot)
      .map(imageRowToWire),
  }));
}

/**
 * Same queue, no image bytes. This is what `GET /pairs` serves: the
 * status/pricing JSON the table needs to paint, plus per-image
 * metadata (slot/name/mime/size) so the client knows what to lazily
 * fetch. Reconstruction is the same two-query O(n) bucket pass as
 * `listAllPairs`, just against the byte-free metadata statement.
 */
export function listAllPairsLight(): PairLightWire[] {
  const pairRows = stmt.selectAllPairs.all();
  if (pairRows.length === 0) return [];
  const metaRows = stmt.selectAllImageMeta.all();

  const byPair = new Map<string, PairImageMetaWire[]>();
  for (const r of metaRows) {
    const arr = byPair.get(r.pair_id) ?? [];
    arr.push({ slot: r.slot, name: r.name, mimeType: r.mime_type, size: r.size });
    byPair.set(r.pair_id, arr);
  }

  return pairRows.map((r) => ({
    id: r.id,
    day: r.day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    collaborator: r.collaborator ?? null,
    status: rowToStatus(r),
    images: (byPair.get(r.id) ?? []).sort((a, b) => a.slot - b.slot),
  }));
}

/** One image's raw bytes by (pair, slot) — the lazy-fetch endpoint's
 *  data source. `null` when the pair or slot doesn't exist. */
export function getPairImage(
  pairId: string,
  slot: number,
): { name: string; mimeType: string; size: number; bytes: Buffer } | null {
  const r = stmt.selectImage.get(pairId, slot);
  if (!r) return null;
  return { name: r.name, mimeType: r.mime_type, size: r.size, bytes: r.bytes };
}

export interface InsertPairInput {
  id: string;
  day: string;
  /** Collaborator picked in the upload flow — stamped once at insert,
   *  never changed by a status transition. Omit/null = direct. */
  collaborator?: Collaborator | null;
  /** Optional initial status — defaults to "pending". "extracting" is
   *  silently coerced to "pending" because we don't persist that state. */
  status?: PairStatus;
  images: Array<{
    name: string;
    mimeType: string;
    size: number;
    bytes: Buffer;
  }>;
}

/**
 * Insert a brand-new pair with its N source images, atomically.
 * Wrapping all inserts in a single `better-sqlite3` transaction
 * guarantees either every row lands or none — we lose the "orphan
 * parent row" failure mode the old Tauri client had to tolerate.
 */
export function insertPair(input: InsertPairInput): PairWire {
  const now = Date.now();
  const statusKind: PairStatusKind =
    input.status?.kind === "extracting"
      ? "pending"
      : (input.status?.kind ?? "pending");
  // Unpaired rows carry their doc kind in status_message; everything
  // else starts with a clean message column.
  const statusMessage = input.status?.kind === "unpaired" ? input.status.docType : null;

  const tx = db.transaction((p: InsertPairInput) => {
    stmt.insertPair.run({
      id: p.id,
      day: p.day,
      created_at: now,
      updated_at: now,
      status_kind: statusKind,
      status_message: statusMessage,
      collaborator: p.collaborator ?? null,
    });
    for (let i = 0; i < p.images.length; i++) {
      const img = p.images[i]!;
      stmt.insertImage.run({
        pair_id: p.id,
        slot: i,
        name: img.name || `image-${i + 1}`,
        mime_type: img.mimeType || "image/*",
        size: img.size,
        bytes: img.bytes,
      });
    }
  });
  tx(input);

  // Read back so the caller gets the canonical PairWire (including
  // status reconstruction + image base64 round-trip), keeping the
  // round-trip contract identical to listAllPairs.
  const pair = getPair(input.id)!;
  // Live: a new pair exists — push it (with images) to every connected
  // desktop so a phone scan appears the instant it lands.
  publishPairEvent({ type: "pair-created", pair });
  return pair;
}

/** Single pair by id, or `null` if no such row. Same shape as a list
 *  element so callers can swap one for the other. */
export function getPair(id: string): PairWire | null {
  const r = stmt.selectPair.get(id);
  if (!r) return null;
  const imageRows = stmt.selectImagesByPair.all(id);
  return {
    id: r.id,
    day: r.day,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    collaborator: r.collaborator ?? null,
    status: rowToStatus(r),
    images: imageRows.map(imageRowToWire),
  };
}

/**
 * Persist a status transition. "extracting" is the one state we
 * deliberately don't write — it's an optimistic UI flip and would be
 * misleading on rehydrate. Every other transition updates the row in
 * place.
 *
 * Returns `true` if the row existed and was touched; `false` if no
 * such id (so the route can return 404 instead of a silent 200).
 */
export function persistPairStatus(id: string, status: PairStatus): boolean {
  const row = stmt.selectPair.get(id);
  if (!row) return false;
  if (status.kind === "extracting") return true; // intentionally noop
  if (status.kind === "unpaired") return true; // set at insert time only — never a transition

  const now = Date.now();
  if (status.kind === "ready") {
    stmt.updateReady.run({
      id,
      service: status.service,
      service_fallback: status.serviceFallback ? 1 : 0,
      edits_json: JSON.stringify(status.edits),
      breakdown_json: JSON.stringify(status.breakdown),
      verification_json: status.verification ? JSON.stringify(status.verification) : null,
      store: status.store ?? status.routing?.store ?? null,
      routing_json: status.routing ? JSON.stringify(status.routing) : null,
      updated_at: now,
    });
  } else if (status.kind === "error") {
    stmt.updateError.run({ id, message: status.message, updated_at: now });
  } else {
    stmt.updatePending.run({ id, updated_at: now });
  }
  // Live: a status changed — push the transition (no images; they don't
  // change on a status flip, and re-sending base64 every time is waste).
  publishPairEvent({ type: "pair-updated", id, day: row.day, updatedAt: now, status });
  return true;
}

/**
 * Emit-only "extracting" pulse — NO database write.
 *
 * The pipeline goes pending → (vision call in flight) → ready/error. We
 * deliberately never PERSIST "extracting" (a crash mid-call would otherwise
 * leave a stuck spinner forever; rowToStatus coerces it back to pending).
 * But for the LIVE view we still want the desktop to show that spinner while
 * the server works, so the scan-batch pipeline calls this right before it
 * starts extracting. The signal is ephemeral by design — only connected
 * clients see it, and a reload reflects the real persisted state.
 */
export function signalExtracting(id: string): void {
  const row = stmt.selectPair.get(id);
  if (!row) return;
  publishPairEvent({
    type: "pair-updated",
    id,
    day: row.day,
    updatedAt: Date.now(),
    status: { kind: "extracting" },
  });
}

/** Drop a single pair (its image rows cascade via the FK, but we
 *  delete explicitly first because PRAGMA foreign_keys is enforced at
 *  connection level — being explicit costs nothing and stays correct
 *  even if a future migration toggles it). */
export function deletePair(id: string): boolean {
  const exists = !!stmt.selectPair.get(id);
  if (!exists) return false;
  const tx = db.transaction(() => {
    stmt.deleteImagesByPair.run(id);
    stmt.deletePair.run(id);
  });
  tx();
  publishPairEvent({ type: "pair-deleted", id });
  return true;
}

/**
 * Clear ONE filing day — every pair filed under `day` (all stores, all
 * collaborators, calculated and unpaired alike), with their image rows.
 * Atomic: a single transaction either removes the whole day or nothing.
 * Emits one `pair-deleted` event per removed pair so every connected
 * client drops exactly those rows live. Returns the count removed.
 */
export function deletePairsByDay(day: string): number {
  const ids = stmt.selectDayPairIds.all(day).map((r) => r.id);
  if (ids.length === 0) return 0;
  const tx = db.transaction(() => {
    stmt.deleteDayImages.run(day);
    stmt.deleteDayPairs.run(day);
  });
  tx();
  for (const id of ids) publishPairEvent({ type: "pair-deleted", id });
  return ids.length;
}

/* ──────────────────────────────────────────────────────────────────────
 * Per-day weekend override
 *
 * A small key/value over the filing day: when a day carries
 * `force_weekend = 1`, every pair priced under it gets the +11,90
 * surcharge regardless of the calendar. The pricing pipeline reads
 * `getWeekendDay(day)` so new scans on a forced day inherit it; the
 * desktop toggles it via `setWeekendDay`.
 * ────────────────────────────────────────────────────────────────────── */

/** Is this filing day forced to weekend pricing? False when no row exists. */
export function getWeekendDay(day: string): boolean {
  const row = stmt.selectWeekendDay.get(day);
  return !!row && row.force_weekend === 1;
}

/** Every filing day currently forced to weekend pricing (ISO, sorted). */
export function getWeekendDays(): string[] {
  return stmt.selectWeekendDays.all().map((r) => r.day);
}

/** Mark (or clear) a filing day as weekend. Clearing removes the row so
 *  the table only ever holds the forced days. */
export function setWeekendDay(day: string, force: boolean): void {
  if (force) {
    stmt.upsertWeekendDay.run({ day, force: 1 });
  } else {
    stmt.deleteWeekendDay.run(day);
  }
}

/** Clear the entire queue (every day, every pair). The route layer
 *  scopes this further if the caller asks for a single day. */
export function deleteAllPairs(): number {
  const before = stmt.selectAllPairs.all().length;
  const tx = db.transaction(() => {
    stmt.deleteAllImages.run();
    stmt.deleteAllPairs.run();
  });
  tx();
  publishPairEvent({ type: "pairs-cleared" });
  return before;
}

/* ──────────────────────────────────────────────────────────────────────
 * Leroy Merlin product cache
 *
 * Keyed by the exact invoice code searched. A row is returned only while
 * fresh (TTL by found/miss); a stale row is treated as a miss so the
 * caller re-fetches. Both hits and misses are cached — a miss is cheap
 * to remember and stops us re-searching a non-existent code every run.
 * ────────────────────────────────────────────────────────────────────── */

export function getCachedLmProduct(query: string): LmProduct | null {
  const r = stmt.selectLmProduct.get(query);
  if (!r) return null;
  const found = r.found === 1;
  const ttl = found ? LM_TTL_FOUND_MS : LM_TTL_MISS_MS;
  if (Date.now() - r.fetched_at > ttl) return null; // stale → re-fetch
  let dimsMm: number[] = [];
  if (r.dims_mm) {
    try {
      const parsed = JSON.parse(r.dims_mm);
      if (Array.isArray(parsed)) dimsMm = parsed.filter((n): n is number => typeof n === "number");
    } catch {
      dimsMm = [];
    }
  }
  return {
    query: r.query,
    found,
    url: r.url,
    name: r.name,
    brand: r.brand,
    priceBuc: r.price_buc,
    weightKg: r.weight_kg,
    areaM2: r.area_m2,
    dimsMm,
  };
}

export function putCachedLmProduct(p: LmProduct): void {
  stmt.upsertLmProduct.run({
    query: p.query,
    found: p.found ? 1 : 0,
    url: p.url,
    name: p.name,
    brand: p.brand,
    price_buc: p.priceBuc,
    weight_kg: p.weightKg,
    area_m2: p.areaM2,
    dims_mm: JSON.stringify(p.dimsMm ?? []),
    fetched_at: Date.now(),
  });
}

/**
 * Pull the image that belongs to one invoice out of a pair, for the
 * "remove a wrongly-matched invoice" flow. Images are stored AWB-first
 * (slot 0), then one per invoice in `edits.invoices` order — so invoice
 * `invoiceIndex` lives at slot `invoiceIndex + 1` WHEN the slot count
 * matches (1 AWB + one image per invoice).
 *
 *   • clean 1:1 mapping  → MOVE that slot out (delete it, renumber the
 *                          rest down) and report `moved: true`.
 *   • combined / deduped → we cannot safely identify a single invoice's
 *                          own image (one photo carries AWB + invoice, or
 *                          two photos collapsed to one invoice). COPY the
 *                          closest image, leave the pair's images intact,
 *                          and report `moved: false`.
 *
 * Returns the chosen image's bytes so the caller can stand up a new
 * "unpaired" row from it. `null` only if the pair has no images at all.
 */
export interface DetachedImage {
  name: string;
  mimeType: string;
  size: number;
  bytes: Buffer;
  /** true = the image was removed from the source pair; false = copied. */
  moved: boolean;
}

export function detachInvoiceImage(
  pairId: string,
  invoiceIndex: number,
  invoiceCount: number,
): DetachedImage | null {
  const rows = stmt.selectImagesByPair.all(pairId); // ordered by slot ASC
  if (rows.length === 0) return null;

  // Clean per-invoice images: exactly AWB + one photo per invoice.
  const onePerInvoice = rows.length === invoiceCount + 1;
  if (onePerInvoice) {
    const slot = invoiceIndex + 1;
    const row = rows.find((r) => r.slot === slot);
    if (row) {
      // Remove that slot and re-lay the rest as a contiguous 0..n-1 run.
      // We delete every image for the pair and re-insert the keepers with
      // fresh slot numbers — bulletproof against any transient PK collision
      // a in-place "shift slots down" UPDATE could hit, and cheap (one rare
      // manual action over a handful of small BLOBs).
      const keep = rows.filter((r) => r.slot !== slot).sort((a, b) => a.slot - b.slot);
      const tx = db.transaction(() => {
        stmt.deleteImagesByPair.run(pairId);
        for (let i = 0; i < keep.length; i++) {
          const k = keep[i]!;
          stmt.insertImage.run({
            pair_id: pairId,
            slot: i,
            name: k.name,
            mime_type: k.mime_type,
            size: k.size,
            bytes: k.bytes,
          });
        }
      });
      tx();
      return {
        name: row.name,
        mimeType: row.mime_type,
        size: row.size,
        bytes: row.bytes,
        moved: true,
      };
    }
  }

  // Fallback: combined photo or a dedup mismatch — copy the closest image
  // (the matching slot if present, else the AWB/only photo) without removing
  // anything from the source pair.
  const wantSlot = rows.length > 1 ? Math.min(invoiceIndex + 1, rows.length - 1) : 0;
  const row = rows.find((r) => r.slot === wantSlot) ?? rows[0]!;
  return {
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    bytes: row.bytes,
    moved: false,
  };
}

/** Close the DB handle. Wired to the server's shutdown hooks so WAL
 *  is checkpointed cleanly on SIGINT/SIGTERM. */
export function closeDb(): void {
  db.close();
}

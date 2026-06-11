/**
 * One-shot migration: re-run resolveRouting against every "ready" pair and
 * overwrite the stored routing_json.
 *
 * Why this exists: the geocoder used to accept Mapbox's first fuzzy hit,
 * which routinely landed on a same-named street in the WRONG locality
 * ("Str. Libertatii, Pietreni" → Strada Libertății in Constanța city),
 * making the informational Mapbox km wildly wrong (6.5 km vs a real
 * 65 km). geocode() now validates the locality and falls back to the
 * locality's center; this script refreshes every stored routing so the
 * Excel comparison and the km warnings reflect the corrected distances.
 *
 * The pair's STORE and price breakdown are deliberately left untouched —
 * the billed km is always the AWB's printed km, so nothing price-bearing
 * changes here. If the fresh routing would pick a different store we KEEP
 * the stored one (it's baked into the price) and log it loudly.
 *
 * Idempotent — safe to re-run.
 *
 * Run with:
 *   node --env-file=.env dist/scripts/reroute-pairs.js
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { resolveRouting } from "../routing.js";
import type { Extracted, Routing } from "../schema.js";

const DB_PATH =
  process.env.CENTRALIZATOR_DB_PATH ??
  resolve(import.meta.dirname, "../../centralizator.db");

/** Mapbox per-pair work is network-bound — a small pool keeps the run
 *  fast without hammering the API. */
const CONCURRENCY = 4;

console.info(`[reroute] opening ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

interface Row {
  id: string;
  edits_json: string | null;
  routing_json: string | null;
}

const rows = db
  .prepare<unknown[], Row>(
    `SELECT id, edits_json, routing_json
       FROM pairs
      WHERE status_kind = 'ready'
        AND edits_json IS NOT NULL`,
  )
  .all();

console.info(`[reroute] found ${rows.length} ready pair(s) to refresh.`);

const update = db.prepare(
  `UPDATE pairs
      SET routing_json = @routing_json,
          updated_at   = @updated_at
    WHERE id = @id`,
);

let done = 0;
let changed = 0;

async function rerouteOne(row: Row): Promise<void> {
  let edits: Extracted;
  let old: Routing | null = null;
  try {
    edits = JSON.parse(row.edits_json!) as Extracted;
    old = row.routing_json ? (JSON.parse(row.routing_json) as Routing) : null;
  } catch {
    console.warn(`[reroute] ${row.id}: corrupt JSON — skipped.`);
    return;
  }

  const fresh = await resolveRouting(edits);

  // The store is baked into the stored price — never silently move it.
  const next: Routing =
    old?.store && fresh.store !== old.store
      ? { ...fresh, store: old.store, storeSource: old.storeSource }
      : fresh;
  if (old?.store && fresh.store !== old.store) {
    console.warn(
      `[reroute] ${row.id}: fresh routing picked store ${fresh.store} but the pair was priced from ${old.store} — keeping ${old.store}.`,
    );
  }

  const awb = edits.awb?.awb_number ?? row.id;
  if (old?.mapboxKm !== next.mapboxKm) {
    changed++;
    console.info(
      `[reroute] AWB ${awb}: mapboxKm ${old?.mapboxKm ?? "—"} → ${next.mapboxKm ?? "—"}${next.approxGeocode ? " (centrul localității)" : ""}`,
    );
  }

  update.run({
    id: row.id,
    routing_json: JSON.stringify(next),
    updated_at: Date.now(),
  });
  done++;
}

// Small worker pool — CONCURRENCY pairs in flight at once.
const queue = [...rows];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        await rerouteOne(row);
      } catch (err) {
        console.warn(`[reroute] ${row.id}: failed — ${(err as Error).message}`);
      }
    }
  }),
);

console.info(`[reroute] refreshed ${done}/${rows.length} pair(s), ${changed} mapboxKm value(s) changed.`);
db.close();

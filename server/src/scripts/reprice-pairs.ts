/**
 * One-shot migration: re-run calculatePrice against every "ready" pair
 * in the queue and overwrite the stored breakdown_json.
 *
 * Why this exists: when we dropped the 19% VAT round-trip (refactor
 * d90d4d9), the tariff table was rebased to the LEROY doc values
 * directly. Pairs priced BEFORE that commit still carry the old
 * breakdown blob in SQLite, so the app shows stale baseTariff /
 * carrierTotal numbers until the user edits a field. This script
 * walks the queue once and recomputes every row.
 *
 * Idempotent — safe to re-run.
 *
 * Run with:
 *   node --env-file=.env dist/scripts/reprice-pairs.js
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import { calculatePrice } from "../pricing.js";
import { buildPricingInput, todayFilingDay } from "../pipeline.js";
import type { Extracted, Routing } from "../schema.js";
import type { City, Service } from "../tariffs.js";

const DB_PATH =
  process.env.CENTRALIZATOR_DB_PATH ??
  resolve(import.meta.dirname, "../../centralizator.db");

console.info(`[reprice] opening ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

interface Row {
  id: string;
  day: string;
  service: Service | null;
  edits_json: string | null;
  breakdown_json: string | null;
  store: City | null;
  routing_json: string | null;
}

const rows = db
  .prepare<unknown[], Row>(
    `SELECT id, day, service, edits_json, breakdown_json, store, routing_json
       FROM pairs
      WHERE status_kind = 'ready'
        AND edits_json IS NOT NULL
        AND service    IS NOT NULL`,
  )
  .all();

console.info(`[reprice] found ${rows.length} ready pair(s) to refresh.`);

const update = db.prepare(
  `UPDATE pairs
      SET breakdown_json = @breakdown_json,
          updated_at     = @updated_at
    WHERE id = @id`,
);

let touched = 0;
let unchanged = 0;
let failed = 0;
const now = Date.now();

db.transaction(() => {
  for (const row of rows) {
    try {
      const edits = JSON.parse(row.edits_json!) as Extracted;
      const routing = row.routing_json
        ? (JSON.parse(row.routing_json) as Routing)
        : null;
      // Mirror the live pipeline exactly via the SHARED input builder:
      //   • distanceKm   — the persisted km (already overwritten with the
      //                    routed distance when the pair was priced);
      //   • weekendBasis — the pair's FILING day (NOT the AWB timestamp);
      //   • macaraStore  — the resolved dispatch store column.
      const breakdown = calculatePrice(
        buildPricingInput(edits, row.service!, {
          distanceKm: edits.awb.distance_extra_km,
          weekendBasis: row.day || todayFilingDay(),
          macaraStore: row.store ?? routing?.store ?? null,
        }),
      );
      const next = JSON.stringify(breakdown);
      if (next === row.breakdown_json) {
        unchanged += 1;
        continue;
      }
      update.run({ id: row.id, breakdown_json: next, updated_at: now });
      touched += 1;
      console.info(
        `[reprice] ${row.id} · ${breakdown.baseKey} · baseTariff=${breakdown.baseTariff} carrierTotal=${breakdown.carrierTotal}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[reprice] ${row.id} FAILED:`, (err as Error).message);
    }
  }
})();

console.info(
  `[reprice] done. updated=${touched} unchanged=${unchanged} failed=${failed}`,
);
db.close();

/**
 * In-process pub/sub for pair lifecycle events.
 *
 * The phone uploads a scan batch → the server creates and prices pairs in
 * the background → those pairs must appear LIVE in the desktop app without a
 * manual refresh. SSE (`routes/events.ts`) is the transport; this module is
 * the bus that feeds it. Every pair mutation in `db.ts` publishes here, and
 * each connected desktop client is a subscriber that forwards the event down
 * its event-stream.
 *
 * It's a plain Node `EventEmitter` because everything runs in ONE process:
 * the same Fastify instance owns the SQLite handle, the background pipeline,
 * AND the SSE connections. No external broker is needed (or wanted) — a
 * single courrier's desktop is the only consumer. If this ever scales to
 * multiple server processes, swap the emitter for Redis pub/sub behind the
 * same two functions and nothing else changes.
 *
 * Type-only import of the DB shapes keeps this module free of a runtime cycle
 * (db.ts imports `publishPairEvent` from here as a value; we import its types
 * with `import type`, which TypeScript erases at compile time).
 */

import { EventEmitter } from "node:events";
import type { PairStatus, PairWire } from "./db.js";

/**
 * What crosses the wire to each desktop client. A discriminated union so the
 * client can pattern-match without guesswork:
 *   • created  — a brand-new pair (carries its images so a remote client can
 *                render thumbnails it never had locally).
 *   • updated  — a status transition only (NO images — they never change, and
 *                re-sending multi-MB base64 on every "ready" flip is waste).
 *                Also used for the emit-only "extracting" pulse.
 *   • deleted  — one pair dropped.
 *   • cleared  — the whole queue was wiped.
 */
export type PairEvent =
  | { type: "pair-created"; pair: PairWire }
  | { type: "pair-updated"; id: string; day: string; updatedAt: number; status: PairStatus }
  | { type: "pair-deleted"; id: string }
  | { type: "pairs-cleared" };

const bus = new EventEmitter();
// One listener per connected SSE client; a single courier desktop is the
// norm, but lift the default-10 cap so a few open windows never warn.
bus.setMaxListeners(0);

const CHANNEL = "pair";

/** Fan an event out to every connected client. Never throws — a slow or
 *  broken subscriber must not break the DB write that triggered it. */
export function publishPairEvent(event: PairEvent): void {
  bus.emit(CHANNEL, event);
}

/** Subscribe to the stream. Returns an unsubscribe function the SSE route
 *  calls when the client disconnects, so listeners don't leak. */
export function subscribePairEvents(listener: (event: PairEvent) => void): () => void {
  bus.on(CHANNEL, listener);
  return () => {
    bus.off(CHANNEL, listener);
  };
}

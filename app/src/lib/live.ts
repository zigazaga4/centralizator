/**
 * Live pair feed — a reconnecting Server-Sent Events client.
 *
 * The desktop hydrates the queue once at launch (`loadAllPairs`); this keeps
 * it in sync from then on. When a courier scans a stack on the phone, the
 * server creates and prices the pairs and pushes each change here, so they
 * appear in the desktop table in real time — pending → spinner → priced —
 * with no refresh.
 *
 * Why a streaming `fetch` and not `EventSource`: `EventSource` cannot set
 * request headers, so it can't carry our `x-api-key`. A streaming `fetch`
 * can, which lets the live feed sit behind the exact same auth gate as every
 * other route. The trade-off — `EventSource`'s built-in auto-reconnect — we
 * re-implement here with bounded exponential backoff.
 *
 * Resilience: on every (re)connect the caller is told via `onStatus(true)`;
 * on any drop, `onStatus(false)` then a backoff before retrying. Events that
 * occur while disconnected are caught up by the caller re-reconciling on the
 * next connect (it re-fetches the authoritative list). This module only
 * parses frames and manages the socket; merge policy lives in the caller.
 */

import { wirePairToClient, type WirePair, type WireStatus } from "./db";
import type { Pair, PairStatus } from "../types";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";
const API_KEY = import.meta.env.VITE_CENTRALIZATOR_API_KEY as string | undefined;

/** Wire event union — mirrors `PairEvent` in server/src/events.ts. */
type LiveEvent =
  | { type: "pair-created"; pair: WirePair }
  | { type: "pair-updated"; id: string; day: string; updatedAt: number; status: WireStatus }
  | { type: "pair-deleted"; id: string }
  | { type: "pairs-cleared" };

export interface LiveHandlers {
  /** A brand-new pair arrived (with images). */
  onCreated(pair: Pair): void;
  /** A status transition for an existing pair (no images change). The
   *  server's `updatedAt` rides along so the client can apply last-write-wins
   *  and drop any out-of-order/stale echo. */
  onUpdated(id: string, day: string, status: PairStatus, updatedAt: number): void;
  /** A pair was removed. */
  onDeleted(id: string): void;
  /** The whole queue was cleared remotely. */
  onCleared(): void;
  /** Connection state changed — drives the header "Live" indicator and
   *  triggers a reconcile on (re)connect. */
  onStatus(connected: boolean): void;
}

/** Backoff schedule between reconnect attempts (ms), capped. A little jitter
 *  is added so many clients don't reconnect in lockstep after an outage. */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse and dispatch a single SSE frame (the text between blank lines). */
function dispatchFrame(frame: string, h: LiveHandlers): void {
  // Collect `data:` lines; ignore comments (`:` heartbeat) and other fields.
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return;

  let event: LiveEvent;
  try {
    event = JSON.parse(dataLines.join("\n")) as LiveEvent;
  } catch {
    return; // malformed frame — skip rather than throw the reader
  }

  switch (event.type) {
    case "pair-created":
      h.onCreated(wirePairToClient(event.pair));
      break;
    case "pair-updated":
      h.onUpdated(event.id, event.day, event.status as PairStatus, event.updatedAt);
      break;
    case "pair-deleted":
      h.onDeleted(event.id);
      break;
    case "pairs-cleared":
      h.onCleared();
      break;
  }
}

/**
 * Open the live feed and keep it open, reconnecting forever until the
 * returned stop function is called. Returns an unsubscribe that aborts the
 * in-flight request and halts the reconnect loop.
 */
export function subscribePairLive(h: LiveHandlers): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  async function loop(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${BASE}/events`, {
          headers: {
            Accept: "text/event-stream",
            ...(API_KEY ? { "x-api-key": API_KEY } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`/events → ${res.status}`);

        h.onStatus(true);
        backoff = BACKOFF_MIN_MS; // healthy connection resets the backoff

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Frames are separated by a blank line.
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            dispatchFrame(frame, h);
          }
        }
      } catch (err) {
        if (stopped) break;
        console.warn("[live] stream dropped, will reconnect:", err);
      } finally {
        h.onStatus(false);
      }
      if (stopped) break;
      await sleep(backoff + Math.random() * 500);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  }

  void loop();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

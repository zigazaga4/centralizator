/**
 * Client-side persistence shim — talks HTTP to the server's /pairs
 * routes instead of touching SQLite directly.
 *
 * The DB itself now lives on the server (`server/centralizator.db`,
 * managed by `better-sqlite3`). This file's only job is the wire
 * conversion: File ↔ base64, `Pair` ↔ JSON. The exported function
 * signatures are intentionally identical to the previous
 * tauri-plugin-sql-backed implementation so App.tsx didn't have to
 * change.
 *
 * Storage shape (server-owned):
 *   • `pairs`        — one row per pair, scalars + two JSON blobs
 *                      for the OCR-extracted struct and the pricing
 *                      breakdown, plus the `day` filing bucket.
 *   • `pair_images`  — N rows per pair (one slot per attached image,
 *                      in submit order), real SQLite BLOBs for the
 *                      image bytes. One slot is conventionally the AWB
 *                      and the rest are invoices, but the role is
 *                      decided by the vision model, not the schema.
 *
 * Failure mode: if the server is unreachable, every export here logs
 * the error and resolves to a safe no-op (empty list / silent skip).
 * That keeps the UI alive offline-ish — it just loses cross-session
 * memory until the server comes back. Throwing here would crash the
 * pair queue in App.tsx for what's recoverable on the next request.
 */

import type { Extracted, Pair, PairStatus, PricingBreakdown, Service, Verification } from "../types";

/**
 * Vite proxies /api/* to the Fastify server during dev. In a packaged
 * Tauri build we'll point this at the deployed server URL via
 * VITE_API_BASE. Matches `lib/api.ts` so both files reach the same
 * server through the same env knob.
 */
const BASE = import.meta.env.VITE_API_BASE ?? "/api";

/**
 * Shared API key, attached to every request as `x-api-key`. Baked
 * into the bundle at build time from `VITE_CENTRALIZATOR_API_KEY`;
 * mirrors the same env var `lib/api.ts` reads so both files speak to
 * the same authenticated server. Only `/health` is exempt server-side.
 */
const API_KEY = import.meta.env.VITE_CENTRALIZATOR_API_KEY as string | undefined;

/* ──────────────────────────────────────────────────────────────────────
 * Wire shapes (mirror server/src/db.ts PairWire / PairImageWire)
 * ────────────────────────────────────────────────────────────────────── */

/** Status as it arrives on the wire. Structurally identical to the client
 *  `PairStatus` (same discriminated union), exported so the live SSE client
 *  can type the status it receives on a `pair-updated` event. */
export type WireStatus =
  | { kind: "pending" }
  | { kind: "extracting" }
  | {
      kind: "ready";
      service: Service;
      serviceFallback: boolean;
      edits: Extracted;
      breakdown: PricingBreakdown;
      verification?: Verification;
    }
  | { kind: "error"; message: string };

interface WireImage {
  name: string;
  mimeType: string;
  size: number;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataB64: string;
}

export interface WirePair {
  id: string;
  day: string;
  createdAt: number;
  updatedAt: number;
  status: WireStatus;
  images: WireImage[];
}

/* ──────────────────────────────────────────────────────────────────────
 * File ↔ base64 plumbing
 *
 * btoa/atob can't handle multi-MB strings in one shot, so we chunk
 * through fixed-size windows. Same encoding the server expects on
 * the wire (no `data:` prefix, no line breaks).
 * ────────────────────────────────────────────────────────────────────── */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 32 KiB per fromCharCode call — safely under arg limits
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Inverse of `bytesToBase64`. Returns `Uint8Array<ArrayBuffer>`
 * specifically — the generic argument is required by the current
 * `BlobPart` typedef (`Uint8Array<ArrayBufferLike>` isn't assignable).
 * Allocating into a fresh ArrayBuffer guarantees the right view.
 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function fileToWireImage(file: File): Promise<WireImage> {
  const buf = await file.arrayBuffer();
  return {
    name: file.name || "image",
    mimeType: file.type || "image/*",
    size: file.size,
    dataB64: bytesToBase64(new Uint8Array(buf)),
  };
}

function wireImageToFile(w: WireImage): File {
  const bytes = base64ToBytes(w.dataB64);
  return new File([bytes], w.name, { type: w.mimeType || "image/*" });
}

/**
 * Convert one server `WirePair` into the client `Pair` shape: decode each
 * base64 image back into a `File` (skipping any that fail to decode rather
 * than dropping the whole pair) and carry the status across as-is (the wire
 * status union is structurally the client `PairStatus`).
 *
 * Exported so the live SSE client (`lib/live.ts`) reuses the exact same
 * decode path as the initial hydrate — one source of truth for wire→model.
 */
export function wirePairToClient(wp: WirePair): Pair {
  const images: File[] = [];
  for (const wi of wp.images) {
    try {
      images.push(wireImageToFile(wi));
    } catch (err) {
      console.warn(`Failed to decode image for pair ${wp.id}:`, err);
    }
  }
  return { id: wp.id, day: wp.day, images, status: wp.status as PairStatus };
}

/* ──────────────────────────────────────────────────────────────────────
 * HTTP helper — single place that knows how to talk to /api/pairs.
 *
 * Two layers:
 *   • `http`        — single attempt, throws on non-2xx or transport
 *                     failure. Used for reads (loadAllPairs) where retry
 *                     is pointless: if the read fails the caller wants
 *                     to know immediately and surface "offline".
 *   • `httpRetry`   — wraps `http` with bounded exponential backoff.
 *                     Used for the MUTATING endpoints so a transient
 *                     network blip doesn't silently lose a calculated
 *                     pair. Without this, `setStatus(ready)` fires the
 *                     PUT as fire-and-forget, the PUT fails (Wi-Fi
 *                     drop, server restart, app killed mid-flight),
 *                     and on the next launch the UI re-hydrates from
 *                     the server and the calculation is gone.
 * ────────────────────────────────────────────────────────────────────── */

/** Attempt counts: original + 2 retries. Three tries handles the common
 *  transient-failure modes (DNS hiccup, momentary 502 from a proxy,
 *  WebView2 burst-rate-limit) without making genuine outages slow.   */
const RETRY_ATTEMPTS = 3;
/** Backoff before attempt N (N=0 → no wait). 0 / 500 / 2000 ms gives a
 *  total worst-case 2.5 s wall-clock before declaring terminal failure. */
const RETRY_BACKOFF_MS = [0, 500, 2000];

async function http(path: string, init?: RequestInit): Promise<Response> {
  // Merge auth header last so callers can't accidentally clobber it
  // with their own `x-api-key`.
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res;
}

/**
 * 4xx responses (except 408/429) mean the SERVER understood the request
 * and rejected it — a retry will fail identically. 5xx, 408 (timeout),
 * and 429 (rate limit) can succeed on retry; transport errors (fetch
 * throws before getting a response) are network problems, also worth
 * retrying.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // Match the message shape thrown by `http`: "PUT /pairs/... → 404: ..."
  const m = /→\s+(\d{3})\s*:/.exec(err.message);
  if (!m) return true; // transport / fetch error — retry
  const code = Number(m[1]);
  if (code >= 500) return true;
  if (code === 408 || code === 429) return true;
  return false;
}

async function httpRetry(
  label: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const wait = RETRY_BACKOFF_MS[attempt] ?? 0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await http(path, init);
    } catch (err) {
      lastErr = err as Error;
      if (!isRetryable(err)) {
        // Hard rejection (400/404/etc) — don't keep trying.
        console.error(`[db] ${label} rejected (non-retryable):`, err);
        throw err;
      }
      console.warn(
        `[db] ${label} attempt ${attempt + 1}/${RETRY_ATTEMPTS} failed:`,
        err,
      );
    }
  }
  throw lastErr ?? new Error(`${label} failed after ${RETRY_ATTEMPTS} attempts`);
}

/* ──────────────────────────────────────────────────────────────────────
 * Public API — same signatures as the old SQLite-backed module.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Pull every pair (with its N images) back into memory, ordered by
 * insertion time so the queue rebuilds in the exact order the user
 * created it.
 *
 * Pairs that were mid-extraction at the previous shutdown come back as
 * "pending" — the server-side `rowToStatus` does the coercion so we
 * don't have to here.
 */
export async function loadAllPairs(): Promise<Pair[]> {
  try {
    const res = await http("/pairs");
    const body = (await res.json()) as { pairs: WirePair[] };
    // The server returns images in slot order (ORDER BY slot ASC); the
    // shared converter trusts that and drops only individual undecodable
    // images, never a whole pair.
    const pairs = body.pairs.map(wirePairToClient);
    console.info(`[db] loadAllPairs: hydrated ${pairs.length} pair(s) from server.`);
    return pairs;
  } catch (err) {
    console.error(
      "[db] loadAllPairs failed — the queue will NOT survive a reload until the server is reachable.\n" +
        "  Is the Fastify server running? Check the .api-port file at the repo root.",
      err,
    );
    return [];
  }
}

/** Insert a brand-new pair with its N source images. Retries on
 *  transient failure — see `httpRetry`. The caller awaits this so a
 *  hard failure surfaces visibly instead of leaving an in-memory row
 *  that the server never received. */
export async function insertPair(pair: Pair): Promise<void> {
  // Encode image bytes to base64 in parallel — these are independent
  // reads and the encode work isn't tiny for multi-MB photos.
  const images = await Promise.all(pair.images.map(fileToWireImage));
  await httpRetry(`insertPair ${pair.id}`, "/pairs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: pair.id, day: pair.day, images }),
  });
  const total = images.reduce((a, w) => a + w.dataB64.length, 0);
  console.info(
    `[db] insertPair ${pair.id} (+${images.length} images, ${(total / 1024).toFixed(0)} KB b64)`,
  );
}

/**
 * Persist a status transition. The "extracting" state is intentionally
 * a no-op (the server drops it too) — it's a purely optimistic UI
 * flip and would be misleading on rehydrate.
 *
 * Retries on transient failure. Callers SHOULD await this and flip the
 * pair to "error" on rejection rather than fire-and-forget — otherwise
 * the UI lies about a "ready" status the server never received, and
 * the next launch re-hydrates as if the calculation never happened.
 */
export async function persistPairStatus(id: string, status: PairStatus): Promise<void> {
  if (status.kind === "extracting") return;
  await httpRetry(
    `persistPairStatus ${id} → ${status.kind}`,
    `/pairs/${encodeURIComponent(id)}/status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(status),
    },
  );
}

/** Drop a single pair. The server cascades the image rows. */
export async function deletePair(id: string): Promise<void> {
  await httpRetry(`deletePair ${id}`, `/pairs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Clear the entire queue. Kept exported for future "Goleşte tot"
 *  flows; the current UI only deletes per-pair via `deletePair`. */
export async function deleteAllPairs(): Promise<void> {
  await httpRetry("deleteAllPairs", "/pairs", { method: "DELETE" });
}

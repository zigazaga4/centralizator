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
 *   • `pair_images`  — two rows per pair (slot 0 / slot 1), real
 *                      SQLite BLOBs for the image bytes.
 *
 * Failure mode: if the server is unreachable, every export here logs
 * the error and resolves to a safe no-op (empty list / silent skip).
 * That keeps the UI alive offline-ish — it just loses cross-session
 * memory until the server comes back. Throwing here would crash the
 * pair queue in App.tsx for what's recoverable on the next request.
 */

import type { Extracted, Pair, PairStatus, PricingBreakdown, Service } from "../types";

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

type WireStatus =
  | { kind: "pending" }
  | { kind: "extracting" }
  | {
      kind: "ready";
      service: Service;
      serviceFallback: boolean;
      edits: Extracted;
      breakdown: PricingBreakdown;
    }
  | { kind: "error"; message: string };

interface WireImage {
  name: string;
  mimeType: string;
  size: number;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataB64: string;
}

interface WirePair {
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

/* ──────────────────────────────────────────────────────────────────────
 * HTTP helper — single place that knows how to talk to /api/pairs.
 *
 * We swallow network errors at the call sites rather than here so each
 * public function can log a domain-specific message ("Failed to
 * persist new pair", etc.) and keep the queue alive.
 * ────────────────────────────────────────────────────────────────────── */

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

/* ──────────────────────────────────────────────────────────────────────
 * Public API — same signatures as the old SQLite-backed module.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Pull every pair (with its two images) back into memory, ordered by
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
    const pairs: Pair[] = [];
    for (const wp of body.pairs) {
      const images: File[] = [];
      // The server returns images in slot order (ORDER BY slot ASC),
      // so we trust that and just stream through. Decode failures
      // drop the offending image rather than killing the whole pair.
      for (const wi of wp.images) {
        try {
          images.push(wireImageToFile(wi));
        } catch (err) {
          console.warn(`Failed to decode image for pair ${wp.id}:`, err);
        }
      }
      pairs.push({ id: wp.id, day: wp.day, images, status: wp.status });
    }
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

/** Insert a brand-new pair with its two source images. */
export async function insertPair(pair: Pair): Promise<void> {
  // Encode image bytes to base64 in parallel — these are independent
  // reads and the encode work isn't tiny for multi-MB photos.
  const images = await Promise.all(pair.images.map(fileToWireImage));
  await http("/pairs", {
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
 */
export async function persistPairStatus(id: string, status: PairStatus): Promise<void> {
  if (status.kind === "extracting") return;
  await http(`/pairs/${encodeURIComponent(id)}/status`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(status),
  });
}

/** Drop a single pair. The server cascades the image rows. */
export async function deletePair(id: string): Promise<void> {
  await http(`/pairs/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Clear the entire queue. Kept exported for future "Goleşte tot"
 *  flows; the current UI only deletes per-pair via `deletePair`. */
export async function deleteAllPairs(): Promise<void> {
  await http("/pairs", { method: "DELETE" });
}

/**
 * Lazy image loading + in-app caching.
 *
 * The hydrate payload (`GET /pairs`) carries image METADATA only, so
 * the queue paints instantly. The actual bytes stream from
 * `GET /pairs/:id/images/:slot`, one request per image, fetched the
 * first time something needs to show (or re-extract) a pair's images.
 *
 * Three cache layers, cheapest first:
 *   1. In-memory `Map<key, Promise<File>>` — dedupes concurrent
 *      requests for the same image and makes repeat reads in one
 *      session free. Keyed `pairId/slot`.
 *   2. Cache Storage API (`caches.open`) — survives app restarts, so
 *      the SECOND launch of the day costs zero network for images.
 *      Guarded: some WebView contexts don't expose `caches`; we fall
 *      back silently to layers 1 + 3.
 *   3. The HTTP cache — the server marks each image
 *      `Cache-Control: private, max-age=31536000, immutable` + ETag,
 *      so even a plain fetch is disk-served by the WebView when the
 *      explicit Cache Storage layer is unavailable.
 *
 * Images are immutable per (pairId, slot) — written once at insert,
 * never updated — which is what makes aggressive caching safe. Stale
 * entries (deleted pairs) are pruned opportunistically by
 * `prefetchPairImages` against the authoritative pair list.
 */

import { useEffect, useState } from "react";
import type { Pair, PairImageRef } from "../types";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";
const API_KEY = import.meta.env.VITE_CENTRALIZATOR_API_KEY as string | undefined;

/** Bump to invalidate every persisted image (e.g. if the URL scheme
 *  or auth model ever changes shape). */
const CACHE_NAME = "centralizator-images-v1";

/** Layer 1 — session memory. Promises (not Files) so two components
 *  asking for the same image while it's in flight share one request. */
const inFlight = new Map<string, Promise<File>>();

function keyOf(ref: PairImageRef): string {
  return `${ref.pairId}/${ref.slot}`;
}

function urlOf(ref: PairImageRef): string {
  return `${BASE}/pairs/${encodeURIComponent(ref.pairId)}/images/${ref.slot}`;
}

/** Cache Storage handle, or null where the API isn't available
 *  (insecure context / stripped-down WebView). Resolved once. */
async function imageCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function responseToFile(res: Response, ref: PairImageRef): Promise<File> {
  const blob = await res.blob();
  return new File([blob], ref.name || "image", {
    type: ref.mimeType || blob.type || "image/*",
  });
}

/**
 * Fetch one image as a `File`, through all three cache layers.
 * Throws only when the network fails AND no cached copy exists.
 */
export function fetchPairImage(ref: PairImageRef): Promise<File> {
  const key = keyOf(ref);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<File> => {
    const url = urlOf(ref);
    const cache = await imageCache();

    // Layer 2 — persisted copy from a previous session.
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return await responseToFile(hit, ref);
      } catch {
        /* corrupt entry — fall through to the network */
      }
    }

    // Network (layer 3, the HTTP cache, sits transparently under this).
    const res = await fetch(url, {
      headers: API_KEY ? { "x-api-key": API_KEY } : {},
    });
    if (!res.ok) throw new Error(`image ${key} → ${res.status}`);

    // Persist for the next launch. Best-effort: a full disk or an
    // opaque-response quirk must not break the image we already have.
    if (cache) {
      try {
        await cache.put(url, res.clone());
      } catch {
        /* ignore — memory + HTTP cache still cover us */
      }
    }
    return await responseToFile(res, ref);
  })();

  // Keep the promise as the memo on success; evict on failure so a
  // transient network error doesn't poison the cache forever.
  inFlight.set(key, promise);
  promise.catch(() => inFlight.delete(key));
  return promise;
}

/**
 * All of one pair's images as Files, in slot order. Locally-created
 * pairs already hold Files — returned as-is, zero cost. Hydrated
 * pairs resolve their refs in parallel.
 */
export function loadPairImages(pair: Pair): Promise<File[]> {
  if (pair.images.length > 0 || !pair.imageRefs?.length) {
    return Promise.resolve(pair.images);
  }
  return Promise.all(pair.imageRefs.map(fetchPairImage));
}

/**
 * React hook — the component-facing face of the loader. Returns the
 * pair's Files (instantly for local pairs / cached refs, streamed for
 * cold ones) plus a loading flag for skeleton placeholders.
 */
export function usePairImages(pair: Pair): { files: File[]; loading: boolean } {
  const hasLocal = pair.images.length > 0;
  const refCount = pair.imageRefs?.length ?? 0;
  const [files, setFiles] = useState<File[]>(hasLocal ? pair.images : []);
  const [loading, setLoading] = useState(!hasLocal && refCount > 0);

  useEffect(() => {
    if (pair.images.length > 0) {
      setFiles(pair.images);
      setLoading(false);
      return;
    }
    if (!pair.imageRefs?.length) {
      setFiles([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadPairImages(pair)
      .then((loaded) => {
        if (cancelled) return;
        setFiles(loaded);
        setLoading(false);
      })
      .catch((err) => {
        console.warn(`[images] load failed for pair ${pair.id}:`, err);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // pair.images identity changes only on real mutations; imageRefs is
    // set once at hydrate. pair.id covers selection switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.id, pair.images, pair.imageRefs]);

  return { files, loading };
}

/** How many image downloads fly at once during the background warm.
 *  Low enough to never starve the interactive requests. */
const PREFETCH_CONCURRENCY = 4;

/**
 * Background warm-up: after hydrate, stream every pair's images into
 * the cache so thumbnails fill in progressively and opening a pair is
 * instant. `priorityDay`'s pairs download first (that's the tab on
 * screen). Also prunes Cache Storage entries belonging to pairs that
 * no longer exist. Fire-and-forget; all failures are swallowed.
 */
export async function prefetchPairImages(pairs: Pair[], priorityDay?: string): Promise<void> {
  const queue: PairImageRef[] = [...pairs]
    .sort((a, b) => Number(b.day === priorityDay) - Number(a.day === priorityDay))
    .flatMap((p) => (p.images.length > 0 ? [] : (p.imageRefs ?? [])));

  // Prune stale persisted entries (deleted pairs) while we're here.
  void (async () => {
    const cache = await imageCache();
    if (!cache) return;
    try {
      const alive = new Set(pairs.map((p) => p.id));
      for (const req of await cache.keys()) {
        // URL shape: .../pairs/<id>/images/<slot>
        const m = /\/pairs\/([^/]+)\/images\/\d+$/.exec(req.url);
        if (m?.[1] && !alive.has(decodeURIComponent(m[1]))) {
          void cache.delete(req);
        }
      }
    } catch {
      /* hygiene only — never let pruning break anything */
    }
  })();

  if (queue.length === 0) return;
  const workers = Array.from(
    { length: Math.min(PREFETCH_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const ref = queue.shift();
        if (!ref) return;
        await fetchPairImage(ref).catch(() => {
          /* background warm — a miss just means it loads on demand later */
        });
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Perceptual de-duplication — dHash (difference hash) over uploaded photos.
 *
 * The couriers shoot carelessly: the same physical document gets
 * photographed twice, or the same photo gets SENT twice. Before the stack
 * reaches the grouping model, this module drops those near-duplicates
 * deterministically, server-side, so the AI never even sees them.
 *
 * The math:
 *   • each image is reduced to a 9×9 grayscale luminance grid (decode edge,
 *     via sharp);
 *   • the hash is the sign of the discrete gradient of that grid —
 *     72 horizontal bits (is pixel[x] brighter than pixel[x+1]?) plus
 *     72 vertical bits (is pixel[y] brighter than pixel[y+1]?) = 144 bits;
 *   • two images are near-duplicates when the Hamming distance between
 *     their hashes is ≤ DHASH_MAX_DISTANCE.
 *
 * Gradient signs are invariant to brightness/contrast shifts and survive
 * recompression, resizing and slight crops — exactly what "the same photo
 * sent twice" looks like. Two DIFFERENT documents with a similar layout
 * (two invoices from the same supplier) still differ in many gradient
 * signs, so a TIGHT threshold keeps false merges out: dropping a real
 * shipment would be far worse than letting a duplicate through (the
 * grouping prompt still catches those downstream).
 */

import sharp from "sharp";

/** Grid side. 9×9 luminance samples → 2 × 8×9 = 144 gradient bits. */
const GRID = 9;
/** Hash length in bytes: 144 bits / 8. */
export const DHASH_BYTES = (2 * (GRID - 1) * GRID) / 8;

/** Max Hamming distance (out of 144 bits) for two photos to count as the
 *  same photo. 0–4 = identical/recompressed copies; ~9–10 covers a phone/
 *  WhatsApp re-save that also resizes; distinct documents land far above
 *  (30+ even on similar synthetic patterns). Override with
 *  DHASH_MAX_DISTANCE. */
export const DHASH_MAX_DISTANCE = Number(process.env.DHASH_MAX_DISTANCE ?? 10);

/** Popcount lookup for one byte — Hamming distance in O(bytes). */
const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1]! + (i & 1);

/**
 * Compute the 144-bit dHash of one image.
 *
 * Returns null when the bytes cannot be decoded (corrupt upload, codec the
 * server build lacks, e.g. some HEIC variants) — the caller must then KEEP
 * the image: never drop a shipment because we failed to look at it.
 */
export async function dhash(bytes: Buffer): Promise<Uint8Array | null> {
  let px: Buffer;
  try {
    ({ data: px } = await sharp(bytes)
      .grayscale()
      .resize(GRID, GRID, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return null;
  }

  const hash = new Uint8Array(DHASH_BYTES);
  let bit = 0;
  const setBit = (on: boolean) => {
    if (on) hash[bit >> 3]! |= 1 << (bit & 7);
    bit++;
  };
  // Horizontal gradient signs: GRID rows × (GRID-1) comparisons.
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID - 1; x++) setBit(px[y * GRID + x]! > px[y * GRID + x + 1]!);
  // Vertical gradient signs: (GRID-1) rows × GRID comparisons.
  for (let y = 0; y < GRID - 1; y++)
    for (let x = 0; x < GRID; x++) setBit(px[y * GRID + x]! > px[(y + 1) * GRID + x]!);
  return hash;
}

/** Hamming distance between two equal-length hashes (number of differing bits). */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[a[i]! ^ b[i]!]!;
  return d;
}

/** One dropped image: which index it was, and which kept index it duplicated. */
export interface DhashDuplicate {
  index: number;
  ofIndex: number;
  distance: number;
}

export interface DhashDedupResult {
  /** Indices to keep, in original order. */
  keptIndices: number[];
  /** Indices dropped as near-duplicates of an earlier kept image. */
  duplicates: DhashDuplicate[];
}

/**
 * Greedy keep-first dedup over an ordered image stack.
 *
 * Walks the stack in scan order; an image whose hash sits within
 * `maxDistance` of any already-kept image is a duplicate of the CLOSEST
 * such image and is dropped. Undecodable images are always kept.
 *
 * Hashes are computed in parallel (sharp fans the decodes across libvips
 * worker threads); the O(n²) Hamming pass is microseconds at stack sizes.
 */
export async function dedupeByDhash(
  buffers: Buffer[],
  maxDistance: number = DHASH_MAX_DISTANCE,
): Promise<DhashDedupResult> {
  const hashes = await Promise.all(buffers.map((b) => dhash(b)));

  const keptIndices: number[] = [];
  const duplicates: DhashDuplicate[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const h = hashes[i];
    if (!h) {
      keptIndices.push(i); // undecodable → never drop
      continue;
    }
    let bestOf = -1;
    let bestDist = Infinity;
    for (const k of keptIndices) {
      const kh = hashes[k];
      if (!kh) continue;
      const d = hammingDistance(h, kh);
      if (d < bestDist) {
        bestDist = d;
        bestOf = k;
      }
    }
    if (bestOf !== -1 && bestDist <= maxDistance) {
      duplicates.push({ index: i, ofIndex: bestOf, distance: bestDist });
    } else {
      keptIndices.push(i);
    }
  }
  return { keptIndices, duplicates };
}

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { dhash, hammingDistance, dedupeByDhash, DHASH_BYTES } from "./dhash.js";

/** Deterministic grayscale test image from a per-pixel intensity function. */
async function makeJpeg(
  f: (x: number, y: number) => number,
  { width = 240, height = 320, quality = 90 } = {},
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw[y * width + x] = Math.max(0, Math.min(255, Math.round(f(x, y))));
  return sharp(raw, { raw: { width, height, channels: 1 } }).jpeg({ quality }).toBuffer();
}

// Two visually DISTINCT "documents": different stripe phase + diagonal field.
const docA = (x: number, y: number) => 128 + 100 * Math.sin(x / 9) + 60 * Math.sin(y / 13);
const docB = (x: number, y: number) => 128 + 100 * Math.sin(y / 7 + 2) - 60 * Math.sin((x + y) / 11);

describe("dhash", () => {
  it("hashes are the right width and identical bytes hash identically", async () => {
    const img = await makeJpeg(docA);
    const h1 = await dhash(img);
    const h2 = await dhash(Buffer.from(img));
    expect(h1).not.toBeNull();
    expect(h1!.length).toBe(DHASH_BYTES);
    expect(hammingDistance(h1!, h2!)).toBe(0);
  });

  it("survives recompression and resize (same photo re-saved by a phone)", async () => {
    const original = await makeJpeg(docA, { quality: 95 });
    const recompressed = await sharp(original).jpeg({ quality: 50 }).toBuffer();
    const resized = await sharp(original).resize(180, 240).jpeg({ quality: 80 }).toBuffer();
    const h = (await dhash(original))!;
    expect(hammingDistance(h, (await dhash(recompressed))!)).toBeLessThanOrEqual(4);
    expect(hammingDistance(h, (await dhash(resized))!)).toBeLessThanOrEqual(10);
  });

  it("keeps distinct documents far apart", async () => {
    const hA = (await dhash(await makeJpeg(docA)))!;
    const hB = (await dhash(await makeJpeg(docB)))!;
    expect(hammingDistance(hA, hB)).toBeGreaterThan(30);
  });

  it("returns null for undecodable bytes", async () => {
    expect(await dhash(Buffer.from("definitely not an image"))).toBeNull();
  });
});

describe("dedupeByDhash", () => {
  it("drops the later copy of a re-sent photo, keeps scan order", async () => {
    const a = await makeJpeg(docA);
    const b = await makeJpeg(docB);
    const aAgain = await sharp(a).jpeg({ quality: 55 }).toBuffer(); // "sent twice"
    const { keptIndices, duplicates } = await dedupeByDhash([a, b, aAgain]);
    expect(keptIndices).toEqual([0, 1]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ index: 2, ofIndex: 0 });
  });

  it("never drops an undecodable image", async () => {
    const a = await makeJpeg(docA);
    const junk = Buffer.from("junk bytes");
    const { keptIndices, duplicates } = await dedupeByDhash([a, junk, junk]);
    expect(keptIndices).toEqual([0, 1, 2]);
    expect(duplicates).toHaveLength(0);
  });

  it("keeps everything when all images are distinct", async () => {
    const imgs = await Promise.all([docA, docB].map((f) => makeJpeg(f)));
    const { keptIndices, duplicates } = await dedupeByDhash(imgs);
    expect(keptIndices).toEqual([0, 1]);
    expect(duplicates).toHaveLength(0);
  });
});

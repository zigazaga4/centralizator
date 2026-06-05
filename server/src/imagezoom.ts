/**
 * Image zoom helper for the vision extraction loop.
 *
 * When the model can't read a small or blurry field (the classic case: a
 * tiny AWB label laid on top of an invoice), it calls the `zoom_region`
 * tool with a normalised rectangle. We crop that rectangle out of the
 * original bytes and upscale it so the text is legible, then hand the crop
 * back as a fresh image for the model to read.
 *
 * Normalised coordinates (0..1) are used on the wire because the model
 * does not know each image's pixel dimensions — it reasons in fractions of
 * the frame ("the label is the top-right quarter"). We resolve those to
 * pixels here against the real metadata.
 */

import sharp from "sharp";

export interface CropResult {
  /** `data:<mime>;base64,...` ready to drop into an image_url part. */
  dataUrl: string;
  /** Final crop pixel size, for logging. */
  width: number;
  height: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Crop a normalised region from an image and upscale it for legibility.
 *
 * @param buffer  original image bytes
 * @param region  { x0, y0, x1, y1 } in 0..1 (top-left → bottom-right)
 * @param targetLongSide  upscale so the longer side reaches this many px
 *                        (only enlarges, never shrinks below the crop)
 */
export async function cropRegion(
  buffer: Buffer,
  region: { x0: number; y0: number; x1: number; y1: number },
  targetLongSide = 1400,
): Promise<CropResult> {
  const img = sharp(buffer, { failOn: "none" }).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("Could not read image dimensions for zoom.");

  // Normalise + order the corners, enforce a sane minimum window (8% of the
  // frame) so a degenerate near-zero box still yields something readable.
  let x0 = clamp01(Math.min(region.x0, region.x1));
  let y0 = clamp01(Math.min(region.y0, region.y1));
  let x1 = clamp01(Math.max(region.x0, region.x1));
  let y1 = clamp01(Math.max(region.y0, region.y1));
  const MIN = 0.08;
  if (x1 - x0 < MIN) {
    const c = (x0 + x1) / 2;
    x0 = clamp01(c - MIN / 2);
    x1 = clamp01(c + MIN / 2);
  }
  if (y1 - y0 < MIN) {
    const c = (y0 + y1) / 2;
    y0 = clamp01(c - MIN / 2);
    y1 = clamp01(c + MIN / 2);
  }

  const left = Math.floor(x0 * W);
  const top = Math.floor(y0 * H);
  const width = Math.max(1, Math.min(W - left, Math.ceil((x1 - x0) * W)));
  const height = Math.max(1, Math.min(H - top, Math.ceil((y1 - y0) * H)));

  const longSide = Math.max(width, height);
  const scale = longSide < targetLongSide ? targetLongSide / longSide : 1;
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);

  const out = await sharp(buffer, { failOn: "none" })
    .rotate()
    .extract({ left, top, width, height })
    .resize(outW, outH, { kernel: "lanczos3", fit: "fill" })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    dataUrl: `data:image/jpeg;base64,${out.toString("base64")}`,
    width: outW,
    height: outH,
  };
}

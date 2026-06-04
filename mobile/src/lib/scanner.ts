/**
 * Document detector — pure JavaScript, zero dependencies, content-based.
 *
 * WHY THIS APPROACH (and not page-boundary edges):
 * The previous version hunted for the page's four OUTER edges inside border
 * windows. But the natural way people scan is to hold the document close so it
 * *fills* (or overflows) the viewfinder — in which case the page edges are
 * off-screen and there is nothing to find. That made it lock almost never.
 *
 * Real shipping scanners detect a document by its CONTENT, not its rim. AWBs
 * and invoices are always covered in text, ruled lines and barcodes, which
 * produce dense, crisp gradients spread across the frame. A bare desk, a hand,
 * or a blank wall does not. So we measure how much of the frame is covered by
 * such content and whether that coverage is spread out (a real page) rather
 * than a single streak (the edge of a table). This is forgiving to tilt,
 * lighting and off-screen edges, and runs instantly on a weak CPU.
 *
 * Per frame (downscaled to ~200 px wide):
 *   1. Grayscale, then per-pixel gradient magnitude |gx| + |gy|.
 *   2. Split the frame into a grid of cells. A cell is "content" when a real
 *      fraction of its pixels are crisp edges (print/lines/barcodes).
 *   3. "ready" when content covers enough of the frame, reaches the centre,
 *      and is spread across most rows AND columns. The caller adds temporal
 *      stability on top, so green means sure.
 */

export interface Detection {
  /** Some document-like content is present (soft hint). */
  found: boolean;
  /** Confident: a page-worth of content fills and spreads across the frame. */
  ready: boolean;
  /** Fraction of frame cells that contain content, 0..1. */
  areaRatio: number;
  /** Spread quality 0..1 (how evenly content covers rows/cols; 1 = full). */
  offset: number;
}

const NONE: Detection = { found: false, ready: false, areaRatio: 0, offset: 0 };

/** Detection runs on a frame downscaled to this width (height keeps aspect). */
const DET_W = 200;

/** Analysis grid. Portrait-ish, so a few more rows than columns. */
const CELLS_X = 10;
const CELLS_Y = 14;

// A pixel counts as a crisp edge when |gx|+|gy| clears this (0..510 scale).
const EDGE_PIX_THR = 26;
// A cell is "content" when this fraction of its pixels are crisp edges.
const CELL_CONTENT_FRAC = 0.045;

// Confidence gates (all must hold for a green-worthy frame).
const COVERAGE_MIN = 0.22; // ≥22% of cells carry content → a page, not a speck
const CENTER_MIN = 0.3; // the central zone must itself be covered
const SPREAD_MIN = 0.5; // content reaches ≥half the rows AND half the cols
// Soft "found" floor for hint purposes (something is there).
const FOUND_MIN = 0.1;

/** Compatibility shim — detection is synchronous, nothing to load. */
export async function initScanner(): Promise<void> {
  /* no-op */
}

/** Reused offscreen canvas for the downscale (no per-frame allocation). */
let work: HTMLCanvasElement | null = null;

export function detect(source: HTMLCanvasElement): Detection {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return NONE;

  const w = DET_W;
  const h = Math.max(1, Math.round((DET_W * sh) / sw));
  if (!work) work = document.createElement("canvas");
  if (work.width !== w || work.height !== h) {
    work.width = w;
    work.height = h;
  }
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) return NONE;
  ctx.drawImage(source, 0, 0, w, h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return NONE;
  }

  // Grayscale (luma).
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  }

  // Per-cell tallies of edge pixels vs. total pixels.
  const cellCount = CELLS_X * CELLS_Y;
  const edges = new Int32Array(cellCount);
  const totals = new Int32Array(cellCount);

  for (let y = 1; y < h - 1; y++) {
    const yw = y * w;
    const cy = Math.min(CELLS_Y - 1, ((y * CELLS_Y) / h) | 0);
    const rowBase = cy * CELLS_X;
    for (let x = 1; x < w - 1; x++) {
      const idx = yw + x;
      const gx = Math.abs(gray[idx + 1]! - gray[idx - 1]!);
      const gy = Math.abs(gray[idx + w]! - gray[idx - w]!);
      const cx = Math.min(CELLS_X - 1, ((x * CELLS_X) / w) | 0);
      const cell = rowBase + cx;
      totals[cell]!++;
      if (gx + gy >= EDGE_PIX_THR) edges[cell]!++;
    }
  }

  // Which cells carry content, and where.
  let contentCells = 0;
  let centerCells = 0;
  let centerTotal = 0;
  const rowHit = new Uint8Array(CELLS_Y);
  const colHit = new Uint8Array(CELLS_X);

  // Central zone = inner ~60% of the grid (where the document should sit).
  const cyLo = Math.floor(CELLS_Y * 0.2);
  const cyHi = Math.ceil(CELLS_Y * 0.8);
  const cxLo = Math.floor(CELLS_X * 0.2);
  const cxHi = Math.ceil(CELLS_X * 0.8);

  for (let gyi = 0; gyi < CELLS_Y; gyi++) {
    for (let gxi = 0; gxi < CELLS_X; gxi++) {
      const cell = gyi * CELLS_X + gxi;
      const tot = totals[cell]!;
      if (tot === 0) continue;
      const frac = edges[cell]! / tot;
      const isContent = frac >= CELL_CONTENT_FRAC;
      const inCenter = gyi >= cyLo && gyi < cyHi && gxi >= cxLo && gxi < cxHi;
      if (inCenter) centerTotal++;
      if (isContent) {
        contentCells++;
        rowHit[gyi] = 1;
        colHit[gxi] = 1;
        if (inCenter) centerCells++;
      }
    }
  }

  const coverage = contentCells / cellCount;
  const centerCoverage = centerTotal ? centerCells / centerTotal : 0;

  let rows = 0;
  for (let i = 0; i < CELLS_Y; i++) rows += rowHit[i]!;
  let cols = 0;
  for (let i = 0; i < CELLS_X; i++) cols += colHit[i]!;
  const rowSpread = rows / CELLS_Y;
  const colSpread = cols / CELLS_X;
  const spread = Math.min(rowSpread, colSpread);

  const ready =
    coverage >= COVERAGE_MIN &&
    centerCoverage >= CENTER_MIN &&
    rowSpread >= SPREAD_MIN &&
    colSpread >= SPREAD_MIN;

  return { found: coverage >= FOUND_MIN, ready, areaRatio: coverage, offset: spread };
}

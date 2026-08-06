/**
 * PDF ingestion — rasterize a PDF into one JPEG per page.
 *
 * Operators increasingly hand in PDFs instead of photos (a scanner that
 * emails a PDF, a courier portal that exports the AWB as PDF, an invoice
 * saved straight from Leroy Merlin). Rather than teaching every downstream
 * stage about a second document format, we convert at the INGEST BOUNDARY:
 * a PDF becomes N page images, and from that point on the pipeline is
 * unchanged — classify reads each page like a photo, the linker pairs them,
 * dedup/storage/thumbnails/zoom all keep working on plain JPEGs.
 *
 * That also gives the right behaviour for free: a 2-page PDF holding an AWB
 * and its invoice pairs exactly like two photos of the same documents.
 *
 * Rasterizing is done with poppler's `pdftoppm` (already on the box), not a
 * JS PDF library: it is fast, handles scanned + vector PDFs alike, and keeps
 * the heavy lifting out of the event loop.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

export const PDF_MIME = "application/pdf";

/** Rendering resolution. 200 dpi keeps an A4 invoice's smallest print legible
 *  to the vision model without producing needlessly huge frames. */
const PDF_DPI = Number(process.env.PDF_RASTER_DPI ?? 200);

/** Safety cap on pages per PDF: a mis-dropped 300-page catalogue must not
 *  turn into 300 vision calls. */
const PDF_MAX_PAGES = Number(process.env.PDF_MAX_PAGES ?? 24);

/** JPEG quality for the rendered pages — high enough for OCR, small enough
 *  to store and upload comfortably. */
const PDF_JPEG_QUALITY = Number(process.env.PDF_JPEG_QUALITY ?? 88);

/** How long a single conversion may take before we give up. */
const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS ?? 120_000);

/** Ceiling on a rendered page's long edge. A PDF whose page box is declared in
 *  pixels rather than points (some "image wrapped in a PDF" exports do this)
 *  would otherwise render enormous at 200 dpi — pure upscale, no extra detail,
 *  but a big upload and a big vision bill. A4 at 200 dpi is ~2339 px, so this
 *  never touches a normal document. */
const PDF_MAX_EDGE_PX = Number(process.env.PDF_MAX_EDGE_PX ?? 2600);

/** Every %PDF file starts with this magic, so we can spot one even when the
 *  browser/phone sends a generic or wrong content-type. */
const PDF_MAGIC = Buffer.from("%PDF-");

/** Is this upload a PDF — by declared MIME type OR by file magic? */
export function isPdf(mimeType: string, bytes?: Buffer): boolean {
  if (mimeType.toLowerCase() === PDF_MIME) return true;
  return !!bytes && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

export interface RasterPage {
  /** Page image bytes (JPEG). */
  bytes: Buffer;
  /** Always "image/jpeg" — the pipeline downstream only sees images. */
  mimeType: string;
  /** 1-based page number, for naming/logging. */
  page: number;
}

/**
 * Render every page of `pdfBytes` to a JPEG. Returns the pages in order.
 *
 * Throws when the file is not a readable PDF (encrypted, truncated, not a
 * PDF at all) so the route can answer 415 rather than silently ingesting
 * nothing. An empty result is likewise an error: a PDF with no renderable
 * page is not something the operator can act on.
 */
export async function rasterizePdf(pdfBytes: Buffer): Promise<RasterPage[]> {
  const dir = await mkdtemp(join(tmpdir(), "centralizator-pdf-"));
  const src = join(dir, "in.pdf");
  const prefix = join(dir, "page");
  try {
    await writeFile(src, pdfBytes);
    // -jpeg + -r dpi + -l lastPage. The prefix makes pdftoppm write
    // page-1.jpg, page-2.jpg, … (zero-padded when there are many pages).
    await run(
      "pdftoppm",
      [
        "-jpeg",
        "-jpegopt", `quality=${PDF_JPEG_QUALITY}`,
        "-r", String(PDF_DPI),
        "-l", String(PDF_MAX_PAGES),
        src,
        prefix,
      ],
      { timeout: PDF_TIMEOUT_MS, maxBuffer: 1 << 20 },
    );

    const files = (await readdir(dir))
      .filter((f) => f.startsWith("page") && f.endsWith(".jpg"))
      // pdftoppm zero-pads only when needed, so sort NUMERICALLY by the page
      // index rather than lexically ("page-10.jpg" must not precede "page-2").
      .map((f) => ({ f, n: Number(f.match(/-(\d+)\.jpg$/)?.[1] ?? 0) }))
      .sort((a, b) => a.n - b.n);

    if (files.length === 0) {
      throw new Error("PDF-ul nu conține nicio pagină care să poată fi citită.");
    }

    const pages: RasterPage[] = [];
    for (const { f, n } of files) {
      const rendered = await readFile(join(dir, f));
      // Clamp an over-large render (see PDF_MAX_EDGE_PX). `withoutEnlargement`
      // guarantees we only ever shrink, never upscale a small scan.
      const meta = await sharp(rendered).metadata();
      const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
      const bytes: Buffer =
        longEdge > PDF_MAX_EDGE_PX
          ? await sharp(rendered)
              .resize({
                width: PDF_MAX_EDGE_PX,
                height: PDF_MAX_EDGE_PX,
                fit: "inside",
                withoutEnlargement: true,
              })
              .jpeg({ quality: PDF_JPEG_QUALITY })
              .toBuffer()
          : rendered;
      pages.push({ bytes, mimeType: "image/jpeg", page: n });
    }
    return pages;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    throw new Error(`PDF-ul nu a putut fi convertit în imagini: ${msg}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort temp cleanup */
    });
  }
}

/**
 * Expand one uploaded file into the image(s) the pipeline should ingest:
 * a PDF becomes its pages, any other file passes straight through. Page
 * images are named "<original> (p1)" so the operator can tell which page of
 * which document a pair came from.
 */
export async function expandUploadToImages<T extends { name: string; mimeType: string; bytes: Buffer }>(
  file: T,
): Promise<Array<{ name: string; mimeType: string; bytes: Buffer }>> {
  if (!isPdf(file.mimeType, file.bytes)) {
    return [{ name: file.name, mimeType: file.mimeType, bytes: file.bytes }];
  }
  const pages = await rasterizePdf(file.bytes);
  const base = file.name.replace(/\.pdf$/i, "");
  return pages.map((p) => ({
    name: pages.length > 1 ? `${base} (p${p.page}).jpg` : `${base}.jpg`,
    mimeType: p.mimeType,
    bytes: p.bytes,
  }));
}

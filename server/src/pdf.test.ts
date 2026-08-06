import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { isPdf, rasterizePdf, expandUploadToImages, PDF_MIME } from "./pdf.js";

/** A minimal, genuinely valid multi-page PDF built by hand (no fixtures on
 *  disk, no deps): each page carries one line of text. */
function makePdf(lines: string[]): Buffer {
  const objs: string[] = [];
  const contents = lines.map((t) => `BT /F1 24 Tf 60 700 Td (${t}) Tj ET`);
  const fontObj = 3 + lines.length * 2;
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] =
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${lines.length} >>`;
  lines.forEach((_, i) => {
    const pg = 3 + i * 2;
    objs[pg] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${pg + 1} 0 R >>`;
    objs[pg + 1] = `<< /Length ${contents[i]!.length} >>\nstream\n${contents[i]}\nendstream`;
  });
  objs[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let out = "%PDF-1.4\n";
  const off: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    off[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(off[i]).padStart(10, "0") + " 00000 n \n";
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("isPdf", () => {
  it("accepts the declared PDF mime type", () => {
    expect(isPdf(PDF_MIME)).toBe(true);
    expect(isPdf("APPLICATION/PDF")).toBe(true);
  });

  it("sniffs the %PDF magic when the mime type is generic", () => {
    // Phones/file pickers routinely send octet-stream for a picked PDF.
    expect(isPdf("application/octet-stream", makePdf(["x"]))).toBe(true);
  });

  it("does not mistake an image for a PDF", () => {
    expect(isPdf("image/jpeg")).toBe(false);
    expect(isPdf("application/octet-stream", Buffer.from("\xFF\xD8\xFF not a pdf"))).toBe(false);
  });
});

describe("rasterizePdf", () => {
  it("renders one JPEG per page, in page order", async () => {
    const pages = await rasterizePdf(makePdf(["page one", "page two", "page three"]));
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages.every((p) => p.mimeType === "image/jpeg")).toBe(true);
    // Each page must be a real, decodable image of the A4 box.
    for (const p of pages) {
      const meta = await sharp(p.bytes).metadata();
      expect(meta.format).toBe("jpeg");
      expect((meta.width ?? 0) > 100).toBe(true);
    }
  }, 60_000);

  it("rejects a corrupt PDF instead of silently ingesting nothing", async () => {
    await expect(rasterizePdf(Buffer.from("%PDF-1.4 hopelessly truncated"))).rejects.toThrow();
  }, 60_000);
});

describe("expandUploadToImages", () => {
  it("passes a normal image straight through, untouched", async () => {
    const bytes = Buffer.from("pretend-jpeg-bytes");
    const out = await expandUploadToImages({ name: "photo.jpg", mimeType: "image/jpeg", bytes });
    expect(out).toEqual([{ name: "photo.jpg", mimeType: "image/jpeg", bytes }]);
  });

  it("expands a multi-page PDF into per-page images with page-numbered names", async () => {
    const out = await expandUploadToImages({
      name: "scan.pdf",
      mimeType: PDF_MIME,
      bytes: makePdf(["awb", "factura"]),
    });
    expect(out.map((o) => o.name)).toEqual(["scan (p1).jpg", "scan (p2).jpg"]);
    expect(out.every((o) => o.mimeType === "image/jpeg")).toBe(true);
  }, 60_000);

  it("drops the page suffix for a single-page PDF", async () => {
    const out = await expandUploadToImages({
      name: "awb.pdf",
      mimeType: PDF_MIME,
      bytes: makePdf(["single"]),
    });
    expect(out.map((o) => o.name)).toEqual(["awb.jpg"]);
  }, 60_000);
});

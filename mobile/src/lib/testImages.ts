/**
 * Bundled sample batch for the Test button.
 *
 * Six real photos (three AWB + invoice pairs from Leroy Merlin Romania),
 * shipped inside the app so a single tap can fire a known-good batch at the
 * server without needing to scan anything. Vite inlines each import as a URL
 * into the bundle; we fetch those back into `File`s so they flow through the
 * exact same `scanBatch` path as a live capture.
 *
 * Order matters for clean grouping: each pair is AWB first, then its invoice.
 *   1. Elena Stoicescu — Piopeni   (AWB 004205106 / FACT …6932)
 *   2. Manuel Chetran — Huși       (AWB 038112124 / FACT …7530)
 *   3. Liviu Urlateanu — Bălcoi    (AWB 004204348 / FACT …4116)
 */
import p1awb from "../assets/test/p1-awb.jpeg";
import p1inv from "../assets/test/p1-invoice.jpeg";
import p2awb from "../assets/test/p2-awb.jpeg";
import p2inv from "../assets/test/p2-invoice.jpeg";
import p3awb from "../assets/test/p3-awb.jpeg";
import p3inv from "../assets/test/p3-invoice.jpeg";

const TEST_BATCH: ReadonlyArray<{ url: string; name: string }> = [
  { url: p1awb, name: "test-p1-awb.jpeg" },
  { url: p1inv, name: "test-p1-invoice.jpeg" },
  { url: p2awb, name: "test-p2-awb.jpeg" },
  { url: p2inv, name: "test-p2-invoice.jpeg" },
  { url: p3awb, name: "test-p3-awb.jpeg" },
  { url: p3inv, name: "test-p3-invoice.jpeg" },
];

/** Load the bundled sample batch as `File`s (AWB, invoice, … in pair order). */
export async function loadTestBatch(): Promise<File[]> {
  return Promise.all(
    TEST_BATCH.map(async ({ url, name }) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Nu pot încărca imaginea de test (${name}).`);
      const blob = await res.blob();
      return new File([blob], name, { type: blob.type || "image/jpeg" });
    }),
  );
}

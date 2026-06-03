/**
 * Leroy Merlin product resolution + spec parsing.
 *
 * Pipeline, per invoice product code:
 *   1. Google-search `site:leroymerlin.ro <code>` (ScrapingDog Google API).
 *      A bare product code returns the exact product page at rank 1; the
 *      product URL ends in `-<digits>.html`.
 *   2. Scrape that page to Markdown (ScrapingDog premium + JS render).
 *   3. Parse the H1 name, brand, per-piece price, packaged weight, unit
 *      area and the nominal dimensions out of the "Tabelul cu
 *      caracteristicile produsului" block.
 *
 * Everything that touches the network lives in `resolveLmProduct`. The
 * parsers (`parseDimsMm`, `parseLmProduct`) are pure and unit-tested so
 * the comparison logic can be trusted without hitting ScrapingDog.
 */

import { googleSearch, scrapeMarkdown } from "./scrapingdog.js";

export interface LmProduct {
  /** The exact string we searched for (the invoice code/name). */
  query: string;
  found: boolean;
  url: string | null;
  /** H1 product title — the canonical manufacturer title, e.g.
   *  "Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²". */
  name: string | null;
  brand: string | null;
  /** Listed price per piece (buc), RON. Null when only an area price
   *  (lei/m²) is shown. Display-only. */
  priceBuc: number | null;
  /** "Produs ambalat: greutate (in kg)" — packaged weight of ONE unit. */
  weightKg: number | null;
  /** "Suprafaţa produsului (in m²)" — area covered by one unit/pack, if
   *  stated. Lets us convert m²-billed lines to a piece count for the
   *  weight cross-check (relevant for the bulky insulation lines). */
  areaM2: number | null;
  /** Nominal product dimensions in millimetres, ascending. Parsed from
   *  the product NAME first (apples-to-apples with the invoice line
   *  name), then from the spec table (grosime/lăţime/lungime/…). */
  dimsMm: number[];
}

/* ──────────────────────────────────────────────────────────────────────
 * Dimension parsing
 *
 * Turn a free-text size like "10 x 100 x 50 cm" into a sorted multiset of
 * millimetre lengths [100, 500, 1000]. Both the invoice size and the
 * Leroy Merlin product name go through this, so a wrong-size code surfaces
 * as a mismatch even though the formatting differs.
 *
 * Rules:
 *   • Separators ×, ✕, X all normalise to "x". Decimal commas → dots.
 *   • A group is one or more numbers joined by "x" followed by a single
 *     LENGTH unit (mm | cm | m). The trailing unit applies to every
 *     number in the group ("10 x 100 x 50 cm" → all cm).
 *   • Area/volume units are excluded via a negative lookahead: "2.5 m²",
 *     "2,5 mp", "5 l", "10 m2" never count as a dimension.
 *   • A bare unit-less group ("100x50") is ignored — without a unit we
 *     can't compare it safely, and guessing would cause false mismatches.
 * ────────────────────────────────────────────────────────────────────── */

const UNIT_TO_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000 };

export function parseDimsMm(text: string | null | undefined): number[] {
  if (!text) return [];
  let s = text.toLowerCase().replace(/[×✕]/g, "x");
  // Decimal comma → dot, but only between digits (so "50 cm, 2.5" keeps
  // the list comma as a separator).
  s = s.replace(/(\d),(\d)/g, "$1.$2");

  const out: number[] = [];
  // number (x number)*  <length-unit not followed by ² / 2 / 3 / a letter>
  const groupRe = /(\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)*)\s*(mm|cm|m)(?![²³2-9a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = groupRe.exec(s)) !== null) {
    const unit = m[2]!.toLowerCase();
    const factor = UNIT_TO_MM[unit];
    if (!factor) continue;
    for (const tok of m[1]!.split("x")) {
      const n = parseFloat(tok.trim());
      if (Number.isFinite(n) && n > 0) out.push(Math.round(n * factor));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * Compare two millimetre dimension multisets.
 *   • "unknown"  — either side has no parseable dimension (can't judge).
 *   • "match"    — same count and every paired value within tolerance
 *                  (max of 2 mm or 3 %).
 *   • "mismatch" — different count, or a paired value outside tolerance.
 */
export function compareDims(a: number[], b: number[]): "match" | "mismatch" | "unknown" {
  if (a.length === 0 || b.length === 0) return "unknown";
  if (a.length !== b.length) return "mismatch";
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const tol = Math.max(2, 0.03 * Math.max(x, y));
    if (Math.abs(x - y) > tol) return "mismatch";
  }
  return "match";
}

/* ──────────────────────────────────────────────────────────────────────
 * Markdown spec parsing (pure)
 * ────────────────────────────────────────────────────────────────────── */

/** Parse a Romanian decimal ("3,7" or "3.7") into a number, or null. */
function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/\s+/g, ""));
  if (!m) return null;
  const v = parseFloat(m[0]!.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

/**
 * Find the value that follows a spec label. The Markdown renders the
 * characteristics table as alternating non-empty lines (label, value),
 * so the value is the next non-empty line after the first line whose
 * START matches `labelRe`. Anchoring at the start keeps "Lăţime (in m)"
 * from also matching the packaged "Produs ambalat: lăţime (in cm)".
 */
function specValue(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (labelRe.test(lines[i]!)) return lines[i + 1] ?? null;
  }
  return null;
}

/** Length unit named inside a spec label, e.g. "Grosime (in mm)". */
function unitFromLabel(lines: string[], labelRe: RegExp): number | null {
  for (const line of lines) {
    if (!labelRe.test(line)) continue;
    const m = /\(in\s*(mm|cm|m)\b/i.exec(line);
    if (m) return UNIT_TO_MM[m[1]!.toLowerCase()] ?? null;
    return null;
  }
  return null;
}

export function parseLmProduct(query: string, url: string, markdown: string): LmProduct {
  const lines = markdown
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Name = first H1 ("# ...").
  let name: string | null = null;
  for (const l of lines) {
    if (l.startsWith("# ")) {
      name = l.slice(2).trim();
      break;
    }
  }

  const brand = specValue(lines, /^brand\b/i);
  const weightKg = num(specValue(lines, /^produs ambalat:\s*greutate/i));
  const areaM2 = num(specValue(lines, /^suprafa[tţ]a produsului/i));

  // Price per piece: "86,18 lei de către buc." (prefer buc; area price is
  // "lei de către m²" which we skip for the per-piece figure).
  let priceBuc: number | null = null;
  const priceMatch = /([\d.,]+)\s*lei\s+de\s+c[ăa]tre\s+buc/i.exec(markdown);
  if (priceMatch) priceBuc = num(priceMatch[1]);

  // Nominal dimensions: prefer the product NAME (same source as the
  // invoice line name), else assemble from the spec table.
  let dimsMm = parseDimsMm(name);
  if (dimsMm.length === 0) {
    const specDims: number[] = [];
    // No \b after the stem: Romanian articulated forms append -a/-ul
    // ("Lăţimea", "Lungimea"), so a trailing word char must still match.
    // The ^ anchor already excludes the packaged "Produs ambalat: …" rows.
    const dimSpecs: RegExp[] = [
      /^grosime/i,
      /^l[aă][tţ]ime/i,
      /^lungime/i,
      /^[iî]n[aă]l[tţ]ime/i,
      /^ad[aâ]ncime/i,
      /^diametru/i,
    ];
    for (const re of dimSpecs) {
      // Skip packaged ("Produs ambalat: …") variants — those are box
      // dimensions, not the product's nominal size.
      const value = num(specValue(lines, re));
      const factor = unitFromLabel(lines, re);
      if (value != null && factor != null) specDims.push(Math.round(value * factor));
    }
    dimsMm = specDims.sort((a, b) => a - b);
  }

  return { query, found: true, url, name, brand, priceBuc, weightKg, areaM2, dimsMm };
}

/* ──────────────────────────────────────────────────────────────────────
 * Resolution (network)
 * ────────────────────────────────────────────────────────────────────── */

/** A real product page URL: www.leroymerlin.ro/.../<slug>-<digits>.html */
const PRODUCT_URL_RE = /^https?:\/\/(?:www\.)?leroymerlin\.ro\/.*-\d+\.html$/i;

/** Pick the best product-page URL from organic results. Prefers a real
 *  product page (slug ends `-<digits>.html`) on the canonical host, and
 *  ignores category pages, PDFs, and backend/uat hosts. */
export function pickProductUrl(results: { link?: string }[]): string | null {
  for (const r of results) {
    const link = r.link?.trim();
    if (link && PRODUCT_URL_RE.test(link)) return link;
  }
  return null;
}

/**
 * Resolve one invoice code/name to a Leroy Merlin product (search →
 * scrape → parse). Returns `{ found: false }` when no product page is
 * found. Network errors propagate to the caller, which downgrades the
 * item to "not checked" rather than failing the whole pair.
 */
export async function resolveLmProduct(query: string): Promise<LmProduct> {
  const notFound: LmProduct = {
    query, found: false, url: null, name: null, brand: null,
    priceBuc: null, weightKg: null, areaM2: null, dimsMm: [],
  };
  const cleaned = query.trim();
  if (!cleaned) return notFound;

  const results = await googleSearch(`site:leroymerlin.ro ${cleaned}`, { results: 10 });
  const url = pickProductUrl(results);
  if (!url) return notFound;

  const markdown = await scrapeMarkdown(url);
  return parseLmProduct(query, url, markdown);
}

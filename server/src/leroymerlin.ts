/**
 * Leroy Merlin product resolution + spec parsing.
 *
 * Pipeline, per invoice product code:
 *   1. Resolve the code to a product page via Leroy Merlin's OWN search bar
 *      (`/search?q=<code>`) — an exact code redirects straight onto the
 *      product page. Google `site:` search is a fallback (it does not index
 *      many of these reference codes). All scraping is ScrapingDog premium
 *      (no JS render: leroymerlin.ro is behind DataDome, but the page is
 *      server-rendered, so `premium=true` alone returns it first try).
 *   2. Parse the product name + price from the jsonld_PRODUCT block and the
 *      weight / area / nominal dimensions from the `m-product-attr-row`
 *      characteristics table (present in the HTML, no accordion click).
 *
 * Everything that touches the network lives in `resolveLmProduct`. The
 * parsers (`parseDimsMm`, `parseLmProduct`) are pure and unit-tested so
 * the comparison logic can be trusted without hitting ScrapingDog.
 */

import { googleSearch, scrapeHtml } from "./scrapingdog.js";

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

/**
 * Unit weight in KILOGRAMS printed in a product NAME — e.g.
 * "CIMENT ECOPLANET PLUS 20KG" → 20, "ALB20KG" → 20, "0,5 kg" → 0.5.
 *
 * This is the reliable fallback for weight when leroymerlin.ro has no
 * catalog weight (the lookup failed, or the page omits it): the kg is
 * printed right on the invoice line. A number (optionally decimal, comma or
 * dot) immediately followed by the unit "kg" (any case, optional space) is
 * a weight; a number with ANY other unit ("2MM", "MIN100", "M29A", "CM11+")
 * is ignored because it is not followed by "kg". Grams are deliberately NOT
 * parsed (wrong magnitude). The first kg token wins when more than one
 * appears (none observed across the real invoices). Returns null when the
 * name states no kg weight.
 */
export function weightFromName(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*kg\b/i.exec(name);
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/* ──────────────────────────────────────────────────────────────────────
 * HTML spec parsing (pure)
 *
 * leroymerlin.ro renders the product page server-side: the full
 * "Caracteristici" table is in the HTML as <tr class="m-product-attr-row">
 * rows (a __name <th> + a __value <td>), present whether or not the
 * accordion is expanded, and a <script id="jsonld_PRODUCT"> block carries
 * the canonical name + price. We parse BOTH — no rendered Markdown (which
 * ScrapingDog returns EMPTY for these pages) and no button click needed.
 * ────────────────────────────────────────────────────────────────────── */

/** Strip HTML tags + common entities, collapse whitespace. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a Romanian decimal ("3,7" or "3.7") into a number, or null. */
function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = /-?\d+(?:[.,]\d+)?/.exec(s.replace(/\s+/g, ""));
  if (!m) return null;
  const v = parseFloat(m[0]!.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

interface Spec {
  label: string;
  value: string;
}

/** Every characteristics-table row as {label, value}, in document order. */
export function parseSpecRows(html: string): Spec[] {
  const out: Spec[] = [];
  const re =
    /m-product-attr-row__name[^>]*>([\s\S]*?)<\/th>[\s\S]*?m-product-attr-row__value[^>]*>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = stripTags(m[1]!);
    const value = stripTags(m[2]!);
    if (label) out.push({ label, value });
  }
  return out;
}

/** Value of the FIRST spec row whose label matches. Anchoring patterns at
 *  the start keeps "Lungime (in m)" from also catching a packaged
 *  "Produs ambalat: …" row. */
function specValue(specs: Spec[], labelRe: RegExp): string | null {
  for (const s of specs) if (labelRe.test(s.label)) return s.value || null;
  return null;
}

/** Length unit named inside a spec label, e.g. "Grosime (in mm)". */
function unitFromLabel(label: string): number | null {
  const m = /\(in\s*(mm|cm|m)\b/i.exec(label);
  return m ? (UNIT_TO_MM[m[1]!.toLowerCase()] ?? null) : null;
}

/** The jsonld_PRODUCT block: canonical name, price and brand. Best-effort —
 *  returns nulls when the block is absent or unparseable. */
function parseJsonLd(html: string): { name: string | null; price: number | null; brand: string | null } {
  const m = /<script[^>]*id=["']jsonld_PRODUCT["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return { name: null, price: null, brand: null };
  try {
    const j = JSON.parse(m[1]!.trim()) as {
      name?: unknown;
      offers?: { price?: unknown } | { price?: unknown }[];
      brand?: unknown;
    };
    const offer = Array.isArray(j.offers) ? j.offers[0] : j.offers;
    const brandObj = j.brand as { name?: unknown } | string | undefined;
    const brand =
      typeof brandObj === "string"
        ? brandObj
        : brandObj && typeof brandObj.name === "string"
          ? brandObj.name
          : null;
    return {
      name: typeof j.name === "string" ? j.name : null,
      price: offer && offer.price != null ? num(String(offer.price)) : null,
      brand,
    };
  } catch {
    return { name: null, price: null, brand: null };
  }
}

/** First <h1> text, tags stripped — the name fallback when JSON-LD is absent. */
function parseH1(html: string): string | null {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? stripTags(m[1]!) || null : null;
}

export function parseLmProduct(query: string, url: string, html: string): LmProduct {
  const specs = parseSpecRows(html);
  const jsonld = parseJsonLd(html);

  const name = jsonld.name ?? parseH1(html);
  const brand = jsonld.brand ?? specValue(specs, /^(?:brand|marc[aă])\b/i);
  const priceBuc = jsonld.price;

  // Weight: prefer the PACKAGED weight (what actually ships), then net,
  // then a bare "Greutate" — every variant is printed "(in kg)". The old
  // parser only matched "Produs ambalat: greutate" and so missed the many
  // products (e.g. gutters) that list only "Greutate neta (in kg)".
  const weightKg =
    num(specValue(specs, /^produs ambalat:\s*greutate/i)) ??
    num(specValue(specs, /^greutate\s*net/i)) ??
    num(specValue(specs, /^greutate\b/i));

  const areaM2 = num(specValue(specs, /^suprafa[tţț]a/i));

  // Nominal dimensions: prefer the product NAME (same source as the invoice
  // line name), else assemble from the spec table's length rows.
  let dimsMm = parseDimsMm(name);
  if (dimsMm.length === 0) {
    // No \b after the stem: Romanian articulated forms append -a/-ul
    // ("Lăţimea", "Lungimea"). Packaged ("Produs ambalat: …") rows are box
    // dimensions, not the nominal size, so they are skipped explicitly.
    const dimLabels: RegExp[] = [
      /^grosime/i,
      /^l[aă][tţț]ime/i,
      /^lungime/i,
      /^[iî]n[aă]l[tţț]ime/i,
      /^ad[aâ]ncime/i,
      /^diametr/i,
    ];
    const specDims: number[] = [];
    for (const re of dimLabels) {
      const row = specs.find((s) => re.test(s.label) && !/^produs ambalat/i.test(s.label));
      if (!row) continue;
      const value = num(row.value);
      const factor = unitFromLabel(row.label);
      if (value != null && factor != null) specDims.push(Math.round(value * factor));
    }
    dimsMm = specDims.sort((a, b) => a - b);
  }

  // `found` means we reached the product page (the URL resolved); individual
  // fields may still be null when the page itself omits them.
  return { query, found: true, url, name, brand, priceBuc, weightKg, areaM2, dimsMm };
}

/* ──────────────────────────────────────────────────────────────────────
 * Resolution (network)
 * ────────────────────────────────────────────────────────────────────── */

/** A real product page URL: www.leroymerlin.ro/.../<slug>-<digits>.html */
const PRODUCT_URL_RE = /^https?:\/\/(?:www\.)?leroymerlin\.ro\/.*-\d+\.html$/i;

/** A product page is recognised by its rendered spec table. */
const PRODUCT_PAGE_RE = /m-product-attr-row/i;

/** Pick the best product-page URL from Google organic results. Prefers a
 *  real product page (slug ends `-<digits>.html`) on the canonical host,
 *  and ignores category pages, PDFs, and backend/uat hosts. */
export function pickProductUrl(results: { link?: string }[]): string | null {
  for (const r of results) {
    const link = r.link?.trim();
    if (link && PRODUCT_URL_RE.test(link)) return link;
  }
  return null;
}

/** The canonical product URL printed on a page (the <link rel="canonical">
 *  or og:url). Used to record the real product URL when an exact-code
 *  search redirected us straight onto the product page. */
export function canonicalUrl(html: string): string | null {
  const link = /<link\b[^>]*\brel=["']canonical["'][^>]*>/i.exec(html)?.[0];
  const fromLink = link ? /href=["']([^"']+)["']/i.exec(link)?.[1] : undefined;
  if (fromLink) return fromLink;
  const og = /<meta\b[^>]*\bproperty=["']og:url["'][^>]*>/i.exec(html)?.[0];
  return (og ? /content=["']([^"']+)["']/i.exec(og)?.[1] : undefined) ?? null;
}

/** Pick a product link out of a search-results page. Prefers the card whose
 *  URL ends in `-<code>.html` (the exact code), else the first product link.
 *  Relative links are absolutised. Returns null when the page lists none. */
export function pickSearchProductUrl(html: string, code: string): string | null {
  const abs = (html.match(/https?:\/\/(?:www\.)?leroymerlin\.ro\/produse\/[a-z0-9-]+-\d+\.html/gi) ?? []);
  const rel = (html.match(/\/produse\/[a-z0-9-]+-\d+\.html/gi) ?? []).map(
    (p) => `https://www.leroymerlin.ro${p}`,
  );
  const all = [...new Set([...abs, ...rel])];
  const digits = code.replace(/\D/g, "");
  return all.find((u) => digits && u.endsWith(`-${digits}.html`)) ?? all[0] ?? null;
}

/**
 * Resolve one invoice code/name to a Leroy Merlin product, then scrape +
 * parse it. Returns `{ found: false }` when no product page is found.
 *
 * Resolution uses LEROY MERLIN'S OWN search bar (the operator's method):
 * `/search?q=<code>`. An exact code redirects straight onto the product
 * page, so we usually parse it in a single scrape; otherwise we read the
 * first matching product card from the results grid. Google `site:` search
 * stays as a fallback for the rare code the bar can't place. Google does
 * NOT index many of these reference codes, so the bar resolves products
 * Google misses (live: 25001980, 11531653).
 *
 * Network errors propagate to the caller, which downgrades the item to
 * "not checked" rather than failing the whole pair.
 */
export async function resolveLmProduct(query: string): Promise<LmProduct> {
  const notFound: LmProduct = {
    query, found: false, url: null, name: null, brand: null,
    priceBuc: null, weightKg: null, areaM2: null, dimsMm: [],
  };
  const cleaned = query.trim();
  if (!cleaned) return notFound;

  // 1) Native search bar. The result page is large (~250 KB); the DataDome
  //    interstitial is tiny — so a generous length check rejects a stub and
  //    we treat the line as "not fetched" (no false-negative cache).
  const searchUrl = `https://www.leroymerlin.ro/search?q=${encodeURIComponent(cleaned)}`;
  // Track whether the search page ACTUALLY came back. A real fetch (even a
  // "niciun rezultat" page) lets us record a genuine miss; a transient block
  // (scrape threw after its retries) must NOT be cached as "not found".
  let searchHtml = "";
  let searchFetched = false;
  try {
    searchHtml = await scrapeHtml(searchUrl, { valid: (b) => b.length > 20_000 });
    searchFetched = true;
  } catch {
    searchFetched = false;
  }

  // 1a) An exact code redirects onto the product page itself → parse it now
  //     (one scrape total), recording the canonical product URL.
  if (searchFetched && PRODUCT_PAGE_RE.test(searchHtml)) {
    return parseLmProduct(query, canonicalUrl(searchHtml) ?? searchUrl, searchHtml);
  }

  // 1b) Results grid → take the exact-code card (else the first product).
  let url = searchFetched ? pickSearchProductUrl(searchHtml, cleaned) : null;

  // 2) Fallback: Google `site:` search, for any code the bar didn't place.
  if (!url) {
    try {
      url = pickProductUrl(await googleSearch(`site:leroymerlin.ro ${cleaned}`, { results: 10 }));
    } catch {
      url = null;
    }
  }

  if (!url) {
    // Genuine miss: the search page WAS fetched and listed no product
    // ("niciun rezultat") — a real "not found" worth caching. But if the
    // search scrape FAILED (transient anti-bot block) and Google didn't save
    // us, do NOT cache a false negative — throw so the caller leaves the line
    // unchecked and a later pass retries it.
    if (searchFetched) return notFound;
    throw new Error(`leroymerlin: code "${cleaned}" not resolvable right now (search unavailable).`);
  }

  // Scrape the resolved product URL. The spec table (the source of weight +
  // dimensions) is in the server-rendered HTML, so one premium fetch gets it.
  const html = await scrapeHtml(url, { valid: (b) => PRODUCT_PAGE_RE.test(b) });
  return parseLmProduct(query, url, html);
}

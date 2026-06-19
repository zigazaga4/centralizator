/**
 * Product verification — cross-check every invoice line against its
 * Leroy Merlin product page and decide whether the pair deserves a
 * warning icon.
 *
 * Per the operator's rule the warning fires ONLY on:
 *   • a SIZE mismatch  — invoice line size vs. site product size, or
 *   • a WEIGHT mismatch — AWB declared weight vs. the sum of catalog
 *     weights × quantity (only when every line is weighable, so a
 *     partial estimate never false-alarms).
 *
 * Everything else (code not found, name, brand, price, link) is captured
 * for the dialog but never raises the alarm.
 *
 * The network side is bounded and resilient:
 *   • a per-call memo dedupes repeated codes,
 *   • a persistent SQLite cache (db.ts) means each unique code is scraped
 *     at most once ever (until its TTL lapses),
 *   • lookups run through a small concurrency pool, and
 *   • a failed lookup downgrades that line to "not checked" instead of
 *     failing the whole pass.
 */

import {
  resolveLmProduct,
  compareDims,
  parseDimsMm,
  weightFromName,
  type LmProduct,
} from "./leroymerlin.js";
import { getCachedLmProduct, putCachedLmProduct } from "./db.js";
import type { Extracted, ItemCheck, Verification } from "./schema.js";

/** Max simultaneous ScrapingDog resolutions (search+scrape) per pair. */
const VERIFY_CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY ?? 4);
/** Weight is flagged only past this relative gap (30 %), and only with
 *  full coverage — unit ambiguity (buc vs m²) makes a tighter band noisy. */
const WEIGHT_TOLERANCE = Number(process.env.VERIFY_WEIGHT_TOLERANCE ?? 0.3);

/** The code we search by: internal reference first, then EAN. Returns
 *  null when the line carries neither — we don't guess from the name
 *  alone (a name search can resolve to the wrong product and produce a
 *  false size mismatch). */
function queryFor(item: { reference?: string | null; ean?: string | null }): string | null {
  const ref = item.reference?.trim();
  if (ref) return ref;
  const ean = item.ean?.trim();
  if (ean) return ean;
  return null;
}

function normUnit(u: string | null | undefined): string {
  return (u ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9²]/g, "");
}
const BUC_UNITS = new Set(["", "buc", "bucata", "bucati", "bc", "set", "rola", "sac", "cutie"]);
const AREA_UNITS = new Set(["m2", "m²", "mp"]);

/**
 * Best-effort per-line TOTAL weight from a known UNIT weight. "buc"-like
 * lines weigh unitKg × quantity; m²-billed lines convert through the pack
 * area (the insulation case the operator cares about). Anything else is not
 * weighable — it makes coverage "partial" and suppresses the weight warning
 * rather than guessing. The unit weight comes from the catalog when the page
 * has it, else from the kg printed in the product name (weightFromName).
 */
function lineWeight(
  unitKg: number | null,
  areaM2: number | null,
  quantity: number,
  unit: string | null | undefined,
): number | null {
  if (unitKg == null) return null;
  const u = normUnit(unit);
  if (BUC_UNITS.has(u)) return unitKg * quantity;
  if (AREA_UNITS.has(u) && areaM2 && areaM2 > 0) {
    return (quantity / areaM2) * unitKg;
  }
  return null;
}

/** Resolve a code through the persistent cache, falling back to a live
 *  ScrapingDog lookup that we then cache (both hits and misses). */
async function resolveCached(query: string): Promise<LmProduct> {
  const cached = getCachedLmProduct(query);
  if (cached) return cached;
  const product = await resolveLmProduct(query);
  putCachedLmProduct(product);
  return product;
}

/** Run async `fn` over `items` with a fixed concurrency ceiling, keeping
 *  the result order aligned to the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * Verify every product line on the pair against leroymerlin.ro and
 * return the full verification report (incl. the `hasWarning` flag that
 * drives the icon). Never throws for a single bad lookup — the offending
 * line just comes back `found:false`.
 */
export async function verifyShipment(extracted: Extracted): Promise<Verification> {
  // Flatten lines with their (invoice, item) coordinates.
  const flat = extracted.invoices.flatMap((inv, invoiceIndex) =>
    inv.items.map((item, itemIndex) => ({ invoiceIndex, itemIndex, item })),
  );

  // Per-call memo so repeated codes resolve once even before the
  // persistent cache warms.
  const memo = new Map<string, Promise<LmProduct>>();
  const resolve = (query: string): Promise<LmProduct> => {
    let p = memo.get(query);
    if (!p) {
      p = resolveCached(query).catch(
        (): LmProduct => ({
          query, found: false, url: null, name: null, brand: null,
          priceBuc: null, weightKg: null, areaM2: null, dimsMm: [],
        }),
      );
      memo.set(query, p);
    }
    return p;
  };

  const checks = await mapPool(flat, VERIFY_CONCURRENCY, async ({ invoiceIndex, itemIndex, item }) => {
    const query = queryFor(item);
    const invoiceDimsMm = parseDimsMm(item.dimensions ?? item.name);
    const product = query
      ? await resolve(query)
      : ({ query: "", found: false, url: null, name: null, brand: null, priceBuc: null, weightKg: null, areaM2: null, dimsMm: [] } as LmProduct);

    const sizeStatus = product.found ? compareDims(invoiceDimsMm, product.dimsMm) : "unknown";

    // Unit weight: the catalog page first (most precise), then the kg printed
    // in the product name ("…20KG") — so a line still carries a weight even
    // when the site lookup failed or the page omits it.
    const unitWeightKg = (product.found ? product.weightKg : null) ?? weightFromName(item.name);

    const check: ItemCheck = {
      invoiceIndex,
      itemIndex,
      name: item.name,
      query,
      invoiceDimsMm,
      quantity: item.quantity,
      unit: item.unit ?? null,
      found: product.found,
      url: product.url,
      siteName: product.name,
      brand: product.brand,
      priceBuc: product.priceBuc,
      weightKg: unitWeightKg,
      siteDimsMm: product.dimsMm,
      sizeStatus,
    };
    return { check, product, unitWeightKg };
  });

  // ── Weight aggregate ──────────────────────────────────────────────
  const awbWeightKg = extracted.awb.weight_kg;
  let weighable = 0;
  let estimate = 0;
  for (const { check, product, unitWeightKg } of checks) {
    const w = lineWeight(unitWeightKg, product.areaM2, check.quantity, check.unit);
    if (w != null) {
      weighable += 1;
      estimate += w;
    }
  }
  const total = checks.length;
  const weightCoverage: Verification["weightCoverage"] =
    total === 0 || weighable === 0 ? "none" : weighable === total ? "full" : "partial";
  const estimatedWeightKg = weighable > 0 ? Math.round(estimate * 100) / 100 : null;

  let weightStatus: Verification["weightStatus"] = "unknown";
  if (weightCoverage === "full" && estimatedWeightKg && estimatedWeightKg > 0 && awbWeightKg > 0) {
    const rel = Math.abs(awbWeightKg - estimatedWeightKg) / Math.max(awbWeightKg, estimatedWeightKg);
    weightStatus = rel > WEIGHT_TOLERANCE ? "mismatch" : "match";
  }

  const items = checks.map((c) => c.check);
  const hasWarning = items.some((c) => c.sizeStatus === "mismatch") || weightStatus === "mismatch";

  const notFound = items.filter((c) => c.query && !c.found).length;
  const note =
    notFound > 0
      ? `${notFound} cod(uri) negăsite pe leroymerlin.ro (neverificate).`
      : null;

  return {
    checkedAt: Date.now(),
    items,
    awbWeightKg,
    estimatedWeightKg,
    weightCoverage,
    weightStatus,
    hasWarning,
    note,
  };
}

/**
 * Thin ScrapingDog client — the only place that knows the ScrapingDog
 * HTTP surface. Two endpoints are used:
 *
 *   • Google Search API   GET https://api.scrapingdog.com/google
 *       Resolve a Leroy Merlin product code/name to its product URL via
 *       a `site:leroymerlin.ro <code>` query. Cheap (5 credits) and very
 *       reliable — a bare product code returns the exact product at rank 1.
 *
 *   • Web Scraping API    GET https://api.scrapingdog.com/scrape
 *       Pull the product page as raw HTML. leroymerlin.ro is behind a
 *       DataDome anti-bot wall, so we scrape with `premium=true` (a
 *       non-premium proxy returns 400 / an empty body). We do NOT use JS
 *       render: `dynamic=true` actually gets BLOCKED (DataDome serves a
 *       tiny challenge stub instead of the page) and costs more credits,
 *       whereas a plain `premium=true` request returns the full
 *       server-rendered page first try, every try (measured). We take HTML,
 *       not Markdown — ScrapingDog's Markdown conversion comes back EMPTY
 *       for these pages. The HTML carries the full `m-product-attr-row`
 *       spec table + the `jsonld_PRODUCT` block — everything we compare
 *       against the invoice (parsed in leroymerlin.ts). One attempt, no
 *       retries: the request either works or the caller leaves the line
 *       unchecked for a later pass.
 *
 * The `ai_extract_rules` AI-parser feature is deliberately NOT used: on
 * the current key it returns `{}` (plan-gated), and Markdown parsing is
 * free + deterministic anyway (see leroymerlin.ts).
 *
 * Auth: SCRAPINGDOG_API_KEY (server/.env). Every call is bounded by an
 * AbortSignal so a stalled upstream fails fast instead of hanging the
 * verification pass.
 */

const API_KEY = process.env.SCRAPINGDOG_API_KEY;
const GOOGLE_URL = "https://api.scrapingdog.com/google";
const SCRAPE_URL = "https://api.scrapingdog.com/scrape";

/** Per-call wall-clock ceilings (ms). Google search is fast; a rendered
 *  premium scrape is the slow one. Both overridable via env. */
const SEARCH_TIMEOUT_MS = Number(process.env.SCRAPINGDOG_SEARCH_TIMEOUT_MS ?? 30_000);
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPINGDOG_SCRAPE_TIMEOUT_MS ?? 60_000);

export function scrapingdogConfigured(): boolean {
  return !!API_KEY;
}

/** One organic result from the Google Search API (`organic_results[]`). */
export interface OrganicResult {
  title?: string;
  link?: string;
  displayed_link?: string;
  snippet?: string;
  rank?: number;
}

function ensureKey(): string {
  if (!API_KEY) {
    throw new Error("SCRAPINGDOG_API_KEY is not configured on the server.");
  }
  return API_KEY;
}

/* ──────────────────────────────────────────────────────────────────────
 * Global concurrency gate
 *
 * The ScrapingDog plan allows only a handful of simultaneous requests
 * (payg = 5). But a scan-batch fans out up to 100 pairs at once, each
 * verifying several products in parallel — without a cap that is dozens of
 * concurrent scrapes against a limit of 5, so the overflow requests fail
 * (rejected / anti-bot) and a real product gets cached as "not found".
 * This semaphore bounds EVERY ScrapingDog call (search + scrape) across the
 * whole process so a burst queues instead of overflowing.
 * ────────────────────────────────────────────────────────────────────── */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.SCRAPINGDOG_CONCURRENCY ?? 5));
let availableSlots = MAX_CONCURRENCY;
const slotQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (availableSlots > 0) {
    availableSlots -= 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => slotQueue.push(resolve));
}

function releaseSlot(): void {
  const next = slotQueue.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else availableSlots += 1;
}

/** Run `fn` while holding one of the global ScrapingDog slots. */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseSlot();
  }
}

/**
 * Run a Google search through ScrapingDog and return the organic
 * results. Defaults to the Romanian locale so leroymerlin.ro ranks
 * naturally. Throws on transport failure or non-2xx.
 */
export async function googleSearch(
  query: string,
  opts: { results?: number; country?: string } = {},
): Promise<OrganicResult[]> {
  const key = ensureKey();
  const params = new URLSearchParams({
    api_key: key,
    query,
    country: opts.country ?? "ro",
    domain: "google.ro",
    language: "ro",
    results: String(opts.results ?? 10),
    page: "0",
  });
  const res = await withSlot(() =>
    fetch(`${GOOGLE_URL}?${params.toString()}`, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) }),
  );
  if (!res.ok) {
    throw new Error(`ScrapingDog google search failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { organic_results?: OrganicResult[] };
  return data.organic_results ?? [];
}

/**
 * Scrape a URL and return its raw HTML. ONE attempt, no retries: the
 * premium proxy (`premium=true`, no JS render) returns leroymerlin.ro's
 * full server-rendered page on the first request. HTML, not Markdown:
 * ScrapingDog's Markdown conversion comes back EMPTY for these product
 * pages, whereas the HTML carries the full spec table and the
 * jsonld_PRODUCT block.
 *
 * `valid` is a positive sanity check on the body (the caller passes
 * "contains the product table"; the default just rejects a tiny stub).
 * Throws on transport failure, non-2xx, an empty body, or a body that
 * fails `valid` (the rare DataDome stub) — the caller then leaves the line
 * unchecked rather than caching a false negative, and a later pass retries.
 */
export async function scrapeHtml(url: string, opts: { valid?: (body: string) => boolean } = {}): Promise<string> {
  const key = ensureKey();
  const valid = opts.valid ?? ((b: string) => b.trim().length >= 3_000);
  const params = new URLSearchParams({
    api_key: key,
    url,
    // No `dynamic` (JS render) — it gets BLOCKED here and costs more credits.
    premium: "true",
    formats: "html",
  });
  const res = await withSlot(() =>
    fetch(`${SCRAPE_URL}?${params.toString()}`, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) }),
  );
  if (!res.ok) {
    throw new Error(`ScrapingDog scrape failed (status ${res.status}): ${(await res.text().catch(() => "")).slice(0, 120)}`);
  }
  const body = await res.text();
  if (body && valid(body)) return body;
  throw new Error("ScrapingDog scrape returned an anti-bot / unrendered body.");
}

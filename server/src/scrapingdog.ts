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
 *       DataDome anti-bot wall (a plain request returns 403, and a
 *       non-premium proxy returns an EMPTY body), so we MUST scrape with
 *       `dynamic=true&premium=true` and a render `wait`. We take HTML, not
 *       Markdown — ScrapingDog's Markdown conversion comes back EMPTY for
 *       these product pages. The HTML carries the full `m-product-attr-row`
 *       spec table + the `jsonld_PRODUCT` block — everything we compare
 *       against the invoice (parsed in leroymerlin.ts).
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
/** Milliseconds ScrapingDog waits after JS render before snapshotting.
 *  6 s reliably lets the product spec table hydrate. */
const SCRAPE_WAIT_MS = Number(process.env.SCRAPINGDOG_WAIT_MS ?? 6_000);
/** How many times to re-try a scrape that comes back as the anti-bot
 *  challenge / an unrendered stub instead of the real page. Even with
 *  premium JS render the DataDome wall occasionally slips through; a fresh
 *  proxy + a longer render wait on the next try clears it. Each retry adds
 *  4 s of wait. */
const SCRAPE_MAX_TRIES = Number(process.env.SCRAPINGDOG_SCRAPE_TRIES ?? 4);

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
  const res = await fetch(`${GOOGLE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`ScrapingDog google search failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { organic_results?: OrganicResult[] };
  return data.organic_results ?? [];
}

/**
 * Scrape a URL and return its raw HTML. Uses the premium residential proxy
 * + JS rendering + a render wait — the combination leroymerlin.ro needs to
 * clear its DataDome wall and return real content instead of a 403/empty
 * body. HTML, not Markdown: ScrapingDog's Markdown conversion comes back
 * EMPTY for these product pages, whereas the server-rendered HTML carries
 * the full spec table and the jsonld_PRODUCT block. Throws on transport
 * failure, non-2xx, or an empty body.
 */
export async function scrapeHtml(url: string, opts: { valid?: (body: string) => boolean } = {}): Promise<string> {
  const key = ensureKey();
  // A good body must look like the REAL page, not the tiny DataDome
  // interstitial (which is non-empty, so an emptiness check is not enough —
  // and the real page itself embeds the DataDome script, so a "datadome"
  // blocklist would reject good pages). The caller passes a positive check
  // ("contains the product table"); the default just rejects a tiny stub.
  const valid = opts.valid ?? ((b: string) => b.trim().length >= 3_000);
  let lastError = "";
  for (let attempt = 1; attempt <= SCRAPE_MAX_TRIES; attempt++) {
    const params = new URLSearchParams({
      api_key: key,
      url,
      dynamic: "true",
      premium: "true",
      // Lengthen the render wait on each retry so a slow DataDome challenge
      // has more time to clear before the snapshot.
      wait: String(SCRAPE_WAIT_MS + (attempt - 1) * 4_000),
      formats: "html",
    });
    try {
      const res = await fetch(`${SCRAPE_URL}?${params.toString()}`, {
        signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = `status ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`;
      } else {
        const body = await res.text();
        if (body && valid(body)) return body;
        lastError = "anti-bot challenge / unrendered body";
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (attempt < SCRAPE_MAX_TRIES) await new Promise((r) => setTimeout(r, 1_500 * attempt));
  }
  throw new Error(`ScrapingDog scrape failed after ${SCRAPE_MAX_TRIES} tries (${lastError}).`);
}

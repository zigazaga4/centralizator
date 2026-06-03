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
 *       Pull the product page as Markdown. leroymerlin.ro is behind an
 *       anti-bot wall (a plain request returns 403, and a non-premium
 *       proxy returns an EMPTY body), so we MUST scrape with
 *       `dynamic=true&premium=true` and a render `wait`. The Markdown
 *       carries the full "Tabelul cu caracteristicile produsului" spec
 *       table, the H1 product name, brand and price — everything we
 *       compare against the invoice.
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
 * Scrape a URL and return its Markdown rendition. Uses the premium
 * residential proxy + JS rendering + a render wait — the combination
 * leroymerlin.ro needs to return real content instead of a 403/empty
 * body. Throws on transport failure, non-2xx, or an empty body.
 */
export async function scrapeMarkdown(url: string): Promise<string> {
  const key = ensureKey();
  const params = new URLSearchParams({
    api_key: key,
    url,
    dynamic: "true",
    premium: "true",
    wait: String(SCRAPE_WAIT_MS),
    formats: "markdown",
  });
  const res = await fetch(`${SCRAPE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`ScrapingDog scrape failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const body = await res.text();
  if (!body || body.trim().length === 0) {
    throw new Error("ScrapingDog scrape returned an empty body (blocked or not rendered).");
  }
  return body;
}

/**
 * Thin Mapbox client — the only place that knows the Mapbox HTTP surface.
 *
 * Three endpoints are used:
 *   • Geocoding v6 (forward)   — delivery address text → coordinates.
 *   • Directions v5 (driving)  — shortest ROAD distance store → delivery.
 *       We ask for alternatives and pick the one with the SMALLEST
 *       distance, and pass `exclude=unpaved` so the route stays on real
 *       roads, never dirt tracks. This matches the operator's rule:
 *       "Leroy ia distanța rutieră cea mai scurtă pe drumuri existente
 *        (nu de pământ)".
 *   • Matrix v1 (driving)      — delivery → all four stores in one call,
 *       used only to pick the NEAREST store when the AWB's Expeditor names
 *       Iași but not which of the two Iași stores.
 *
 * Auth: MAPBOX_TOKEN (server/.env). Every call is bounded by an
 * AbortSignal so a stalled upstream fails fast and the pipeline falls
 * back to the AWB's printed km instead of hanging the extraction.
 */

const TOKEN = process.env.MAPBOX_TOKEN;
const GEOCODE_URL = "https://api.mapbox.com/search/geocode/v6/forward";
const DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/driving";
const MATRIX_URL = "https://api.mapbox.com/directions-matrix/v1/mapbox/driving";

/** Per-call wall-clock ceiling (ms). Mapbox is fast; this just stops a
 *  network stall from blocking the extraction. Override with MAPBOX_TIMEOUT_MS. */
const TIMEOUT_MS = Number(process.env.MAPBOX_TIMEOUT_MS ?? 15_000);

export interface LngLat {
  lng: number;
  lat: number;
}

export function mapboxConfigured(): boolean {
  return !!TOKEN;
}

function ensureToken(): string {
  if (!TOKEN) throw new Error("MAPBOX_TOKEN is not configured on the server.");
  return TOKEN;
}

/** `lng,lat` pair in the order Mapbox expects in path coordinates. */
function coord(p: LngLat): string {
  return `${p.lng},${p.lat}`;
}

/** Romanian street-type abbreviations → the full word the geocoder indexes. */
// Each pattern consumes the optional trailing dot and is anchored by a
// lookahead for the next separator, so "Str." → "Strada" (dot gone) but the
// full word "Strada" is never re-matched (keeps formatAddress idempotent).
const SEP = "(?=\\s|,|$)";
const STREET_ABBREV: readonly [RegExp, string][] = [
  [new RegExp(`\\bb-?dul\\.?${SEP}`, "gi"), "Bulevardul"],
  [new RegExp(`\\bblv?d\\.?${SEP}`, "gi"), "Bulevardul"],
  [new RegExp(`\\bbd\\.?${SEP}`, "gi"), "Bulevardul"],
  [new RegExp(`\\bstr\\.?${SEP}`, "gi"), "Strada"],
  [new RegExp(`\\bs[oô]s\\.?${SEP}`, "gi"), "Șoseaua"],
  [new RegExp(`\\bşos\\.?${SEP}`, "gi"), "Șoseaua"],
  [new RegExp(`\\bcal\\.?${SEP}`, "gi"), "Calea"],
  [new RegExp(`\\bp-?ta\\.?${SEP}`, "gi"), "Piața"],
  [new RegExp(`\\bpta\\.?${SEP}`, "gi"), "Piața"],
];

/**
 * Sub-building / contact noise that hurts geocoding. Romanian AWBs cram the
 * block, staircase, floor, apartment, intercom, even a phone number into the
 * address. The geocoder resolves to a STREET; these only confuse it, so we
 * drop any comma-segment that is purely one of them.
 */
const NOISE_SEGMENT =
  /^(?:bl|bloc|sc|scara|ap|apt|apartament|et|etaj|parter|tronson|int|intrare|interfon|cam|camera|tel|telefon|mobil|pers(?:oana)?\s*contact|cod\s*postal)\b/i;
const PHONE_SEGMENT = /^\+?\d[\d\s.\-/]{6,}$/;

/**
 * Format a raw AWB delivery address so Mapbox resolves the best location.
 *
 * The model copies the address verbatim off the AWB; that text often
 * geocodes poorly. We:
 *   • expand street abbreviations (Str. → Strada, Bd. → Bulevardul, …),
 *   • drop sub-building + contact noise (Bloc, Sc., Ap., Et., phone, …),
 *   • collapse separators, and
 *   • pin the country (", România") so the search stays in Romania.
 *
 * Pure + idempotent. Returns "" for empty input.
 */
export function formatAddress(raw: string): string {
  let s = (raw ?? "").replace(/\s*[\r\n]+\s*/g, ", ").trim();
  if (!s) return "";

  for (const [re, full] of STREET_ABBREV) s = s.replace(re, full);

  const parts = s
    .split(",")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p && !NOISE_SEGMENT.test(p) && !PHONE_SEGMENT.test(p));

  // De-duplicate consecutive identical segments (OCR sometimes repeats the
  // locality), preserving order.
  const seen = new Set<string>();
  const kept = parts.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let out = kept.join(", ").replace(/\s+/g, " ").trim();
  if (!/rom[âa]nia/i.test(out)) out = out ? `${out}, România` : "România";
  return out;
}

/* ──────────────────────────────────────────────────────────────────────
 * Locality validation
 *
 * Mapbox forward search is FUZZY: when the requested street isn't indexed
 * in the requested locality it silently returns a same-named street in a
 * DIFFERENT locality (often pulled toward the proximity bias). For routed
 * km that's catastrophic — "Str. Libertatii, Pietreni" resolving to
 * Strada Libertății in Constanța city turns a 65 km route into 6 km. So
 * we extract the locality the address itself names and accept only
 * geocode candidates that sit in (a name-compatible) locality; when none
 * do, we fall back to the locality's own center point, which is far
 * closer to the truth than a street 60 km away in another town.
 * ────────────────────────────────────────────────────────────────────── */

/** Comparison normal form: no diacritics, lower-case, collapsed spaces.
 *  Exported for reuse anywhere two Romanian strings must compare loosely
 *  (the document linker matches recipient names with it). */
export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritic marks
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Romanian postal codes are exactly six digits. */
const POSTCODE = /\b\d{6}\b/g;

/** Administrative words that prefix a locality/county on AWBs. */
const ADMIN_PREFIX =
  /^(?:sat(?:ul)?|com(?:una)?\.?|oras(?:ul)?|orașul|mun(?:icipiul)?\.?|jud(?:e[tț](?:ul)?)?\.?)\s+/i;

/** A segment that IS the county marker ("Jud. Constanta", "Județ(ul) Iași"). */
const COUNTY_MARKER = /^jud(?:e[tț](?:ul)?)?\.?\s+/i;

/** Date-named villages ("2 Mai", "23 August") are real localities — the
 *  digit must not make them read as a street line. */
const DATE_LOCALITY =
  /^\d{1,2}\s+(?:ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)\b/i;

/** Street-marker words — a segment containing these (or any digit, house
 *  numbers included) is an address line, not a locality. */
const STREETISH =
  /\d|\b(?:str(?:ada)?|bulevardul|b-?dul|blvd|bd|sos(?:eaua)?|șoseaua|calea|cal|piata|piața|p-?ta|aleea|intrarea|drumul|splaiul|prelungirea|fundatura|fundătura|nr)\b/i;

function isStreetish(seg: string): boolean {
  return !DATE_LOCALITY.test(seg) && STREETISH.test(seg);
}

/**
 * Read the locality + county a formatted address names.
 *
 * AWB addresses are usually "street…, locality, county[ postcode]" but the
 * wild forms all occur: an explicit "Jud. X" segment, no street at all
 * ("Neptun, județ Constanta"), the locality repeated, neighbourhood noise.
 * The rules, in order:
 *   • a "Jud./Județul X" segment is the county, never the locality;
 *   • otherwise the LAST segment is the county (possibly the city itself);
 *   • the locality is the RIGHTMOST remaining segment that doesn't read
 *     like a street line and isn't just the county repeated;
 *   • street + county only ⇒ the locality IS the county-level city.
 * Returns nulls when the address has no comma structure to read.
 */
export function addressLocality(formatted: string): {
  locality: string | null;
  county: string | null;
} {
  const segments = (formatted ?? "")
    .split(",")
    .map((s) => s.replace(POSTCODE, "").replace(/\s+/g, " ").trim())
    .filter((s) => s && !/^rom[âa]nia$/i.test(s));
  if (segments.length < 2) return { locality: null, county: null };

  // Explicit county markers are the county — pull them out of the pool.
  let county: string | null = null;
  let explicitCounty = false;
  let pool: string[] = [];
  for (const s of segments) {
    if (COUNTY_MARKER.test(s)) {
      county = s.replace(COUNTY_MARKER, "").trim() || county;
      explicitCounty = true;
    } else {
      pool.push(s);
    }
  }
  // No marker: the trailing segment is the county.
  if (!explicitCounty && pool.length > 0) {
    county = pool.pop()!.replace(ADMIN_PREFIX, "").trim() || null;
  }
  // The county name riding AGAIN in the pool ("…, Jud. Constanta,
  // Constanta") must not shadow the real locality.
  if (county) {
    const ckey = norm(county);
    pool = pool.filter((s) => norm(s.replace(ADMIN_PREFIX, "")) !== ckey);
  }

  let locality: string | null = null;
  for (let i = pool.length - 1; i >= 0; i--) {
    const seg = pool[i]!.replace(ADMIN_PREFIX, "").trim();
    if (seg && !isStreetish(seg)) {
      locality = seg;
      break;
    }
  }
  return { locality: locality ?? county, county };
}

/**
 * Do two locality names refer to the same place? Token-subset in either
 * direction after normalisation, so "Eforie" ⊆ "Eforie Nord" matches (the
 * geocoder names the commune, the AWB the village) while "Pietreni" vs
 * "Constanța" — the wrong-locality case — is rejected.
 */
export function localityMatches(
  expected: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  if (!expected || !candidate) return false;
  const e = norm(expected.replace(ADMIN_PREFIX, "")).split(/[\s-]+/).filter(Boolean);
  const c = norm(candidate.replace(ADMIN_PREFIX, "")).split(/[\s-]+/).filter(Boolean);
  if (e.length === 0 || c.length === 0) return false;
  const [small, big] = e.length <= c.length ? [e, c] : [c, e];
  const bigSet = new Set(big);
  return small.every((t) => bigSet.has(t));
}

/** A geocoded point plus how trustworthy it is. */
export interface GeocodeResult extends LngLat {
  /** True when the street couldn't be confirmed in the address's own
   *  locality and we fell back to the locality's center point. */
  approximate: boolean;
  /** Locality/place name the chosen feature actually sits in. */
  place: string | null;
  /** How the point was confirmed:
   *    • "street"      — a street hit validated in the right locality;
   *    • "center"      — locality-center fallback (street not indexed);
   *    • "unvalidated" — the parsed locality isn't a place Mapbox knows
   *      (neighbourhood/residence noise) — first fuzzy hit kept as the
   *      best remaining guess. */
  confidence: "street" | "center" | "unvalidated";
}

/** The slice of a Geocoding-v6 feature we read. */
interface GeoFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    feature_type?: string;
    context?: {
      place?: { name?: string };
      locality?: { name?: string };
    };
  };
}

function featurePoint(f: GeoFeature): LngLat | null {
  const c = f.geometry?.coordinates;
  if (!c || c.length < 2) return null;
  return { lng: c[0], lat: c[1] };
}

/** Every locality-level name a feature carries (context + its own name
 *  when the feature itself is a place/locality). */
function featurePlaceNames(f: GeoFeature): string[] {
  const p = f.properties;
  const names = [p?.context?.locality?.name, p?.context?.place?.name];
  if (p?.feature_type === "place" || p?.feature_type === "locality") names.push(p?.name);
  return names.filter((n): n is string => !!n);
}

/** One forward-search call, raw features back. */
async function forwardGeocode(
  q: string,
  opts: { proximity?: LngLat; types?: string; limit?: number } = {},
): Promise<GeoFeature[]> {
  const token = ensureToken();
  const params = new URLSearchParams({
    q,
    country: "ro",
    language: "ro",
    limit: String(opts.limit ?? 1),
    access_token: token,
  });
  // Bias the result toward the dispatch store — deliveries cluster near the
  // store they leave from, so this disambiguates same-named streets in
  // different localities and picks the closest plausible match.
  if (opts.proximity) {
    params.set("proximity", `${opts.proximity.lng},${opts.proximity.lat}`);
  }
  if (opts.types) params.set("types", opts.types);
  const res = await fetch(`${GEOCODE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mapbox geocoding failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { features?: GeoFeature[] };
  return data.features ?? [];
}

/**
 * Forward-geocode a free-text Romanian address to coordinates, KEEPING THE
 * LOCALITY the address names. Mapbox's fuzzy search loves returning a
 * same-named street in another town; we accept only candidates whose
 * place/locality agrees with the address, and when none does we geocode
 * the locality itself and return its center flagged `approximate: true`.
 * Returns null when the address is empty or nothing trustworthy matches
 * (the caller then falls back to the AWB's printed km).
 */
export async function geocode(
  address: string,
  opts: { proximity?: LngLat } = {},
): Promise<GeocodeResult | null> {
  const q = formatAddress(address);
  if (!q) return null;

  const { locality, county } = addressLocality(q);
  const features = await forwardGeocode(q, { proximity: opts.proximity, limit: 5 });

  // No locality to validate against — first hit wins (legacy behaviour).
  if (!locality) {
    const f = features[0];
    const pt = f ? featurePoint(f) : null;
    return pt
      ? { ...pt, approximate: false, place: featurePlaceNames(f!)[0] ?? null, confidence: "street" }
      : null;
  }

  // First candidate that sits in the RIGHT locality wins.
  for (const f of features) {
    const names = featurePlaceNames(f);
    if (!names.some((n) => localityMatches(locality, n))) continue;
    const pt = featurePoint(f);
    if (pt) return { ...pt, approximate: false, place: names[0] ?? null, confidence: "street" };
  }

  // Every street candidate is in the WRONG locality (same-named street
  // elsewhere). The locality's own center is far closer to the truth than
  // a street 60 km away in another town. No proximity bias here — the
  // county already pins the search, and the bias is what dragged the
  // street matches astray in the first place.
  const fallbackQ = [locality, county, "România"].filter(Boolean).join(", ");
  const places = await forwardGeocode(fallbackQ, { types: "place,locality", limit: 3 });
  for (const f of places) {
    const name = f.properties?.name ?? null;
    if (!localityMatches(locality, name)) continue;
    const pt = featurePoint(f);
    if (pt) return { ...pt, approximate: true, place: name, confidence: "center" };
  }

  // The parsed "locality" isn't a place Mapbox knows either (often a
  // neighbourhood or residence name riding in the address). The first
  // fuzzy hit is the best remaining guess — keep it, flagged, instead of
  // losing the route entirely.
  const f = features[0];
  const pt = f ? featurePoint(f) : null;
  return pt
    ? { ...pt, approximate: false, place: featurePlaceNames(f!)[0] ?? null, confidence: "unvalidated" }
    : null;
}

/** The shortest paved route between two points. */
export interface DrivingRoute {
  km: number;
  /** Encoded polyline (precision 5) of that route — present only when
   *  geometry was requested; null otherwise. */
  polyline: string | null;
}

/**
 * Shortest driving ROAD route between two points, on real roads (unpaved
 * excluded). Asks for route alternatives and returns the one with the
 * minimum distance. Pass `geometry: true` to also get the route's encoded
 * polyline (simplified overview — compact enough for a static-map URL).
 * Returns null when no route exists.
 */
export async function shortestDrivingRoute(
  origin: LngLat,
  dest: LngLat,
  opts: { geometry?: boolean } = {},
): Promise<DrivingRoute | null> {
  const token = ensureToken();
  const params = new URLSearchParams({
    alternatives: "true",
    overview: opts.geometry ? "simplified" : "false",
    exclude: "unpaved",
    annotations: "distance",
    access_token: token,
  });
  if (opts.geometry) params.set("geometries", "polyline");
  const path = `${coord(origin)};${coord(dest)}`;
  const res = await fetch(`${DIRECTIONS_URL}/${path}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mapbox directions failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { routes?: { distance?: number; geometry?: string }[] };
  let best: { distance: number; geometry?: string } | null = null;
  for (const r of data.routes ?? []) {
    if (typeof r.distance !== "number" || !Number.isFinite(r.distance)) continue;
    if (!best || r.distance < best.distance) best = { distance: r.distance, geometry: r.geometry };
  }
  if (!best) return null;
  return { km: best.distance / 1000, polyline: best.geometry ?? null };
}

/** Shortest driving ROAD distance (km) — thin wrapper over the route call
 *  for callers that only need the number. */
export async function shortestDrivingKm(origin: LngLat, dest: LngLat): Promise<number | null> {
  return (await shortestDrivingRoute(origin, dest))?.km ?? null;
}

/** Static Images API endpoint (style baked in — the standard streets map). */
const STATIC_URL = "https://api.mapbox.com/styles/v1/mapbox/streets-v12/static";

/**
 * Build the Static Images URL that draws the routed road: blue path, a
 * warehouse pin on the origin store, a home pin on the delivery point,
 * auto-fit viewport. The URL embeds the token, so it must only ever be
 * fetched SERVER-SIDE and proxied as bytes — never handed to the client.
 */
export function staticRouteMapUrl(origin: LngLat, dest: LngLat, polyline: string | null): string {
  const token = ensureToken();
  const overlays = [
    polyline ? `path-5+1d6feb-0.8(${encodeURIComponent(polyline)})` : null,
    `pin-s-warehouse+1d6feb(${coord(origin)})`,
    `pin-s-home+e11d48(${coord(dest)})`,
  ]
    .filter(Boolean)
    .join(",");
  return `${STATIC_URL}/${overlays}/auto/1000x640@2x?padding=60&access_token=${token}`;
}

/**
 * Driving distance (km) from one delivery point to several store points,
 * in a single Matrix call. Index `i` of the result corresponds to
 * `stores[i]`; an entry is null when that leg has no route. Used to pick
 * the nearest store when the Expeditor can't disambiguate the two Iași
 * sites.
 */
export async function distancesToStores(dest: LngLat, stores: LngLat[]): Promise<(number | null)[]> {
  const token = ensureToken();
  if (stores.length === 0) return [];
  // Coordinates: source (dest) first, then every store.
  const coords = [dest, ...stores].map(coord).join(";");
  const destinations = stores.map((_, i) => i + 1).join(";"); // skip index 0 (the source)
  const params = new URLSearchParams({
    sources: "0",
    destinations,
    annotations: "distance",
    access_token: token,
  });
  const res = await fetch(`${MATRIX_URL}/${coords}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mapbox matrix failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { distances?: (number | null)[][] };
  const row = data.distances?.[0] ?? [];
  return stores.map((_, i) => {
    const m = row[i];
    return typeof m === "number" && Number.isFinite(m) ? m / 1000 : null;
  });
}

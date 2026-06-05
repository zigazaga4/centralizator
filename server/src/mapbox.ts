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

/**
 * Forward-geocode a free-text Romanian address to coordinates. Returns
 * null when the address is empty or Mapbox finds no match (the caller
 * then falls back to the AWB's printed km).
 */
export async function geocode(address: string): Promise<LngLat | null> {
  const token = ensureToken();
  const q = address.trim();
  if (!q) return null;

  const params = new URLSearchParams({
    q,
    country: "ro",
    language: "ro",
    limit: "1",
    access_token: token,
  });
  const res = await fetch(`${GEOCODE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mapbox geocoding failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as {
    features?: { geometry?: { coordinates?: [number, number] } }[];
  };
  const c = data.features?.[0]?.geometry?.coordinates;
  if (!c || c.length < 2) return null;
  return { lng: c[0], lat: c[1] };
}

/**
 * Shortest driving ROAD distance (km) between two points, on real roads
 * (unpaved excluded). Asks for route alternatives and returns the minimum
 * distance among them. Returns null when no route exists.
 */
export async function shortestDrivingKm(origin: LngLat, dest: LngLat): Promise<number | null> {
  const token = ensureToken();
  const params = new URLSearchParams({
    alternatives: "true",
    overview: "false",
    exclude: "unpaved",
    annotations: "distance",
    access_token: token,
  });
  const path = `${coord(origin)};${coord(dest)}`;
  const res = await fetch(`${DIRECTIONS_URL}/${path}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mapbox directions failed (${res.status}): ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { routes?: { distance?: number }[] };
  const dists = (data.routes ?? [])
    .map((r) => r.distance)
    .filter((d): d is number => typeof d === "number" && Number.isFinite(d));
  if (dists.length === 0) return null;
  return Math.min(...dists) / 1000;
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

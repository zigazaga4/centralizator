/**
 * Distance + origin-store resolution for one extracted shipment.
 *
 * This is the bridge between the OCR result and the pricing engine. It
 * answers two coupled questions for a pair:
 *
 *   1. WHICH store did it ship from?  (the centralizator bucket + the
 *      route origin) — read from the AWB's Expeditor via `matchStore`.
 *   2. HOW FAR is the delivery?       (the km the price is built on) —
 *      ALWAYS the km printed on the AWB (`distance_extra_km`). That is
 *      the operator's source of truth and it is never overwritten.
 *
 * Mapbox is still consulted, but ONLY to cross-check: when the routed
 * road distance disagrees with the AWB's printed km we set `mapboxKm` +
 * `kmWarning` so the UI can flag it. The billed `distanceKm` stays equal
 * to `awbKm` in every case. Mapbox is also used to pick the origin store
 * when the Expeditor is ambiguous (nearest-by-road), which does not touch
 * the billed distance.
 *
 * It is BEST EFFORT by contract: any Mapbox hiccup (no token, geocode
 * miss, route stall) is caught — the price is unaffected because it never
 * depended on Mapbox in the first place. A pair must never fail just
 * because the map service did.
 */

import {
  STORES,
  STORE_KEYS,
  matchStore,
  type StoreKey,
} from "./stores.js";
import {
  mapboxConfigured,
  geocode,
  shortestDrivingKm,
  distancesToStores,
  type LngLat,
} from "./mapbox.js";
import { distanceBucket, distanceTariffEscalates } from "./buckets.js";
import type { Extracted, Routing } from "./schema.js";

export type { Routing } from "./schema.js";

/** Round to one decimal — enough precision for billing, clean to display. */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function storeLngLat(key: StoreKey): LngLat {
  const s = STORES[key];
  return { lng: s.lng, lat: s.lat };
}

/**
 * Resolve the origin store + the billed distance for an extraction.
 * Never throws — on any failure it returns the AWB's printed km with
 * `source: "awb"` and the best store guess available.
 */
export async function resolveRouting(extracted: Extracted): Promise<Routing> {
  const awbKm = extracted.awb.distance_extra_km;
  const deliveryAddress = extracted.awb.recipient_address?.trim() || null;

  const matched = matchStore({
    senderName: extracted.awb.sender_name,
    senderAddress: extracted.awb.sender_address,
    hubDestination: extracted.awb.hub_destination,
  });
  // A specific store from the Expeditor (not the ambiguous "Iasi" marker).
  const specific: StoreKey | null = matched && matched !== "Iasi" ? matched : null;

  const fallback = (note: string, store: StoreKey | null = specific): Routing => ({
    store,
    storeSource: store ? "expeditor" : "none",
    distanceKm: awbKm,
    source: "awb",
    awbKm,
    mapboxKm: null,
    deliveryAddress,
    resolved: false,
    note,
  });

  if (!mapboxConfigured()) return fallback("Mapbox neconfigurat — s-a folosit km de pe AWB.");
  if (!deliveryAddress) return fallback("Lipsește adresa de livrare — s-a folosit km de pe AWB.");

  try {
    // Bias geocoding toward the origin store when we know it (or the Iași
    // region for the ambiguous Iași case) so same-named streets resolve to
    // the right locality and the nearest plausible match wins.
    const proximity =
      specific ? storeLngLat(specific) : matched === "Iasi" ? storeLngLat("IasiTudor") : undefined;
    const dest = await geocode(deliveryAddress, { proximity });
    if (!dest) return fallback("Adresa de livrare nu a putut fi localizată — s-a folosit km de pe AWB.");

    // Decide the origin store.
    let store: StoreKey;
    let storeSource: Routing["storeSource"];
    let nearestKm: number | null = null;

    if (specific) {
      store = specific;
      storeSource = "expeditor";
    } else {
      // Either the Expeditor said only "Iași" (pick between the two Iași
      // stores) or it said nothing usable (pick among all four). Nearest
      // by road wins — which is exactly the shortest-distance rule.
      const candidates: StoreKey[] =
        matched === "Iasi" ? ["IasiTudor", "IasiERA"] : [...STORE_KEYS];
      const dists = await distancesToStores(dest, candidates.map(storeLngLat));
      let best = -1;
      let bestKm = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const d = dists[i];
        if (d != null && d < bestKm) {
          bestKm = d;
          best = i;
        }
      }
      if (best < 0) {
        // Matrix gave nothing — keep the ambiguous bucket null, use AWB km.
        return fallback("Ruta către magazine nu a putut fi calculată — s-a folosit km de pe AWB.", null);
      }
      store = candidates[best]!;
      storeSource = "nearest";
      nearestKm = bestKm;
    }

    // Final, accurate shortest-road distance for the chosen origin.
    let km: number | null = null;
    try {
      km = await shortestDrivingKm(storeLngLat(store), dest);
    } catch {
      km = null;
    }
    if (km == null) km = nearestKm; // matrix value, if we have one

    // The exact point the km was (or would have been) measured to — kept on
    // the routing so the route-map endpoint draws the SAME route, plus the
    // honesty flag when the geocode is only the locality's center.
    const destPoint = {
      destLng: dest.lng,
      destLat: dest.lat,
      approxGeocode: dest.approximate,
      geocodedPlace: dest.place,
    };
    const approxNote =
      dest.confidence === "center"
        ? `Strada nu a fost găsită în ${dest.place ?? "localitate"} — Mapbox a măsurat până la centrul localității.`
        : dest.confidence === "unvalidated"
          ? "Localitatea din adresă nu a fost recunoscută — ruta Mapbox poate fi imprecisă."
          : null;

    if (km == null) {
      return {
        store,
        storeSource,
        distanceKm: awbKm,
        source: "awb",
        awbKm,
        mapboxKm: null,
        deliveryAddress,
        resolved: false,
        note: "Ruta nu a putut fi calculată — s-a folosit km de pe AWB.",
        ...destPoint,
      };
    }

    const mapboxKm = round1(km);
    // The billed distance is ALWAYS the AWB's printed km — Mapbox never
    // replaces it. We only reconcile the two, and we only ALERT when the
    // discrepancy would change the tariff: the routed distance lands in a
    // higher price bracket than the AWB km (operator rule, 2026-06-24). A
    // map distance that is smaller, or larger-but-in-the-same-bracket
    // (e.g. AWB 21 → map 24, both 20-30 km), is shown but never alarms.
    const kmDiff = round1(mapboxKm - awbKm);
    const kmWarning = distanceTariffEscalates(awbKm, mapboxKm);
    const kmNote = kmWarning
      ? `Mapbox a calculat ${mapboxKm} km față de ${awbKm} km de pe AWB — alt prag de tarifare (${distanceBucket(awbKm)} → ${distanceBucket(mapboxKm)}). S-a folosit km de pe AWB.`
      : null;
    return {
      store,
      storeSource,
      distanceKm: awbKm,
      source: "awb",
      awbKm,
      mapboxKm,
      kmDiff,
      kmWarning,
      deliveryAddress,
      resolved: true,
      note: [approxNote, kmNote].filter(Boolean).join(" ") || null,
      ...destPoint,
    };
  } catch (err) {
    return fallback(`Eroare Mapbox (${(err as Error).message}) — s-a folosit km de pe AWB.`);
  }
}

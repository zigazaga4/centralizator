/**
 * Distance + origin-store resolution for one extracted shipment.
 *
 * This is the bridge between the OCR result and the pricing engine. It
 * answers two coupled questions for a pair:
 *
 *   1. WHICH store did it ship from?  (the centralizator bucket + the
 *      route origin) — read from the AWB's Expeditor via `matchStore`.
 *   2. HOW FAR is the delivery?       (the km the price is built on) —
 *      the shortest driving road distance from that store to the
 *      geocoded delivery address, per the operator's Leroy rule.
 *
 * It is BEST EFFORT by contract: any Mapbox hiccup (no token, geocode
 * miss, route stall) is caught and the result falls back to the km the
 * AWB itself printed (`distance_extra_km`). A pair must never fail just
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
import type { Extracted, Routing } from "./schema.js";

export type { Routing } from "./schema.js";

/** Round to one decimal — enough precision for billing, clean to display. */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * How far the Mapbox-routed km may stray from the AWB's printed km before
 * it raises a warning. The operator's rule is "any difference", so this is
 * 0 by default; the tiny epsilon in the comparison only absorbs float noise
 * between two values that are each already rounded to 0.1 km.
 */
const KM_WARN_TOLERANCE = Number(process.env.KM_WARN_TOLERANCE ?? 0);

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
    const dest = await geocode(deliveryAddress);
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
      };
    }

    const distanceKm = round1(km);
    // Reconcile our routed km against the km the AWB printed. The operator
    // wants ANY difference flagged, so it rides on the warning component.
    const kmDiff = round1(distanceKm - awbKm);
    const kmWarning = Math.abs(kmDiff) > KM_WARN_TOLERANCE + 1e-9;
    return {
      store,
      storeSource,
      distanceKm,
      source: "mapbox",
      awbKm,
      mapboxKm: distanceKm,
      kmDiff,
      kmWarning,
      deliveryAddress,
      resolved: true,
      note: null,
    };
  } catch (err) {
    return fallback(`Eroare Mapbox (${(err as Error).message}) — s-a folosit km de pe AWB.`);
  }
}

/**
 * Leroy Merlin dispatch-store registry + Expeditor matching.
 *
 * Every shipment leaves from ONE physical Leroy Merlin store. That store
 * is two things at once:
 *   1. the ROUTE ORIGIN for the Mapbox km calculation (store → delivery),
 *   2. the CENTRALIZATOR bucket the pair is filed under (the desktop app
 *      keeps a separate excel per store and the top dropdown switches
 *      between them).
 *
 * We learn the origin store from the AWB's Expeditor (sender) — Leroy
 * Merlin prints the dispatching store's name/address there. `matchStore`
 * keys on the distinctive street/locality token of each store, so it is
 * robust to OCR noise and formatting drift. When the Expeditor only says
 * "Iași" (no street) the two Iași stores are indistinguishable from text
 * alone; the caller then falls back to the nearest store by road distance.
 *
 * The four store keys are EXACTLY the four pricing `City` keys, so the
 * store a pair is filed under and the commission column shown for it line
 * up one-to-one with no extra mapping.
 *
 * Coordinates were geocoded once via the Mapbox Geocoding API (v6) from
 * the addresses the operator supplied; they are pinned here so the fixed
 * origins cost zero geocoding calls at runtime.
 */

import type { City } from "./tariffs.js";

/** A dispatch store key — identical to the pricing `City` keys. */
export type StoreKey = City;

export interface Store {
  key: StoreKey;
  /** Romanian display label (matches the client's CITY labels). */
  label: string;
  /** Human address as supplied by the operator. */
  address: string;
  /** Geocoded coordinates (WGS84). */
  lng: number;
  lat: number;
}

/**
 * The four stores. Iași has two:
 *   • IasiERA   — Calea Chișinăului 23, Hello Shopping Park (Bitlo collaborator, east Iași)
 *   • IasiTudor — Șoseaua Păcurari 121 / Mall Moldova (west Iași)
 */
export const STORES: Readonly<Record<StoreKey, Store>> = Object.freeze({
  Ploiesti: {
    key: "Ploiesti",
    label: "Ploiești",
    address: "DN 1, Km. 6, Comuna Blejoi 107070, Prahova",
    lng: 26.014277,
    lat: 44.987106,
  },
  IasiTudor: {
    key: "IasiTudor",
    label: "Iași (Tudor)",
    address: "Șoseaua Păcurari nr. 121, Mall Moldova, 700544 Iași",
    lng: 27.513137,
    lat: 47.167289,
  },
  IasiERA: {
    key: "IasiERA",
    label: "Iași (ERA)",
    address: "Calea Chișinăului 23, Hello Shopping Park, 700265 Iași",
    lng: 27.599649,
    lat: 47.148548,
  },
  Constanta: {
    key: "Constanta",
    label: "Constanța",
    address: "Bd. Aurel Vlaicu nr. 207, Constanța",
    lng: 28.600252,
    lat: 44.192539,
  },
});

export const STORE_KEYS: readonly StoreKey[] = ["Ploiesti", "IasiTudor", "IasiERA", "Constanta"];

/** Lowercase + strip diacritics so "Șoseaua Păcurari" matches "soseaua pacurari". */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Identify the origin store from the AWB's Expeditor fields.
 *
 * We concatenate every sender-side signal (name, address, hub) and look
 * for the store's distinctive token. Order matters: the street tokens are
 * tried before the bare city token so a full "Iași, Calea Chișinăului"
 * address resolves to the specific store, and only a city-only "Iași"
 * falls through to the ambiguous case.
 *
 * Returns:
 *   • a StoreKey when a specific store is identified;
 *   • "Iasi" (ambiguous marker) when the text says Iași but not WHICH store;
 *   • null when nothing matches.
 */
export function matchStore(parts: {
  senderName?: string | null;
  senderAddress?: string | null;
  hubDestination?: string | null;
}): StoreKey | "Iasi" | null {
  const hay = normalize(
    [parts.senderName, parts.senderAddress, parts.hubDestination].filter(Boolean).join(" | "),
  );
  if (!hay.trim()) return null;

  // Specific store tokens first. The Calea Chișinăului store is the
  // "Hello Shopping Park" location (Bitlo collaborator); match either the
  // street or the mall name so the Expeditor resolves even when only one
  // is printed/legible.
  if (/\bchisinaului\b/.test(hay)) return "IasiERA";
  if (/\bhello\b/.test(hay)) return "IasiERA";
  if (/\bera\b/.test(hay) && /\biasi\b/.test(hay)) return "IasiERA";
  if (/\bpacurari\b/.test(hay)) return "IasiTudor";
  if (/\bmoldova\b/.test(hay) && /\biasi\b/.test(hay)) return "IasiTudor";
  if (/\btudor\b/.test(hay)) return "IasiTudor";

  if (/\bvlaicu\b/.test(hay) || /\bconstanta\b/.test(hay)) return "Constanta";

  if (/\bblejoi\b/.test(hay) || /\bploiesti\b/.test(hay) || /\bprahova\b/.test(hay)) {
    return "Ploiesti";
  }

  // City-only Iași — we know it's an Iași store but not which one.
  if (/\biasi\b/.test(hay)) return "Iasi";

  return null;
}

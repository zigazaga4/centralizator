import type { WeightBucket, DistanceBucket } from "./tariffs.js";

/**
 * Weight (kg) → discrete weight bucket used by the tariff lookup.
 * Boundaries are inclusive on the lower end, exclusive on the upper,
 * matching the Excel category labels (`0-200kg`, `200-500kg`, etc.).
 *
 * Anything < 0 throws — there is no such thing as negative weight.
 */
export function weightBucket(weightKg: number): WeightBucket {
  if (!Number.isFinite(weightKg) || weightKg < 0) {
    throw new RangeError(`weightKg must be a non-negative finite number, got ${weightKg}`);
  }
  if (weightKg < 200)   return "0-200kg";
  if (weightKg < 500)   return "200-500kg";
  if (weightKg < 800)   return "500-800kg";
  if (weightKg < 1200)  return "800-1200kg";
  return ">1200kg";
}

/**
 * Distance (km) → discrete distance bucket. Same lower-inclusive,
 * upper-exclusive convention as the weight bucket. Anything > 50 km
 * lands in the ">50 km" bucket which also triggers per-km surcharge.
 */
export function distanceBucket(distanceKm: number): DistanceBucket {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError(`distanceKm must be a non-negative finite number, got ${distanceKm}`);
  }
  if (distanceKm < 15)  return "0-15 km";
  if (distanceKm < 20)  return "15-20 km";
  if (distanceKm < 30)  return "20-30 km";
  if (distanceKm < 50)  return "30-50 km";
  return ">50 km";
}

/**
 * Does the Mapbox-routed distance push the shipment into a HIGHER price
 * bracket than the AWB's printed km? This is the operator's km-alert rule
 * (2026-06-24): a km discrepancy only matters when it would change the
 * tariff. Concretely:
 *   • map km ≤ AWB km            → never alert (closer/equal is harmless;
 *                                   the AWB km is always what we bill).
 *   • map km > AWB km, SAME bucket → no alert (e.g. AWB 21 → map 24, both
 *                                   in the 20-30 km bracket — same price).
 *   • map km > AWB km, HIGHER bucket → ALERT (e.g. AWB 21 → map 31: 20-30
 *                                   crosses into 30-50, a different tariff).
 * Buckets are monotonic in km, so "larger AND different bucket" is exactly
 * "lands in a more expensive bracket".
 */
export function distanceTariffEscalates(awbKm: number, mapboxKm: number): boolean {
  if (!Number.isFinite(awbKm) || !Number.isFinite(mapboxKm)) return false;
  if (mapboxKm <= awbKm) return false;
  return distanceBucket(mapboxKm) !== distanceBucket(awbKm);
}

/**
 * The price-relevant WEIGHT tier of a shipment: its base weight bucket plus,
 * above 1200 kg, the number of extra-1000 kg increments (each adds an
 * increment-row tariff and a truck round — see pricing.ts). Two weights that
 * map to the same tier bill identically on the weight axis.
 */
export function weightTariffTier(weightKg: number): string {
  if (!Number.isFinite(weightKg) || weightKg < 0) return "invalid";
  const b = weightBucket(weightKg);
  // Mirror pricing.ts exactly: a >1200 kg order bills off the 800-1200 kg base
  // ROW plus one increment per full/partial extra 1000 kg over 1200. So the
  // price-relevant tier is (base row, increment count). Written this way, 1200
  // kg (0 increments) collapses to the same tier as 1199 kg — same tariff, no
  // false alarm across the boundary.
  const baseRow = b === ">1200kg" ? "800-1200kg" : b;
  const increments = b === ">1200kg" ? Math.ceil((weightKg - 1200) / 1000) : 0;
  return `${baseRow}+${increments}`;
}

/**
 * Would swapping the AWB's declared weight for the catalog-estimated weight
 * change the tariff? This is the weight analogue of distanceTariffEscalates:
 * a weight gap only matters when it moves the price, i.e. the two weights fall
 * in DIFFERENT weight tiers (a different base bucket, or a different >1200 kg
 * increment count). A difference that stays inside one tier bills the same and
 * is not flagged.
 *
 * Symmetric on purpose (unlike the km rule): the billed weight is always the
 * AWB's, but a catalog estimate in either a higher OR a lower tier means the
 * declared weight is priced in the wrong bracket, so both directions deserve
 * the flag. (ops 2026-07-01)
 */
export function weightTariffChanges(awbKg: number, estimatedKg: number): boolean {
  if (!Number.isFinite(awbKg) || !Number.isFinite(estimatedKg)) return false;
  if (awbKg < 0 || estimatedKg < 0) return false;
  return weightTariffTier(awbKg) !== weightTariffTier(estimatedKg);
}

/**
 * Romanian weekend = Saturday (6) or Sunday (0).
 * Accepts either a Date or an ISO-style `YYYY-MM-DD` string. Uses the
 * UTC weekday — calendar days don't shift across CET/CEST boundaries
 * for this purpose, and we don't want a timezone surprise mid-billing.
 */
export function isWeekend(date: Date | string): boolean {
  const d = typeof date === "string" ? parseISODate(date) : date;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Parse `YYYY-MM-DD` into a UTC-midnight Date. Throws on malformed input.
 */
export function parseISODate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new RangeError(`expected YYYY-MM-DD, got ${JSON.stringify(s)}`);
  const [, y, mo, da] = m;
  const d = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(da)));
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid date ${s}`);
  return d;
}

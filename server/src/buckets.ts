import type { WeightBucket, DistanceBucket, MacaraDistanceBucket } from "./tariffs.js";

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
 * Distance (km) → macara (crane) distance bucket. Same lower-inclusive,
 * upper-exclusive convention as `distanceBucket`, but the macara tariff
 * splits the first tier into 0-10 and 10-15 km (per "Tarife livrare
 * macara"). Anything > 50 km lands in ">50 km", which triggers the
 * macara per-km surcharge.
 */
export function macaraDistanceBucket(distanceKm: number): MacaraDistanceBucket {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new RangeError(`distanceKm must be a non-negative finite number, got ${distanceKm}`);
  }
  if (distanceKm < 10) return "0-10 km";
  if (distanceKm < 15) return "10-15 km";
  if (distanceKm < 20) return "15-20 km";
  if (distanceKm < 30) return "20-30 km";
  if (distanceKm < 50) return "30-50 km";
  return ">50 km";
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

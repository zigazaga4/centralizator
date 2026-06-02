/**
 * Tariff tables, ported verbatim from the Excel "Lookups" sheet of
 * `Centralizator Ploiesti STALEXONE 18-24.05.2026_UNLOCKED.xlsx`.
 *
 * Every number here is RON with the LEGACY 19% VAT already included
 * (that is how the source workbook was built). The pricing engine
 * reverses the 19% VAT to net, then re-applies the current 21% VAT.
 *
 * Source of truth: Lookups!B:C (60 base tariffs), Lookups!K:L (15
 * increment tariffs for >1200kg orders), Lookups!G (per-km surcharge
 * 1.90 RON for >50 km tier, 0 otherwise — bumped from the workbook's
 * original 1.70 per ops directive 2026-06-02), Lookups!C63 (weekend extra).
 *
 * DO NOT mutate these maps at runtime — they are the contract.
 */

export type Service = "Express" | "Premium" | "Prestabilita";
export type WeightBucket =
  | "0-200kg"
  | "200-500kg"
  | "500-800kg"
  | "800-1200kg"
  | ">1200kg";
export type DistanceBucket =
  | "0-15 km"
  | "15-20 km"
  | "20-30 km"
  | "30-50 km"
  | ">50 km";

export const SERVICES: readonly Service[] = ["Express", "Premium", "Prestabilita"] as const;
export const WEIGHT_BUCKETS: readonly WeightBucket[] = [
  "0-200kg", "200-500kg", "500-800kg", "800-1200kg", ">1200kg",
] as const;
export const DISTANCE_BUCKETS: readonly DistanceBucket[] = [
  "0-15 km", "15-20 km", "20-30 km", "30-50 km", ">50 km",
] as const;

/**
 * Map AWB "Serviciu" field values (free text from courier) onto our
 * three pricing services. Standard couriers map to Express.
 * Add more rows here as new strings appear in the field — never silently
 * default; throw and let the user decide.
 */
export const SERVICE_TEXT_MAP: Record<string, Service> = {
  standard: "Express",
  express: "Express",
  premium: "Premium",
  prestabilita: "Prestabilita",
  prestabilit: "Prestabilita",
};

/**
 * Base delivery tariffs, with the legacy 19% VAT already included.
 * Key = `${service} / ${weightBucket} / ${distanceBucket}`.
 * 60 entries (3 × 4 × 5). The >1200kg weight tier lives in INCREMENT_TARIFFS.
 */
export const BASE_TARIFFS: Readonly<Record<string, number>> = Object.freeze({
  // === Express / 0-200kg ===
  "Express / 0-200kg / 0-15 km":      23.80,
  "Express / 0-200kg / 15-20 km":     29.75,
  "Express / 0-200kg / 20-30 km":     35.70,
  "Express / 0-200kg / 30-50 km":     47.60,
  "Express / 0-200kg / >50 km":       47.60,
  // === Express / 200-500kg ===
  "Express / 200-500kg / 0-15 km":    41.65,
  "Express / 200-500kg / 15-20 km":   65.45,
  "Express / 200-500kg / 20-30 km":   65.45,
  "Express / 200-500kg / 30-50 km":   89.25,
  "Express / 200-500kg / >50 km":     89.25,
  // === Express / 500-800kg ===
  "Express / 500-800kg / 0-15 km":    47.60,
  "Express / 500-800kg / 15-20 km":   89.25,
  "Express / 500-800kg / 20-30 km":   89.25,
  "Express / 500-800kg / 30-50 km":  130.90,
  "Express / 500-800kg / >50 km":    130.90,
  // === Express / 800-1200kg ===
  "Express / 800-1200kg / 0-15 km":   59.50,
  "Express / 800-1200kg / 15-20 km": 101.15,
  "Express / 800-1200kg / 20-30 km": 101.15,
  "Express / 800-1200kg / 30-50 km": 128.52,
  "Express / 800-1200kg / >50 km":   128.52,

  // === Premium / 0-200kg ===
  "Premium / 0-200kg / 0-15 km":      95.20,
  "Premium / 0-200kg / 15-20 km":    101.15,
  "Premium / 0-200kg / 20-30 km":    107.10,
  "Premium / 0-200kg / 30-50 km":    119.00,
  "Premium / 0-200kg / >50 km":      297.50,
  // === Premium / 200-500kg ===
  "Premium / 200-500kg / 0-15 km":   107.10,
  "Premium / 200-500kg / 15-20 km":  208.25,
  "Premium / 200-500kg / 20-30 km":  208.25,
  "Premium / 200-500kg / 30-50 km":  214.20,
  "Premium / 200-500kg / >50 km":    357.00,
  // === Premium / 500-800kg ===
  "Premium / 500-800kg / 0-15 km":   214.20,
  "Premium / 500-800kg / 15-20 km":  261.80,
  "Premium / 500-800kg / 20-30 km":  261.80,
  "Premium / 500-800kg / 30-50 km":  285.60,
  "Premium / 500-800kg / >50 km":    416.50,
  // === Premium / 800-1200kg ===
  "Premium / 800-1200kg / 0-15 km":  297.50,
  "Premium / 800-1200kg / 15-20 km": 333.20,
  "Premium / 800-1200kg / 20-30 km": 333.20,
  "Premium / 800-1200kg / 30-50 km": 357.00,
  "Premium / 800-1200kg / >50 km":   476.00,

  // === Prestabilita / 0-200kg ===
  "Prestabilita / 0-200kg / 0-15 km":     83.30,
  "Prestabilita / 0-200kg / 15-20 km":    89.25,
  "Prestabilita / 0-200kg / 20-30 km":    95.20,
  "Prestabilita / 0-200kg / 30-50 km":   107.10,
  "Prestabilita / 0-200kg / >50 km":     297.50,
  // === Prestabilita / 200-500kg ===
  "Prestabilita / 200-500kg / 0-15 km":   95.20,
  "Prestabilita / 200-500kg / 15-20 km": 184.45,
  "Prestabilita / 200-500kg / 20-30 km": 184.45,
  "Prestabilita / 200-500kg / 30-50 km": 202.30,
  "Prestabilita / 200-500kg / >50 km":   357.00,
  // === Prestabilita / 500-800kg ===
  "Prestabilita / 500-800kg / 0-15 km":  142.80,
  "Prestabilita / 500-800kg / 15-20 km": 202.30,
  "Prestabilita / 500-800kg / 20-30 km": 202.30,
  "Prestabilita / 500-800kg / 30-50 km": 226.10,
  "Prestabilita / 500-800kg / >50 km":   416.50,
  // === Prestabilita / 800-1200kg ===
  "Prestabilita / 800-1200kg / 0-15 km": 238.00,
  "Prestabilita / 800-1200kg / 15-20 km":297.50,
  "Prestabilita / 800-1200kg / 20-30 km":297.50,
  "Prestabilita / 800-1200kg / 30-50 km":333.20,
  "Prestabilita / 800-1200kg / >50 km":  476.00,
});

/**
 * Increment tariffs — when an order weighs >1200 kg OR when a single
 * delivery covers multiple stops (num_deliveries > 1), each additional
 * 1000 kg / additional stop is charged the >1200kg tariff for the
 * same distance bucket. Excel column K formula: `(D-1) * J`.
 *
 * Key = `${service} / >1200kg / ${distanceBucket}`.
 */
export const INCREMENT_TARIFFS: Readonly<Record<string, number>> = Object.freeze({
  "Express / >1200kg / 0-15 km":   53.55,
  "Express / >1200kg / 15-20 km":  95.20,
  "Express / >1200kg / 20-30 km":  95.20,
  "Express / >1200kg / 30-50 km": 122.57,
  "Express / >1200kg / >50 km":   122.57,

  "Premium / >1200kg / 0-15 km":  291.55,
  "Premium / >1200kg / 15-20 km": 327.25,
  "Premium / >1200kg / 20-30 km": 327.25,
  "Premium / >1200kg / 30-50 km": 351.05,
  "Premium / >1200kg / >50 km":   470.05,

  "Prestabilita / >1200kg / 0-15 km":  232.05,
  "Prestabilita / >1200kg / 15-20 km": 291.55,
  "Prestabilita / >1200kg / 20-30 km": 291.55,
  "Prestabilita / >1200kg / 30-50 km": 327.25,
  "Prestabilita / >1200kg / >50 km":   470.05,
});

/**
 * Weekend surcharge (Sat/Sun) added once per row, with 19% VAT included.
 * Source: Lookups!C63.
 */
export const WEEKEND_SURCHARGE_VAT19 = 11.90;

/**
 * Per-extra-km tariff for the ">50 km" bucket only, with 19% VAT included.
 * Applied as: extra_km × rate × 2 (round trip) × num_deliveries.
 * Source: Lookups!G6 originally 1.70; raised to 1.90 per ops directive
 * 2026-06-02 (this constant is now the contract, not the workbook).
 */
export const PER_KM_SURCHARGE_VAT19 = 1.90;

/**
 * Distance above which the per-km surcharge kicks in. The >50 km bucket
 * means total > 50, and (total − 50) km is charged.
 * Source: Lookups!F6.
 */
export const EXTRA_KM_THRESHOLD = 50;

/**
 * VAT rates: the workbook stores tariffs as gross @ 19% (the rate in
 * effect when the table was built); current billing is at 21%.
 */
export const VAT_LEGACY = 0.19;
export const VAT_CURRENT = 0.21;

/**
 * Per-city dispatcher commission, applied on top of the carrier gross
 * (totalVat21). The workbook tariffs above are what the CARRIER charges;
 * the company marks them up by this percentage on a per-hub basis, and
 * that marked-up number is what the END CUSTOMER pays.
 *
 * Applied per city as:
 *   customerTotal[city] = totalVat21 + round2(totalVat21 × pct[city]).
 *
 * Source: PRETURI COLABORATORI sheet, "LUAM" rows. Iași has two
 * dispatch sites (Tudor and ERA) that happen to share the same 33.7%
 * cut today; they are still modelled as distinct cities so a future
 * divergence is a one-line edit.
 */
export type City = "Ploiesti" | "IasiTudor" | "IasiERA" | "Constanta";

export const CITIES: readonly City[] = [
  "Ploiesti", "IasiTudor", "IasiERA", "Constanta",
] as const;

export const COMPANY_COMMISSION_BY_CITY: Readonly<Record<City, number>> = Object.freeze({
  Ploiesti:  0.501,
  IasiTudor: 0.337,
  IasiERA:   0.337,
  Constanta: 0.337,
});

/**
 * Per-collaborator bonus, applied on top of the SAME carrier gross
 * (totalVat21) as the city commission, using the same formula:
 *   collaboratorTotal[c] = totalVat21 + round2(totalVat21 × bonusPct[c]).
 *
 * Source: PRETURI COLABORATORI sheet, "BONUS" rows. Macara-side
 * collaborators (EMV MACARA, MACARA PLOIESTI) are deliberately
 * excluded — those run on a different (crane) tariff that this engine
 * does not price.
 */
export type Collaborator =
  | "Stalexone"
  | "EMV"
  | "Bitlo"
  | "VicDinamicExpert"
  | "Tiberiu";

export const COLLABORATORS: readonly Collaborator[] = [
  "Stalexone", "EMV", "Bitlo", "VicDinamicExpert", "Tiberiu",
] as const;

export const COLLABORATOR_BONUS_BY_NAME: Readonly<Record<Collaborator, number>> = Object.freeze({
  Stalexone:        0.25,
  EMV:              0.301,
  Bitlo:            0.12,
  VicDinamicExpert: 0.25,
  Tiberiu:          0.29,
});

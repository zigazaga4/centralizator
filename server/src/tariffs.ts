/**
 * Tariff tables — sourced from the operator pricing documents:
 *   • DRAFT LISTA PRETURI LEROY.docx (Express)
 *   • PRETURI COLABORATORI.ods (city commissions + collaborator bonuses)
 *
 * Every number here is RON with the CURRENT VAT already included
 * ("TVA inclus" in the docs). The engine adds them straight onto the
 * carrier total — no legacy-rate round-trip. Premium / Prestabilita
 * rows are not in the docs; their values are the pre-baked equivalent
 * of the historical workbook tariffs at the current VAT rate.
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
 * Base delivery tariffs (RON, VAT included at the current rate).
 * Key = `${service} / ${weightBucket} / ${distanceBucket}`.
 *
 * Express values are taken verbatim from DRAFT LISTA PRETURI LEROY.docx.
 * The doc collapses 15-20 and 20-30 into a single 15-30 bucket for the
 * 200-500 / 500-800 / 800-1200 weight tiers (and the >1200 increment
 * table); we materialise the same value into both buckets so the lookup
 * stays a flat table. The >50 km tier shares the 30-50 base rate; the
 * per-km surcharge below kicks in on top of it.
 *
 * Premium / Prestabilita do not appear in the docs; their rates here
 * are the pre-baked current-VAT equivalents of the historical workbook
 * values so a stray AWB tagged with one of those tiers still prices.
 *
 * 60 entries (3 × 4 × 5). The >1200kg weight tier lives in INCREMENT_TARIFFS.
 */
export const BASE_TARIFFS: Readonly<Record<string, number>> = Object.freeze({
  // === Express / 0-200kg ===
  "Express / 0-200kg / 0-15 km":      24.20,
  "Express / 0-200kg / 15-20 km":     30.30,
  "Express / 0-200kg / 20-30 km":     36.31,
  "Express / 0-200kg / 30-50 km":     48.40,
  "Express / 0-200kg / >50 km":       48.40,
  // === Express / 200-500kg ===
  "Express / 200-500kg / 0-15 km":    42.40,
  "Express / 200-500kg / 15-20 km":   66.60,
  "Express / 200-500kg / 20-30 km":   66.60,
  "Express / 200-500kg / 30-50 km":   90.80,
  "Express / 200-500kg / >50 km":     90.80,
  // === Express / 500-800kg ===
  "Express / 500-800kg / 0-15 km":    48.40,
  "Express / 500-800kg / 15-20 km":   90.80,
  "Express / 500-800kg / 20-30 km":   90.80,
  "Express / 500-800kg / 30-50 km":  133.10,
  "Express / 500-800kg / >50 km":    133.10,
  // === Express / 800-1200kg ===
  "Express / 800-1200kg / 0-15 km":   60.50,
  "Express / 800-1200kg / 15-20 km": 102.90,
  "Express / 800-1200kg / 20-30 km": 102.90,
  "Express / 800-1200kg / 30-50 km": 130.66,
  "Express / 800-1200kg / >50 km":   130.66,

  // === Premium / 0-200kg ===
  "Premium / 0-200kg / 0-15 km":      96.80,
  "Premium / 0-200kg / 15-20 km":    102.85,
  "Premium / 0-200kg / 20-30 km":    108.90,
  "Premium / 0-200kg / 30-50 km":    121.00,
  "Premium / 0-200kg / >50 km":      302.50,
  // === Premium / 200-500kg ===
  "Premium / 200-500kg / 0-15 km":   108.90,
  "Premium / 200-500kg / 15-20 km":  211.75,
  "Premium / 200-500kg / 20-30 km":  211.75,
  "Premium / 200-500kg / 30-50 km":  217.80,
  "Premium / 200-500kg / >50 km":    363.00,
  // === Premium / 500-800kg ===
  "Premium / 500-800kg / 0-15 km":   217.80,
  "Premium / 500-800kg / 15-20 km":  266.20,
  "Premium / 500-800kg / 20-30 km":  266.20,
  "Premium / 500-800kg / 30-50 km":  290.40,
  "Premium / 500-800kg / >50 km":    423.50,
  // === Premium / 800-1200kg ===
  "Premium / 800-1200kg / 0-15 km":  302.50,
  "Premium / 800-1200kg / 15-20 km": 338.80,
  "Premium / 800-1200kg / 20-30 km": 338.80,
  "Premium / 800-1200kg / 30-50 km": 363.00,
  "Premium / 800-1200kg / >50 km":   484.00,

  // === Prestabilita / 0-200kg ===
  "Prestabilita / 0-200kg / 0-15 km":     84.70,
  "Prestabilita / 0-200kg / 15-20 km":    90.75,
  "Prestabilita / 0-200kg / 20-30 km":    96.80,
  "Prestabilita / 0-200kg / 30-50 km":   108.90,
  "Prestabilita / 0-200kg / >50 km":     302.50,
  // === Prestabilita / 200-500kg ===
  "Prestabilita / 200-500kg / 0-15 km":   96.80,
  "Prestabilita / 200-500kg / 15-20 km": 187.55,
  "Prestabilita / 200-500kg / 20-30 km": 187.55,
  "Prestabilita / 200-500kg / 30-50 km": 205.70,
  "Prestabilita / 200-500kg / >50 km":   363.00,
  // === Prestabilita / 500-800kg ===
  "Prestabilita / 500-800kg / 0-15 km":  145.20,
  "Prestabilita / 500-800kg / 15-20 km": 205.70,
  "Prestabilita / 500-800kg / 20-30 km": 205.70,
  "Prestabilita / 500-800kg / 30-50 km": 229.90,
  "Prestabilita / 500-800kg / >50 km":   423.50,
  // === Prestabilita / 800-1200kg ===
  "Prestabilita / 800-1200kg / 0-15 km": 242.00,
  "Prestabilita / 800-1200kg / 15-20 km":302.50,
  "Prestabilita / 800-1200kg / 20-30 km":302.50,
  "Prestabilita / 800-1200kg / 30-50 km":338.80,
  "Prestabilita / 800-1200kg / >50 km":  484.00,
});

/**
 * Increment tariffs (RON, VAT included at the current rate) — when an
 * order weighs >1200 kg OR when a single AWB covers multiple stops
 * (num_deliveries > 1), each additional 1000 kg / additional stop is
 * charged the >1200kg tariff for the same distance bucket.
 * Formula: `incrementCost = (D - 1) * INCREMENT_TARIFFS[key]`.
 *
 * Express row taken verbatim from DRAFT LISTA PRETURI LEROY.docx.
 *
 * Key = `${service} / >1200kg / ${distanceBucket}`.
 */
export const INCREMENT_TARIFFS: Readonly<Record<string, number>> = Object.freeze({
  "Express / >1200kg / 0-15 km":   54.50,
  "Express / >1200kg / 15-20 km":  96.80,
  "Express / >1200kg / 20-30 km":  96.80,
  "Express / >1200kg / 30-50 km": 124.66,
  "Express / >1200kg / >50 km":   124.66,

  "Premium / >1200kg / 0-15 km":  296.45,
  "Premium / >1200kg / 15-20 km": 332.75,
  "Premium / >1200kg / 20-30 km": 332.75,
  "Premium / >1200kg / 30-50 km": 356.95,
  "Premium / >1200kg / >50 km":   477.95,

  "Prestabilita / >1200kg / 0-15 km":  235.95,
  "Prestabilita / >1200kg / 15-20 km": 296.45,
  "Prestabilita / >1200kg / 20-30 km": 296.45,
  "Prestabilita / >1200kg / 30-50 km": 332.75,
  "Prestabilita / >1200kg / >50 km":   477.95,
});

/**
 * Weekend surcharge (Sat/Sun), VAT included. Source: LEROY doc — same
 * 11.90 RON line that runs down the right-hand column of every weight
 * tier.
 */
export const WEEKEND_SURCHARGE = 11.90;

/**
 * Per-extra-km tariff for the ">50 km" bucket only (RON, VAT included).
 * Applied as: extra_km × rate × 2 (round trip) × num_deliveries.
 *
 * The LEROY doc lists this at 1.70 RON; per ops directive 2026-06-02 we
 * charge 1.90 RON. This constant is the contract — the doc is the
 * baseline, the override stands.
 */
export const PER_KM_SURCHARGE = 1.90;

/**
 * Distance above which the per-km surcharge kicks in. The >50 km bucket
 * means total > 50, and (total − 50) km is charged.
 */
export const EXTRA_KM_THRESHOLD = 50;

/**
 * Bulky-but-light goods (polystyrene / mineral wool) fill a truck by
 * volume, not by weight. Ops rule 2026-06-11: the ONLY qualifying
 * criteria is the piece count, 24 bulky pieces per transport. Each extra
 * transport is charged like a real extra trip, one increment tariff plus
 * another round of the per-km surcharge.
 *
 * Below 24 pieces nothing is charged. From 24 up, one extra transport per
 * started block of 24, regardless of what else is on the truck:
 *   23 → 0,  24 → 1,  25 → 2,  48 → 2,  49 → 3.
 */
export const BULKY_UNITS_PER_TRANSPORT = 24;

/**
 * Unloading fee ("descărcare") — a SEPARATE flat tax, not part of the
 * transport tariff and NOT marked up by the city commission / collaborator
 * bonus. Billed per qualifying unloading on the shipment.
 *
 * The operator fixed both figures verbatim: 177.69 RON without VAT, which
 * is 210 RON with VAT. Only invoice "descărcare" lines billed at exactly
 * this amount are the standard unloading fee; any other "descărcare" line
 * (a different amount) is something else and is NOT counted here.
 *
 * Source: ops directive 2026-06-05 (Ambient Intermed).
 */
export const UNLOADING_TAX_NET = 177.69;
export const UNLOADING_TAX_GROSS = 210;

/* ──────────────────────────────────────────────────────────────────────
 * Macara (crane delivery) — a SEPARATE pricing track, and one that does
 * NOT carry the dispatcher commission / collaborator bonus at all. A macara
 * run is priced ONLY off the macara table below; the standard transport
 * tariff and every commission/bonus are irrelevant for it.
 *
 * Two distinct rate tables, by dispatch site:
 *
 *   • Table A (RON cu TVA) — "Tarife livrare macara", Iași Tudor + Constanța.
 *       Source: "Tarife Macara Constanta si Iasi 1.pdf".
 *       0-10 / 10-15 km = 638,3 · 15-20 = 704,0 · 20-30 = 735,2 ·
 *       30-50 = 940,2 · >50 = 940,2 + 5 lei/km tur-retur. Descărcare 26,7/palet.
 *
 *   • Table B (RON cu TVA) — "TARIFE MACARA (1-8 paleți)", Ploiești + Iași ERA.
 *       Source: "TARIFE MACARA(2).odt" (the updated ord. 2 sheet).
 *       0-15 km = 494 · 15-20 = 545 · 20-30 = 569 · 30-50 = 728 ·
 *       >50 = 728 + 4,5 lei/km tur-retur. Descărcare 24/palet.
 *
 * In both tables the "tur-retur" round trip is ALREADY baked into the per-km
 * figure, so it is NOT doubled the way the standard PER_KM_SURCHARGE is.
 * 1-8 paleți ride at one flat distance price; the per-palet descărcare fee
 * is billed on top. Detection + warning rule (ops directive 2026-06-05): the
 * AWB "Serviciu" naming macara is the legitimate signal; if instead the AWB
 * reads something else but a macara line is on the invoice, a separate
 * warning fires for the operator.
 * ────────────────────────────────────────────────────────────────────── */
export type MacaraDistanceBucket =
  | "0-10 km"
  | "10-15 km"
  | "0-15 km"
  | "15-20 km"
  | "20-30 km"
  | "30-50 km"
  | ">50 km";

/** One distance bracket: distance < `maxKm` selects this row (last row uses
 *  Infinity as the ">50 km" sentinel). */
export interface MacaraBracket {
  maxKm: number;
  label: MacaraDistanceBucket;
  price: number;
}

/** A full macara rate table for a group of dispatch sites. */
export interface MacaraRateTable {
  brackets: readonly MacaraBracket[];
  /** Per-km tur-retur surcharge applied to the km past `thresholdKm`
   *  (round trip already included, so NOT doubled). RON cu TVA. */
  perKmGross: number;
  thresholdKm: number;
  /** Descărcare fee per palet delivered with macara. RON cu TVA. */
  unloadPerPalletGross: number;
}

/** Table A — Iași Tudor + Constanța
 *  ("Tarife Macara Constanta si Iasi 1-2.pdf", cu TVA). */
export const MACARA_TABLE_A: MacaraRateTable = Object.freeze({
  brackets: Object.freeze([
    { maxKm: 10,       label: "0-10 km",  price: 638.3 },
    { maxKm: 15,       label: "10-15 km", price: 638.3 },
    { maxKm: 20,       label: "15-20 km", price: 704.0 },
    { maxKm: 30,       label: "20-30 km", price: 735.2 },
    { maxKm: 50,       label: "30-50 km", price: 940.2 },
    { maxKm: Infinity, label: ">50 km",   price: 940.2 },
  ]) as readonly MacaraBracket[],
  perKmGross: 5,
  thresholdKm: 50,
  unloadPerPalletGross: 26.7,
});

/** Table B — Ploiești + Iași ERA
 *  ("TARIFE MACARA PLOIESTI SI IASI 2.odt", cu TVA). */
export const MACARA_TABLE_B: MacaraRateTable = Object.freeze({
  brackets: Object.freeze([
    { maxKm: 15,       label: "0-15 km",  price: 471.8 },
    { maxKm: 20,       label: "15-20 km", price: 520.6 },
    { maxKm: 30,       label: "20-30 km", price: 544 },
    { maxKm: 50,       label: "30-50 km", price: 695.5 },
    { maxKm: Infinity, label: ">50 km",   price: 695.5 },
  ]) as readonly MacaraBracket[],
  perKmGross: 4.5,
  thresholdKm: 50,
  unloadPerPalletGross: 15,
});

/** A single crane truck carries 1-8 paleți (per the macara docs:
 *  "TARIFE MACARA (1-8 PALETI)"). Past 8 paleți a second truck run is
 *  needed, and the delivery price is billed once per started block of 8. */
export const MACARA_PALLETS_PER_RUN = 8;

/** Which macara table each dispatch site uses. */
export const MACARA_TABLE_BY_CITY: Readonly<Record<City, MacaraRateTable>> = Object.freeze({
  IasiTudor: MACARA_TABLE_A,
  Constanta: MACARA_TABLE_A,
  Ploiesti:  MACARA_TABLE_B,
  IasiERA:   MACARA_TABLE_B,
});

/** Table used when the dispatch store is undetermined — defaults to the
 *  PDF (Table A) since it covers the headline "Constanța + Iași" sites. */
export const MACARA_DEFAULT_TABLE: MacaraRateTable = MACARA_TABLE_A;

/**
 * Per-city dispatcher commission, applied on top of the carrier total.
 * The base tariffs above are what the CARRIER charges; the company
 * marks them up by this percentage on a per-hub basis, and that
 * marked-up number is what the END CUSTOMER pays.
 *
 * Applied per city as:
 *   customerTotal[city] = carrierTotal + round2(carrierTotal × pct[city]).
 *
 * Source: PRETURI COLABORATORI.ods, "LUAM" rows. Iași has two dispatch
 * sites (Tudor and ERA) that happen to share the same 33.7% cut today;
 * they are still modelled as distinct cities so a future divergence is
 * a one-line edit.
 */
export type City = "Ploiesti" | "IasiTudor" | "IasiERA" | "Constanta";

export const CITIES: readonly City[] = [
  "Ploiesti", "IasiTudor", "IasiERA", "Constanta",
] as const;

/**
 * STAGED company commission ("bonus") per city — operator directive
 * 2026-06-11 (Ambient Intermed). The bonus is NOT one flat percentage; it
 * is applied in successive stages, each on the RESULT of the previous one:
 *
 *   • Iași ERA / Iași Tudor / Constanța: +2,7%, apoi +3,6% din rezultat,
 *     apoi +16% din rezultat, apoi +11,4% din rezultat.
 *   • Ploiești: +22,7%, apoi +16% din rezultat, apoi +11,4% din rezultat.
 *
 * Successive percentages on the running result are a product of factors,
 * so the effective rate is Π(1 + stage) − 1:
 *   Iași/Constanța: 1.027 × 1.036 × 1.16 × 1.114 − 1 ≈ 0.374907 (≈ 37,5%)
 *   Ploiești:       1.227 × 1.16 × 1.114 − 1         ≈ 0.585578 (≈ 58,6%)
 *
 * This supersedes the flat 33,7% / 50,1% figures from PRETURI
 * COLABORATORI.ods. Confirmed against reality: the courier's customer
 * prices in the Main export decode to EXACTLY ×1.375 of the contract grid
 * on Constanța runs — the staged compound, to the fourth decimal.
 */
export const COMPANY_COMMISSION_STAGES_BY_CITY: Readonly<Record<City, readonly number[]>> =
  Object.freeze({
    Ploiesti:  [0.227, 0.16, 0.114],
    // Iași Tudor (Iași 1) has its OWN rule (ops directive 2026-06-11):
    //   1. base prices +18,7%
    //   2. km suplimentari stay 1,90 lei/km (flat, never commissioned)
    //   3. the resulting prices are bonused by +11,4%
    // → compound on the base = 1.187 × 1.114 − 1 ≈ 0.322318 (≈ 32,23%).
    // The descărcare for Iași Tudor is ALSO bonused by the 11,4% (see
    // DESCARCARE_BONUS_BY_CITY): 210 → 233,94 RON.
    IasiTudor: [0.187, 0.114],
    IasiERA:   [0.027, 0.036, 0.16, 0.114],
    Constanta: [0.027, 0.036, 0.16, 0.114],
  });

/**
 * Per-city bonus applied to the descărcare (unloading) fee, on top of its
 * base 210 RON cu TVA. Ops directive 2026-06-11: Iași Tudor bonuses the
 * descărcare by the same +11,4% as its transport prices (210 → 233,94).
 * Every other city bills the flat 210 (factor 0) until told otherwise.
 */
export const DESCARCARE_BONUS_BY_CITY: Readonly<Record<City, number>> = Object.freeze({
  Ploiesti:  0,
  IasiTudor: 0.114,
  IasiERA:   0,
  Constanta: 0,
});

/** Effective compound commission rate per city = Π(1 + stage) − 1. */
export const COMPANY_COMMISSION_BY_CITY: Readonly<Record<City, number>> = Object.freeze(
  Object.fromEntries(
    CITIES.map((city) => [
      city,
      COMPANY_COMMISSION_STAGES_BY_CITY[city].reduce((f, s) => f * (1 + s), 1) - 1,
    ]),
  ) as Record<City, number>,
);

/**
 * Per-collaborator bonus, applied on top of the SAME carrier total as
 * the city commission, using the same formula:
 *   collaboratorTotal[c] = carrierTotal + round2(carrierTotal × bonusPct[c]).
 *
 * Source: PRETURI COLABORATORI.ods, "BONUS" rows, plus the Constanța
 * roster (Berneanu/Rotaru/Saulea×2/Tudorof) added later by the
 * operator at a flat 10% each. Macara-side collaborators (EMV MACARA,
 * MACARA PLOIESTI) are deliberately excluded — those run on a
 * different (crane) tariff that this engine does not price.
 */
export type Collaborator =
  | "Stalexone"
  | "EMV"
  | "Bitlo"
  | "VicDinamicExpert"
  | "Tiberiu"
  | "BerneanuAdrian"
  | "RotaruIulian"
  | "SauleaConstantin"
  | "SauleaLiliana"
  | "TudorofTiberiu";

export const COLLABORATORS: readonly Collaborator[] = [
  "Stalexone", "EMV", "Bitlo", "VicDinamicExpert", "Tiberiu",
  "BerneanuAdrian", "RotaruIulian", "SauleaConstantin", "SauleaLiliana", "TudorofTiberiu",
] as const;

export const COLLABORATOR_BONUS_BY_NAME: Readonly<Record<Collaborator, number>> = Object.freeze({
  Stalexone:        0.25,
  EMV:              0.301,
  Bitlo:            0.12,
  VicDinamicExpert: 0.25,
  Tiberiu:          0.29,
  // Constanța roster — flat 10% commission each.
  BerneanuAdrian:   0.10,
  RotaruIulian:     0.10,
  SauleaConstantin: 0.10,
  SauleaLiliana:    0.10,
  TudorofTiberiu:   0.10,
});

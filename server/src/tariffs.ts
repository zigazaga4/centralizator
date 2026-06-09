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
 * volume, not by weight. Ops rule 2026-06-03: one extra transport per
 * this many bulky units. Each extra transport is charged like a real
 * extra trip — one increment tariff plus another round of the per-km
 * surcharge.
 *
 * When the shipment is ALL bulky, the first 24 units ride in the base
 * transport (so 24 → 0 extra, 25 → 1 extra). When there are also other
 * products, the base transport is taken by those, so every 24 bulky
 * units needs its own extra transport (24 → 1, 25 → 2).
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
 * Macara (crane delivery) — a SEPARATE pricing track.
 *
 * Source: "Tarife Macara Constanta si Iasi 1.pdf" — "Tarife livrare macara
 * (cu TVA) Iași Tudor, Iași ERA, Constanța, Ploiești". The SAME table
 * applies to all four dispatch sites. Every figure is RON WITH VAT
 * ("cu TVA"); the document gives no without-VAT figures, so none are
 * invented here.
 *
 * A macara run carries 1-8 paleți at one flat distance-bucketed price, plus
 * a per-palet unloading fee (26,7 lei cu TVA / palet). Over 50 km the base
 * price gets a 5 lei/km tur-retur surcharge on the kilometres past 50 (the
 * "tur-retur" round trip is ALREADY baked into the 5 lei, so it is not
 * doubled the way the standard PER_KM_SURCHARGE is).
 *
 * Like the descărcare tax, macara is kept ENTIRELY separate: its own
 * breakdown section, NOT commissioned and NOT folded into the carrier /
 * customer / collaborator totals. Detection + warning rule (ops directive
 * 2026-06-05): the AWB "Serviciu" naming macara is the legitimate signal;
 * if instead the AWB reads something else (e.g. "standard") but a macara
 * line is on the invoice, that fires a separate warning for the operator.
 * ────────────────────────────────────────────────────────────────────── */
export type MacaraDistanceBucket =
  | "0-10 km"
  | "10-15 km"
  | "15-20 km"
  | "20-30 km"
  | "30-50 km"
  | ">50 km";

export const MACARA_DISTANCE_BUCKETS: readonly MacaraDistanceBucket[] = [
  "0-10 km", "10-15 km", "15-20 km", "20-30 km", "30-50 km", ">50 km",
] as const;

/** Macara delivery price per distance bucket (RON, cu TVA). Flat for 1-8
 *  paleți. The >50 km bucket shares the 30-50 km base; the per-km surcharge
 *  below is added on top of it. */
export const MACARA_TARIFFS_GROSS: Readonly<Record<MacaraDistanceBucket, number>> = Object.freeze({
  "0-10 km":  638.3,
  "10-15 km": 638.3,
  "15-20 km": 704.0,
  "20-30 km": 735.2,
  "30-50 km": 940.2,
  ">50 km":   940.2,
});

/** Macara per-km surcharge for the >50 km bucket (RON cu TVA), applied to the
 *  (km − 50) overage. The doc's "5 Ron/km tur-retur" already counts the round
 *  trip, so it is NOT multiplied by 2 (unlike the standard PER_KM_SURCHARGE). */
export const MACARA_PER_KM_GROSS = 5;

/** Distance above which the macara per-km surcharge kicks in. */
export const MACARA_EXTRA_KM_THRESHOLD = 50;

/** Unloading fee per palet delivered with macara (RON cu TVA), the doc's
 *  "Taxa descarcare" column. Billed once per palet on the run. */
export const MACARA_UNLOAD_PER_PALLET_GROSS = 26.7;

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

export const COMPANY_COMMISSION_BY_CITY: Readonly<Record<City, number>> = Object.freeze({
  Ploiesti:  0.501,
  IasiTudor: 0.337,
  IasiERA:   0.337,
  Constanta: 0.337,
});

/**
 * Per-collaborator bonus, applied on top of the SAME carrier total as
 * the city commission, using the same formula:
 *   collaboratorTotal[c] = carrierTotal + round2(carrierTotal × bonusPct[c]).
 *
 * Source: PRETURI COLABORATORI.ods, "BONUS" rows. Macara-side
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

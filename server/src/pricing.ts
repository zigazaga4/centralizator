/**
 * Pricing engine — deterministic, pure, no I/O.
 *
 * This is a line-for-line port of the formulas in the Excel sheet
 * `Centralizator OFFLINE+ONLINE`, columns E through P:
 *
 *   E = VLOOKUP(C, Lookups!B:C, 2, 0)              base tariff (gross @19% VAT)
 *   G = VLOOKUP(C, Lookups!B:G, 6, 0)              per-km rate (1.70 for >50 km bucket, 0 else)
 *   H = F * G * 2 * D                              extra-km cost, round-trip × num_deliveries
 *   J = VLOOKUP(I, Lookups!K:L, 2, 0)              >1200kg increment tariff
 *   K = (D - 1) * J                                cost of additional stops / extra 1000 kg
 *   L = weekend ? 11.90 : 0                        weekend surcharge
 *   M = E + H + K + L                              total gross @19% VAT (legacy)
 *   N = M / 1.19                                   net
 *   O = N * 0.21                                   VAT 21%
 *   P = N + O                                      carrier gross @21% VAT
 *
 * Then the per-city company commission AND the per-collaborator bonus,
 * neither of which are in the workbook — added per ops directive
 * 2026-06-02. Both are applied to the carrier gross P with the same
 * formula, just different pct lookups:
 *
 *   cityCommissions[city].commission    = round2(P × companyPct[city])
 *   cityCommissions[city].customerTotal = round2(P + commission)
 *
 *   collaboratorPrices[c].bonus         = round2(P × bonusPct[c])
 *   collaboratorPrices[c].total         = round2(P + bonus)
 *
 * The breakdown carries ALL 4 cities and ALL 5 collaborators every
 * time, so the UI can flip city/collaborator dropdowns client-side
 * without re-hitting the server.
 *
 * Inputs are post-extraction, post-validation. The function trusts
 * its arguments; callers (route handlers) validate via Zod first.
 */

import {
  BASE_TARIFFS,
  INCREMENT_TARIFFS,
  WEEKEND_SURCHARGE_VAT19,
  PER_KM_SURCHARGE_VAT19,
  EXTRA_KM_THRESHOLD,
  VAT_LEGACY,
  VAT_CURRENT,
  CITIES,
  COLLABORATORS,
  COMPANY_COMMISSION_BY_CITY,
  COLLABORATOR_BONUS_BY_NAME,
  type Service,
  type WeightBucket,
  type DistanceBucket,
  type City,
  type Collaborator,
} from "./tariffs.js";
import { weightBucket, distanceBucket, isWeekend } from "./buckets.js";

export interface PricingInput {
  /** Service tier — already mapped from AWB free text (Standard → Express, etc). */
  service: Service;
  /** Raw weight in kg from the AWB's "Greutate (kg)" field. */
  weightKg: number;
  /** Total km from hub to recipient — AWB's "Distanță extra (km)" field. */
  distanceKm: number;
  /** Number of distinct deliveries on this AWB. Default 1. */
  numDeliveries: number;
  /** ISO date YYYY-MM-DD of the delivery. Drives the weekend surcharge. */
  deliveryDate: string;
}

export interface PricingBreakdown {
  /** Derived buckets — handy for the UI to display. */
  weightBucket: WeightBucket;
  distanceBucket: DistanceBucket;
  /** The keys used to hit the tariff tables. */
  baseKey: string;
  incrementKey: string;
  /** km charged at the per-km surcharge rate (one-way overage above 50 km). */
  extraKm: number;
  /** Whether the weekend surcharge was applied. */
  weekend: boolean;
  /** Excel column E. */
  baseTariff: number;
  /** Excel column H. */
  extraKmCost: number;
  /** Excel column J. */
  incrementTariff: number;
  /** Excel column K. */
  incrementCost: number;
  /** Excel column L. */
  weekendSurcharge: number;
  /** Excel column M — legacy gross @19% VAT. */
  totalVat19: number;
  /** Excel column N — net before VAT. */
  net: number;
  /** Excel column O — VAT amount @21%. */
  vat21: number;
  /** Excel column P — carrier-side billable gross @21% VAT.
   *  This is the "base rate" both the city commission and the
   *  collaborator bonus are applied to. */
  totalVat21: number;
  /** Per-city company commission (markup on top of totalVat21). The
   *  matching `customerTotal` is what the END customer in that city pays. */
  cityCommissions: Record<City, CityCommission>;
  /** Per-collaborator bonus (markup on top of totalVat21). The matching
   *  `total` is the collaborator-facing price. */
  collaboratorPrices: Record<Collaborator, CollaboratorPrice>;
}

export interface CityCommission {
  /** Commission rate, e.g. 0.501 for Ploiești. */
  pct: number;
  /** Commission amount in RON, = round2(totalVat21 × pct). */
  commission: number;
  /** Final customer total, = round2(totalVat21 + commission). */
  customerTotal: number;
}

export interface CollaboratorPrice {
  /** Bonus rate, e.g. 0.25 for Stalexone. */
  pct: number;
  /** Bonus amount in RON, = round2(totalVat21 × pct). */
  bonus: number;
  /** Final collaborator-facing price, = round2(totalVat21 + bonus). */
  total: number;
}

export function calculatePrice(input: PricingInput): PricingBreakdown {
  const { service, weightKg, distanceKm, numDeliveries, deliveryDate } = input;

  if (!Number.isInteger(numDeliveries) || numDeliveries < 1) {
    throw new RangeError(`numDeliveries must be a positive integer, got ${numDeliveries}`);
  }

  const wBucket = weightBucket(weightKg);
  const dBucket = distanceBucket(distanceKm);

  // For pricing, weight bucket >1200kg uses the increment table for the
  // BASE row too (treated as 0 base + N×increment). Match Excel: the
  // base lookup of a >1200kg row is missing from the BASE_TARIFFS map,
  // so for >1200kg we fall back to the increment as the per-stop tariff.
  // (The Excel author models the >1200kg case via the J column only.)
  const baseKey = `${service} / ${wBucket} / ${dBucket}`;
  const incrementKey = `${service} / >1200kg / ${dBucket}`;

  const baseTariff = wBucket === ">1200kg"
    ? (INCREMENT_TARIFFS[incrementKey] ?? unknownKey(incrementKey))
    : (BASE_TARIFFS[baseKey] ?? unknownKey(baseKey));

  const incrementTariff = INCREMENT_TARIFFS[incrementKey] ?? unknownKey(incrementKey);

  // Extra km surcharge only for the >50 km tier; Excel takes F as the
  // distance and applies F × 1.70 × 2 × D. F is "km beyond the 50-km
  // base zone, one-way" — i.e. (total − 50).
  const extraKm = dBucket === ">50 km" ? Math.max(0, distanceKm - EXTRA_KM_THRESHOLD) : 0;
  const perKm = dBucket === ">50 km" ? PER_KM_SURCHARGE_VAT19 : 0;
  const extraKmCost = round2(extraKm * perKm * 2 * numDeliveries);

  // Each extra stop / extra 1000 kg = one increment fee. Excel: (D-1) * J.
  // For >1200kg orders, the increment fee also represents each additional
  // 1000 kg beyond the first 1200; treat numDeliveries as the stop count
  // and let the caller multiply by extra-1000kg count if needed.
  const incrementCost = round2((numDeliveries - 1) * incrementTariff);

  const weekend = isWeekend(deliveryDate);
  const weekendSurcharge = weekend ? WEEKEND_SURCHARGE_VAT19 : 0;

  const totalVat19 = round2(baseTariff + extraKmCost + incrementCost + weekendSurcharge);
  const net = round2(totalVat19 / (1 + VAT_LEGACY));
  const vat21 = round2(net * VAT_CURRENT);
  const totalVat21 = round2(net + vat21);

  // City-side company commission (what the END customer in that city pays)
  // and collaborator-side bonus (collaborator-facing price). Both are
  // applied on top of the carrier gross totalVat21 with the same formula;
  // we materialise all four cities and all five collaborators so the UI
  // can switch dropdowns client-side without another round-trip.
  const cityCommissions = Object.fromEntries(
    CITIES.map((city) => {
      const pct = COMPANY_COMMISSION_BY_CITY[city];
      const commission = round2(totalVat21 * pct);
      const customerTotal = round2(totalVat21 + commission);
      return [city, { pct, commission, customerTotal }];
    }),
  ) as Record<City, CityCommission>;

  const collaboratorPrices = Object.fromEntries(
    COLLABORATORS.map((c) => {
      const pct = COLLABORATOR_BONUS_BY_NAME[c];
      const bonus = round2(totalVat21 * pct);
      const total = round2(totalVat21 + bonus);
      return [c, { pct, bonus, total }];
    }),
  ) as Record<Collaborator, CollaboratorPrice>;

  return {
    weightBucket: wBucket,
    distanceBucket: dBucket,
    baseKey,
    incrementKey,
    extraKm,
    weekend,
    baseTariff: round2(baseTariff),
    extraKmCost,
    incrementTariff: round2(incrementTariff),
    incrementCost,
    weekendSurcharge,
    totalVat19,
    net,
    vat21,
    totalVat21,
    cityCommissions,
    collaboratorPrices,
  };
}

function unknownKey(key: string): never {
  throw new Error(`No tariff for key "${key}". Check service/weight/distance bucket combination.`);
}

/**
 * Round half-up to 2 decimal places (RON has 2 decimals). Floating-point
 * artifacts on multiplication can drift, e.g. 47.6/1.19 = 39.9999999996;
 * rounding once at the end of each Excel-column computation gives us
 * outputs that match the workbook penny-for-penny.
 */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

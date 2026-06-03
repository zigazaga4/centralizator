/**
 * Pricing engine — deterministic, pure, no I/O.
 *
 * Sourced from the operator pricing documents (DRAFT LISTA PRETURI
 * LEROY.docx + PRETURI COLABORATORI.ods); every rate in tariffs.ts is
 * already VAT-included at the current rate, so the engine sums them
 * straight into a carrier total — no legacy 19% → 21% conversion.
 *
 *   baseTariff       = BASE_TARIFFS[service × weightBucket × distanceBucket]
 *   extraKmCost      = (km - 50) × 1.90 × 2 × deliveries   [only for >50 km]
 *   incrementCost    = (deliveries - 1) × INCREMENT_TARIFFS[...]
 *   weekendSurcharge = 11.90 if Sat/Sun else 0
 *   carrierTotal     = baseTariff + extraKmCost + incrementCost + weekendSurcharge
 *
 * Then the per-city company commission and the per-collaborator bonus,
 * both applied to the same carrierTotal with the same shape:
 *
 *   cityCommissions[city].commission    = round2(carrierTotal × companyPct[city])
 *   cityCommissions[city].customerTotal = round2(carrierTotal + commission)
 *
 *   collaboratorPrices[c].bonus         = round2(carrierTotal × bonusPct[c])
 *   collaboratorPrices[c].total         = round2(carrierTotal + bonus)
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
  WEEKEND_SURCHARGE,
  PER_KM_SURCHARGE,
  EXTRA_KM_THRESHOLD,
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
  /** Base tariff from BASE_TARIFFS, VAT included. */
  baseTariff: number;
  /** Per-km surcharge total = extraKm × 1.90 × 2 × deliveries. */
  extraKmCost: number;
  /** Increment tariff from INCREMENT_TARIFFS (used for the row's
   *  incrementCost; surfaced separately so the UI can label it). */
  incrementTariff: number;
  /** Extra-stop / extra-1000kg cost = (deliveries - 1) × incrementTariff. */
  incrementCost: number;
  /** Weekend surcharge (0 or 11.90). */
  weekendSurcharge: number;
  /** Carrier-side total in RON, VAT included.
   *  This is the "base" both the city commission and the
   *  collaborator bonus are applied to. */
  carrierTotal: number;
  /** Per-city company commission (markup on top of carrierTotal). The
   *  matching `customerTotal` is what the END customer in that city pays. */
  cityCommissions: Record<City, CityCommission>;
  /** Per-collaborator bonus (markup on top of carrierTotal). The matching
   *  `total` is the collaborator-facing price. */
  collaboratorPrices: Record<Collaborator, CollaboratorPrice>;
}

export interface CityCommission {
  /** Commission rate, e.g. 0.501 for Ploiești. */
  pct: number;
  /** Commission amount in RON, = round2(carrierTotal × pct). */
  commission: number;
  /** Final customer total, = round2(carrierTotal + commission). */
  customerTotal: number;
}

export interface CollaboratorPrice {
  /** Bonus rate, e.g. 0.25 for Stalexone. */
  pct: number;
  /** Bonus amount in RON, = round2(carrierTotal × pct). */
  bonus: number;
  /** Final collaborator-facing price, = round2(carrierTotal + bonus). */
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
  // BASE row too (treated as 0 base + N×increment). The doc's base
  // table only carries the first four weight tiers; >1200kg shipments
  // collapse onto the increment row.
  const baseKey = `${service} / ${wBucket} / ${dBucket}`;
  const incrementKey = `${service} / >1200kg / ${dBucket}`;

  const baseTariff = wBucket === ">1200kg"
    ? (INCREMENT_TARIFFS[incrementKey] ?? unknownKey(incrementKey))
    : (BASE_TARIFFS[baseKey] ?? unknownKey(baseKey));

  const incrementTariff = INCREMENT_TARIFFS[incrementKey] ?? unknownKey(incrementKey);

  // Extra-km surcharge only for the >50 km tier; the (km - 50) overage
  // is charged at PER_KM_SURCHARGE × 2 (round trip) × numDeliveries.
  const extraKm = dBucket === ">50 km" ? Math.max(0, distanceKm - EXTRA_KM_THRESHOLD) : 0;
  const perKm = dBucket === ">50 km" ? PER_KM_SURCHARGE : 0;
  const extraKmCost = round2(extraKm * perKm * 2 * numDeliveries);

  // Each extra stop / extra 1000 kg = one increment fee: (D-1) × J.
  // For >1200kg orders, the increment fee also represents each
  // additional 1000 kg beyond the first 1200; treat numDeliveries as
  // the stop count and let the caller multiply by extra-1000kg count
  // if needed.
  const incrementCost = round2((numDeliveries - 1) * incrementTariff);

  const weekend = isWeekend(deliveryDate);
  const weekendSurcharge = weekend ? WEEKEND_SURCHARGE : 0;

  const carrierTotal = round2(baseTariff + extraKmCost + incrementCost + weekendSurcharge);

  // City-side company commission (what the END customer in that city pays)
  // and collaborator-side bonus (collaborator-facing price). Both are
  // applied on top of the carrier total with the same formula; we
  // materialise all four cities and all five collaborators so the UI
  // can switch dropdowns client-side without another round-trip.
  const cityCommissions = Object.fromEntries(
    CITIES.map((city) => {
      const pct = COMPANY_COMMISSION_BY_CITY[city];
      const commission = round2(carrierTotal * pct);
      const customerTotal = round2(carrierTotal + commission);
      return [city, { pct, commission, customerTotal }];
    }),
  ) as Record<City, CityCommission>;

  const collaboratorPrices = Object.fromEntries(
    COLLABORATORS.map((c) => {
      const pct = COLLABORATOR_BONUS_BY_NAME[c];
      const bonus = round2(carrierTotal * pct);
      const total = round2(carrierTotal + bonus);
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
    carrierTotal,
    cityCommissions,
    collaboratorPrices,
  };
}

function unknownKey(key: string): never {
  throw new Error(`No tariff for key "${key}". Check service/weight/distance bucket combination.`);
}

/**
 * Round half-up to 2 decimal places (RON has 2 decimals). Floating-point
 * artifacts on multiplication can drift; rounding once at the end of
 * each step keeps outputs matching the doc penny-for-penny.
 */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

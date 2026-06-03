/**
 * Pricing engine — deterministic, pure, no I/O.
 *
 * Sourced from the operator pricing documents (DRAFT LISTA PRETURI
 * LEROY.docx + PRETURI COLABORATORI.ods); every rate in tariffs.ts is
 * already VAT-included at the current rate, so the engine sums them
 * straight into a carrier total — no legacy 19% → 21% conversion.
 *
 *   weightIncrements = ceil((weight - 1200) / 1000) when weight > 1200, else 0
 *                      (= the number of extra 1000kg loads on top of the
 *                       standard 1200kg base — per the LEROY doc)
 *   rounds           = 1 + weightIncrements
 *                      (one truck round-trip per 1200kg slice)
 *   baseTariff       = BASE_TARIFFS[service × baseBucket × distanceBucket]
 *                      where baseBucket = 800-1200kg when weight > 1200,
 *                      else weightBucket itself.
 *   bulkyTransports  = extra truck runs forced by bulky-but-light goods
 *                      (polystyrene / mineral wool). One extra transport
 *                      per 24 bulky units; the first 24 ride in the base
 *                      transport only when the WHOLE shipment is bulky:
 *                        all-bulky  → ceil(units / 24) - 1
 *                        + others   → ceil(units / 24)
 *                      Each one is a real extra trip → +1 increment tariff
 *                      AND +1 round of the per-km surcharge.
 *   extraKmCost      = (km - 50) × 1.90 × 2 × (rounds × deliveries + bulkyTransports)  [>50 km]
 *   incrementCost    = (weightIncrements + (deliveries - 1) + bulkyTransports) × INCREMENT_TARIFFS[...]
 *   weekendSurcharge = 11.90 if Sat/Sun else 0
 *   commissionBase   = baseTariff + incrementCost + weekendSurcharge
 *   carrierTotal     = commissionBase + extraKmCost
 *
 * The per-km surcharge (extraKmCost) is a pass-through cost that is NOT
 * marked up by the commission/bonus percentage. The company commission
 * and collaborator bonus apply ONLY to commissionBase; the km cost is
 * then added flat on top at the very end. Per ops directive 2026-06-03:
 * "take the 1.90 addon out of the initial calculation, add it with a
 * simple plus at the end of the commission calculation".
 *
 *   cityCommissions[city].commission    = round2(commissionBase × companyPct[city])
 *   cityCommissions[city].customerTotal = round2(commissionBase + commission + extraKmCost)
 *
 *   collaboratorPrices[c].bonus         = round2(commissionBase × bonusPct[c])
 *   collaboratorPrices[c].total         = round2(commissionBase + bonus + extraKmCost)
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
  BULKY_UNITS_PER_TRANSPORT,
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
  /** Total count of bulky-but-light units (polystyrene / mineral wool)
   *  across every invoice on this AWB. Drives the extra-transport
   *  surcharge. Default 0 (no bulky goods). */
  bulkyUnits?: number;
  /** Whether the invoice(s) also carry non-bulky products. Changes the
   *  bulky formula: when the whole shipment is bulky the first 24 units
   *  ride in the base transport; when other products share the truck,
   *  every 24 bulky units needs its own transport. Default false. */
  hasOtherProducts?: boolean;
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
  /** Number of full or partial 1000-kg "increment" loads above the
   *  1200-kg standard base. 0 when weight ≤ 1200 kg. */
  weightIncrements: number;
  /** Number of truck round trips required = 1 + weightIncrements. The
   *  truck slot is 1200 kg, so each extra 1000 kg over 1200 forces
   *  another round (the per-km surcharge scales by this). */
  rounds: number;
  /** Bulky-but-light units (polystyrene / mineral wool) counted across
   *  all invoices on this AWB. 0 when none. */
  bulkyUnits: number;
  /** Extra truck transports forced by the bulky units (one per 24, less
   *  the first 24 when the whole shipment is bulky). Each adds one
   *  increment tariff and one round of the per-km surcharge. */
  bulkyTransports: number;
  /** Whether the weekend surcharge was applied. */
  weekend: boolean;
  /** Base tariff from BASE_TARIFFS (VAT included). For >1200kg orders
   *  this is the 800-1200kg standard row; the >1200kg overflow is
   *  billed via incrementCost. */
  baseTariff: number;
  /** Per-km surcharge total = extraKm × 1.90 × 2 × rounds × deliveries. */
  extraKmCost: number;
  /** Increment tariff from INCREMENT_TARIFFS (used for the row's
   *  incrementCost; surfaced separately so the UI can label it). */
  incrementTariff: number;
  /** Extra-1000kg + extra-stop cost
   *  = (weightIncrements + (deliveries - 1)) × incrementTariff. */
  incrementCost: number;
  /** Weekend surcharge (0 or 11.90). */
  weekendSurcharge: number;
  /** Commission base in RON, VAT included = baseTariff + incrementCost +
   *  weekendSurcharge. This is what the city commission and the
   *  collaborator bonus percentages are applied to. It deliberately
   *  EXCLUDES the per-km surcharge (extraKmCost), which is a pass-through
   *  added flat at the end, not marked up. */
  commissionBase: number;
  /** Carrier-side total in RON, VAT included = commissionBase + extraKmCost.
   *  What the carrier actually receives for the run (base work + km). */
  carrierTotal: number;
  /** Per-city company commission. The matching `customerTotal` is what the
   *  END customer in that city pays — commissionBase grossed up by pct,
   *  then the flat km cost added on top. */
  cityCommissions: Record<City, CityCommission>;
  /** Per-collaborator bonus. The matching `total` is the collaborator-facing
   *  price — commissionBase grossed up by pct, then the flat km cost on top. */
  collaboratorPrices: Record<Collaborator, CollaboratorPrice>;
}

export interface CityCommission {
  /** Commission rate, e.g. 0.501 for Ploiești. */
  pct: number;
  /** Commission amount in RON, = round2(commissionBase × pct). */
  commission: number;
  /** Final customer total, = round2(commissionBase + commission + extraKmCost). */
  customerTotal: number;
}

export interface CollaboratorPrice {
  /** Bonus rate, e.g. 0.25 for Stalexone. */
  pct: number;
  /** Bonus amount in RON, = round2(commissionBase × pct). */
  bonus: number;
  /** Final collaborator-facing price, = round2(commissionBase + bonus + extraKmCost). */
  total: number;
}

export function calculatePrice(input: PricingInput): PricingBreakdown {
  const { service, weightKg, distanceKm, numDeliveries, deliveryDate } = input;
  const bulkyUnits = Math.max(0, Math.floor(input.bulkyUnits ?? 0));
  const hasOtherProducts = input.hasOtherProducts ?? false;

  if (!Number.isInteger(numDeliveries) || numDeliveries < 1) {
    throw new RangeError(`numDeliveries must be a positive integer, got ${numDeliveries}`);
  }

  const wBucket = weightBucket(weightKg);
  const dBucket = distanceBucket(distanceKm);

  // Per the LEROY doc: "Pentru comenzi cu o greutate mai mare de 1200 kg
  // se vor adauga la tarifele standard costurile de mai jos la fiecare
  // 1000 kg ce depasesc cele 1200 kg din tariful de baza."
  //
  // So for >1200kg orders the base is the 800-1200kg standard row, and
  // each full or partial extra 1000 kg over 1200 adds one increment-row
  // tariff. weight ≤ 1200 → weightBucket as-is, weightIncrements = 0.
  const baseLookupBucket: WeightBucket = wBucket === ">1200kg" ? "800-1200kg" : wBucket;
  const baseKey = `${service} / ${baseLookupBucket} / ${dBucket}`;
  const incrementKey = `${service} / >1200kg / ${dBucket}`;

  const baseTariff = BASE_TARIFFS[baseKey] ?? unknownKey(baseKey);
  const incrementTariff = INCREMENT_TARIFFS[incrementKey] ?? unknownKey(incrementKey);

  // Physical truck capacity is one "1200kg slot". Each extra 1000 kg
  // above 1200 forces another round of the same route → the per-km
  // surcharge scales by `rounds`, not by 2 only. With weight 1500 kg
  // that's 1 increment → 2 rounds → km × 2 × 2 = ×4 (matches ops
  // hand-calc: "Km × 4 rounds because the kg are over the limit and
  // it got 2 rounds to complete the order").
  const weightIncrements = wBucket === ">1200kg"
    ? Math.ceil((weightKg - 1200) / 1000)
    : 0;
  const rounds = 1 + weightIncrements;

  // Bulky-but-light goods (polystyrene / mineral wool) fill the truck by
  // volume regardless of weight. One extra transport per 24 bulky units.
  // When the whole shipment is bulky the first 24 ride in the base
  // transport (ceil(n/24) - 1); when other products share the truck the
  // base is taken by those, so every 24 bulky units needs its own
  // transport (ceil(n/24)). Ops rule 2026-06-03.
  const bulkyGroups = bulkyUnits > 0 ? Math.ceil(bulkyUnits / BULKY_UNITS_PER_TRANSPORT) : 0;
  const bulkyTransports = bulkyUnits > 0
    ? (hasOtherProducts ? bulkyGroups : bulkyGroups - 1)
    : 0;

  // Extra-km surcharge only for the >50 km tier; the (km - 50) overage
  // is charged at PER_KM_SURCHARGE × 2 (round trip). The weight rounds and
  // the multi-delivery count compound (rounds × numDeliveries); each bulky
  // transport is its own dispatch on the same route, so it adds one flat
  // extra round on top.
  const extraKm = dBucket === ">50 km" ? Math.max(0, distanceKm - EXTRA_KM_THRESHOLD) : 0;
  const perKm = dBucket === ">50 km" ? PER_KM_SURCHARGE : 0;
  const extraKmCost = round2(extraKm * perKm * 2 * (rounds * numDeliveries + bulkyTransports));

  // Extra-1000kg-over-1200, extra stops (numDeliveries > 1), AND extra
  // bulky transports each pay one increment-row tariff. Same physical
  // fact: an extra truck run with its own base load.
  const totalIncrements = weightIncrements + (numDeliveries - 1) + bulkyTransports;
  const incrementCost = round2(totalIncrements * incrementTariff);

  const weekend = isWeekend(deliveryDate);
  const weekendSurcharge = weekend ? WEEKEND_SURCHARGE : 0;

  // The commission/bonus percentage applies ONLY to the base work
  // (base tariff + increments + weekend), NOT to the per-km surcharge.
  // The km cost is a pass-through that gets added flat at the very end.
  // Ops directive 2026-06-03: "take the 1.90 addon out of the initial
  // calculation, add it with a simple plus at the end of the commission".
  const commissionBase = round2(baseTariff + incrementCost + weekendSurcharge);
  // The carrier still receives the km money — it's just not commissionable.
  const carrierTotal = round2(commissionBase + extraKmCost);

  // City-side company commission (what the END customer in that city pays)
  // and collaborator-side bonus (collaborator-facing price). Both gross up
  // commissionBase by their percentage, then add the flat km cost on top.
  // We materialise all four cities and all five collaborators so the UI
  // can switch dropdowns client-side without another round-trip.
  const cityCommissions = Object.fromEntries(
    CITIES.map((city) => {
      const pct = COMPANY_COMMISSION_BY_CITY[city];
      const commission = round2(commissionBase * pct);
      const customerTotal = round2(commissionBase + commission + extraKmCost);
      return [city, { pct, commission, customerTotal }];
    }),
  ) as Record<City, CityCommission>;

  const collaboratorPrices = Object.fromEntries(
    COLLABORATORS.map((c) => {
      const pct = COLLABORATOR_BONUS_BY_NAME[c];
      const bonus = round2(commissionBase * pct);
      const total = round2(commissionBase + bonus + extraKmCost);
      return [c, { pct, bonus, total }];
    }),
  ) as Record<Collaborator, CollaboratorPrice>;

  return {
    weightBucket: wBucket,
    distanceBucket: dBucket,
    baseKey,
    incrementKey,
    extraKm,
    weightIncrements,
    rounds,
    bulkyUnits,
    bulkyTransports,
    weekend,
    baseTariff: round2(baseTariff),
    extraKmCost,
    incrementTariff: round2(incrementTariff),
    incrementCost,
    weekendSurcharge,
    commissionBase,
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

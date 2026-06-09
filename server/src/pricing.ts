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
 *   unloadingCount   = unloadingUnits + (weight > 1200kg ? weightIncrements : 0)
 *                      (the standard "descărcare" fee, +1 per extra transport
 *                       when the unloaded shipment is over 1200kg)
 *   unloadingTax     = unloadingCount × 210  (RON with VAT; 177.69 without)
 *   commissionBase   = baseTariff + incrementCost + weekendSurcharge
 *   carrierTotal     = commissionBase + extraKmCost
 *   grandTotal       = carrierTotal + unloadingTax + macara.total
 *                      (all-in, cu TVA — folds the descărcare + crane tracks
 *                       back in so it matches the courier portal's one-line
 *                       price; NOT used for the commission math)
 *
 * The per-km surcharge (extraKmCost) is a pass-through cost that is NOT
 * marked up by the commission/bonus percentage. The company commission
 * and collaborator bonus apply ONLY to commissionBase; the km cost is then
 * added flat on top at the very end. Per ops directive 2026-06-03.
 *
 * The unloading tax (unloadingTax) is COMPLETELY separate: it is neither
 * commissioned NOR folded into any total. The commission/carrier/customer/
 * collaborator math is identical to the pre-descărcare engine. Unloading is
 * reported only on its own fields (unloadingCount / unloadingTax /
 * unloadingTaxNet) and handled separately by the operator. Per ops directive
 * 2026-06-05: "descărcare is its own tax, it doesn't go into the commission
 * at all".
 *
 * Macara (crane delivery) is treated the SAME way: its own breakdown section
 * (`macara`), priced off the dedicated "Tarife livrare macara" table (cu TVA),
 * neither commissioned nor folded into any total. It is detected from the AWB
 * "Serviciu" (legitimate) and/or an invoice macara line; macara on the invoice
 * with no macara on the AWB raises `macara.warning`. Per ops directive
 * 2026-06-05.
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
  UNLOADING_TAX_GROSS,
  UNLOADING_TAX_NET,
  MACARA_TABLE_BY_CITY,
  MACARA_DEFAULT_TABLE,
  CITIES,
  COLLABORATORS,
  COMPANY_COMMISSION_BY_CITY,
  COLLABORATOR_BONUS_BY_NAME,
  type Service,
  type WeightBucket,
  type DistanceBucket,
  type MacaraDistanceBucket,
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
  /** Count of standard unloading fees ("descărcare", 177.69 net / 210 gross)
   *  billed on the shipment — detected from the invoice(s) (or the AWB's
   *  "Standard descărcare" service). 0 when no unloading. The >1200 kg
   *  multiplier (one extra unloading per extra transport) is applied here. */
  unloadingUnits?: number;
  /** Macara (crane delivery) named on the AWB "Serviciu" field — the
   *  legitimate signal that this is a macara run. Default false. */
  macaraOnAwb?: boolean;
  /** A macara line was found on an invoice (product/line named "macara").
   *  When this is true but `macaraOnAwb` is false, the engine raises a
   *  separate warning. Default false. */
  macaraOnInvoice?: boolean;
  /** Paleți delivered by crane, read off the invoice/AWB — drives the
   *  per-palet macara unloading fee. Falls back to 1 when macara is detected
   *  but no count was read. Default 0 (no macara). */
  macaraPallets?: number;
  /** Dispatch store the macara run leaves from — picks which macara rate
   *  table applies (Iași Tudor + Constanța vs. Ploiești + Iași ERA). Null /
   *  undefined falls back to the default (Table A). */
  macaraStore?: City | null;
}

/**
 * Macara (crane delivery) breakdown — a SEPARATE pricing track, mirroring how
 * the descărcare tax is kept apart. It is NOT commissioned and NOT folded into
 * the carrier / customer / collaborator totals; the operator bills it on its
 * own. Every figure is RON WITH VAT (cu TVA), straight from "Tarife livrare
 * macara".
 */
export interface MacaraBreakdown {
  /** True when this run is macara — named on the AWB OR found on an invoice. */
  isMacara: boolean;
  /** Macara named on the AWB "Serviciu" — the legitimate signal (no warning). */
  onAwb: boolean;
  /** Macara found on an invoice line. */
  onInvoice: boolean;
  /** SEPARATE warning: macara is on the invoice but the AWB does NOT declare
   *  it (e.g. the AWB "Serviciu" reads "standard"). The operator must
   *  reconcile the AWB. False whenever the AWB itself names macara. */
  warning: boolean;
  /** Paleți billed (1-8). 0 when not macara; 1 when macara is detected but no
   *  palet count was read. */
  pallets: number;
  /** Macara distance bucket used for the base price; null when not macara. */
  distanceBucket: MacaraDistanceBucket | null;
  /** km charged at the macara per-km rate (overage past 50 km). 0 otherwise. */
  extraKm: number;
  /** Flat macara delivery price for the bucket (RON cu TVA). */
  basePrice: number;
  /** Per-km tur-retur rate used (5 for Table A, 4,5 for Table B). RON cu TVA. */
  perKm: number;
  /** Macara per-km surcharge total = extraKm × perKm (RON cu TVA, tur-retur
   *  already included, so NOT doubled). */
  kmCost: number;
  /** Unloading fee per palet (26,7 Table A / 15 Table B). RON cu TVA. */
  unloadPerPallet: number;
  /** Total macara unloading = pallets × 26,7 (RON cu TVA). */
  unloadCost: number;
  /** Macara total (RON cu TVA) = basePrice + kmCost + unloadCost. COMPLETELY
   *  separate: not commissioned and NOT in any carrier/customer/collab total. */
  total: number;
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
  /** Standard unloading fees detected on the shipment (the base count,
   *  before the >1200 kg multiplier). 0 when no unloading applies. */
  unloadingUnits: number;
  /** Total unloading fees billed = unloadingUnits + (weight > 1200 kg ?
   *  weightIncrements : 0). One extra unloading per extra transport. */
  unloadingCount: number;
  /** Unloading tax in RON WITH VAT = unloadingCount × 210. COMPLETELY
   *  separate: not commissioned and NOT folded into any total (carrier,
   *  customer, or collaborator). Reported on its own for the operator. */
  unloadingTax: number;
  /** Unloading tax WITHOUT VAT = unloadingCount × 177.69 (for reference). */
  unloadingTaxNet: number;
  /** Macara (crane delivery) breakdown — a SEPARATE track (cu TVA), not
   *  commissioned and not folded into any total. `macara.isMacara` is false
   *  for an ordinary delivery. Priced for the pair's resolved store. */
  macara: MacaraBreakdown;
  /** The macara breakdown computed for EVERY city, so the UI can show the
   *  macara tariff per city (the rate table differs by dispatch site). Same
   *  detection + paleți across all four; only the price differs. */
  macaraByCity: Record<City, MacaraBreakdown>;
  /** Commission base in RON, VAT included = baseTariff + incrementCost +
   *  weekendSurcharge. This is what the city commission and the
   *  collaborator bonus percentages are applied to. It deliberately
   *  EXCLUDES the per-km surcharge (extraKmCost), which is a pass-through
   *  added flat at the end, not marked up. */
  commissionBase: number;
  /** Carrier-side total in RON, VAT included = commissionBase + extraKmCost.
   *  What the carrier actually receives for the run (base work + km). This
   *  stays PURE (no descărcare, no macara) so the commission math is
   *  unchanged. */
  carrierTotal: number;
  /** All-in comparable total in RON, VAT included
   *  = carrierTotal + unloadingTax + macara.total.
   *  This folds the two SEPARATE tracks (descărcare unloading + crane) back
   *  in, so it lines up with what the courier portal bills on one line. It is
   *  the number the Excel cross-check compares against ("Pret cu TVA"). The
   *  commission/collaborator totals are NOT derived from this — they still
   *  use commissionBase. */
  grandTotal: number;
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
  const unloadingUnits = Math.max(0, Math.floor(input.unloadingUnits ?? 0));

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

  // Unloading fee ("descărcare") — a SEPARATE flat tax, not commissioned.
  // Base count is what the invoice/AWB billed; when the unloaded shipment is
  // over 1200 kg it rides on more than one transport, and the operator adds
  // one more unloading per extra transport (= weightIncrements). Zero when no
  // unloading applies.
  const unloadingExtra = unloadingUnits > 0 && weightKg > 1200 ? weightIncrements : 0;
  const unloadingCount = unloadingUnits > 0 ? unloadingUnits + unloadingExtra : 0;
  const unloadingTax = round2(unloadingCount * UNLOADING_TAX_GROSS);
  const unloadingTaxNet = round2(unloadingCount * UNLOADING_TAX_NET);

  // Macara (crane delivery) — another SEPARATE track on its own tariff,
  // neither commissioned nor folded into any total. Detected upstream from
  // the AWB "Serviciu" and/or an invoice macara line.
  const macaraOnAwb = input.macaraOnAwb ?? false;
  const macaraOnInvoice = input.macaraOnInvoice ?? false;
  const macaraPallets = Math.max(0, Math.floor(input.macaraPallets ?? 0));
  // Primary macara breakdown — uses the pair's resolved dispatch store (or the
  // default table when unknown). This is the one the table/footer fall back to.
  const macara = computeMacara({
    onAwb: macaraOnAwb,
    onInvoice: macaraOnInvoice,
    pallets: macaraPallets,
    distanceKm,
    store: input.macaraStore ?? null,
  });
  // Macara priced for EVERY city, so the UI can show the macara tariff per
  // city (Ploiești + Iași ERA on Table B, Iași Tudor + Constanța on Table A),
  // exactly like the standard per-city customer totals. Same detection /
  // paleți across cities; only the rate table (price) differs.
  const macaraByCity = Object.fromEntries(
    CITIES.map((city) => [
      city,
      computeMacara({
        onAwb: macaraOnAwb,
        onInvoice: macaraOnInvoice,
        pallets: macaraPallets,
        distanceKm,
        store: city,
      }),
    ]),
  ) as Record<City, MacaraBreakdown>;

  // The commission/bonus percentage applies ONLY to the base work
  // (base tariff + increments + weekend), NOT to the per-km surcharge.
  // The km cost is a pass-through that gets added flat at the very end.
  // Ops directive 2026-06-03: "take the 1.90 addon out of the initial
  // calculation, add it with a simple plus at the end of the commission".
  const commissionBase = round2(baseTariff + incrementCost + weekendSurcharge);
  // The carrier still receives the km money — it's just not commissionable.
  // The unloading tax is kept ENTIRELY separate (its own breakdown fields)
  // and is deliberately NOT added into carrierTotal or any other total.
  const carrierTotal = round2(commissionBase + extraKmCost);
  // All-in total for the courier-portal cross-check: fold the two separate
  // tracks (descărcare unloading + macara crane, both already cu TVA) back
  // onto the carrier total. This is what lines up with the portal's single
  // "Pret" line; it does NOT feed the commission/collaborator math.
  const grandTotal = round2(carrierTotal + unloadingTax + macara.total);

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
    unloadingUnits,
    unloadingCount,
    unloadingTax,
    unloadingTaxNet,
    macara,
    macaraByCity,
    commissionBase,
    carrierTotal,
    grandTotal,
    cityCommissions,
    collaboratorPrices,
  };
}

/**
 * Pure macara computation. Mirrors the operator's rule:
 *   • macara on the AWB "Serviciu"     → it IS macara, no warning.
 *   • macara only on an invoice line   → it IS macara, but a SEPARATE
 *                                         warning fires (the AWB mislabels it).
 *   • macara nowhere                   → not macara (all fields zeroed).
 * Every figure is RON cu TVA. The result is kept entirely separate from the
 * commission/carrier/customer/collaborator math.
 */
function computeMacara(args: {
  onAwb: boolean;
  onInvoice: boolean;
  pallets: number;
  distanceKm: number;
  store: City | null;
}): MacaraBreakdown {
  const { onAwb, onInvoice, distanceKm, store } = args;
  const isMacara = onAwb || onInvoice;
  // Pick the rate table for the dispatch site (Table A: Iași Tudor +
  // Constanța; Table B: Ploiești + Iași ERA). Default A when undetermined.
  const table = store ? MACARA_TABLE_BY_CITY[store] : MACARA_DEFAULT_TABLE;
  if (!isMacara) {
    return {
      isMacara: false,
      onAwb: false,
      onInvoice: false,
      warning: false,
      pallets: 0,
      distanceBucket: null,
      extraKm: 0,
      basePrice: 0,
      perKm: table.perKmGross,
      kmCost: 0,
      unloadPerPallet: table.unloadPerPalletGross,
      unloadCost: 0,
      total: 0,
    };
  }
  // The big/separate warning: macara reached us only via an invoice line —
  // the AWB "Serviciu" did NOT declare macara (e.g. it reads "standard").
  const warning = onInvoice && !onAwb;
  // Macara is detected; bill at least one palet even if the count was unread.
  const pallets = args.pallets > 0 ? args.pallets : 1;
  // First bracket whose upper bound the distance falls under; the last row
  // (maxKm = Infinity) is the ">50 km" sentinel.
  const bracket =
    table.brackets.find((b) => distanceKm < b.maxKm) ??
    table.brackets[table.brackets.length - 1]!;
  const basePrice = bracket.price;
  const extraKm = distanceKm > table.thresholdKm ? distanceKm - table.thresholdKm : 0;
  // The per-km figure already counts the round trip ("tur-retur"), so no ×2.
  const kmCost = round2(extraKm * table.perKmGross);
  const unloadCost = round2(pallets * table.unloadPerPalletGross);
  const total = round2(basePrice + kmCost + unloadCost);
  return {
    isMacara: true,
    onAwb,
    onInvoice,
    warning,
    pallets,
    distanceBucket: bracket.label,
    extraKm,
    basePrice: round2(basePrice),
    perKm: table.perKmGross,
    kmCost,
    unloadPerPallet: table.unloadPerPalletGross,
    unloadCost,
    total,
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

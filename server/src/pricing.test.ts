import { describe, it, expect } from "vitest";
import { calculatePrice } from "./pricing.js";
import { weightBucket, distanceBucket, isWeekend } from "./buckets.js";

describe("weightBucket", () => {
  it("maps weights to the right bucket", () => {
    expect(weightBucket(0)).toBe("0-200kg");
    expect(weightBucket(64)).toBe("0-200kg");
    expect(weightBucket(199.99)).toBe("0-200kg");
    expect(weightBucket(200)).toBe("200-500kg");
    expect(weightBucket(499)).toBe("200-500kg");
    expect(weightBucket(500)).toBe("500-800kg");
    expect(weightBucket(800)).toBe("800-1200kg");
    expect(weightBucket(1200)).toBe(">1200kg");
    expect(weightBucket(5000)).toBe(">1200kg");
  });
  it("rejects negative weight", () => {
    expect(() => weightBucket(-1)).toThrow();
  });
});

describe("distanceBucket", () => {
  it("maps km to the right bucket", () => {
    expect(distanceBucket(0)).toBe("0-15 km");
    expect(distanceBucket(3)).toBe("0-15 km");
    expect(distanceBucket(15)).toBe("15-20 km");
    expect(distanceBucket(20)).toBe("20-30 km");
    expect(distanceBucket(30)).toBe("30-50 km");
    expect(distanceBucket(50)).toBe(">50 km");
    expect(distanceBucket(101)).toBe(">50 km");
  });
});

describe("isWeekend", () => {
  it("flags Saturday and Sunday only", () => {
    // 2026-05-25 is Monday
    expect(isWeekend("2026-05-25")).toBe(false);
    // 2026-05-23 Saturday, 2026-05-24 Sunday
    expect(isWeekend("2026-05-23")).toBe(true);
    expect(isWeekend("2026-05-24")).toBe(true);
    // 2026-05-22 Friday
    expect(isWeekend("2026-05-22")).toBe(false);
  });
});

describe("calculatePrice — LEROY doc rates (VAT included)", () => {
  // Express / 500-800kg / 0-15 km, single delivery.
  //   base = 48.40, no surcharges → carrier 48.40
  it("Express 500-800kg 0-15km, single delivery", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-18", // Monday
    });
    expect(r.baseTariff).toBe(48.40);
    expect(r.extraKmCost).toBe(0);
    expect(r.incrementCost).toBe(0);
    expect(r.weekendSurcharge).toBe(0);
    expect(r.carrierTotal).toBe(48.40);
  });

  // Delivery count no longer bills (ops 2026-06-25): increments are WEIGHT-based
  // only, so 2 deliveries at 600 kg (≤1200 kg, no weight increment) add nothing.
  it("delivery count does not add an increment (weight-based only)", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 5,
      numDeliveries: 2,
      deliveryDate: "2026-05-19",
    });
    expect(r.baseTariff).toBe(48.40);
    expect(r.incrementCost).toBe(0);
    expect(r.carrierTotal).toBe(48.40);
  });

  // >50 km tier: base 133.10 (LEROY 500-800kg / 30-50 km used for >50)
  // + (101 − 50) × 1.90 × 2 × 1 = 193.80 → carrier 326.90.
  // PER_KM stays at 1.90 per ops directive (doc says 1.70, override stands).
  it(">50 km tier adds per-km surcharge at 1.90 RON/km", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101, // 50 base + 51 extra one-way
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.baseTariff).toBe(133.10);
    expect(r.extraKm).toBe(51);
    expect(r.extraKmCost).toBe(193.80);
    expect(r.carrierTotal).toBe(326.90);
  });

  // AWB 007209914: Express, 64 kg, 3 km, weekday, 1 delivery.
  // LEROY 0-200kg / 0-15 km = 24.20 → carrier 24.20.
  it("the test AWB 007209914 prices to 24.20 RON", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 64.0,
      distanceKm: 3,
      numDeliveries: 1,
      deliveryDate: "2026-05-25",
    });
    expect(r.weightBucket).toBe("0-200kg");
    expect(r.distanceBucket).toBe("0-15 km");
    expect(r.baseTariff).toBe(24.20);
    expect(r.carrierTotal).toBe(24.20);
  });

  it("a weekend DATE does NOT auto-trigger the surcharge — weekend is manual now", () => {
    // The AWB's printed date is its GENERATION date, not the delivery date,
    // so a Saturday on the paper must NOT add the surcharge by itself. Only
    // the operator's manual `forceWeekend` flag does (see the next test).
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-23", // Saturday — but the calendar no longer matters
    });
    expect(r.weekend).toBe(false);
    expect(r.weekendForced).toBe(false);
    expect(r.weekendSurcharge).toBe(0);
    // base 24.20, no weekend surcharge
    expect(r.carrierTotal).toBe(24.20);
  });

  it("forceWeekend applies the 11.90 surcharge on a weekday (manual override)", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-18", // Monday — no weekend by the calendar
      forceWeekend: true,
    });
    expect(r.weekend).toBe(true);
    expect(r.weekendForced).toBe(true);
    expect(r.weekendSurcharge).toBe(11.90);
    // base 24.20 + forced weekend 11.90 = 36.10
    expect(r.carrierTotal).toBe(36.10);
  });

  it("forceWeekend=false leaves a weekday unchanged", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-18", // Monday
      forceWeekend: false,
    });
    expect(r.weekend).toBe(false);
    expect(r.weekendForced).toBe(false);
    expect(r.weekendSurcharge).toBe(0);
    expect(r.carrierTotal).toBe(24.20);
  });

  // Per-city company commissions are applied to commissionBase ONLY
  // (base + increment + weekend), NOT to the per-km surcharge. The km
  // cost is added flat at the end. The commission is STAGED (ops directive
  // 2026-06-11): Iași/Constanța +2,7% → +3,6% → +16% → +11,4% (compound
  // ≈ 37.4907%), Ploiești +22,7% → +16% → +11,4% (compound ≈ 58.5578%).
  // Reuses the >50 km case:
  //   commissionBase = 133.10  ·  extraKmCost = 193.80  ·  carrier 326.90
  //   Ploiești  → commission 77.94 → customer 133.10 + 77.94 + 193.80 = 404.84
  //   IasiTudor → own rule 1.187×1.114 → commission 42.90 → customer 369.80
  //   IasiERA / Constanța share 1.027×1.036×1.16×1.114 → 376.80
  it("city commissions: staged compound percentage on base only, km added flat at the end", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.commissionBase).toBe(133.10);
    expect(r.extraKmCost).toBe(193.80);
    expect(r.carrierTotal).toBe(326.90);

    expect(r.cityCommissions.Ploiesti.pct).toBeCloseTo(1.227 * 1.16 * 1.114 - 1, 10);
    expect(r.cityCommissions.Ploiesti.commission).toBe(77.94);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(404.84);

    // Iași Tudor has its OWN rule: +18.7% then +11.4% (≈ 32.2318%).
    expect(r.cityCommissions.IasiTudor.pct).toBeCloseTo(1.187 * 1.114 - 1, 10);
    expect(r.cityCommissions.IasiTudor.commission).toBe(42.90);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(369.80);

    // Iași ERA + Constanța keep the four-stage rate (≈ 37.4907%).
    expect(r.cityCommissions.IasiERA.pct).toBeCloseTo(1.027 * 1.036 * 1.16 * 1.114 - 1, 10);
    expect(r.cityCommissions.IasiERA.customerTotal).toBe(376.80);
    expect(r.cityCommissions.Constanta.customerTotal).toBe(376.80);
  });

  // Per-collaborator bonuses use the same rule on commissionBase (133.10),
  // then the flat km cost (193.80) is added on top:
  //   Stalexone        25%   → bonus 33.28 → total 360.18
  //   EMV              30.1% → bonus 40.06 → total 366.96
  //   Bitlo            12%   → bonus 15.97 → total 342.87
  //   VicDinamicExpert 25%   → bonus 33.28 → total 360.18
  //   Tiberiu          29%   → bonus 38.60 → total 365.50
  it("collaborator bonuses: percentage on base only, km added flat at the end", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.commissionBase).toBe(133.10);
    expect(r.extraKmCost).toBe(193.80);

    expect(r.collaboratorPrices.Stalexone.pct).toBe(0.25);
    expect(r.collaboratorPrices.Stalexone.bonus).toBe(33.28);
    expect(r.collaboratorPrices.Stalexone.total).toBe(360.18);

    expect(r.collaboratorPrices.EMV.pct).toBe(0.301);
    expect(r.collaboratorPrices.EMV.bonus).toBe(40.06);
    expect(r.collaboratorPrices.EMV.total).toBe(366.96);

    expect(r.collaboratorPrices.Bitlo.bonus).toBe(15.97);
    expect(r.collaboratorPrices.Bitlo.total).toBe(342.87);

    expect(r.collaboratorPrices.VicDinamicExpert.total).toBe(360.18);
    expect(r.collaboratorPrices.Tiberiu.total).toBe(365.50);
  });

  // Tiny-AWB sanity (the 24.20 RON test row) with the worked example
  // the user gave in plain language: base × (1 + pct).
  //   carrier 24.20
  //   Ploiești  staged ≈ 58.5578% → 14.17 → customer 38.37
  //   Stalexone 25%              →  6.05 → total    30.25
  it("AWB 007209914: small invoice still threads through every dimension", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 64.0,
      distanceKm: 3,
      numDeliveries: 1,
      deliveryDate: "2026-05-25",
    });
    expect(r.carrierTotal).toBe(24.20);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(38.37);
    expect(r.collaboratorPrices.Stalexone.total).toBe(30.25);
  });

  // >1200kg path. LEROY doc: "Pentru comenzi cu o greutate mai mare de
  // 1200 kg se vor adauga la tarifele standard costurile de mai jos la
  // fiecare 1000 kg ce depasesc cele 1200 kg din tariful de baza."
  //
  // Worked by an ops dispatcher manually for AWB 038112124:
  //   • weight 1500 kg → 1 extra 1000 kg over 1200 → 2 truck rounds.
  //   • distance 81 km → 31 km past the 50 km threshold.
  //   • Express tier, 1 delivery, weekday (Mon 2026-06-01).
  //
  //   base    = BASE_TARIFFS[Express / 800-1200kg / >50 km]   = 130.66
  //   incr    = INCREMENT_TARIFFS[Express / >1200kg / >50 km] = 124.66
  //   extraKm = 31 km × 1.90 × 2 (round) × 2 (rounds) × 1 (deliv) = 235.60
  //   commissionBase = 130.66 + 124.66 = 255.32   (km NOT included)
  //   carrier        = 255.32 + 235.60 = 490.92
  //   Iași staged ≈ 37.4907% → commission 95.72 → customer 255.32 + 95.72 + 235.60 = 586.64
  //   (the per-km 235.60 is added flat AFTER the commission, not marked up)
  it("AWB 038112124: 1500kg / 81km / 1 delivery → carrier 490.92, Iași 586.64", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 1500,
      distanceKm: 81,
      numDeliveries: 1,
      deliveryDate: "2026-06-01", // Monday
    });
    expect(r.weightBucket).toBe(">1200kg");
    expect(r.distanceBucket).toBe(">50 km");
    expect(r.weightIncrements).toBe(1);
    expect(r.rounds).toBe(2);
    expect(r.baseTariff).toBe(130.66);
    expect(r.incrementTariff).toBe(124.66);
    expect(r.incrementCost).toBe(124.66);
    expect(r.extraKm).toBe(31);
    expect(r.extraKmCost).toBe(235.60);
    expect(r.weekendSurcharge).toBe(0);
    expect(r.commissionBase).toBe(255.32);
    expect(r.carrierTotal).toBe(490.92);

    // Iași Tudor own rule (≈ 32.2318%): commission 82.29 → customer
    // 255.32 + 82.29 + 235.60 = 573.21.
    expect(r.cityCommissions.IasiTudor.commission).toBe(82.29);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(573.21);
    // Iași ERA + Constanța keep the four-stage rate → 586.64.
    expect(r.cityCommissions.IasiERA.customerTotal).toBe(586.64);
    expect(r.cityCommissions.Constanta.customerTotal).toBe(586.64);
    // Ploiești staged ≈ 58.5578% → commission 149.51 → customer 255.32 + 149.51 + 235.60 = 640.43
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(640.43);
  });

  // Edge: exactly 1200 kg is still the 800-1200kg bucket, NOT the
  // >1200kg path. No extra round, no weight increment.
  it("exactly 1200 kg stays in the >1200kg bucket boundary check", () => {
    // weightBucket() puts 1200 in ">1200kg"; verify the engine treats
    // the 1200 boundary as "no extra increments yet" via ceil((1200-1200)/1000)=0.
    const r = calculatePrice({
      service: "Express",
      weightKg: 1200,
      distanceKm: 40,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
    });
    expect(r.weightBucket).toBe(">1200kg");
    expect(r.weightIncrements).toBe(0);
    expect(r.rounds).toBe(1);
    // base = 800-1200kg / 30-50 km = 130.66, no extras
    expect(r.baseTariff).toBe(130.66);
    expect(r.incrementCost).toBe(0);
    expect(r.carrierTotal).toBe(130.66);
  });

  // 2500 kg → ceil((2500-1200)/1000) = 2 increments → 3 rounds.
  // base 130.66 + 2 × 124.66 = 380.0 (no >50km here, so no extraKm).
  it("2500 kg = 2 increments, 3 rounds, no extra km", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 2500,
      distanceKm: 40,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
    });
    expect(r.weightIncrements).toBe(2);
    expect(r.rounds).toBe(3);
    expect(r.baseTariff).toBe(130.66);
    expect(r.incrementCost).toBe(249.32);
    expect(r.carrierTotal).toBe(379.98);
  });

  // The delivery count is ignored (ops 2026-06-25): 1500 kg / 81 km prices the
  // SAME whether the AWB shows 1 or 2 deliveries — only weight + km bill.
  //   weight 1500 → 1 weight-increment, rounds 2
  //   base 130.66 + 1 × 124.66 = 255.32
  //   extraKmCost = 31 × 1.90 × 2 × 2 (rounds) = 235.60
  //   carrier = 490.92  (identical to the 1-delivery 1500 kg / 81 km case above)
  it("1500 kg + 2 deliveries prices the same as 1 delivery (count ignored)", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 1500,
      distanceKm: 81,
      numDeliveries: 2,
      deliveryDate: "2026-06-01",
    });
    expect(r.weightIncrements).toBe(1);
    expect(r.rounds).toBe(2);
    expect(r.incrementCost).toBe(124.66); // 1 × 124.66, weight only
    expect(r.extraKmCost).toBe(235.60);
    expect(r.carrierTotal).toBe(490.92);
  });
});

// Bulky-but-light goods (polystyrene / mineral wool). Ops rule 2026-06-11:
// the ONLY qualifying criteria is the piece count — 24 bulky pieces per
// transport. Below 24 pieces nothing is charged; from 24 up, one extra
// transport per started block of 24 (24 → 1, 25 → 2), regardless of what
// else shares the truck. Each extra transport is a real trip → +1
// increment tariff AND +1 round of the per-km surcharge.
describe("calculatePrice — bulky goods (polystyrene / vata) extra transports", () => {
  // Under the 24-piece threshold → no surcharge at all, even on a mixed
  // shipment (the Mincu Anisoara case: 3 XPS boards next to parchet).
  it("3 bulky units on a mixed shipment → 0 extra transports", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-06-01", // Monday
      bulkyUnits: 3,
      hasOtherProducts: true,
    });
    expect(r.bulkyUnits).toBe(3);
    expect(r.bulkyTransports).toBe(0);
    expect(r.incrementCost).toBe(0);
    expect(r.carrierTotal).toBe(24.20);
  });

  // 23 pieces — one short of the threshold → still nothing.
  it("23 bulky units → 0 extra transports", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
      bulkyUnits: 23,
      hasOtherProducts: false,
    });
    expect(r.bulkyTransports).toBe(0);
    expect(r.carrierTotal).toBe(24.20);
  });

  // Exactly 24 pieces → 1 extra transport, mixed or not.
  // increment "Express / >1200kg / 0-15 km" = 54.50.
  //   base 24.20 + 54.50 = 78.70.
  it("24 bulky units → 1 extra transport at the increment tariff", () => {
    for (const hasOtherProducts of [false, true]) {
      const r = calculatePrice({
        service: "Express",
        weightKg: 100,
        distanceKm: 5,
        numDeliveries: 1,
        deliveryDate: "2026-06-01",
        bulkyUnits: 24,
        hasOtherProducts,
      });
      expect(r.bulkyTransports).toBe(1);
      expect(r.incrementTariff).toBe(54.50);
      expect(r.incrementCost).toBe(54.50);
      expect(r.carrierTotal).toBe(78.70);
    }
  });

  // 25 pieces → the transport calculation applies twice: 2 extra
  // transports.  base 24.20 + 2 × 54.50 = 133.20.
  it("25 bulky units → 2 extra transports", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
      bulkyUnits: 25,
      hasOtherProducts: false,
    });
    expect(r.bulkyTransports).toBe(2);
    expect(r.incrementCost).toBe(109.00); // 2 × 54.50
    expect(r.carrierTotal).toBe(133.20);
  });

  // 49 pieces → ceil(49/24) = 3 extra transports.
  //   base 24.20 + 3 × 54.50 = 187.70.
  it("49 bulky units → 3 extra transports", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
      bulkyUnits: 49,
      hasOtherProducts: true,
    });
    expect(r.bulkyTransports).toBe(3);
    expect(r.incrementCost).toBe(163.50); // 3 × 54.50
    expect(r.carrierTotal).toBe(187.70);
  });

  // Bulky transport ALSO multiplies the per-km surcharge on the >50 km
  // tier. 25 units (2 extra transports), 81 km, weekday.
  //   base    = BASE_TARIFFS[Express / 0-200kg / >50 km]   = 48.40
  //   incr    = INCREMENT_TARIFFS[Express / >1200kg / >50 km] = 124.66
  //   extraKm = 31 × 1.90 × 2 × (1 round×1 deliv + 2 bulky) = 31×1.90×2×3 = 353.40
  //   commissionBase = 48.40 + 2 × 124.66 = 297.72   (km NOT included)
  //   carrier        = 297.72 + 353.40 = 651.12
  it("bulky transports add rounds of per-km surcharge on >50 km", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 81,
      numDeliveries: 1,
      deliveryDate: "2026-06-01",
      bulkyUnits: 25,
      hasOtherProducts: false,
    });
    expect(r.bulkyTransports).toBe(2);
    expect(r.baseTariff).toBe(48.40);
    expect(r.extraKm).toBe(31);
    expect(r.incrementCost).toBe(249.32);
    expect(r.extraKmCost).toBe(353.40);
    expect(r.commissionBase).toBe(297.72);
    expect(r.carrierTotal).toBe(651.12);
  });

  // No bulky goods → engine behaves exactly as before (regression guard).
  it("no bulky goods leaves the price untouched", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.bulkyUnits).toBe(0);
    expect(r.bulkyTransports).toBe(0);
    expect(r.carrierTotal).toBe(326.90);
  });
});

describe("calculatePrice — unloading tax (descărcare)", () => {
  // One unloading, light shipment: reported as its own 210 gross / 177.69 net
  // fee. It is COMPLETELY separate — neither commissioned nor folded into any
  // total. Every total stays byte-for-byte identical to the no-unloading run.
  it("reports a single 210 RON unloading fee separately, not in any total", () => {
    const base = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      unloadingUnits: 1,
    });
    expect(r.unloadingUnits).toBe(1);
    expect(r.unloadingCount).toBe(1);
    expect(r.unloadingTax).toBe(210);
    expect(r.unloadingTaxNet).toBe(177.69);
    // commissionBase (the commissioned part) is unchanged by the tax.
    expect(r.commissionBase).toBe(base.commissionBase);
    // The unloading fee does NOT touch any total — carrier, every city, and
    // every collaborator price are identical to the run with no descărcare.
    expect(r.carrierTotal).toBe(base.carrierTotal);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(
      base.cityCommissions.Ploiesti.customerTotal,
    );
    expect(r.collaboratorPrices.Bitlo.total).toBe(
      base.collaboratorPrices.Bitlo.total,
    );
  });

  // >1200 kg: one extra unloading per extra transport (weightIncrements).
  // 2500 kg → ceil((2500-1200)/1000) = 2 increments → 1 base + 2 = 3 fees.
  it("adds one extra unloading per extra transport when over 1200 kg", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 2500, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      unloadingUnits: 1,
    });
    expect(r.weightIncrements).toBe(2);
    expect(r.unloadingUnits).toBe(1);
    expect(r.unloadingCount).toBe(3);
    expect(r.unloadingTax).toBe(630);
    expect(r.unloadingTaxNet).toBe(round2(3 * 177.69));
  });

  // No unloading detected → zero tax, totals identical to the plain run.
  it("no unloading leaves the price untouched", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    expect(r.unloadingUnits).toBe(0);
    expect(r.unloadingCount).toBe(0);
    expect(r.unloadingTax).toBe(0);
    expect(r.carrierTotal).toBe(48.40);
  });

  // The >1200 kg multiplier must NOT fire when no unloading applies.
  it("does not add unloading for a heavy shipment with no descărcare", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 2500, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    expect(r.unloadingCount).toBe(0);
    expect(r.unloadingTax).toBe(0);
  });

  // Iași Tudor (Iași 1) bonuses the descărcare by +11,4% (ops directive
  // 2026-06-11): 210 → 233.94 cu TVA, 177.69 → 197.95 net. Keyed off the
  // resolved dispatch store. Other cities keep the flat 210.
  it("Iași Tudor bonuses the descărcare fee by 11.4% (210 → 233.94)", () => {
    const tudor = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      unloadingUnits: 1, macaraStore: "IasiTudor",
    });
    expect(tudor.unloadingTax).toBe(233.94);
    expect(tudor.unloadingTaxNet).toBe(197.95);

    // Constanța (and the rest) stay on the flat 210.
    const constanta = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      unloadingUnits: 1, macaraStore: "Constanta",
    });
    expect(constanta.unloadingTax).toBe(210);
  });
});

describe("calculatePrice — macara (crane delivery), a separate track", () => {
  // Macara named on the AWB Serviciu → legitimate macara, no warning.
  // distance 5 km → "0-10 km" base 638.3 + 1 palet × 26.7 = 665.0 (cu TVA).
  // It must NOT touch the carrier/customer/collaborator totals.
  it("macara on the AWB prices on its own table with no warning", () => {
    const base = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 1,
    });
    expect(r.macara.isMacara).toBe(true);
    expect(r.macara.onAwb).toBe(true);
    expect(r.macara.warning).toBe(false);
    expect(r.macara.distanceBucket).toBe("0-10 km");
    expect(r.macara.basePrice).toBe(638.3);
    expect(r.macara.pallets).toBe(1);
    expect(r.macara.unloadCost).toBe(26.7);
    expect(r.macara.total).toBe(665.0);
    // Separate: the standard totals are byte-for-byte the no-macara run.
    expect(r.carrierTotal).toBe(base.carrierTotal);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(base.cityCommissions.Ploiesti.customerTotal);
    expect(r.collaboratorPrices.Bitlo.total).toBe(base.collaboratorPrices.Bitlo.total);
  });

  // Macara only on the invoice (AWB says something else) → WARNING.
  // distance 25 km → "20-30 km" base 735.2 + 3 paleți × 26.7 = 80.1 → 815.3.
  it("macara on the invoice but not the AWB raises the separate warning", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 25,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: false, macaraOnInvoice: true, macaraPallets: 3,
    });
    expect(r.macara.isMacara).toBe(true);
    expect(r.macara.onInvoice).toBe(true);
    expect(r.macara.onAwb).toBe(false);
    expect(r.macara.warning).toBe(true);
    expect(r.macara.distanceBucket).toBe("20-30 km");
    expect(r.macara.basePrice).toBe(735.2);
    expect(r.macara.pallets).toBe(3);
    expect(r.macara.unloadCost).toBe(80.1);
    expect(r.macara.total).toBe(815.3);
  });

  // >50 km macara: base 940.2 + (81−50) × 5 = 155 + 1 palet 26.7 = 1121.9.
  it(">50 km macara adds 5 lei/km tur-retur on the overage", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 81,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true,
    });
    expect(r.macara.distanceBucket).toBe(">50 km");
    expect(r.macara.basePrice).toBe(940.2);
    expect(r.macara.extraKm).toBe(31);
    expect(r.macara.kmCost).toBe(155);
    expect(r.macara.pallets).toBe(1); // fell back to 1 (no count read)
    expect(r.macara.total).toBe(1121.9);
  });

  // Ploiești + Iași ERA use Table B (TARIFE MACARA PLOIESTI SI IASI 2.odt):
  // 471.8 base, 4.5 lei/km, 15/palet. Ploiești, distance 5 km →
  // "0-15 km" 471.8 + 1 × 15 = 486.8.
  it("Ploiești macara uses Table B (471.8 base, 15/palet)", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 1, macaraStore: "Ploiesti",
    });
    expect(r.macara.distanceBucket).toBe("0-15 km");
    expect(r.macara.basePrice).toBe(471.8);
    expect(r.macara.unloadPerPallet).toBe(15);
    expect(r.macara.perKm).toBe(4.5);
    expect(r.macara.total).toBe(486.8);
  });

  // Iași ERA (Iași 2) is also Table B; >50 km adds 4.5 lei/km.
  // 81 km → ">50 km" 695.5 + (81−50)×4.5 = 139.5 + 2 paleți × 15 = 30 → 865.0.
  it("Iași ERA macara, >50 km, Table B per-km 4.5", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 81,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 2, macaraStore: "IasiERA",
    });
    expect(r.macara.distanceBucket).toBe(">50 km");
    expect(r.macara.basePrice).toBe(695.5);
    expect(r.macara.extraKm).toBe(31);
    expect(r.macara.kmCost).toBe(139.5);
    expect(r.macara.unloadCost).toBe(30);
    expect(r.macara.total).toBe(865.0);
  });

  // Iași Tudor + Constanța stay on Table A (638.3, 26.7/palet).
  it("Constanța macara stays on Table A (638.3 base)", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 1, macaraStore: "Constanta",
    });
    expect(r.macara.distanceBucket).toBe("0-10 km");
    expect(r.macara.basePrice).toBe(638.3);
    expect(r.macara.unloadPerPallet).toBe(26.7);
    expect(r.macara.total).toBe(665.0);
  });

  // macaraByCity prices the same run on each city's table at once: Ploiești +
  // Iași ERA on Table B (494), Iași Tudor + Constanța on Table A (638.3).
  it("macaraByCity prices every city on its own table", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 1, macaraStore: "Ploiesti",
    });
    expect(r.macaraByCity.Ploiesti.basePrice).toBe(471.8);
    expect(r.macaraByCity.IasiERA.basePrice).toBe(471.8);
    expect(r.macaraByCity.IasiTudor.basePrice).toBe(638.3);
    expect(r.macaraByCity.Constanta.basePrice).toBe(638.3);
    // Ploiești: 471.8 + 15 = 486.8 · Constanța: 638.3 + 26.7 = 665.0
    expect(r.macaraByCity.Ploiesti.total).toBe(486.8);
    expect(r.macaraByCity.Constanta.total).toBe(665.0);
  });

  // No macara anywhere → all macara fields zeroed, price untouched.
  it("no macara leaves the price untouched", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    expect(r.macara.isMacara).toBe(false);
    expect(r.macara.warning).toBe(false);
    expect(r.macara.total).toBe(0);
    expect(r.carrierTotal).toBe(48.40);
  });

  // More than 8 paleți needs a second crane truck. Derived from the palet
  // count alone (no explicit run count): 10 paleți → ceil(10/8) = 2 runs.
  // Ploiești Table B 0-15 km: base 471.8 × 2 = 943.6 + 10 × 15 = 150 → 1093.6.
  it("9+ paleți bill the macara delivery once per truck (ceil/8)", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 10, macaraStore: "Ploiesti",
    });
    expect(r.macara.runs).toBe(2);
    expect(r.macara.basePrice).toBe(943.6);
    expect(r.macara.unloadCost).toBe(150);
    expect(r.macara.total).toBe(1093.6);
  });

  // Explicit run count wins when the invoice carries several "LIVRARE MACARA"
  // lines even though the paleți would fit one truck: 6 paleți but 2 delivery
  // lines → 2 runs. Constanța Table A: base 638.3 × 2 = 1276.6 + 6 × 26.7 =
  // 160.2 → 1436.8.
  it("explicit macaraRuns from multiple delivery lines scales the base", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 6, macaraRuns: 2, macaraStore: "Constanta",
    });
    expect(r.macara.runs).toBe(2);
    expect(r.macara.basePrice).toBe(1276.6);
    expect(r.macara.unloadCost).toBe(160.2);
    expect(r.macara.total).toBe(1436.8);
  });

  // Operator override: macara was on the AWB but the operator forces a normal
  // delivery (Leroy Merlin mis-tagged it). isMacara flips false, the macara
  // total zeroes, and the standard totals match the plain non-macara run —
  // while `detected` + the palet count are preserved so it can be toggled back.
  it("macaraForceNormal turns a detected macara into an ordinary delivery", () => {
    const base = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
    });
    const macara = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 3,
    });
    const forced = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 3, macaraForceNormal: true,
    });
    // Sanity: without the override it IS macara.
    expect(macara.macara.isMacara).toBe(true);
    // With the override it is billed as a normal delivery.
    expect(forced.macara.isMacara).toBe(false);
    expect(forced.macara.detected).toBe(true);
    expect(forced.macara.forcedNormal).toBe(true);
    expect(forced.macara.warning).toBe(false);
    expect(forced.macara.total).toBe(0);
    // The detected palet count is retained so the toggle can be reverted.
    expect(forced.macara.pallets).toBe(3);
    // Every per-city macara figure is zeroed too.
    expect(forced.macaraByCity.Ploiesti.isMacara).toBe(false);
    expect(forced.macaraByCity.Ploiesti.total).toBe(0);
    // The standard totals now match the plain non-macara run byte-for-byte.
    expect(forced.carrierTotal).toBe(base.carrierTotal);
    expect(forced.grandTotal).toBe(base.grandTotal);
    expect(forced.cityCommissions.Ploiesti.customerTotal).toBe(
      base.cityCommissions.Ploiesti.customerTotal,
    );
  });

  // The override is inert when there was no macara to begin with: a plain
  // delivery stays plain and `forcedNormal` is false (nothing was overridden).
  it("macaraForceNormal is a no-op when no macara was detected", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraForceNormal: true,
    });
    expect(r.macara.isMacara).toBe(false);
    expect(r.macara.detected).toBe(false);
    expect(r.macara.forcedNormal).toBe(false);
    expect(r.macara.total).toBe(0);
  });
});

/** Local 2-dp round mirroring the engine, for assertions. */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

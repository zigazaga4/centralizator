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

  // Two deliveries adds one increment: increment key
  // "Express / >1200kg / 0-15 km" = 54.50 (LEROY).
  //   base 48.40 + increment 54.50 = 102.90
  it("two deliveries adds one increment", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 5,
      numDeliveries: 2,
      deliveryDate: "2026-05-19",
    });
    expect(r.baseTariff).toBe(48.40);
    expect(r.incrementTariff).toBe(54.50);
    expect(r.incrementCost).toBe(54.50);
    expect(r.carrierTotal).toBe(102.90);
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

  it("weekend Saturday triggers the 11.90 surcharge", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 100,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-23", // Saturday
    });
    expect(r.weekend).toBe(true);
    expect(r.weekendSurcharge).toBe(11.90);
    // base 24.20 + weekend 11.90 = 36.10
    expect(r.carrierTotal).toBe(36.10);
  });

  // Per-city company commissions are applied to commissionBase ONLY
  // (base + increment + weekend), NOT to the per-km surcharge. The km
  // cost is added flat at the end. Reuses the >50 km case:
  //   commissionBase = 133.10  ·  extraKmCost = 193.80  ·  carrier 326.90
  //   Ploiești   50.1% → commission 66.68 → customer 133.10 + 66.68 + 193.80 = 393.58
  //   IasiTudor  33.7% → commission 44.85 → customer 133.10 + 44.85 + 193.80 = 371.75
  //   IasiERA / Constanța share the 33.7% → same 371.75
  it("city commissions: percentage on base only, km added flat at the end", () => {
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

    expect(r.cityCommissions.Ploiesti.pct).toBe(0.501);
    expect(r.cityCommissions.Ploiesti.commission).toBe(66.68);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(393.58);

    expect(r.cityCommissions.IasiTudor.pct).toBe(0.337);
    expect(r.cityCommissions.IasiTudor.commission).toBe(44.85);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(371.75);

    expect(r.cityCommissions.IasiERA.customerTotal).toBe(371.75);
    expect(r.cityCommissions.Constanta.customerTotal).toBe(371.75);
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
  //   Ploiești   50.1% → 12.12 → customer 36.32
  //   Stalexone  25%   →  6.05 → total    30.25
  it("AWB 007209914: small invoice still threads through every dimension", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 64.0,
      distanceKm: 3,
      numDeliveries: 1,
      deliveryDate: "2026-05-25",
    });
    expect(r.carrierTotal).toBe(24.20);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(36.32);
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
  //   Iași 33.7% → commission 86.04 → customer 255.32 + 86.04 + 235.60 = 576.96
  //   (the per-km 235.60 is added flat AFTER the commission, not marked up)
  it("AWB 038112124: 1500kg / 81km / 1 delivery → carrier 490.92, Iași 576.96", () => {
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

    expect(r.cityCommissions.IasiTudor.commission).toBe(86.04);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(576.96);
    expect(r.cityCommissions.IasiERA.customerTotal).toBe(576.96);
    expect(r.cityCommissions.Constanta.customerTotal).toBe(576.96);
    // Ploiești 50.1% → commission 127.92 → customer 255.32 + 127.92 + 235.60 = 618.84
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(618.84);
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

  // Multi-stop AND >1200kg both add increment hits, both scale km cost.
  // weight 1500 (1 weight-increment) + 2 deliveries (1 stop-increment)
  //   → totalIncrements = 2, rounds = 2
  //   base 130.66 + 2 × 124.66 = 379.98
  //   extraKmCost = 31 × 1.90 × 2 × 2 (rounds) × 2 (deliv) = 471.20
  //   carrier = 851.18
  it("1500 kg + 2 deliveries stacks weight + stop increments", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 1500,
      distanceKm: 81,
      numDeliveries: 2,
      deliveryDate: "2026-06-01",
    });
    expect(r.weightIncrements).toBe(1);
    expect(r.rounds).toBe(2);
    expect(r.incrementCost).toBe(249.32); // 2 × 124.66
    expect(r.extraKmCost).toBe(471.20);
    expect(r.carrierTotal).toBe(851.18);
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

  // Ploiești + Iași ERA use Table B (TARIFE MACARA(2).odt): 494 base,
  // 4.5 lei/km, 24/palet. Ploiești, distance 5 km → "0-15 km" 494 + 1 × 24 = 518.
  it("Ploiești macara uses Table B (494 base, 24/palet)", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 5,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 1, macaraStore: "Ploiesti",
    });
    expect(r.macara.distanceBucket).toBe("0-15 km");
    expect(r.macara.basePrice).toBe(494);
    expect(r.macara.unloadPerPallet).toBe(24);
    expect(r.macara.perKm).toBe(4.5);
    expect(r.macara.total).toBe(518);
  });

  // Iași ERA (Iași 2) is also Table B; >50 km adds 4.5 lei/km.
  // 81 km → ">50 km" 728 + (81−50)×4.5 = 139.5 + 2 paleți × 24 = 48 → 915.5.
  it("Iași ERA macara, >50 km, Table B per-km 4.5", () => {
    const r = calculatePrice({
      service: "Express", weightKg: 600, distanceKm: 81,
      numDeliveries: 1, deliveryDate: "2026-05-18",
      macaraOnAwb: true, macaraPallets: 2, macaraStore: "IasiERA",
    });
    expect(r.macara.distanceBucket).toBe(">50 km");
    expect(r.macara.basePrice).toBe(728);
    expect(r.macara.extraKm).toBe(31);
    expect(r.macara.kmCost).toBe(139.5);
    expect(r.macara.unloadCost).toBe(48);
    expect(r.macara.total).toBe(915.5);
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
    expect(r.macaraByCity.Ploiesti.basePrice).toBe(494);
    expect(r.macaraByCity.IasiERA.basePrice).toBe(494);
    expect(r.macaraByCity.IasiTudor.basePrice).toBe(638.3);
    expect(r.macaraByCity.Constanta.basePrice).toBe(638.3);
    // Ploiești: 494 + 24 = 518 · Constanța: 638.3 + 26.7 = 665.0
    expect(r.macaraByCity.Ploiesti.total).toBe(518);
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
});

/** Local 2-dp round mirroring the engine, for assertions. */
function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

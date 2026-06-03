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

  // Per-city company commissions land on top of carrierTotal with
  // city-specific percentages. Reuses the >50 km case (carrier 326.90):
  //   Ploiești   50.1% → commission 163.78 → customerTotal 490.68
  //   IasiTudor  33.7% → commission 110.17 → customerTotal 437.07
  //   IasiERA    33.7% → commission 110.17 → customerTotal 437.07
  //   Constanța  33.7% → commission 110.17 → customerTotal 437.07
  it("city commissions: all 4 cities surface their own customerTotal", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.carrierTotal).toBe(326.90);

    expect(r.cityCommissions.Ploiesti.pct).toBe(0.501);
    expect(r.cityCommissions.Ploiesti.commission).toBe(163.78);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(490.68);

    expect(r.cityCommissions.IasiTudor.pct).toBe(0.337);
    expect(r.cityCommissions.IasiTudor.commission).toBe(110.17);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(437.07);

    expect(r.cityCommissions.IasiERA.commission).toBe(110.17);
    expect(r.cityCommissions.Constanta.commission).toBe(110.17);
  });

  // Per-collaborator bonuses use the same formula on carrierTotal with
  // collaborator-specific percentages (carrier = 326.90):
  //   Stalexone        25%   → bonus  81.72 → total 408.62
  //   EMV              30.1% → bonus  98.40 → total 425.30
  //   Bitlo            12%   → bonus  39.23 → total 366.13
  //   VicDinamicExpert 25%   → bonus  81.72 → total 408.62
  //   Tiberiu          29%   → bonus  94.80 → total 421.70
  // (81.725 rounds down at the float level — 326.9 × 0.25 yields
  //  81.72499... in IEEE-754 so the half-up rule lands on 81.72.)
  it("collaborator bonuses: all 5 collaborators surface their own total", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.carrierTotal).toBe(326.90);

    expect(r.collaboratorPrices.Stalexone.pct).toBe(0.25);
    expect(r.collaboratorPrices.Stalexone.bonus).toBe(81.72);
    expect(r.collaboratorPrices.Stalexone.total).toBe(408.62);

    expect(r.collaboratorPrices.EMV.pct).toBe(0.301);
    expect(r.collaboratorPrices.EMV.bonus).toBe(98.40);
    expect(r.collaboratorPrices.EMV.total).toBe(425.30);

    expect(r.collaboratorPrices.Bitlo.bonus).toBe(39.23);
    expect(r.collaboratorPrices.Bitlo.total).toBe(366.13);

    expect(r.collaboratorPrices.VicDinamicExpert.total).toBe(408.62);
    expect(r.collaboratorPrices.Tiberiu.total).toBe(421.70);
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
});

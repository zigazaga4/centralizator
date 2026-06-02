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

describe("calculatePrice — known rows from the source workbook", () => {
  // Excel row 5 — AWB 4204019, Express / 500-800kg / 0-15 km, 1 delivery
  //   E = 47.60, H = 0, K = 0, M = 47.60, N = 40.00, O = 8.40, P = 48.40
  it("row 5: Express 500-800kg 0-15km, single delivery", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 5,
      numDeliveries: 1,
      deliveryDate: "2026-05-18", // Monday
    });
    expect(r.baseTariff).toBe(47.60);
    expect(r.extraKmCost).toBe(0);
    expect(r.incrementCost).toBe(0);
    expect(r.weekendSurcharge).toBe(0);
    expect(r.totalVat19).toBe(47.60);
    expect(r.net).toBe(40.00);
    expect(r.vat21).toBe(8.40);
    expect(r.totalVat21).toBe(48.40);
  });

  // Excel row 19 — AWB 4204215, Express / 500-800kg / 0-15 km, 2 deliveries
  //   E = 47.60, J = 53.55, K = 53.55, M = 101.15
  it("row 19: two deliveries adds one increment", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 5,
      numDeliveries: 2,
      deliveryDate: "2026-05-19",
    });
    expect(r.baseTariff).toBe(47.60);
    expect(r.incrementTariff).toBe(53.55);
    expect(r.incrementCost).toBe(53.55);
    expect(r.totalVat19).toBe(101.15);
  });

  // Excel row 25 — AWB 4204229, Express / 500-800kg / >50 km, F=51
  // Per-km rate raised from workbook's 1.70 to 1.90 per ops directive 2026-06-02.
  //   E = 130.90, G = 1.90, H = 51 * 1.90 * 2 * 1 = 193.80
  //   M = 130.90 + 193.80 = 324.70
  it("row 25: >50 km tier adds per-km surcharge", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101, // 50 base + 51 extra one-way
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.baseTariff).toBe(130.90);
    expect(r.extraKm).toBe(51);
    expect(r.extraKmCost).toBe(193.80);
    expect(r.totalVat19).toBe(324.70);
  });

  // The actual AWB in our test pile: 007209914
  //   Service Standard→Express, weight 64 kg, distanță extra 3 km,
  //   date 2026-05-25 (Monday), 1 delivery.
  //   E = TARIFF["Express / 0-200kg / 0-15 km"] = 23.80
  //   H = 0, K = 0, L = 0, M = 23.80, N = 20.00, O = 4.20, P = 24.20
  it("the test AWB 007209914 prices to 24.20 RON gross @21% VAT", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 64.0,
      distanceKm: 3,
      numDeliveries: 1,
      deliveryDate: "2026-05-25",
    });
    expect(r.weightBucket).toBe("0-200kg");
    expect(r.distanceBucket).toBe("0-15 km");
    expect(r.baseTariff).toBe(23.80);
    expect(r.totalVat19).toBe(23.80);
    expect(r.net).toBe(20.00);
    expect(r.vat21).toBe(4.20);
    expect(r.totalVat21).toBe(24.20);
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
    // base 23.80 + 11.90 = 35.70 @19% VAT
    expect(r.totalVat19).toBe(35.70);
  });

  // Per-city company commissions land on top of the carrier gross
  // (totalVat21) with city-specific percentages. Reuses row 25's
  // numbers (P = 330.16) so the whole chain stays auditable:
  //   Ploiești   50.1% → commission 165.41 → customerTotal 495.57
  //   IasiTudor  33.7% → commission 111.26 → customerTotal 441.42
  //   IasiERA    33.7% → commission 111.26 → customerTotal 441.42
  //   Constanța  33.7% → commission 111.26 → customerTotal 441.42
  it("row 25 + city commissions: all 4 cities surface their own customerTotal", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.totalVat21).toBe(330.16);

    expect(r.cityCommissions.Ploiesti.pct).toBe(0.501);
    expect(r.cityCommissions.Ploiesti.commission).toBe(165.41);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(495.57);

    expect(r.cityCommissions.IasiTudor.pct).toBe(0.337);
    expect(r.cityCommissions.IasiTudor.commission).toBe(111.26);
    expect(r.cityCommissions.IasiTudor.customerTotal).toBe(441.42);

    expect(r.cityCommissions.IasiERA.commission).toBe(111.26);
    expect(r.cityCommissions.Constanta.commission).toBe(111.26);
  });

  // Per-collaborator bonuses use the same formula on totalVat21 with
  // collaborator-specific percentages:
  //   Stalexone        25%   → bonus  82.54 → total 412.70
  //   EMV              30.1% → bonus  99.38 → total 429.54
  //   Bitlo            12%   → bonus  39.62 → total 369.78
  //   VicDinamicExpert 25%   → bonus  82.54 → total 412.70
  //   Tiberiu          29%   → bonus  95.75 → total 425.91
  it("row 25 + collaborator bonuses: all 5 collaborators surface their own total", () => {
    const r = calculatePrice({
      service: "Express",
      weightKg: 600,
      distanceKm: 101,
      numDeliveries: 1,
      deliveryDate: "2026-05-20",
    });
    expect(r.totalVat21).toBe(330.16);

    expect(r.collaboratorPrices.Stalexone.pct).toBe(0.25);
    expect(r.collaboratorPrices.Stalexone.bonus).toBe(82.54);
    expect(r.collaboratorPrices.Stalexone.total).toBe(412.70);

    expect(r.collaboratorPrices.EMV.pct).toBe(0.301);
    expect(r.collaboratorPrices.EMV.bonus).toBe(99.38);
    expect(r.collaboratorPrices.EMV.total).toBe(429.54);

    expect(r.collaboratorPrices.Bitlo.bonus).toBe(39.62);
    expect(r.collaboratorPrices.Bitlo.total).toBe(369.78);

    expect(r.collaboratorPrices.VicDinamicExpert.total).toBe(412.70);
    expect(r.collaboratorPrices.Tiberiu.total).toBe(425.91);
  });

  // Tiny-AWB sanity (the 24.20 RON test row) with the worked example
  // the user gave in plain language: base × (1 + pct).
  //   P = 24.20
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
    expect(r.totalVat21).toBe(24.20);
    expect(r.cityCommissions.Ploiesti.customerTotal).toBe(36.32);
    expect(r.collaboratorPrices.Stalexone.total).toBe(30.25);
  });
});

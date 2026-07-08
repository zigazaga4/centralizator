import { describe, it, expect } from "vitest";
import {
  distanceBucket,
  distanceTariffEscalates,
  weightTariffTier,
  weightTariffChanges,
} from "./buckets.js";

describe("distanceTariffEscalates — the km-alert rule (2026-06-24)", () => {
  // The operator only wants a km alert when the routed distance would change
  // the tariff bracket upward. Same bracket or a smaller map distance is fine.

  it("no alert when the map distance is smaller than the AWB km", () => {
    // AWB 30, map 24 — closer is harmless; we always bill the AWB km.
    expect(distanceTariffEscalates(30, 24)).toBe(false);
  });

  it("no alert when both fall in the SAME bracket (AWB 21 → map 24, 20-30)", () => {
    expect(distanceBucket(21)).toBe("20-30 km");
    expect(distanceBucket(24)).toBe("20-30 km");
    expect(distanceTariffEscalates(21, 24)).toBe(false);
  });

  it("ALERT when the map distance crosses into a higher bracket (AWB 21 → map 31)", () => {
    expect(distanceBucket(21)).toBe("20-30 km");
    expect(distanceBucket(31)).toBe("30-50 km");
    expect(distanceTariffEscalates(21, 31)).toBe(true);
  });

  it("no alert on an equal distance", () => {
    expect(distanceTariffEscalates(25, 25)).toBe(false);
  });

  it("ALERT when crossing into the >50 km bracket (AWB 48 → map 52)", () => {
    expect(distanceTariffEscalates(48, 52)).toBe(true);
  });

  it("no alert just under a boundary (AWB 14 → map 14.9, both 0-15)", () => {
    expect(distanceTariffEscalates(14, 14.9)).toBe(false);
  });

  it("ALERT right across a boundary (AWB 14.9 → map 15.1: 0-15 → 15-20)", () => {
    expect(distanceTariffEscalates(14.9, 15.1)).toBe(true);
  });

  it("is safe on non-finite inputs", () => {
    expect(distanceTariffEscalates(NaN, 30)).toBe(false);
    expect(distanceTariffEscalates(20, Infinity)).toBe(false);
  });
});

describe("distanceBucket — boundaries are upper-inclusive (ops 2026-07-07)", () => {
  // A distance exactly on a bracket edge takes the LOWER (cheaper) bracket, so
  // the operator never bills a higher bracket than the courier paid them for.
  it("an exact boundary lands in the lower bracket", () => {
    expect(distanceBucket(15)).toBe("0-15 km");
    expect(distanceBucket(20)).toBe("15-20 km");
    expect(distanceBucket(30)).toBe("20-30 km"); // the reported case
    expect(distanceBucket(50)).toBe("30-50 km");
  });

  it("just above a boundary steps up to the next bracket", () => {
    expect(distanceBucket(15.01)).toBe("15-20 km");
    expect(distanceBucket(20.01)).toBe("20-30 km");
    expect(distanceBucket(30.01)).toBe("30-50 km");
    expect(distanceBucket(50.01)).toBe(">50 km");
  });

  it("0 km and mid-bracket values", () => {
    expect(distanceBucket(0)).toBe("0-15 km");
    expect(distanceBucket(25)).toBe("20-30 km");
    expect(distanceBucket(1000)).toBe(">50 km");
  });
});

describe("weightTariffChanges — the weight-alert rule (2026-07-01)", () => {
  // A weight gap only alarms when it would move the price: the AWB weight and
  // the catalog estimate must fall in different weight-tariff tiers.

  it("tier is the base row (+0) up to 1200 kg", () => {
    expect(weightTariffTier(100)).toBe("0-200kg+0");
    expect(weightTariffTier(650)).toBe("500-800kg+0");
    expect(weightTariffTier(1000)).toBe("800-1200kg+0");
  });

  it("tier adds the >1200 kg increment count above 1200 kg", () => {
    // exactly 1200 = 0 increments = same tier as the 800-1200 kg row (no
    // false alarm across the boundary).
    expect(weightTariffTier(1199)).toBe("800-1200kg+0");
    expect(weightTariffTier(1200)).toBe("800-1200kg+0");
    expect(weightTariffTier(1500)).toBe("800-1200kg+1"); // ceil((1500-1200)/1000)=1
    expect(weightTariffTier(2200)).toBe("800-1200kg+1");
    expect(weightTariffTier(2201)).toBe("800-1200kg+2");
  });

  it("no alarm when both weights sit in the SAME tier (100 vs 150, both 0-200)", () => {
    expect(weightTariffChanges(100, 150)).toBe(false);
  });

  it("no alarm across the 1200 kg boundary at 0 increments (1199 vs 1200)", () => {
    expect(weightTariffChanges(1199, 1200)).toBe(false);
  });

  it("no alarm for a big gap that stays in one tier (210 vs 490, both 200-500)", () => {
    expect(weightTariffTier(210)).toBe("200-500kg+0");
    expect(weightTariffTier(490)).toBe("200-500kg+0");
    expect(weightTariffChanges(210, 490)).toBe(false); // ~57% gap, same tariff tier
  });

  it("ALARM when the estimate crosses a base bucket (190 vs 260: 0-200 → 200-500)", () => {
    expect(weightTariffChanges(190, 260)).toBe(true);
  });

  it("ALARM in EITHER direction (symmetric)", () => {
    expect(weightTariffChanges(260, 190)).toBe(true);
    expect(weightTariffChanges(190, 260)).toBe(true);
  });

  it("ALARM when the >1200 kg increment count differs (1500 vs 2500)", () => {
    expect(weightTariffTier(1500)).toBe("800-1200kg+1");
    expect(weightTariffTier(2500)).toBe("800-1200kg+2");
    expect(weightTariffChanges(1500, 2500)).toBe(true);
  });

  it("no alarm crossing 1200 from below into the first increment only when tier changes", () => {
    // 1100 (800-1200kg) vs 1300 (>1200kg+1) — different tiers → alarm.
    expect(weightTariffChanges(1100, 1300)).toBe(true);
  });

  it("is safe on non-finite / negative inputs", () => {
    expect(weightTariffChanges(NaN, 300)).toBe(false);
    expect(weightTariffChanges(300, Infinity)).toBe(false);
    expect(weightTariffChanges(-5, 300)).toBe(false);
  });
});

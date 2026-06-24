import { describe, it, expect } from "vitest";
import { distanceBucket, distanceTariffEscalates } from "./buckets.js";

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

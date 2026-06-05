import { describe, it, expect } from "vitest";
import { formatAddress } from "./mapbox.js";

describe("formatAddress", () => {
  it("expands Romanian street abbreviations", () => {
    expect(formatAddress("Str. Florilor 3, Iasi")).toBe("Strada Florilor 3, Iasi, România");
    expect(formatAddress("Bd. Independentei 12, Ploiesti")).toBe(
      "Bulevardul Independentei 12, Ploiesti, România",
    );
    expect(formatAddress("Sos. Pacurari 121, Iasi")).toBe("Șoseaua Pacurari 121, Iasi, România");
    expect(formatAddress("Cal. Chisinaului 23, Iasi")).toBe("Calea Chisinaului 23, Iasi, România");
  });

  it("drops sub-building + contact noise that confuses the geocoder", () => {
    expect(
      formatAddress("Str. Garii 5, Bl. A2, Sc. 1, Et. 3, Ap. 12, Ploiesti"),
    ).toBe("Strada Garii 5, Ploiesti, România");
    expect(formatAddress("Strada Lalelelor 7, tel 0722123456, Constanta")).toBe(
      "Strada Lalelelor 7, Constanta, România",
    );
  });

  it("pins the country exactly once", () => {
    expect(formatAddress("Strada Mare 1, Iasi, România")).toBe("Strada Mare 1, Iasi, România");
    expect(formatAddress("Strada Mare 1, Iasi, Romania")).toBe("Strada Mare 1, Iasi, Romania");
  });

  it("collapses newlines + whitespace and dedupes repeated segments", () => {
    expect(formatAddress("Strada Mica 9\n\nIasi\nIasi")).toBe("Strada Mica 9, Iasi, România");
  });

  it("is idempotent", () => {
    const once = formatAddress("Str. Florilor 3, Bl. 4, Iasi");
    expect(formatAddress(once)).toBe(once);
  });

  it("returns empty for empty input", () => {
    expect(formatAddress("")).toBe("");
    expect(formatAddress("   ")).toBe("");
  });
});

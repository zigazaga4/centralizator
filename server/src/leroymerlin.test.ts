import { describe, it, expect } from "vitest";
import { parseDimsMm, compareDims, parseLmProduct, pickProductUrl } from "./leroymerlin.js";

describe("parseDimsMm", () => {
  it("parses a 3-number group with a shared trailing unit (cm → mm)", () => {
    expect(parseDimsMm("10 x 100 x 50 cm")).toEqual([100, 500, 1000]);
  });

  it("extracts the size token from a full product title and ignores area (m²)", () => {
    expect(parseDimsMm("Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²")).toEqual([
      100, 500, 1000,
    ]);
  });

  it("handles mm directly and the × separator", () => {
    expect(parseDimsMm("2000 × 1000 mm")).toEqual([1000, 2000]);
  });

  it("handles a single diameter and a decimal comma in metres", () => {
    expect(parseDimsMm("Ø 50 mm")).toEqual([50]);
    expect(parseDimsMm("2,5 m")).toEqual([2500]);
  });

  it("returns nothing for area, volume, unit-less, or empty inputs", () => {
    expect(parseDimsMm("2.5 m²")).toEqual([]);
    expect(parseDimsMm("5 l")).toEqual([]);
    expect(parseDimsMm("100x50")).toEqual([]); // no unit → unsafe to compare
    expect(parseDimsMm("")).toEqual([]);
    expect(parseDimsMm(null)).toEqual([]);
  });
});

describe("compareDims", () => {
  it("matches identical multisets and tolerates rounding", () => {
    expect(compareDims([100, 500, 1000], [100, 500, 1000])).toBe("match");
    expect(compareDims([1000], [1002])).toBe("match"); // within max(2mm, 3%)
  });

  it("flags a different count or an out-of-tolerance value", () => {
    expect(compareDims([100, 500], [100, 500, 1000])).toBe("mismatch");
    expect(compareDims([100, 500, 1000], [100, 500, 2000])).toBe("mismatch");
  });

  it("is unknown when either side has no dimensions", () => {
    expect(compareDims([], [100])).toBe("unknown");
    expect(compareDims([100], [])).toBe("unknown");
  });
});

describe("pickProductUrl", () => {
  it("picks the real product page and skips category / backend hosts", () => {
    const results = [
      { link: "https://www.leroymerlin.ro/produse/materiale-constructii/termoizolatii/" },
      { link: "https://backend-ccdp.uat.leroymerlin.ro/produse/polistiren/1571/x/72325" },
      { link: "https://www.leroymerlin.ro/produse/polistiren-expandat-eps80-10-x-100-x-50-cm-2-5-m2-11698211.html" },
    ];
    expect(pickProductUrl(results)).toBe(
      "https://www.leroymerlin.ro/produse/polistiren-expandat-eps80-10-x-100-x-50-cm-2-5-m2-11698211.html",
    );
  });

  it("returns null when there is no product page", () => {
    expect(pickProductUrl([{ link: "https://www.leroymerlin.ro/produse/termoizolatii/" }])).toBeNull();
  });
});

describe("parseLmProduct", () => {
  // Mirrors the real Markdown structure ScrapingDog returns for a product
  // page: H1 title, a per-piece price line, then the alternating
  // label/value characteristics table (with a packaged-dimensions
  // sub-block that must NOT desync the targeted field lookups).
  const markdown = [
    "# Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²",
    "",
    "34,47 lei Vândut de către m²",
    "",
    "86,18 lei de către buc.",
    "",
    "Tabelul cu caracteristicile produsului",
    "",
    "Grosime (in mm)",
    "",
    "100",
    "",
    "Material principal",
    "",
    "Polistiren expandat (EPS)",
    "",
    "Latimea (in m)",
    "",
    "0.5",
    "",
    "Lungime (in m)",
    "",
    "1",
    "",
    "Brand produs",
    "",
    "MINDO",
    "",
    "Suprafata produsului (in m²)",
    "",
    "2.5",
    "",
    "Numar bucati continut",
    "",
    "5",
    "",
    "Dimensiunile produsului ambalat",
    "",
    "Produs ambalat: latime (in cm)",
    "",
    "100",
    "",
    "Produs ambalat: greutate (in kg)",
    "",
    "3.7",
  ].join("\n");

  it("extracts name, brand, price, weight, area and name-derived dims", () => {
    const p = parseLmProduct("11698211", "https://www.leroymerlin.ro/x-11698211.html", markdown);
    expect(p.found).toBe(true);
    expect(p.name).toBe("Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²");
    expect(p.brand).toBe("MINDO");
    expect(p.priceBuc).toBeCloseTo(86.18, 2);
    expect(p.weightKg).toBeCloseTo(3.7, 2); // from "Produs ambalat: greutate (in kg)"
    expect(p.areaM2).toBeCloseTo(2.5, 2);
    expect(p.dimsMm).toEqual([100, 500, 1000]); // from the product NAME
  });

  it("falls back to spec-table dims when the name has no size", () => {
    const md = [
      "# Adeziv flexibil gri",
      "",
      "Tabelul cu caracteristicile produsului",
      "",
      "Grosime (in mm)",
      "",
      "8",
      "",
      "Latimea (in cm)",
      "",
      "30",
      "",
      "Lungime (in m)",
      "",
      "1.2",
    ].join("\n");
    const p = parseLmProduct("123", "https://www.leroymerlin.ro/x-123.html", md);
    // 8 mm, 30 cm = 300 mm, 1.2 m = 1200 mm → sorted
    expect(p.dimsMm).toEqual([8, 300, 1200]);
  });
});

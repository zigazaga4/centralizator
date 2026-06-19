import { describe, it, expect } from "vitest";
import {
  parseDimsMm,
  compareDims,
  parseLmProduct,
  pickProductUrl,
  canonicalUrl,
  pickSearchProductUrl,
  weightFromName,
} from "./leroymerlin.js";

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
  /** Build a characteristics-table row exactly as leroymerlin.ro renders it. */
  const row = (label: string, value: string) =>
    `<tr class="m-product-attr-row "><th class="m-product-attr-row__name" scope="row">${label}</th>` +
    `<td class="m-product-attr-row__value"> ${value} </td></tr>`;

  // Mirrors the real HTML: a jsonld_PRODUCT block (name + price) plus the
  // m-product-attr-row spec table, including a packaged sub-block that must
  // NOT bleed into the nominal-dimension lookups.
  const polistirenHtml = `
    <h1 class="m-product-title">Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²</h1>
    <script type="application/ld+json" id="jsonld_PRODUCT">
      { "@type":"Product",
        "name":"Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²",
        "offers":{ "@type":"Offer", "price":"86.18", "priceCurrency":"RON" } }
    </script>
    <table>
      ${row("Grosime (in mm)", "100")}
      ${row("Material principal", "Polistiren expandat (EPS)")}
      ${row("Latimea (in m)", "0.5")}
      ${row("Lungime (in m)", "1")}
      ${row("Brand produs", "MINDO")}
      ${row("Suprafata produsului (in m²)", "2.5")}
      ${row("Numar bucati continut", "5")}
      ${row("Produs ambalat: latime (in cm)", "100")}
      ${row("Produs ambalat: greutate (in kg)", "3.7")}
    </table>`;

  it("extracts name, brand, price, packaged weight, area and name-derived dims", () => {
    const p = parseLmProduct("11698211", "https://www.leroymerlin.ro/x-11698211.html", polistirenHtml);
    expect(p.found).toBe(true);
    expect(p.name).toBe("Polistiren expandat EPS80, 10 x 100 x 50 cm, 2.5 m²");
    expect(p.brand).toBe("MINDO");
    expect(p.priceBuc).toBeCloseTo(86.18, 2);
    expect(p.weightKg).toBeCloseTo(3.7, 2); // prefers "Produs ambalat: greutate (in kg)"
    expect(p.areaM2).toBeCloseTo(2.5, 2);
    expect(p.dimsMm).toEqual([100, 500, 1000]); // from the product NAME
  });

  it("reads 'Greutate neta (in kg)' when no packaged weight is listed (the gutter bug)", () => {
    // Real jgheab page: only a net weight, name-derived dims, JSON-LD price.
    const html = `
      <script type="application/ld+json" id="jsonld_PRODUCT">
        { "@type":"Product", "name":"Jgheab metal, Ø 125 mm, L 3000 mm, maro",
          "offers":{ "price":"41.89" } }
      </script>
      ${row("Diametrul burlanului (in mm)", "125")}
      ${row("Lungime (in m)", "3")}
      ${row("Greutate neta (in kg)", "3.24")}`;
    const p = parseLmProduct("11503604", "https://www.leroymerlin.ro/x-11503604.html", html);
    expect(p.name).toBe("Jgheab metal, Ø 125 mm, L 3000 mm, maro");
    expect(p.priceBuc).toBeCloseTo(41.89, 2);
    expect(p.weightKg).toBeCloseTo(3.24, 2); // <- was null before the fix
    expect(p.dimsMm).toEqual([125, 3000]); // from the product NAME
  });

  it("falls back to spec-table dims when the name has no size", () => {
    const html = `
      <script type="application/ld+json" id="jsonld_PRODUCT">{ "name":"Adeziv flexibil gri" }</script>
      ${row("Grosime (in mm)", "8")}
      ${row("Latimea (in cm)", "30")}
      ${row("Lungime (in m)", "1.2")}`;
    const p = parseLmProduct("123", "https://www.leroymerlin.ro/x-123.html", html);
    // 8 mm, 30 cm = 300 mm, 1.2 m = 1200 mm → sorted
    expect(p.dimsMm).toEqual([8, 300, 1200]);
  });

  it("does not borrow a packaged dimension as a nominal one", () => {
    // No name size, no nominal length rows — only a packaged row exists.
    const html = `
      <script type="application/ld+json" id="jsonld_PRODUCT">{ "name":"Sac ciment gri" }</script>
      ${row("Produs ambalat: latime (in cm)", "40")}
      ${row("Greutate neta (in kg)", "25")}`;
    const p = parseLmProduct("9", "https://www.leroymerlin.ro/x-9.html", html);
    expect(p.dimsMm).toEqual([]); // packaged width must NOT count
    expect(p.weightKg).toBeCloseTo(25, 2);
  });
});

describe("canonicalUrl / pickSearchProductUrl (search-bar resolution)", () => {
  it("reads the canonical product URL off a product page", () => {
    expect(
      canonicalUrl('<link rel="canonical" href="https://www.leroymerlin.ro/produse/x-123.html">'),
    ).toBe("https://www.leroymerlin.ro/produse/x-123.html");
  });

  it("falls back to og:url", () => {
    expect(
      canonicalUrl('<meta property="og:url" content="https://www.leroymerlin.ro/produse/y-9.html">'),
    ).toBe("https://www.leroymerlin.ro/produse/y-9.html");
  });

  it("returns null when neither canonical nor og:url is present", () => {
    expect(canonicalUrl("<html><head></head></html>")).toBeNull();
  });

  it("prefers the exact-code product card, absolutising relative links", () => {
    const html =
      '<a href="/produse/alt-produs-999.html">x</a>' +
      '<a href="/produse/terminatie-plinta-pvc-11531653.html">y</a>';
    expect(pickSearchProductUrl(html, "11531653")).toBe(
      "https://www.leroymerlin.ro/produse/terminatie-plinta-pvc-11531653.html",
    );
  });

  it("falls back to the first product link and ignores category pages", () => {
    const html = '<a href="/produse/gradina-si-amenajare/">cat</a><a href="/produse/abc-500.html">p</a>';
    expect(pickSearchProductUrl(html, "12345")).toBe("https://www.leroymerlin.ro/produse/abc-500.html");
  });

  it("returns null when the results list no products", () => {
    expect(pickSearchProductUrl('<a href="/produse/baie/">x</a> niciun rezultat', "1")).toBeNull();
  });
});

describe("weightFromName (unit weight from the product name)", () => {
  it("parses the kg printed in real invoice product names", () => {
    expect(weightFromName("CIMENT ECOPLANET PLUS 20KG")).toBe(20);
    expect(weightFromName("TENC BOB WEBER MIN100 2MM ALB20KG")).toBe(20);
    expect(weightFromName("ADEZIV INTERIOR CERESIT 25KG CM11+")).toBe(25);
    expect(weightFromName("CHIT ROSTURI PRAF ANTRACIT 2KG CE40")).toBe(2);
    expect(weightFromName("GRUND TENCUIALA BONUSS GRI GRAFIT 5KG")).toBe(5);
    expect(weightFromName("MEMBRANA LICHIDA MAPEI MAPEGUM WPS 10KG")).toBe(10);
    expect(weightFromName("MORTAR REFRACTAR M29A 25KG")).toBe(25); // 25, not the code's 29
  });

  it("accepts a space, any case and a decimal (comma or dot)", () => {
    expect(weightFromName("Sac ciment 25 kg")).toBe(25);
    expect(weightFromName("adeziv 0,5kg")).toBe(0.5);
    expect(weightFromName("vopsea 1.5 KG")).toBe(1.5);
  });

  it("ignores other units and product codes (no false positives)", () => {
    expect(weightFromName("TENC STRUCT BONUSS 2MM GRI GRAFIT")).toBeNull(); // mm, no kg
    expect(weightFromName("MORTAR REFRACTAR M29A")).toBeNull(); // code, no kg
    expect(weightFromName("JGHEAB 125 mm 3000 mm")).toBeNull();
    expect(weightFromName("Bidon vopsea 5 l")).toBeNull(); // litres, not kg
  });

  it("returns null on empty input or a name with no kg", () => {
    expect(weightFromName(null)).toBeNull();
    expect(weightFromName("")).toBeNull();
    expect(weightFromName("Adeziv flexibil gri")).toBeNull();
  });
});

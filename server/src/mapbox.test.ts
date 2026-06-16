import { describe, it, expect } from "vitest";
import { addressLocality, formatAddress, localityMatches } from "./mapbox.js";

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

describe("addressLocality", () => {
  it("reads locality + county from street, locality, county", () => {
    expect(addressLocality("Strada Libertatii 32 32, Pietreni, Constanta 907112, România")).toEqual(
      { locality: "Pietreni", county: "Constanta" },
    );
    expect(addressLocality("Strada Soarelui 34, Valu lui Traian, Constanta, România")).toEqual({
      locality: "Valu lui Traian",
      county: "Constanta",
    });
  });

  it("treats a two-segment address as a county-level city", () => {
    expect(addressLocality("Strada Florilor 3, Iasi, România")).toEqual({
      locality: "Iasi",
      county: "Iasi",
    });
  });

  it("strips postcodes and administrative prefixes", () => {
    expect(addressLocality("Strada X 1, Sat Pietreni, Judetul Constanta 907112, România")).toEqual(
      { locality: "Pietreni", county: "Constanta" },
    );
    expect(addressLocality("Strada X 1, Comuna Deleni, Constanta, România")).toEqual({
      locality: "Deleni",
      county: "Constanta",
    });
  });

  it("keeps numeric locality names intact (postcodes are exactly 6 digits)", () => {
    expect(addressLocality("Alexandru Ioan Cuza 362 A, 2 Mai, Constanta 907161, România")).toEqual(
      { locality: "2 Mai", county: "Constanta" },
    );
  });

  it("reads a bare locality + explicit county marker (no street at all)", () => {
    expect(addressLocality("Neptun, județ Constanta, România")).toEqual({
      locality: "Neptun",
      county: "Constanta",
    });
  });

  it("does not let a Jud. segment or a repeated county shadow the locality", () => {
    expect(
      addressLocality(
        "Strada Nicolae Iorga Nr. 5, Valu Lui Traian, Jud. Constanta, Constanta 907300, România",
      ),
    ).toEqual({ locality: "Valu Lui Traian", county: "Constanta" });
  });

  it("falls back to the county-level city when the locality repeats it", () => {
    expect(addressLocality("Strada Promenada --, Constanta, Constanta 900746, România")).toEqual({
      locality: "Constanta",
      county: "Constanta",
    });
  });

  it("returns nulls when there is no comma structure to read", () => {
    expect(addressLocality("România")).toEqual({ locality: null, county: null });
    expect(addressLocality("")).toEqual({ locality: null, county: null });
  });

  it("recovers a locality GLUED to the house number (no clean segment)", () => {
    // The locality rode in the same comma-segment as the street + number, so
    // it used to collapse to the county and Mapbox matched the wrong town.
    expect(
      addressLocality("Strada Preot Vasile Nicolau Nr 204 204 Brebu Megiesesc, Prahova, România"),
    ).toEqual({ locality: "Brebu Megiesesc", county: "Prahova" });
    expect(addressLocality("Strada Principala, Nr 132 Magula, Prahova, România")).toEqual({
      locality: "Magula",
      county: "Prahova",
    });
  });

  it("recovers a locality from a comma-less address (the Focșani 160 km bug)", () => {
    // "Str Arges Nr48 Eforie Sud" has no commas at all → used to parse as
    // null and let Mapbox's fuzzy match land 160 km away in Focșani.
    expect(addressLocality("Strada Arges Nr48 Eforie Sud, România")).toEqual({
      locality: "Eforie Sud",
      county: null,
    });
  });

  it("does not invent a locality when only a street + number is present", () => {
    // Nothing trails the number → no false locality; the county still stands.
    expect(addressLocality("Strada Florilor 3, Iasi, România")).toEqual({
      locality: "Iasi",
      county: "Iasi",
    });
    expect(addressLocality("Strada Mihai Viteazul 5, România")).toEqual({
      locality: null,
      county: null,
    });
  });
});

describe("localityMatches", () => {
  it("matches exact names, ignoring diacritics and case", () => {
    expect(localityMatches("Cumpana", "Cumpăna")).toBe(true);
    expect(localityMatches("CONSTANTA", "Constanța")).toBe(true);
  });

  it("matches when one name is a token-subset of the other", () => {
    // The geocoder names the commune, the AWB the village (or vice versa).
    expect(localityMatches("Eforie Nord", "Eforie")).toBe(true);
    expect(localityMatches("Eforie", "Eforie Sud")).toBe(true);
  });

  it("rejects the wrong-locality cases that broke the routed km", () => {
    expect(localityMatches("Pietreni", "Constanța")).toBe(false); // 65.7 vs 6.5 km
    expect(localityMatches("2 Mai", "Agigea")).toBe(false); // 61.9 vs 15.9 km
    expect(localityMatches("Agigea", "Constanța")).toBe(false); // 22.7 vs 3.0 km
    expect(localityMatches("Cumpăna", "Cobadin")).toBe(false); // 14.2 vs 41.3 km
    expect(localityMatches("Valu lui Traian", "Constanța")).toBe(false); // 11.8 vs 4.6 km
  });

  it("rejects sibling localities that share a token only one way", () => {
    expect(localityMatches("Eforie Nord", "Eforie Sud")).toBe(false);
  });

  it("rejects empty input", () => {
    expect(localityMatches("", "Constanța")).toBe(false);
    expect(localityMatches("Pietreni", null)).toBe(false);
  });
});

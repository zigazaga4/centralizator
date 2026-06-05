import { describe, it, expect } from "vitest";
import { matchStore, normalize, STORES, STORE_KEYS } from "./stores.js";

describe("normalize", () => {
  it("lowercases and strips Romanian diacritics", () => {
    expect(normalize("Șoseaua Păcurari")).toBe("soseaua pacurari");
    expect(normalize("Calea Chișinăului")).toBe("calea chisinaului");
    expect(normalize("CONSTANȚA")).toBe("constanta");
  });
});

describe("matchStore", () => {
  it("resolves the ERA store from the Chișinăului street token", () => {
    expect(matchStore({ senderAddress: "Leroy Merlin, Calea Chișinăului 23, Iași" })).toBe("IasiERA");
  });

  it("resolves the ERA store from the Hello Shopping Park mall name", () => {
    // Bitlo collaborator store; the Expeditor may print only the mall name.
    expect(matchStore({ senderAddress: "Calea Chisinaului, Nr. 23, Hello Shopping Park" })).toBe("IasiERA");
    expect(matchStore({ senderName: "Leroy Merlin Hello Shopping Park" })).toBe("IasiERA");
  });

  it("resolves the Tudor store from Păcurari / Mall Moldova", () => {
    expect(matchStore({ senderAddress: "Șoseaua Păcurari nr.121, Mall Moldova, Iași" })).toBe("IasiTudor");
    expect(matchStore({ senderAddress: "Leroy Merlin Mall Moldova, Iasi" })).toBe("IasiTudor");
  });

  it("resolves Constanța from Aurel Vlaicu or the city name", () => {
    expect(matchStore({ senderAddress: "Bd. Aurel Vlaicu nr 207, Constanta" })).toBe("Constanta");
    expect(matchStore({ senderName: "Leroy Merlin Constanța" })).toBe("Constanta");
  });

  it("resolves Ploiești from Blejoi / Prahova / city name", () => {
    expect(matchStore({ senderAddress: "DN 1, Km. 6, Comuna Blejoi 107070" })).toBe("Ploiesti");
    expect(matchStore({ hubDestination: "Hub Ploiesti" })).toBe("Ploiesti");
  });

  it("returns the ambiguous 'Iasi' marker when only the city is known", () => {
    expect(matchStore({ senderAddress: "Leroy Merlin, Iași, jud. Iași" })).toBe("Iasi");
  });

  it("returns null when nothing matches", () => {
    expect(matchStore({ senderAddress: "Strada Florilor 3, Suceava" })).toBeNull();
    expect(matchStore({})).toBeNull();
  });

  it("prefers a specific street over the bare city token", () => {
    // Address carries both "Iași" and "Chișinăului" — the street wins.
    expect(matchStore({ senderAddress: "Leroy Merlin, Calea Chișinăului 23, Iași 700265" })).toBe("IasiERA");
  });
});

describe("STORES registry", () => {
  it("has all four store keys with finite coordinates", () => {
    for (const key of STORE_KEYS) {
      const s = STORES[key];
      expect(s.key).toBe(key);
      expect(Number.isFinite(s.lng)).toBe(true);
      expect(Number.isFinite(s.lat)).toBe(true);
    }
  });
});

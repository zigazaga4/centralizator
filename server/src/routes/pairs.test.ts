import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPricingInput,
  summariseBulky,
  summariseMacara,
  resolveService,
} from "../pipeline.js";
import { calculatePrice } from "../pricing.js";
import { ExtractedSchema, type Extracted } from "../schema.js";

/**
 * Regression guard for the "lone AWB" fix.
 *
 * A user pulled a single AWB out of the unpaired pool and tried to file it
 * as its own pair — there genuinely was no invoice for it (the linker found
 * no factură with a matching recipient). The server rejected it because
 * `POST /pairs` required `images.min(2)`. These tests lock in that ONE
 * document is a valid, priceable pair: the tariff comes entirely from the
 * AWB-side scalars, and the rest of the pipeline tolerates zero invoices.
 */

// The real shape the unpaired pool produces: an AWB with no invoice rows.
const loneAwb: Extracted = ExtractedSchema.parse({
  awb: {
    awb_number: "004204265",
    delivery_date: "2026-05-19",
    service_text: "Express",
    weight_kg: 600,
    distance_extra_km: 5,
    num_deliveries: 1,
  },
  invoices: [],
});

describe("lone AWB (no invoice) is a valid, priceable pair", () => {
  it("ExtractedSchema accepts zero invoices — never fabricated to satisfy the schema", () => {
    expect(loneAwb.invoices).toEqual([]);
  });

  it("no invoices ⇒ no bulky / macara / unloading surcharges to aggregate", () => {
    expect(summariseBulky(loneAwb)).toEqual({ bulkyUnits: 0, hasOtherProducts: false });
    const m = summariseMacara(loneAwb);
    expect(m.onInvoice).toBe(false);
    expect(m.pallets).toBe(0);
    expect(m.runs).toBe(0);
  });

  it("prices off the AWB scalars alone (Express / 500-800kg / 0-15km = 48.40)", () => {
    const { service } = resolveService(loneAwb.awb.service_text);
    const breakdown = calculatePrice(
      buildPricingInput(loneAwb, service, {
        distanceKm: loneAwb.awb.distance_extra_km,
        weekendBasis: "2026-05-18", // Monday — no weekend surcharge
        macaraStore: null,
      }),
    );
    expect(breakdown.carrierTotal).toBe(48.4);
  });
});

/**
 * The actual create gate. Importing the route opens its SQLite handle at
 * module load, so point it at a throwaway temp DB first — never the live one.
 */
describe("POST /pairs schema — one image is allowed (the manual-pairing fix)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let NewPairSchema: any;
  beforeAll(async () => {
    process.env.CENTRALIZATOR_DB_PATH = join(
      tmpdir(),
      `centralizator-pairs-test-${process.pid}.db`,
    );
    ({ NewPairSchema } = await import("./pairs.js"));
  });

  const img = (name: string) => ({ name, mimeType: "image/jpeg", size: 1, dataB64: "AA==" });
  const body = (n: number) => ({
    id: "test-pair",
    day: "2026-05-19",
    images: Array.from({ length: n }, (_, i) => img(`doc-${i}.jpg`)),
  });

  it("accepts ONE image — a lone AWB from the unpaired pool", () => {
    expect(NewPairSchema.safeParse(body(1)).success).toBe(true);
  });

  it("still accepts the normal AWB + invoice(s) case", () => {
    expect(NewPairSchema.safeParse(body(3)).success).toBe(true);
  });

  it("rejects ZERO images — a pair needs at least one document", () => {
    expect(NewPairSchema.safeParse(body(0)).success).toBe(false);
  });

  it("rejects more than 12 images — the upload cap is unchanged", () => {
    expect(NewPairSchema.safeParse(body(13)).success).toBe(false);
  });
});

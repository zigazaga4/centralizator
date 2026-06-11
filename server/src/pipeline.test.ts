import { describe, it, expect } from "vitest";
import { summariseMacara } from "./pipeline.js";
import { ExtractedSchema, type Extracted } from "./schema.js";

/**
 * Build a valid Extracted from a minimal AWB + one invoice's item list.
 * Parsing through the Zod schema fills every default, so the fixture stays
 * honest about the real shape the pipeline sees.
 */
function makeExtracted(opts: {
  serviceText?: string;
  macaraPallets?: number;
  items?: { name: string; quantity: number }[];
}): Extracted {
  return ExtractedSchema.parse({
    awb: {
      awb_number: "004204265",
      delivery_date: "2026-05-19",
      service_text: opts.serviceText ?? "Standard",
      weight_kg: 600,
      distance_extra_km: 13,
      num_deliveries: 1,
    },
    invoices: [
      {
        invoice_number: "538483",
        invoice_date: "2026-05-19",
        macara_pallets: opts.macaraPallets ?? 0,
        items: (opts.items ?? []).map((it) => ({
          name: it.name,
          quantity: it.quantity,
          unit: "buc",
          unit_price_net: 0,
          value_net: 0,
        })),
      },
    ],
  });
}

describe("summariseMacara — palet count drives the per-palet unload fee", () => {
  // The Rafael Boscu pair (AWB 004204265): macara on the AWB, the invoice
  // carries a "LIVRARE MACARA 5-8 PALETI" delivery line (qty 1) AND a
  // "DESCARCARE PALET M07" line (qty 5). The unload fee must bill 5 paleți,
  // not the 1 of the delivery line.
  it("uses the DESCARCARE PALET quantity, not the macara delivery line qty", () => {
    const r = summariseMacara(
      makeExtracted({
        serviceText: "Macara",
        macaraPallets: 1,
        items: [
          { name: "LIVRARE MACARA 5-8 PALETI 5-15KM", quantity: 1 },
          { name: "DESCARCARE PALET M07", quantity: 5 },
        ],
      }),
    );
    expect(r.onAwb).toBe(true);
    expect(r.onInvoice).toBe(true);
    expect(r.pallets).toBe(5);
  });

  // No descărcare-palet line → fall back to the macara_pallets the model read.
  it("falls back to macara_pallets when there is no descărcare-palet line", () => {
    const r = summariseMacara(
      makeExtracted({
        serviceText: "Macara",
        macaraPallets: 3,
        items: [{ name: "LIVRARE MACARA 1-4 PALETI", quantity: 1 }],
      }),
    );
    expect(r.pallets).toBe(3);
  });

  // No macara anywhere → not a macara run, palet count 0 even if a stray
  // "descărcare palet" line exists (that's the standard-truck unloading track).
  it("is not macara when neither the AWB nor an invoice line names macara", () => {
    const r = summariseMacara(
      makeExtracted({
        serviceText: "Standard",
        items: [{ name: "DESCARCARE PALET M07", quantity: 5 }],
      }),
    );
    expect(r.onAwb).toBe(false);
    expect(r.onInvoice).toBe(false);
    expect(r.pallets).toBe(0);
    expect(r.runs).toBe(0);
  });

  // The Alexandru Munteanu invoice (AWB 038112324): TWO "LIVRARE MACARA"
  // lines (5-8 PALETI + 1-4 PALETI) = 2 crane runs. No descărcare line, but
  // garanție-paleți lines give the paleți: 2 + 8 = 10.
  it("counts two LIVRARE MACARA lines as 2 runs and reads paleți from garanție", () => {
    const r = summariseMacara(
      makeExtracted({
        serviceText: "Standard",
        items: [
          { name: "LIVRARE MACARA 5-8 PALETI 5-15KM", quantity: 1 },
          { name: "LIVRARE MACARA 1-4 PALETI 5-15KM", quantity: 1 },
          { name: "GARANTIE EUROPALETI", quantity: 2 },
          { name: "GARANTIE PALETI NON EURO 1", quantity: 8 },
        ],
      }),
    );
    expect(r.onInvoice).toBe(true);
    expect(r.pallets).toBe(10);
    expect(r.runs).toBe(2);
  });

  // BOTH a descărcare-palet line AND garanție-paleți lines present → paleți
  // come from the descărcare line only (never summed), so no double charge.
  it("does not double-count paleți when descărcare AND garanție both appear", () => {
    const r = summariseMacara(
      makeExtracted({
        serviceText: "Macara",
        items: [
          { name: "LIVRARE MACARA 1-4 PALETI", quantity: 1 },
          { name: "DESCARCARE PALET M07", quantity: 4 },
          { name: "GARANTIE EUROPALETI", quantity: 4 },
        ],
      }),
    );
    expect(r.pallets).toBe(4); // descărcare wins, NOT 4 + 4
    expect(r.runs).toBe(1);
  });
});

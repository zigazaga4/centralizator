import { describe, it, expect } from "vitest";
import { linkDocuments, tokenSet, overlapScore, type DocInfo } from "./linker.js";

/** Shorthand DocInfo factory. */
function doc(index: number, type: DocInfo["type"], fields: Partial<DocInfo> = {}): DocInfo {
  return {
    index,
    type,
    awbNumber: null,
    recipientName: null,
    recipientAddress: null,
    invoiceNumber: null,
    orderNumber: null,
    ...fields,
  };
}

describe("tokenSet / overlapScore", () => {
  it("matches duplicated and reordered Romanian names", () => {
    const a = tokenSet("CIUREA CRISTIAN CRISTIAN CIUREA");
    const b = tokenSet("CRISTIAN CIUREA");
    expect(overlapScore(a, b)).toBe(1);
  });

  it("matches a name with an extra middle token", () => {
    expect(overlapScore(tokenSet("Hudea George"), tokenSet("Hudea George vasile"))).toBe(1);
  });

  it("strips diacritics", () => {
    expect(overlapScore(tokenSet("Mincu Anişoara"), tokenSet("MINCU ANISOARA"))).toBe(1);
  });

  it("does not match different people", () => {
    expect(
      overlapScore(tokenSet("AUREL PALAGHICIUC"), tokenSet("Hudea George vasile")),
    ).toBe(0);
  });

  it("empty input scores zero", () => {
    expect(overlapScore(tokenSet(null), tokenSet("Hudea George"))).toBe(0);
  });
});

describe("linkDocuments — assignment", () => {
  it("binds invoices to their AWB by recipient name, before or after in scan order", () => {
    const { groups } = linkDocuments([
      doc(0, "invoice", { recipientName: "AUREL PALAGHICIUC", orderNumber: "480746" }),
      doc(1, "awb", { awbNumber: "007211219", recipientName: "AUREL PALAGHICIUC" }),
      doc(2, "awb", { awbNumber: "007211172", recipientName: "Hudea George" }),
      doc(3, "invoice", { recipientName: "Hudea George vasile", orderNumber: "480610" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 1, invoiceIndices: [0] },
      { awbIndex: 2, invoiceIndices: [3] },
    ]);
  });

  it("name match beats adjacency", () => {
    // Invoice at 2 is ADJACENT to awb at 1 but NAMES it to the awb at 4.
    const { groups } = linkDocuments([
      doc(1, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(2, "invoice", { recipientName: "Elena Dincu" }),
      doc(4, "awb", { awbNumber: "007211002", recipientName: "ELENA DINCU" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 1, invoiceIndices: [1] }, // lone anchor reuses itself
      { awbIndex: 4, invoiceIndices: [2] },
    ]);
  });

  it("falls back to nearest anchor for unreadable photos, preferring the preceding one on ties", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "A B" }),
      doc(1, "unknown"),
      doc(2, "awb", { awbNumber: "007211002", recipientName: "C D" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 0, invoiceIndices: [1] },
      { awbIndex: 2, invoiceIndices: [2] },
    ]);
  });

  it("same recipient with two shipments: adjacency splits the invoices", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "NICU VULPE" }),
      doc(1, "invoice", { recipientName: "NICU VULPE" }),
      doc(5, "invoice", { recipientName: "NICU VULPE" }),
      doc(6, "awb", { awbNumber: "007211009", recipientName: "NICU VULPE" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 0, invoiceIndices: [1] },
      { awbIndex: 6, invoiceIndices: [5] },
    ]);
  });

  it("address confirms when names are missing", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientAddress: "Str. Zorilor 51, Ovidiu" }),
      doc(3, "awb", { awbNumber: "007211002", recipientAddress: "Str. Murelor Nr8, Ovidiu" }),
      // Adjacent to anchor 3 but its address belongs to anchor 0.
      doc(4, "invoice", { recipientAddress: "STR ZORILOR 51, OVIDIU" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 0, invoiceIndices: [4] },
      { awbIndex: 3, invoiceIndices: [3] },
    ]);
  });
});

describe("linkDocuments — anchor dedup (the 0900 trap)", () => {
  it("folds a partial-number combined re-shoot into its full anchor and keeps its invoice view", () => {
    // The real production case: label photo + combined photo + combined
    // re-shoot whose flipped label reads only "...0900".
    const { groups, droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "007210900", recipientName: "CIUREA CRISTIAN CRISTIAN CIUREA" }),
      doc(1, "combined", {
        awbNumber: "007210900",
        recipientName: "CRISTIAN CIUREA",
        orderNumber: "479676",
      }),
      doc(2, "combined", { awbNumber: "0900", recipientName: "CRISTIAN CIUREA", orderNumber: "479676" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1, 2] }]);
    expect(droppedAnchors.map((d) => d.index).sort()).toEqual([1, 2]);
  });

  it("never merges two anchors with different full numbers, even same name and adjacent", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "NICU VULPE" }),
      doc(1, "awb", { awbNumber: "007211009", recipientName: "NICU VULPE" }),
    ]);
    expect(groups.length).toBe(2);
  });

  it("identical full numbers merge no matter the distance", () => {
    const { groups, droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "A B" }),
      doc(40, "awb", { awbNumber: "007211001", recipientName: "A B" }),
    ]);
    expect(groups.length).toBe(1);
    expect(droppedAnchors).toHaveLength(1);
  });

  it("keeps the photo with the LONGER number read as the anchor", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "0900", recipientName: "CRISTIAN CIUREA" }),
      doc(1, "awb", { awbNumber: "007210900", recipientName: "CRISTIAN CIUREA" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 1, invoiceIndices: [1] }]);
  });

  it("unreadable-number anchor folds into a nearby same-name anchor", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(1, "awb", { recipientName: "MARIAN PAIU" }), // blurry barcode
      doc(2, "invoice", { recipientName: "MARIAN PAIU" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [2] }]);
  });

  it("an unreadable-number anchor FAR from its name twin stays its own shipment", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(20, "awb", { recipientName: "MARIAN PAIU" }),
    ]);
    expect(groups.length).toBe(2);
  });
});

describe("linkDocuments — degenerate stacks", () => {
  it("no anchors: contiguous invoice runs become visible awb-less groups", () => {
    const { groups } = linkDocuments([
      doc(0, "invoice", { recipientName: "A B" }),
      doc(1, "invoice", { recipientName: "A B" }),
      doc(5, "invoice", { recipientName: "C D" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: null, invoiceIndices: [0, 1] },
      { awbIndex: null, invoiceIndices: [5] },
    ]);
  });

  it("a lone combined photo forms a complete self-pair", () => {
    const { groups } = linkDocuments([
      doc(0, "combined", { awbNumber: "007211001", recipientName: "A B", orderNumber: "1" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [0] }]);
  });

  it("empty input yields no groups", () => {
    expect(linkDocuments([]).groups).toEqual([]);
  });

  it("groups come out in scan order", () => {
    const { groups } = linkDocuments([
      doc(0, "invoice", { recipientName: "C D" }),
      doc(1, "awb", { awbNumber: "007211002", recipientName: "C D" }),
      doc(2, "awb", { awbNumber: "007211001", recipientName: "A B" }),
      doc(3, "invoice", { recipientName: "A B" }),
    ]);
    expect(groups.map((g) => g.awbIndex)).toEqual([1, 2]);
  });
});

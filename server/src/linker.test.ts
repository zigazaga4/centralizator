import { describe, it, expect } from "vitest";
import { linkDocuments, tokenSet, overlapScore, type DocInfo } from "./linker.js";

/** Shorthand DocInfo factory. */
function doc(index: number, type: DocInfo["type"], fields: Partial<DocInfo> = {}): DocInfo {
  return {
    index,
    type,
    awbNumber: null,
    awbConfident: true, // tests assume clean reads unless stated otherwise
    extraAwbNumbers: [],
    recipientName: null,
    recipientAddress: null,
    invoiceNumber: null,
    orderNumber: null,
    awbRaw: null,
    invoiceRaw: null,
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
    // Anchor 1's invoice never matched → it cannot form a valid pair and
    // is dropped (only valid pairs are shown).
    expect(groups).toEqual([{ awbIndex: 4, invoiceIndices: [2] }]);
  });

  it("a name match BEYOND the assignment window never binds — everything goes unpaired", () => {
    // The live VOICU case: a far anchor must not steal a stop's invoice,
    // and (by command) the invoice is never position-guessed onto the
    // near anchor either — the human pairs it from the app.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211261", recipientName: "Mihai Bercea" }),
      doc(1, "invoice", { recipientName: "VOICU CONSTANTIN" }), // misread or shuffled paper
      doc(11, "awb", { awbNumber: "007211193", recipientName: "VOICU CONSTANTIN" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1, 11]);
  });

  it("unreadable photos are never position-bound — they go unpaired", () => {
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "A B" }),
      doc(1, "unknown"),
      doc(2, "awb", { awbNumber: "007211002", recipientName: "C D" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1, 2]);
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
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [4] }]);
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
    const { droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "NICU VULPE" }),
      doc(1, "awb", { awbNumber: "007211009", recipientName: "NICU VULPE" }),
    ]);
    expect(droppedAnchors).toHaveLength(0); // two distinct shipments, no fold
  });

  it("identical full numbers merge no matter the distance", () => {
    const { droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "A B" }),
      doc(40, "awb", { awbNumber: "007211001", recipientName: "A B" }),
    ]);
    expect(droppedAnchors).toHaveLength(1); // folded into one shipment
  });

  it("keeps the photo with the LONGER number read as the anchor", () => {
    const { droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "0900", recipientName: "CRISTIAN CIUREA" }),
      doc(1, "awb", { awbNumber: "007210900", recipientName: "CRISTIAN CIUREA" }),
    ]);
    expect(droppedAnchors).toEqual([
      expect.objectContaining({ index: 0, ofIndex: 1 }),
    ]);
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
    const { droppedAnchors, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(20, "awb", { recipientName: "MARIAN PAIU" }),
    ]);
    expect(droppedAnchors).toHaveLength(0); // not folded — two shipments
    expect(unpaired).toHaveLength(2);
  });

  it("a WEAK (rotated/blurred) full-number read folds by name+adjacency despite differing digits", () => {
    // The live failure: an upside-down label hallucinated as a full number
    // that differed from the true sibling anchor — the FAIR IMPEX split.
    const { groups } = linkDocuments([
      doc(0, "combined", { awbNumber: "007211227", recipientName: "FAIR IMPEX 3 SRL" }),
      doc(1, "combined", {
        awbNumber: "007209914",
        awbConfident: false,
        recipientName: "FAIR IMPEX 3 SRL",
      }),
    ]);
    // The folded combined duplicate becomes the invoice view; the anchor
    // itself rides in the AWB slot, so the extractor sees both photos.
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
  });

  it("two CONFIDENT different numbers never merge even with matching name nearby", () => {
    const { droppedAnchors, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "NICU VULPE" }),
      doc(1, "awb", { awbNumber: "007211009", recipientName: "NICU VULPE" }),
    ]);
    expect(droppedAnchors).toHaveLength(0); // no fold = two distinct shipments
    expect(unpaired).toEqual([0, 1]); // both lack invoices → unpaired in the app
  });

  it("a 13-digit invoice-header number never acts as an AWB identity", () => {
    // Header contamination: awb_number = the FACTURĂ number. Identity must
    // be void, letting the photo fold into its name twin next door.
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211253", recipientName: "Cerasela Ionescu" }),
      doc(1, "combined", {
        awbNumber: "0072600052396",
        invoiceNumber: "0072600052396",
        recipientName: "CERASELA IONESCU",
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
  });

  it("a short ambiguous partial folds into the NEAREST containing anchor", () => {
    // "0072" is a substring of every AWB in the system — adjacency decides.
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211265", recipientName: "PINDICI VALENTIN" }),
      doc(3, "awb", { awbNumber: "007211161", recipientName: "anghelescu claudiu" }),
      doc(4, "combined", { awbNumber: "0072", awbConfident: false }),
    ]);
    expect(groups).toEqual([{ awbIndex: 3, invoiceIndices: [4] }]);
  });

  it("the CONFIDENT read wins the anchor role over a weak one", () => {
    const { groups } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007299999",
        awbConfident: false,
        recipientName: "ADRIAN TIHAN",
      }),
      doc(1, "awb", { awbNumber: "007211074", recipientName: "ADRIAN TIHAN" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 1, invoiceIndices: [0] }]);
  });

  it("legal-form and supplier stopwords don't dilute name identity", () => {
    // Live case: "HOME SRL" (partial read) must still fold into
    // "AVANGARDE HOME SRL" next door.
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211306", recipientName: "AVANGARDE HOME SRL" }),
      doc(1, "combined", { awbConfident: false, recipientName: "HOME SRL" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
  });

  it("digit-only and supplier-word 'names' carry no identity", () => {
    // "0000000" (a CNP read as a name) and "Leroy Merlin Romania" (the
    // store) must never make two documents the same shipment. The two
    // confident-numbered labels stay as real (incomplete) shipments;
    // the two identity-free readings are JUNK and never become pairs.
    const { groups, droppedJunk, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211290", recipientName: "0000000" }),
      doc(1, "awb", { awbNumber: "007211074", recipientName: "0000000" }),
      doc(5, "awb", { awbConfident: false, recipientName: "Leroy Merlin Romania" }),
      doc(6, "awb", { awbConfident: false, recipientName: "Leroy Merlin Romania" }),
    ]);
    expect(groups).toHaveLength(0); // none has an invoice → no pair
    expect(droppedJunk.sort()).toEqual([5, 6]);
    expect(unpaired).toEqual([0, 1]);
  });

  it("a stray-sheet reading that identifies nothing never becomes a pair", () => {
    // The live junk pairs: a pile photo read as a label with garbage
    // digits, no name, no confidence — dropped, not shown.
    const { groups, droppedJunk } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211290", recipientName: "PULIA VITALIY" }),
      doc(1, "invoice", { recipientName: "PULIA VITALIY" }),
      doc(2, "awb", { awbNumber: "22006569", awbConfident: false }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
    expect(droppedJunk).toEqual([2]);
  });

  it("stray labels in extra_awb_numbers never create or break anchors", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211074", recipientName: "ADRIAN TIHAN" }),
      doc(1, "invoice", {
        recipientName: "ADRIAN TIHAN",
        extraAwbNumbers: ["007211187"], // neighbour's label peeking in
      }),
      doc(2, "awb", { awbNumber: "007211187", recipientName: "Liliana Radu" }),
      doc(3, "invoice", { recipientName: "Liliana Radu" }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 0, invoiceIndices: [1] },
      { awbIndex: 2, invoiceIndices: [3] },
    ]);
  });
});

describe("linkDocuments — degenerate stacks", () => {
  it("no anchors: invoices without any AWB go unpaired", () => {
    const { groups, unpaired } = linkDocuments([
      doc(0, "invoice", { recipientName: "A B" }),
      doc(1, "invoice", { recipientName: "A B" }),
      doc(5, "invoice", { recipientName: "C D" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1, 5]);
  });

  it("a lone label and a nameless invoice photo are NOT married by position — both unpaired", () => {
    // By command there is no adjacency pairing: a label next to an
    // unreadable-buyer invoice photo is a guess, and the system never
    // guesses. Both surface as unpaired for the human to join.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211290", recipientName: "PULIA VITALIY" }),
      doc(1, "combined", { awbConfident: false, invoiceRaw: { order_number: "480831" } }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1]);
  });

  it("a named invoice-bearing label photo with NO matching anchor goes unpaired, never adjacency-bound", () => {
    // A document naming a different person next to Iuliana's pair:
    // binding by adjacency would put their invoice inside the wrong
    // shipment — it surfaces as unpaired instead.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211281", recipientName: "Iuliana-Ioana" }),
      doc(1, "invoice", { recipientName: "Iuliana-Ioana" }),
      doc(2, "awb", {
        awbConfident: false,
        recipientName: "Liliana Radu",
        invoiceRaw: { supplier_name: "Leroy Merlin" },
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
    expect(unpaired).toEqual([2]);
  });

  it("a combined photo with a readable name forms its own valid pair", () => {
    // Liliana's real photo: label + invoice in ONE image — a complete
    // shipment on its own, shown as a pair.
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211281", recipientName: "Iuliana-Ioana" }),
      doc(1, "invoice", { recipientName: "Iuliana-Ioana" }),
      doc(2, "combined", {
        awbConfident: false,
        recipientName: "Liliana Radu",
        awbRaw: { recipient_name: "Liliana Radu" }, // the LABEL prints her name
        invoiceRaw: { order_number: "480700" },
      }),
    ]);
    expect(groups).toEqual([
      { awbIndex: 0, invoiceIndices: [1] },
      { awbIndex: 2, invoiceIndices: [2] },
    ]);
  });

  it("a phantom label on an invoice photo never anchors a pair — the missing AWB is exposed", () => {
    // The Roxana Petre case: a stack of her invoice photos, one reported
    // as "combined" because the model mistook the invoice's printed
    // Standard/km/L-code fields for a courier label — but that label has
    // NO digits and NO printed recipient (her name came from the BUYER
    // block). The real AWB was never photographed. Nothing may pair:
    // every photo surfaces unpaired so the human SEES the AWB is missing,
    // instead of a ready pair with an empty AWB and a phantom price.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbConfident: false,
        recipientName: "ROXANA PETRE",
        awbRaw: { service_text: "Standard", distance_extra_km: 23, content_code: "L07-26-633018" },
        invoiceRaw: { buyer_name: "ROXANA PETRE", order_number: "481064" },
        orderNumber: "481064",
      }),
      doc(1, "invoice", { recipientName: "ROXANA PETRE" }),
      doc(2, "invoice", { recipientName: "ROXANA PETRE" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1, 2]);
  });

  it("an AWB photo showing only the BUYER BLOCK of the invoice behind it never self-pairs", () => {
    // The Omer Filiz case: the label sits ON its invoice, so the photo
    // catches the Cumparator block — but no number, no comandă, no
    // totals. Self-pairing on that ghost masks the real invoice photos
    // (here misread "FILIS" vs "FILIZ", below the name threshold), so
    // label AND invoices must all surface unpaired for the human.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007211755",
        recipientName: "OMER FILIZ",
        awbRaw: { recipient_name: "OMER FILIZ", hub_destination: "Constanta Hub" },
        invoiceRaw: { buyer_name: "FILIS OMER" },
      }),
      doc(1, "invoice", { recipientName: "FILIS OMER" }),
      doc(2, "invoice", { recipientName: "FILIS OMER" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1, 2]);
  });

  it("a combined with a printed label recipient but unreadable digits still anchors its pair", () => {
    const { groups } = linkDocuments([
      doc(0, "combined", {
        awbConfident: false,
        recipientName: "Mihai Popa",
        awbRaw: { recipient_name: "Mihai Popa" },
        invoiceRaw: { buyer_name: "Mihai Popa", invoice_total_gross: 250 },
      }),
      doc(1, "invoice", { recipientName: "Mihai Popa" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
  });

  it("a nameless invoice photo between two shipments is never guessed — unpaired", () => {
    // Formerly the adjacency tie-break decided this; by command position
    // proves nothing, so the nameless photo and the label it probably
    // belongs to both go to the app's unpaired strip.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211290", recipientName: "PULIA VITALIY" }),
      doc(1, "combined", { awbConfident: false, invoiceRaw: { supplier_name: "LM" } }),
      doc(2, "awb", { awbNumber: "007211279", recipientName: "Catalin Chioaru" }),
      doc(3, "invoice", { recipientName: "Catalin Chioaru" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 2, invoiceIndices: [3] }]);
    expect(unpaired).toEqual([0, 1]);
  });

  it("a combined self-pair whose invoice already lives in another pair folds into it", () => {
    // The recurring stray-sheet label (007209914) on a second photo of an
    // already-paired invoice must not spawn a ghost shipment.
    const { groups, droppedAnchors } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007211273",
        recipientName: "Panait Daniela",
        invoiceRaw: { order_number: "480833" },
        orderNumber: "480833",
      }),
      doc(1, "combined", {
        awbNumber: "007209914",
        recipientName: "Panait Daniela",
        invoiceRaw: { order_number: "480833" },
        orderNumber: "480833",
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [0, 1] }]);
    expect(droppedAnchors).toEqual([
      expect.objectContaining({ index: 1, ofIndex: 0 }),
    ]);
  });

  it("a company-buyer invoice follows the NAME; the label left empty goes unpaired", () => {
    // The Necmin/PRO CLIENT shape: the invoice next to Necmin's label
    // prints a company buyer that name-matches a different anchor. With
    // positional repair removed (by command), the invoice follows what
    // the paper SAYS, and the widowed label surfaces as unpaired for the
    // human to fix.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211240", recipientName: "NECMIN COLTUSA" }),
      doc(1, "invoice", { recipientName: "PRO CLIENT CONSTANTA" }),
      doc(4, "awb", { awbNumber: "007211113", recipientName: "PRO CLIENT CONSTANTA" }),
      doc(5, "invoice", { recipientName: "PRO CLIENT CONSTANTA" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 4, invoiceIndices: [1, 5] }]);
    expect(unpaired).toEqual([0]);
  });

  it("an orphan photo of an ALREADY-PAIRED invoice folds into that pair (same comandă)", () => {
    // The live Pereche #26 case: Tihan's invoice photographed twice, the
    // second copy with an unreadable stray label. Same comandă → same
    // invoice → the photo joins its pair instead of becoming an AWB-less
    // row in the app.
    const { groups, droppedAnchors } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211074", recipientName: "ADRIAN TIHAN" }),
      doc(1, "invoice", { recipientName: "ADRIAN TIHAN", orderNumber: "480654" }),
      doc(2, "combined", { awbConfident: false, orderNumber: "480654" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1, 2] }]);
    expect(droppedAnchors).toEqual([
      expect.objectContaining({ index: 2, ofIndex: 0 }),
    ]);
  });

  it("a lone combined photo with invoice SUBSTANCE forms a complete self-pair", () => {
    // The Cerasela Ionescu shape: label clipped onto its full invoice —
    // number, buyer and totals all readable in the one photo.
    const { groups } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007211253",
        recipientName: "Cerasela Ionescu",
        invoiceNumber: "0072600058403",
        orderNumber: "480805",
        invoiceRaw: { buyer_name: "Cerasela Ionescu", invoice_total_gross: 644 },
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [0] }]);
  });

  it("a label with only an invoice SLIVER never self-pairs — both halves go unpaired", () => {
    // The Ambrosie 007211168 case: the label photo caught ONE item row of
    // the sheet underneath (no number, no buyer, no totals). That sliver
    // is not an invoice; the photo is a LABEL. Its real invoice photo
    // read no buyer name, so nothing can marry — both surface unpaired.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007211168",
        recipientName: "Ambrosie Camelia Elena Frumosu",
        invoiceRaw: { items: [{ name: "PERGOLA OMEGA ALUMINIU 400X282CM" }] },
      }),
      doc(1, "invoice", {}), // the real invoice — buyer unreadable
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0, 1]);
  });

  it("a sliver-label still marries its real invoice by NAME", () => {
    const { groups } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "007211168",
        recipientName: "Ambrosie Camelia Elena Frumosu",
        invoiceRaw: { items: [{ name: "PERGOLA OMEGA ALUMINIU 400X282CM" }] },
      }),
      doc(1, "invoice", { recipientName: "Camelia Elena Ambrosie" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
  });

  it("empty input yields no groups", () => {
    expect(linkDocuments([]).groups).toEqual([]);
  });

  it("groups come out in scan order", () => {
    const { groups } = linkDocuments([
      doc(0, "invoice", { recipientName: "Carmen Dinu" }),
      doc(1, "awb", { awbNumber: "007211002", recipientName: "Carmen Dinu" }),
      doc(2, "awb", { awbNumber: "007211001", recipientName: "Ana Banu" }),
      doc(3, "invoice", { recipientName: "Ana Banu" }),
    ]);
    expect(groups.map((g) => g.awbIndex)).toEqual([1, 2]);
  });
});

import { describe, it, expect } from "vitest";
import { linkDocuments, tokenSet, overlapScore, sameAddress, parseAddress, type DocInfo } from "./linker.js";

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

  it("a name match binds across the whole batch — no scan-distance window", () => {
    // The live PETRE MATEOIU case: the AWB and its invoice landed far apart
    // in the upload, but the recipient name is identical on both, so they
    // MUST pair regardless of distance. The neighbouring Mihai Bercea AWB
    // (no name match) is never guessed onto the invoice and goes unpaired.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211261", recipientName: "Mihai Bercea" }),
      doc(1, "invoice", { recipientName: "VOICU CONSTANTIN" }),
      doc(11, "awb", { awbNumber: "007211193", recipientName: "VOICU CONSTANTIN" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 11, invoiceIndices: [1] }]);
    expect(unpaired).toEqual([0]);
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

  it("a numberless label is not an anchor — it binds to its real same-name AWB", () => {
    // doc1's barcode is fully unreadable (no digits, no Hub), so it can never
    // be its own AWB pair (operator rule 2026-06-24). It is treated as an
    // extra document and binds, by name, to the REAL MARIAN PAIU AWB (doc0).
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(1, "awb", { recipientName: "MARIAN PAIU" }), // blurry barcode, no digits
      doc(2, "invoice", { recipientName: "MARIAN PAIU" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1, 2] }]);
  });

  it("a numberless label with a real same-name AWB present binds there, not its own shipment", () => {
    // A label whose number is fully unreadable can never anchor a pair; with a
    // real same-name AWB present (doc0) it binds there by name (batch-wide).
    // It used to be kept as its own numberless 'shipment' — now disallowed.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211001", recipientName: "MARIAN PAIU" }),
      doc(20, "awb", { recipientName: "MARIAN PAIU" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [20] }]);
    expect(unpaired).toEqual([]);
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
    // doc 5 & 6 are numberless labels (no digits, no Hub) → not anchors; their
    // stopword-only "name" matches nothing, so they surface as unpaired for the
    // human (rather than silently dropped) alongside the two invoice-less AWBs.
    expect(droppedJunk).toEqual([]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([0, 1, 5, 6]);
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

  it("a combined photo with a name but NO AWB number does not self-pair — it goes unpaired", () => {
    // Operator rule 2026-06-24: a label half with a recipient name but NO
    // usable AWB number and NO Hub is an invoice the model decorated with a
    // phantom report_awb (the model copies the buyer into recipient_name), so
    // it must NOT form its own pair. With no same-name anchor to bind to, it
    // surfaces as unpaired for the human (no more blank-AWB "pairs").
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211281", recipientName: "Iuliana-Ioana" }),
      doc(1, "invoice", { recipientName: "Iuliana-Ioana" }),
      doc(2, "combined", {
        awbConfident: false,
        recipientName: "Liliana Radu",
        awbRaw: { recipient_name: "Liliana Radu" }, // name only — no number, no Hub
        invoiceRaw: { order_number: "480700" },
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
    expect(unpaired).toEqual([2]);
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

  it("a combined with a recipient name but unreadable digits no longer anchors — goes unpaired", () => {
    // Was 'still anchors its pair'. Operator rule 2026-06-24: no usable AWB
    // number (and no Hub) → not a real label → must not anchor. The phantom
    // label photo and the invoice both surface as unpaired.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbConfident: false,
        recipientName: "Mihai Popa",
        awbRaw: { recipient_name: "Mihai Popa" },
        invoiceRaw: { buyer_name: "Mihai Popa", invoice_total_gross: 250 },
      }),
      doc(1, "invoice", { recipientName: "Mihai Popa" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([0, 1]);
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

describe("sameAddress / parseAddress — true street+number identity", () => {
  it("rejects two different streets in the same town (the Bucov bug)", () => {
    // PETRE MATEOIU's invoice address vs Aurel Vasile's AWB address — both
    // in Bucov, sharing only "str" + "bucov". NOT the same address.
    expect(
      sameAddress("Str tineretului 192, Bucov", "Str. Constantin Stere 110 110, Bucov, Prahova 107110"),
    ).toBe(false);
  });

  it("matches the same street + number despite formatting and diacritics", () => {
    expect(
      sameAddress("Str. Constantin Stere nr 110, Bucov", "constantin stere 110, bucov, prahova"),
    ).toBe(true);
  });

  it("rejects the same street with different house numbers", () => {
    expect(sameAddress("Str Republicii 1, Blejoi", "Str Republicii 45, Blejoi")).toBe(false);
  });

  it("matches a partial street-name read by containment", () => {
    expect(sameAddress("Stere 110", "Constantin Stere 110")).toBe(true);
  });

  it("requires a real house number on BOTH sides — a numberless side never binds", () => {
    // Operator rule 2026-06-24: a numberless landmark blob must not bind by a
    // shared (often generic) street name like "Principala". Both sides need a
    // parseable house number, and the numbers must match.
    expect(sameAddress("Str Constantin Stere, Bucov", "Constantin Stere 110, Bucov")).toBe(false);
    expect(sameAddress("Constantin Stere 110, Bucov", "Constantin Stere 110, Bucov")).toBe(true);
  });

  it("never matches on boilerplate or locality tokens alone", () => {
    expect(sameAddress("Str, Bucov, Prahova", "Str, Bucov, Prahova")).toBe(false);
    expect(sameAddress("Comuna Bucov, Prahova", "Comuna Bucov, Prahova")).toBe(false);
    expect(sameAddress(null, "Constantin Stere 110")).toBe(false);
  });

  it("treats a 6-digit postal code as not-a-house-number", () => {
    expect(parseAddress("Str Garii 7, Ploiesti 100001").number).toBe("7");
    expect([...parseAddress("Str Garii 7, Ploiesti 100001").street]).toEqual(["garii"]);
  });
});

describe("linkDocuments — same-town stranger never glues onto a foreign AWB", () => {
  it("pairs the name-matching invoice and unpairs the same-town stranger", () => {
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", {
        awbNumber: "004206025",
        recipientName: "Aurel Vasile",
        recipientAddress: "Str. Constantin Stere 110, Bucov, Prahova",
      }),
      doc(1, "invoice", {
        recipientName: "PETRE MATEOIU",
        recipientAddress: "Str Tineretului 192, Bucov",
        invoiceNumber: "0042600062938",
        orderNumber: "543861",
      }),
      doc(2, "invoice", {
        recipientName: "Aurel Vasile",
        recipientAddress: "Str. Constantin Stere 110, Bucov, Prahova",
        invoiceNumber: "0042600062676",
        orderNumber: "543764",
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [2] }]);
    expect(unpaired).toEqual([1]);
  });

  it("still binds a no-name second invoice to the SAME address by street+number", () => {
    // Name unreadable on the second invoice, but its address is the AWB's
    // address exactly → address tier rescues it (legitimate same-address).
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", {
        awbNumber: "007211900",
        recipientName: "Maria Pop",
        recipientAddress: "Str Garii 7, Ploiesti",
      }),
      doc(1, "invoice", {
        recipientName: null,
        recipientAddress: "Strada Garii nr 7, Ploiesti, Prahova",
        invoiceNumber: "0072600061111",
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
    expect(unpaired).toEqual([]);
  });
});

describe("linkDocuments — regression: the live failures of 2026-06-24", () => {
  it("BUG A: a 'combined' with no AWB number never becomes a blank-AWB pair (VIRGILIU NICOLESCU)", () => {
    // The model decorated a plain invoice with a phantom report_awb that had
    // NO awb_number and copied the buyer into recipient_name. It used to
    // self-pair into a ready pair with a blank AWB. Now it is demoted and,
    // with no real same-name AWB, surfaces as unpaired.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        recipientName: "VIRGILIU NICOLESCU",
        awbRaw: { recipient_name: "VIRGILIU NICOLESCU" }, // name only — no number, no Hub
        invoiceNumber: "I26 M004 004260005231",
        invoiceRaw: {
          invoice_number: "I26 M004 004260005231",
          buyer_name: "VIRGILIU NICOLESCU",
          invoice_total_gross: 250,
        },
      }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0]);
  });

  it("BUG B: a landmark-blob AWB does not vacuum up same-street strangers (AWB 004205970)", () => {
    // AWB recipient is "Ilinca Cristina" at "Str. Principala 687a …, Dambovita".
    // Two foreign invoices (Ion Popa in Gornet, Cristina Pigul in Strejnicu)
    // are on a street ALSO called "Principala" but in different villages with
    // different house numbers. Only Cristina Ilinca (name match) belongs.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", {
        awbNumber: "004205970",
        recipientName: "Ilinca Cristina Cristina Ilinca",
        recipientAddress:
          "Str. Principala 687a Parcare, Trecere Pieton. Vizavi Monument I. L. Caragiale, Dambovita 137255",
      }),
      doc(1, "invoice", {
        recipientName: "Ion Popa",
        recipientAddress: "Principala 755, Magurele Prahova, Gornet",
        invoiceNumber: "0042600062736",
      }),
      doc(2, "invoice", {
        recipientName: "Cristina Ilinca",
        recipientAddress: "Principala 12, I. L. Caragiale, Dambovita",
        invoiceNumber: "0042600062455",
      }),
      doc(3, "invoice", {
        recipientName: "Cristina Pigul",
        recipientAddress: "Principala 211, Strejnicu, Prahova",
        invoiceNumber: "0042600062951",
      }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [2] }]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

describe("linkDocuments — regression: no AWB-less pair on retry (2026-06-25)", () => {
  // The operator re-ran AI pairing over a day's unpaired documents (POST
  // /pairs/retry-unpaired) and it built a "pair" out of 3 invoices with NO
  // AWB. A pair must NEVER form without a genuine courier label: documents
  // without an AWB stay in "documente fără pereche" for a human to pair.

  it("three same-buyer invoices, one mis-tagged with the Comandă as its AWB number, never pair", () => {
    // The phantom: the model decorated the first invoice with a report_awb and
    // copied the Comandă (480654) into awb_number. The Comandă is an
    // invoice-side number, so it is NOT an AWB identity — the photo is demoted
    // and all three surface as unpaired.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "480654",
        recipientName: "ACME CONSTRUCT SRL",
        invoiceNumber: "0072600012345",
        orderNumber: "480654",
        invoiceRaw: { buyer_name: "ACME CONSTRUCT SRL", order_number: "480654", invoice_total_gross: 500 },
      }),
      doc(1, "invoice", { recipientName: "ACME CONSTRUCT SRL", invoiceNumber: "0072600012346", orderNumber: "480655" }),
      doc(2, "invoice", { recipientName: "ACME CONSTRUCT SRL", invoiceNumber: "0072600012347", orderNumber: "480656" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("even a CONFIDENT full-length Comandă in awb_number is not an AWB identity", () => {
    // The Comandă can be 6+ digits and read cleanly; it is still voided because
    // it equals the invoice's own order number. No blank-AWB self-pair.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "480700", // confident, 6 digits — but it IS the Comandă
        recipientName: "GAMA SRL",
        orderNumber: "480700",
        invoiceRaw: { buyer_name: "GAMA SRL", order_number: "480700", invoice_total_gross: 900 },
      }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired).toEqual([0]);
  });

  it("a phantom label with only a short/unconfident number never anchors same-buyer invoices", () => {
    // A mis-tagged invoice whose 'AWB number' is a short, unconfident scrap
    // (not a real 9-digit waybill) cannot anchor its buyer-twin invoices.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        awbNumber: "12345",
        awbConfident: false,
        recipientName: "BETA DESIGN SRL",
        orderNumber: "771000",
        invoiceRaw: { buyer_name: "BETA DESIGN SRL", order_number: "771000", invoice_total_gross: 300 },
      }),
      doc(1, "invoice", { recipientName: "BETA DESIGN SRL", orderNumber: "771001" }),
      doc(2, "invoice", { recipientName: "BETA DESIGN SRL", orderNumber: "771002" }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("a REAL AWB still pairs all of one buyer's invoices (the fix doesn't over-correct)", () => {
    const { groups } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211500", recipientName: "GAMA INSTAL SRL" }),
      doc(1, "invoice", { recipientName: "GAMA INSTAL SRL", orderNumber: "900001" }),
      doc(2, "invoice", { recipientName: "GAMA INSTAL SRL", orderNumber: "900002" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1, 2] }]);
  });

  it("a real label with a blurry (unconfident) number still pairs by name", () => {
    // The label is a genuine waybill (type awb, NO invoice content) whose number
    // read came back unconfident. It is not a mis-tagged invoice, so it still
    // anchors and pairs with its same-name invoice — the gate only blocks
    // invoice-substance photos that lack courier proof, not blurry real labels.
    const { groups, unpaired } = linkDocuments([
      doc(0, "awb", { awbNumber: "007211480", awbConfident: false, recipientName: "DELTA PROIECT SRL" }),
      doc(1, "invoice", { recipientName: "DELTA PROIECT SRL", orderNumber: "812000" }),
    ]);
    expect(groups).toEqual([{ awbIndex: 0, invoiceIndices: [1] }]);
    expect(unpaired).toEqual([]);
  });

  it("LIVE case: a 'combined' invoice with a hallucinated Hub but NO AWB number never anchors (GPS/GFS AUTOMATION)", () => {
    // The exact production failure (pair 517df404): the model tagged a GFS
    // AUTOMATION invoice as 'combined' with hub_destination "Ploiesti Hub" and
    // NO awb_number, then two same-company invoices married it into a 3-invoice
    // AWB-less pair. A Hub the model invents on an invoice is NOT courier proof,
    // so the photo (it has invoice substance) is held out — all three unpair.
    const { groups, unpaired } = linkDocuments([
      doc(0, "combined", {
        recipientName: "GFS AUTOMATION TECHNOLOGIES S.R.L.",
        awbRaw: { hub_destination: "Ploiesti Hub" }, // hub but NO awb_number
        invoiceNumber: "0042600061730",
        orderNumber: "548130",
        invoiceRaw: {
          buyer_name: "GFS AUTOMATION TECHNOLOGIES S.R.L.",
          order_number: "548130",
          invoice_total_gross: 1200,
        },
      }),
      doc(1, "invoice", {
        recipientName: "GPS AUTOMATION TECHNOLOGIES SRL",
        invoiceNumber: "0042600061764",
        orderNumber: "548132",
      }),
      doc(2, "invoice", {
        recipientName: "GFS AUTOMATION TECHNOLOGIES S.R.L.",
        invoiceNumber: "0042600061790",
        orderNumber: "548135",
      }),
    ]);
    expect(groups).toEqual([]);
    expect(unpaired.slice().sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

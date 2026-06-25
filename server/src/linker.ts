/**
 * Deterministic document linking — replaces the grouping AI agent.
 *
 * The old design asked one model call to look at MANY images at once and
 * split them into shipments. That breaks exactly where it matters: a big
 * stack overflows the model's attention (an 83-image call reproducibly
 * dropped the tail), and duplicate re-shoots spawned phantom pairs unless
 * the model spent minutes of thinking. Filename-based chunking was the
 * workaround, and filenames cannot be trusted.
 *
 * New design: the AI reads ONE image per call (classify.ts) — a task it
 * never fails from volume — and THIS module links the readings into
 * shipment groups with plain, auditable code. The join keys are printed
 * on the paper itself (verified against the real documents):
 *
 *   1. AWB number — the anchor's identity. Two photos reading the same
 *      number are the same shipment, always. A partial read ("…0900",
 *      label flipped) folds into the full number it suffixes.
 *   2. Recipient name — the AWB's "Destinatar" equals the invoice's
 *      "Cumparator", modulo duplicated/reordered tokens, so matching is
 *      by shared name tokens, not exact strings.
 *   3. Recipient address — confirms when the invoice carries it
 *      ("Sediul"); often N/A, so it is a secondary signal.
 *
 * There is NO positional pairing (by command): a document that matches
 * no anchor by name or address is never guessed onto the nearest photo —
 * it surfaces in the app as an UNPAIRED item for the day, and a human
 * pairs it. Scan adjacency is used ONLY to dedupe re-shoots of the same
 * physical label, never to join two different documents.
 *
 * NOTE: the courier label's "Continut" field looked like a join key but
 * is NOT one — on current labels it is an internal load code
 * (L07-26-xxxxx), unrelated to the invoice's Comandă. Checked on paper
 * 2026-06-12; do not "fix" the linker to use it.
 *
 * Everything here is pure and synchronous — no AI, no IO — so the whole
 * linking policy is unit-testable.
 */

import { norm } from "./mapbox.js";

export type DocType = "awb" | "invoice" | "combined" | "unknown";

/** One image's reading, produced by classify.ts. All fields may be null —
 *  the linker must survive any subset being unreadable. */
export interface DocInfo {
  /** 0-based position in the uploaded stack (scan order). */
  index: number;
  type: DocType;
  awbNumber: string | null;
  /** True only when the classifier saw the digits upright, sharp and whole.
   *  Rotated/blurred labels produce plausible-but-WRONG digit strings
   *  (observed live: an upside-down label read as another shipment's real
   *  AWB), so an unconfident number is never treated as proof of identity. */
  awbConfident: boolean;
  /** Stray courier labels from OTHER documents caught in the frame (the
   *  pile beneath, a sheet peeking in at the edge). Never anchor identity —
   *  recorded for diagnostics only. */
  extraAwbNumbers: string[];
  recipientName: string | null;
  recipientAddress: string | null;
  invoiceNumber: string | null;
  orderNumber: string | null;
  /** The raw report_awb arguments (the full waybill fields) — assembled
   *  into the pair's data by pipeline.assembleExtracted. */
  awbRaw: Record<string, unknown> | null;
  /** The raw report_invoice arguments (the full invoice fields). */
  invoiceRaw: Record<string, unknown> | null;
}

/** One shipment, expressed as 0-based indices into the uploaded stack.
 *  Shape is unchanged from the old grouping module so the extraction
 *  pipeline downstream needs no edits. */
export interface DocumentGroup {
  awbIndex: number | null;
  invoiceIndices: number[];
}

export interface DroppedAnchor {
  /** Image omitted as a duplicate shot of a kept anchor. */
  index: number;
  ofIndex: number;
  reason: string;
}

export interface LinkResult {
  /** Only VALID pairs: every group has an AWB anchor and ≥1 invoice
   *  image. Nothing else ever reaches the app. */
  groups: DocumentGroup[];
  droppedAnchors: DroppedAnchor[];
  /** Images that identify NOTHING — no invoice content, no recipient
   *  name, no confident AWB number (stray pile sheets, hopeless blurs).
   *  They never become pairs; the app must not show junk. */
  droppedJunk: number[];
  /** Real documents the system could not pair by name or address (a
   *  label whose invoice never matched, an invoice naming nobody we
   *  know, an unreadable photo). By command these are NOT guessed onto
   *  a neighbour — they surface in the app as UNPAIRED items for the
   *  day so a human pairs them. */
  unpaired: number[];
}

/** Two readings of the same recipient share at least this fraction of the
 *  shorter name's tokens. 0.6 lets "Hudea George" match
 *  "Hudea George vasile" while rejecting single-common-token noise. */
const NAME_MATCH = 0.6;
/** Two STREET NAMES count as the same street at this token overlap
 *  (containment-based, so "Stere" ⊂ "Constantin Stere" still scores 1).
 *  Replaces the old whole-address bag-of-tokens overlap, which matched any
 *  two deliveries to the same town on "str" + the town name alone. */
const STREET_MATCH = 0.6;
/** How far apart (in scan positions) two photos can be and still count as
 *  re-shoots of the same document when the number alone can't prove it. */
const DUPLICATE_WINDOW = 4;
/** Digit-string lengths: below MIN_PARTIAL the read is noise; within
 *  [FULL_MIN, FULL_MAX] the number is shaped like a complete AWB (real
 *  AWBs are 9 digits); ABOVE FULL_MAX it is something else entirely —
 *  invoice header numbers are 13 digits and must never act as an AWB. */
const MIN_PARTIAL_DIGITS = 4;
const FULL_MIN_DIGITS = 6;
const FULL_MAX_DIGITS = 10;

/** Loose-comparison token set of a name/address: normalised, split on
 *  non-alphanumerics, short fragments dropped, duplicates collapsed. */
export function tokenSet(s: string | null): Set<string> {
  if (!s) return new Set();
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** Tokens that carry NO identity in a recipient name: legal-form suffixes
 *  and the supplier/courier words the classifier sometimes mistakes for
 *  the buyer ("Leroy Merlin Romania", carrier names). Without this,
 *  "HOME SRL" fails to match "AVANGARDE HOME SRL" (srl dilutes the
 *  overlap) and two garbage "Leroy Merlin" reads would match each other. */
const NAME_STOPWORDS = new Set(["srl", "sa", "pfa", "ii", "leroy", "merlin", "romania"]);

/** Token set for RECIPIENT NAMES specifically: also drops pure-digit
 *  tokens (a CNP of zeros is not a name) and identity-free stopwords.
 *  Addresses keep using the plain tokenSet — their numbers matter. */
export function nameTokenSet(s: string | null): Set<string> {
  const out = new Set<string>();
  for (const t of tokenSet(s)) {
    if (/^\d+$/.test(t)) continue;
    if (NAME_STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** |A ∩ B| / min(|A|,|B|) — 1.0 when the shorter set is contained in the
 *  longer one ("CRISTIAN CIUREA" ⊂ "CIUREA CRISTIAN CRISTIAN CIUREA"). */
export function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Address words that carry NO place identity: street-type prefixes,
 *  address-part labels and administrative-unit labels. Romanian addresses
 *  are dense with these, and every delivery to a given town shares them — so
 *  the OLD whole-address overlap matched strangers on "str" + the town name
 *  (live: PETRE MATEOIU's invoice glued onto Aurel Vasile's AWB, both in
 *  Bucov). They are dropped before any street comparison. */
const ADDRESS_STOPWORDS = new Set([
  "str", "strada", "stradela", "bd", "bdul", "blvd", "bulevard", "bulevardul",
  "sos", "soseaua", "sosea", "cal", "calea", "ale", "aleea", "drum", "drumul",
  "int", "intrarea", "pta", "piata", "splai", "splaiul", "fundatura", "prelungirea",
  "nr", "no", "numarul", "bl", "blocul", "sc", "scara", "ap", "apartament",
  "apartamentul", "et", "etaj", "etajul", "parter", "demisol", "mansarda",
  "casa", "vila", "corp", "tronson", "km",
  "jud", "judetul", "judet", "com", "comuna", "sat", "satul", "oras", "orasul",
  "mun", "municipiul", "loc", "localitatea", "sector", "sectorul", "cartier",
  "ro", "romania",
]);

/** Romanian county names (normalised, multi-word counties split into tokens).
 *  An AWB and its invoice are in the SAME locality by construction, so the
 *  county is shared by every same-town pair and proves nothing — dropping it
 *  stops it being the lone "matching" street token. (parseAddress also drops
 *  everything printed AFTER the house number, where town + county sit, so
 *  this is a second safety net for oddly-ordered addresses.) */
const ADDRESS_LOCALITY = new Set([
  "alba", "arad", "arges", "bacau", "bihor", "bistrita", "nasaud", "botosani",
  "braila", "brasov", "buzau", "calarasi", "caras", "severin", "cluj", "constanta",
  "covasna", "dambovita", "dolj", "galati", "giurgiu", "gorj", "harghita",
  "hunedoara", "ialomita", "iasi", "ilfov", "maramures", "mehedinti", "mures",
  "neamt", "olt", "prahova", "salaj", "sibiu", "suceava", "teleorman", "timis",
  "tulcea", "valcea", "vaslui", "vrancea", "bucuresti",
]);

/** Split an address into its IDENTIFYING parts — the street-name tokens and
 *  the house number. Romanian addresses read
 *  "[street-type] <name…> [nr] <number> , <town> , <county> <postal>", so the
 *  street name is the run of meaningful words BEFORE the first house number,
 *  and the town/county/postal that trail the number are dropped (shared by
 *  every same-town pair). A 5–6 digit postal code is never a house number.
 *  Returns an empty street set when nothing identifiable is present. */
export function parseAddress(s: string | null): { street: Set<string>; number: string | null } {
  const raw = norm(s ?? "").split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  let number: string | null = null;
  let numberPos = raw.length;
  for (let i = 0; i < raw.length; i++) {
    // House numbers are 1-4 digits with an OPTIONAL trailing letter ("687a",
    // "12b") — Romanian addresses use these constantly. Without the letter,
    // "687a" was read as no-number-at-all, which collapsed the whole address
    // to a bare street name and false-matched any same-street delivery (live:
    // AWB 004205970 on "Str. Principala 687a" glued on invoices from Gornet
    // and Strejnicu, also on a "Principala"). A 5-6 digit postal code is still
    // never a house number.
    if (/^\d{1,4}[a-z]?$/.test(raw[i]!)) {
      number = raw[i]!;
      numberPos = i;
      break;
    }
  }
  const street = new Set<string>();
  for (const t of raw.slice(0, numberPos)) {
    if (t.length < 2) continue;
    if (/^\d+$/.test(t)) continue;
    if (ADDRESS_STOPWORDS.has(t)) continue;
    if (ADDRESS_LOCALITY.has(t)) continue;
    street.add(t);
  }
  return { street, number };
}

/** Same physical address? Two addresses match ONLY when their street names
 *  agree AND their house numbers do not contradict — the operator's rule
 *  ("the address must be the SAME, not a word-by-word overlap"). Different
 *  streets never match; the same street with two different numbers never
 *  matches; the same street with a number missing on one side matches only
 *  on a COMPLETE street-name agreement (OCR sometimes drops the number). */
export function sameAddress(a: string | null, b: string | null): boolean {
  const pa = parseAddress(a);
  const pb = parseAddress(b);
  if (pa.street.size === 0 || pb.street.size === 0) return false;
  // Require a real house number on BOTH sides, and require them to be EQUAL.
  // A landmark blob with no parseable number (e.g. "Vizavi Monument …") must
  // never bind by a shared street name alone — street names like "Principala"
  // are shared by every delivery in a village, so the old "one number missing
  // → a complete street match is enough" branch glued strangers together
  // (live: AWB 004205970). No number on a side → fall through to the human
  // (unpaired), which the operator prefers over a wrong pair. (Rule 2026-06-24.)
  if (pa.number === null || pb.number === null) return false;
  if (overlapScore(pa.street, pb.street) < STREET_MATCH) return false;
  return pa.number === pb.number;
}

/** Usable digits of a doc's AWB read, or null when the read is noise:
 *  too short, longer than any real AWB (a leaked invoice-header number),
 *  or equal to one of the doc's own invoice-side numbers (the 13-digit header
 *  OR the Comandă) — header/Comandă contamination. The model copies an
 *  invoice number into awb_number on an invoice it mis-tagged as a label, and
 *  that number must never pass for an AWB identity (else a plain invoice
 *  anchors an AWB-less pair). */
function awbDigits(d: Pick<DocInfo, "awbNumber" | "invoiceNumber" | "orderNumber">): string | null {
  const n = (d.awbNumber ?? "").replace(/\D/g, "");
  if (n.length < MIN_PARTIAL_DIGITS || n.length > FULL_MAX_DIGITS) return null;
  const inv = (d.invoiceNumber ?? "").replace(/\D/g, "");
  if (inv.length > 0 && (n === inv || inv.endsWith(n))) return null;
  // The Comandă (order) number is an invoice-side number too: when the model
  // drops it into awb_number on a mis-tagged invoice it must NOT count as an
  // AWB identity. (Operator rule 2026-06-25.)
  const ord = (d.orderNumber ?? "").replace(/\D/g, "");
  if (ord.length > 0 && n === ord) return null;
  return n;
}

function nameScore(a: DocInfo, b: DocInfo): number {
  return overlapScore(nameTokenSet(a.recipientName), nameTokenSet(b.recipientName));
}

/**
 * Does a combined photo's AWB half show a REAL courier label? Invoices
 * and avize print "Standard", km and content codes too, so the model
 * sometimes decorates a plain invoice photo with a phantom report_awb —
 * no digits, no recipient printed ON THE LABEL (the doc's recipientName
 * then comes from the invoice buyer fallback, which proves nothing).
 * Live case: Roxana Petre's invoice stack anchored a 5-image pair with
 * NO AWB anywhere. A label is real only if it shows usable AWB digits
 * or its own printed recipient/phone/address/hub.
 */
function awbSubstance(d: DocInfo): boolean {
  // A REAL courier label proves itself with a COURIER-ONLY signal: a usable
  // AWB number, or the destination "Hub" line. Recipient name / address /
  // phone are NOT proof — they are printed on invoices too, and the model
  // copies the invoice buyer into a phantom report_awb on a plain invoice
  // (live blank-AWB "pairs": VIRGILIU NICOLESCU, GPS AUTOMATION, Persoana
  // Fizica — invoices with no real label). Requiring a courier-only signal
  // sends a label-less invoice to the unpaired strip instead of letting it
  // anchor a pair with no AWB, which is exactly the operator's rule
  // ("daca nu au awb sa le lase la documente fara pereche", 2026-06-24).
  if (awbDigits(d) !== null) return true;
  const r = (d.awbRaw ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return text(r.hub_destination) !== "";
}

/**
 * Does this photo carry proof it is a real waybill label? The ONLY trustworthy
 * proof is a CONFIDENT, full-length AWB number (≥ FULL_MIN_DIGITS) that is not
 * one of the invoice's own numbers (13-digit header or Comandă — see awbDigits).
 *
 * `hub_destination` is deliberately NOT accepted: it looked courier-only, but
 * the vision model fabricates it on plain invoices (live 2026-06-25: a GFS
 * AUTOMATION invoice tagged "combined" with hub_destination "Ploiesti Hub" and
 * NO awb_number anchored an AWB-less pair of three same-company invoices). A
 * field the model can invent on an invoice cannot be the thing that proves the
 * photo is a label.
 *
 * This is the proof that lets a photo with invoice substance (a real label
 * clipped onto its invoice) still anchor its pair. It is stricter than the raw
 * digit read — a short partial or an unconfident scrap is NOT proof (those are
 * how a mis-tagged invoice sneaks in) — and it runs AFTER the anchor dedup,
 * where every genuine re-shoot ("0900", "0072") has already folded into its
 * full anchor.
 */
function hasCourierProof(d: DocInfo): boolean {
  const n = awbDigits(d);
  return n !== null && n.length >= FULL_MIN_DIGITS && d.awbConfident;
}

/**
 * Does a combined photo's invoice half show a REAL invoice? Labels are
 * photographed lying ON the document pile, so a SLIVER of whatever sheet
 * is underneath (an item row peeking out below the label) gets reported
 * as report_invoice too — but a sliver with no invoice number, no
 * comandă, no buyer and no totals identifies NO invoice (live case: AWB
 * 007211168 self-paired on a one-row sliver). Such a photo is a plain
 * label and must wait for its real invoice, never marry itself.
 */
function invoiceSubstance(d: DocInfo): boolean {
  const r = (d.invoiceRaw ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const inv = (d.invoiceNumber ?? text(r.invoice_number)).replace(/\D/g, "");
  if (inv.length >= 6) return true;
  const ord = (d.orderNumber ?? text(r.order_number)).replace(/\D/g, "");
  if (ord.length >= 4) return true;
  // NOTE: a buyer block alone (Cumparator name/CIF) is NOT substance —
  // the model reads it off the invoice peeking from BEHIND the label
  // (live case: AWB 007211755 self-paired on a bare Cumparator block,
  // masking its real, separately-photographed invoices). A usable
  // invoice needs billable evidence: a number, a comandă, or totals.
  for (const k of ["invoice_total_gross", "invoice_total_net", "invoice_total_vat"]) {
    const v = r[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return true;
  }
  return false;
}

/**
 * Link a stack of per-image readings into shipment groups.
 *
 * Anchors (awb/combined photos) are deduplicated first — same full number,
 * partial-suffix + name/adjacency, or no-number + name + adjacency all
 * mean "the same physical label photographed again". Of a duplicate set
 * the photo with the LONGEST number read survives as the anchor (best
 * identity); a dropped duplicate that was a combined photo is kept as an
 * extra INVOICE image for its shipment (its invoice side may be the only
 * view of that page), while a dropped label-only photo is omitted.
 *
 * Invoices (and unreadable photos) then each pick an anchor:
 *   tier 1 — name-token match, nearest in scan order;
 *   tier 2 — SAME street + house number match (sameAddress), nearest in
 *            scan order. Not a word overlap: a stranger's invoice in the
 *            same town no longer binds on "str" + the town name alone.
 *
 * There is no tier 3 (by command): a photo matching no anchor by name
 * or address is never guessed onto the nearest one — it goes to
 * `unpaired` and the app shows it for a human to resolve.
 *
 * A combined photo with its own AWB identity forms a complete pair on
 * its own (the self-pair convention the extractor already understands).
 */
export function linkDocuments(docs: DocInfo[]): LinkResult {
  // Normalize FIRST: an awb/combined photo whose AWB half carries no
  // courier-only signal (no usable AWB number, no destination Hub) is NOT a
  // real label — it is an invoice the model decorated with a phantom
  // report_awb (avize and invoice headers print Standard/km/codes too, and
  // the model copies the buyer into recipient_name). Letting it act as an
  // anchor builds a pair with NO AWB in it, so it is demoted to a plain
  // invoice before any anchoring happens. It then binds to its real shipment
  // by name/address, or surfaces as unpaired for a human — never a blank-AWB
  // pair. (Covers BOTH "combined" and "awb" mis-reads; rule 2026-06-24.)
  docs = docs.map((d) =>
    (d.type === "combined" || d.type === "awb") && !awbSubstance(d)
      ? { ...d, type: "invoice" }
      : d,
  );

  const anchorsIn = docs
    .filter((d) => d.type === "awb" || d.type === "combined")
    .sort((a, b) => a.index - b.index);

  // ── Anchor dedup ────────────────────────────────────────────────────
  const kept: DocInfo[] = [];
  const droppedAnchors: DroppedAnchor[] = [];
  /** dup combined photos to force-attach as invoices: keptIndex → images */
  const extraInvoices = new Map<number, number[]>();

  for (const a of anchorsIn) {
    const aNum = awbDigits(a);
    const aFull = aNum !== null && aNum.length >= FULL_MIN_DIGITS ? aNum : null;
    const aStrong = aFull !== null && a.awbConfident;

    // Compare against kept anchors, nearest in scan order first.
    const byDistance = [...kept].sort(
      (x, y) => Math.abs(x.index - a.index) - Math.abs(y.index - a.index),
    );
    let dupOf: DocInfo | null = null;
    let reason = "";
    for (const b of byDistance) {
      const bNum = awbDigits(b);
      const bFull = bNum !== null && bNum.length >= FULL_MIN_DIGITS ? bNum : null;
      const bStrong = bFull !== null && b.awbConfident;
      const near = Math.abs(a.index - b.index) <= DUPLICATE_WINDOW;
      const names = nameScore(a, b) >= NAME_MATCH;

      if (aStrong && bStrong) {
        // Two CONFIDENT complete identities: equal → the same physical
        // label, merge at any distance; different → provably distinct, no
        // softer signal may override two clear reads.
        if (aFull === bFull) {
          dupOf = b;
          reason = `same AWB number ${aFull}`;
          break;
        }
        continue;
      }
      // At least one side is a weak read (rotated/blurred labels produce
      // plausible-but-wrong digits — observed live), so digits alone prove
      // nothing here; identity falls back to softer signals.
      if (aFull !== null && aFull === bFull && (names || near)) {
        dupOf = b;
        reason = `same AWB number ${aFull} (weak read)`;
        break;
      }
      if (names && near) {
        dupOf = b;
        reason = "same recipient nearby";
        break;
      }
      if (near && aNum !== null && bFull !== null && bFull.includes(aNum)) {
        dupOf = b;
        reason = `partial "${aNum}" within ${bFull}`;
        break;
      }
      if (near && bNum !== null && aFull !== null && aFull.includes(bNum)) {
        dupOf = b;
        reason = `partial "${bNum}" within ${aFull}`;
        break;
      }
    }

    if (dupOf === null) {
      kept.push(a);
      continue;
    }

    // Of the duplicate pair the better identity wins the anchor role:
    // confident read first, then the longer digit string.
    const dupNum = awbDigits(dupOf) ?? "";
    const dupStrong = dupNum.length >= FULL_MIN_DIGITS && dupOf.awbConfident;
    let winner = dupOf;
    let loser = a;
    if (aStrong && !dupStrong ? true : aStrong === dupStrong && (aNum ?? "").length > dupNum.length) {
      kept[kept.indexOf(dupOf)] = a;
      // Re-home any extras already attached to the replaced anchor.
      const moved = extraInvoices.get(dupOf.index);
      if (moved) {
        extraInvoices.delete(dupOf.index);
        extraInvoices.set(a.index, moved);
      }
      winner = a;
      loser = dupOf;
    }
    droppedAnchors.push({ index: loser.index, ofIndex: winner.index, reason });
    // A combined duplicate still SHOWS the invoice page — keep that view.
    if (loser.type === "combined") {
      const list = extraInvoices.get(winner.index) ?? [];
      list.push(loser.index);
      extraInvoices.set(winner.index, list);
    }
  }

  // Dedup survivors, in scan order. Re-shoots and partial reads have already
  // folded into their full anchor above. A survivor may anchor a pair UNLESS it
  // is a PHANTOM: a photo carrying invoice substance (it really IS an invoice)
  // with no courier-only proof (no confident full AWB number, no Hub). That is
  // exactly an invoice the model mis-tagged as a label — it is held OUT of the
  // anchor pool, so no invoice attaches to it and it can never form an AWB-less
  // pair; Pass A routes it as an invoice (binds by name) or surfaces it as
  // unpaired. A GENUINE label — even one whose number is blurry — has no
  // invoice substance, so it still anchors and pairs by name. (Operator rule
  // 2026-06-25: "dacă nu au AWB, nu le împerechea — lasă-le fără pereche.")
  const survivors = [...kept].sort((a, b) => a.index - b.index);
  const anchors = survivors.filter((d) => hasCourierProof(d) || !invoiceSubstance(d));

  // ── Invoice assignment ──────────────────────────────────────────────
  const items = docs
    .filter((d) => d.type === "invoice" || d.type === "unknown")
    .sort((a, b) => a.index - b.index);
  const assigned = new Map<number, number[]>(); // anchor index → invoice images
  for (const a of anchors) assigned.set(a.index, [...(extraInvoices.get(a.index) ?? [])]);

  /** Items no anchor claimed by name/address — they get one exact
   *  invoice-key fold chance below, then surface as unpaired. */
  const unassignedItems: DocInfo[] = [];

  for (const item of items) {
    if (anchors.length === 0) {
      unassignedItems.push(item);
      continue;
    }

    const itemNames = nameTokenSet(item.recipientName);
    const pick = (pool: DocInfo[]): DocInfo =>
      pool.reduce((best, c) => {
        const db = Math.abs(best.index - item.index);
        const dc = Math.abs(c.index - item.index);
        if (dc !== db) return dc < db ? c : best;
        // Equal distance: prefer the anchor BEFORE the invoice.
        return c.index < item.index ? c : best;
      });

    // Name/address matches are searched BATCH-WIDE — no scan-distance
    // window. A distinctive full-name match (or a same street + house
    // number address match) identifies the shipment no matter how far apart
    // the AWB and its invoice landed in the upload order. When more than one
    // anchor matches, the NEAREST in scan order wins (see pick()), so two
    // same-name shipments in one batch still split by adjacency.
    const tier1 = anchors.filter(
      (a) => overlapScore(itemNames, nameTokenSet(a.recipientName)) >= NAME_MATCH,
    );
    // Address tier: bind ONLY to an anchor at the SAME street + house number
    // (sameAddress). The old whole-address token overlap matched any two
    // deliveries to the same town on "str" + the town name alone, gluing a
    // stranger's invoice onto a shipment — now a different street or a
    // different house number never binds; the invoice goes to `unpaired`.
    let tier2: DocInfo[] = [];
    if (tier1.length === 0) {
      tier2 = anchors.filter((a) => sameAddress(item.recipientAddress, a.recipientAddress));
    }
    // NO tier 3: a photo neither tier claims is never position-guessed
    // onto the nearest anchor — the human pairs it from the app instead.
    const pool = tier1.length > 0 ? tier1 : tier2;
    if (pool.length === 0) {
      unassignedItems.push(item);
      continue;
    }
    assigned.get(pick(pool).index)!.push(item.index);
  }

  // ── Assemble groups in scan order — ONLY valid pairs survive ────────
  const docByIndex = new Map(docs.map((d) => [d.index, d]));
  /** Invoice identity keys: the printed invoice number and/or comandă.
   *  Two readings sharing a key are the SAME invoice — the operator's
   *  rule: "any invoice or AWB which is the exact same, we dedupe". */
  const invoiceKeysOf = (d: DocInfo | undefined): string[] => {
    if (!d) return [];
    const keys: string[] = [];
    const inv = (d.invoiceNumber ?? "").replace(/\D/g, "");
    if (inv.length >= 6) keys.push(`i${inv}`);
    const ord = (d.orderNumber ?? "").replace(/\D/g, "");
    if (ord.length >= 4) keys.push(`o${ord}`);
    return keys;
  };

  const groups: DocumentGroup[] = [];
  const droppedJunk: number[] = [];
  const unpaired: number[] = [];
  const keyToGroup = new Map<string, DocumentGroup>();
  const groupOfAnchor = new Map<number, DocumentGroup>();
  const registerGroup = (g: DocumentGroup) => {
    groups.push(g);
    if (g.awbIndex !== null) groupOfAnchor.set(g.awbIndex, g);
    for (const i of [g.awbIndex!, ...g.invoiceIndices])
      for (const k of invoiceKeysOf(docByIndex.get(i))) if (!keyToGroup.has(k)) keyToGroup.set(k, g);
  };

  // Safety net: a combined re-shoot that folded onto a survivor which then
  // turned out NOT to be a real label (two mis-tagged invoice photos that
  // deduped onto each other) would lose its image — surface it as unpaired so
  // no document is ever hidden. Empty in the common case (real anchors win
  // dedups), so this only fires on that rare phantom-on-phantom fold.
  for (const s of survivors) {
    if (anchors.includes(s)) continue;
    for (const extra of extraInvoices.get(s.index) ?? []) unpaired.push(extra);
  }

  // Pass A — sort the lone anchors by what they actually are:
  //   • combined with a real AWB identity → a complete pair in one photo;
  //   • a real label (name or confident number) with no invoice YET →
  //     pending: an invoice-bearing photo may still marry it below;
  //   • invoice content without AWB identity → it IS an invoice the model
  //     mistook for a label — goes to the rescue/demotion passes;
  //   • identifies nothing → junk.
  const pendingLabels: DocInfo[] = [];
  const rescuable: DocInfo[] = [];
  for (const a of survivors) {
    // Only real labels are in `anchors`, so only they ever have invoices
    // assigned — a phantom survivor has none and falls through to the
    // invoice/unpaired/junk routing below.
    const invoices = [...new Set(assigned.get(a.index) ?? [])].sort((x, y) => x - y);
    if (invoices.length > 0) {
      registerGroup({ awbIndex: a.index, invoiceIndices: invoices });
      continue;
    }
    // A combined photo may self-pair ONLY when it carries courier proof. A
    // mis-tagged invoice with a buyer name (but no real AWB number/Hub) must
    // NOT marry itself into a blank-AWB pair — it falls through to the invoice
    // (rescue/unpaired) routing instead.
    if (a.type === "combined" && hasCourierProof(a)) {
      if (!invoiceSubstance(a)) {
        // The "invoice" is a sliver peeking from under the label — this
        // photo IS a label. It waits for a real invoice photo (married
        // by name below) like any other lone label, or goes unpaired.
        pendingLabels.push(a);
        continue;
      }
      // Its invoice may be a SECOND PHOTO of an invoice already inside a
      // pair (the recurring stray-sheet label makes such photos look like
      // their own shipment) — same invoice number/comandă proves it.
      const dupOf = invoiceKeysOf(a)
        .map((k) => keyToGroup.get(k))
        .find((x): x is DocumentGroup => x !== undefined);
      if (dupOf) {
        if (!dupOf.invoiceIndices.includes(a.index)) dupOf.invoiceIndices.push(a.index);
        droppedAnchors.push({
          index: a.index,
          ofIndex: dupOf.awbIndex ?? dupOf.invoiceIndices[0]!,
          reason: "same invoice content — folded into its pair",
        });
      } else {
        registerGroup({ awbIndex: a.index, invoiceIndices: [a.index] });
      }
    } else if (a.invoiceRaw !== null || invoiceKeysOf(a).length > 0) {
      rescuable.push(a);
    } else if (hasCourierProof(a) || nameTokenSet(a.recipientName).size > 0) {
      // A genuine label awaiting its invoice (courier proof) or a label-typed
      // photo with a readable recipient: it waits to marry its invoice by name
      // below, or surfaces as unpaired — never anchors a blank-AWB pair.
      pendingLabels.push(a);
    } else {
      droppedJunk.push(a.index);
    }
  }

  // Pass B — exact rescue: an orphan whose invoice number/comandă matches
  // an invoice already inside a pair is a SECOND PHOTO of that invoice —
  // fold the image into its pair (the operator's rule: exact same
  // invoice → dedupe). Unclaimed assignment items get the same chance —
  // a second photo of an already-paired invoice may carry no name at all.
  const unrescued: DocInfo[] = [];
  for (const p of [...rescuable, ...unassignedItems]) {
    const g = invoiceKeysOf(p)
      .map((k) => keyToGroup.get(k))
      .find((x): x is DocumentGroup => x !== undefined);
    if (g) {
      if (!g.invoiceIndices.includes(p.index)) g.invoiceIndices.push(p.index);
      droppedAnchors.push({
        index: p.index,
        ofIndex: g.awbIndex ?? g.invoiceIndices[0]!,
        reason: "same invoice content — folded into its pair",
      });
    } else {
      unrescued.push(p);
    }
  }

  // Pass C — demotion by NAME ONLY: what's left is an INVOICE photo.
  // Give it one more binding chance, against existing groups AND the
  // pending lone labels (marrying a label completes a pair) — but only
  // when its name matches. There is NO adjacency binding (by command):
  // a nameless, addressless photo goes to the app as unpaired rather
  // than being guessed into a neighbour's shipment.
  const marriedLabels = new Set<number>();
  for (const p of unrescued) {
    const pNames = nameTokenSet(p.recipientName);
    if (pNames.size === 0) {
      unpaired.push(p.index);
      continue;
    }
    const candidates = [...groupOfAnchor.keys(), ...pendingLabels.map((l) => l.index)]
      .map((i) => docByIndex.get(i)!)
      .filter((a) => overlapScore(pNames, nameTokenSet(a.recipientName)) >= NAME_MATCH)
      .sort((x, y) => {
        const d = Math.abs(x.index - p.index) - Math.abs(y.index - p.index);
        if (d !== 0) return d;
        // Equal distance: the EMPTY label wins over an anchor that
        // already has invoices — completing a pair beats padding one.
        return Number(groupOfAnchor.has(x.index)) - Number(groupOfAnchor.has(y.index));
      });
    const target = candidates[0];
    if (!target) {
      unpaired.push(p.index);
      continue;
    }
    const existing = groupOfAnchor.get(target.index);
    if (existing) {
      if (!existing.invoiceIndices.includes(p.index)) existing.invoiceIndices.push(p.index);
    } else {
      registerGroup({ awbIndex: target.index, invoiceIndices: [p.index] });
      marriedLabels.add(target.index);
    }
  }

  // Pass D — pending labels that never got an invoice cannot form a
  // valid pair → unpaired (shown in the app for a human to resolve).
  for (const l of pendingLabels) {
    if (!marriedLabels.has(l.index)) unpaired.push(l.index);
  }

  for (const g of groups) g.invoiceIndices.sort((x, y) => x - y);
  groups.sort(
    (a, b) =>
      Math.min(a.awbIndex ?? Infinity, ...a.invoiceIndices) -
      Math.min(b.awbIndex ?? Infinity, ...b.invoiceIndices),
  );

  unpaired.sort((a, b) => a - b);
  return { groups, droppedAnchors, droppedJunk, unpaired };
}

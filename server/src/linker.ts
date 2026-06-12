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
 *   4. Scan adjacency — one shipment's photos are taken together, so the
 *      nearest anchor in scan order breaks every remaining tie (and is
 *      the sole signal for unreadable images).
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
  groups: DocumentGroup[];
  droppedAnchors: DroppedAnchor[];
}

/** Two readings of the same recipient share at least this fraction of the
 *  shorter name's tokens. 0.6 lets "Hudea George" match
 *  "Hudea George vasile" while rejecting single-common-token noise. */
const NAME_MATCH = 0.6;
/** Address token overlap that counts as confirmation. */
const ADDRESS_MATCH = 0.5;
/** How far apart (in scan positions) two photos can be and still count as
 *  re-shoots of the same document when the number alone can't prove it. */
const DUPLICATE_WINDOW = 4;
/** How far (in scan positions) an invoice may look for a name/address
 *  match. A shipment's photos are taken together at one stop, so a match
 *  farther than this is a misread, not a discovery. */
const ASSIGN_WINDOW = 6;
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

/** |A ∩ B| / min(|A|,|B|) — 1.0 when the shorter set is contained in the
 *  longer one ("CRISTIAN CIUREA" ⊂ "CIUREA CRISTIAN CRISTIAN CIUREA"). */
export function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Usable digits of a doc's AWB read, or null when the read is noise:
 *  too short, longer than any real AWB (a leaked invoice-header number),
 *  or equal to the doc's own invoice number (header contamination). */
function awbDigits(d: Pick<DocInfo, "awbNumber" | "invoiceNumber">): string | null {
  const n = (d.awbNumber ?? "").replace(/\D/g, "");
  if (n.length < MIN_PARTIAL_DIGITS || n.length > FULL_MAX_DIGITS) return null;
  const inv = (d.invoiceNumber ?? "").replace(/\D/g, "");
  if (inv.length > 0 && (n === inv || inv.endsWith(n))) return null;
  return n;
}

function nameScore(a: DocInfo, b: DocInfo): number {
  return overlapScore(tokenSet(a.recipientName), tokenSet(b.recipientName));
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
 *   tier 2 — address-token match, nearest in scan order;
 *   tier 3 — nearest anchor in scan order (ties prefer the preceding
 *            anchor, mirroring the old "invoices ride with their adjacent
 *            AWB" rule).
 *
 * An anchor that ends up with no invoice image reuses itself (the
 * combined-photo convention the extractor already understands). With no
 * anchors at all, each contiguous run of invoices becomes an awb-less
 * group, which downstream records as a visible "incomplete" pair.
 */
export function linkDocuments(docs: DocInfo[]): LinkResult {
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

  const anchors = [...kept].sort((a, b) => a.index - b.index);

  // ── Invoice assignment ──────────────────────────────────────────────
  const items = docs
    .filter((d) => d.type === "invoice" || d.type === "unknown")
    .sort((a, b) => a.index - b.index);
  const assigned = new Map<number, number[]>(); // anchor index → invoice images
  for (const a of anchors) assigned.set(a.index, [...(extraInvoices.get(a.index) ?? [])]);

  const orphanRuns: number[][] = [];
  let orphanRun: number[] = [];

  for (const item of items) {
    if (anchors.length === 0) {
      // No anchors anywhere: contiguous invoices form awb-less groups.
      if (orphanRun.length > 0 && item.index !== orphanRun[orphanRun.length - 1]! + 1) {
        orphanRuns.push(orphanRun);
        orphanRun = [];
      }
      orphanRun.push(item.index);
      continue;
    }

    const itemNames = tokenSet(item.recipientName);
    const itemAddr = tokenSet(item.recipientAddress);
    const pick = (pool: DocInfo[]): DocInfo =>
      pool.reduce((best, c) => {
        const db = Math.abs(best.index - item.index);
        const dc = Math.abs(c.index - item.index);
        if (dc !== db) return dc < db ? c : best;
        // Equal distance: prefer the anchor BEFORE the invoice.
        return c.index < item.index ? c : best;
      });

    // A shipment's photos are taken together at one stop, so name/address
    // matches only count among NEARBY anchors — a "match" across half the
    // stack is a misread capturing someone else's invoice, not a discovery.
    const nearAnchors = anchors.filter((a) => Math.abs(a.index - item.index) <= ASSIGN_WINDOW);
    const tier1 = nearAnchors.filter(
      (a) => overlapScore(itemNames, tokenSet(a.recipientName)) >= NAME_MATCH,
    );
    // Addresses share boilerplate tokens ("str", the town), so within the
    // address tier the HIGHEST overlap wins and distance only breaks ties.
    let tier2: DocInfo[] = [];
    if (tier1.length === 0) {
      const scored = nearAnchors
        .map((a) => ({ a, s: overlapScore(itemAddr, tokenSet(a.recipientAddress)) }))
        .filter(({ s }) => s >= ADDRESS_MATCH);
      const best = Math.max(0, ...scored.map(({ s }) => s));
      tier2 = scored.filter(({ s }) => s === best).map(({ a }) => a);
    }
    const chosen = pick(tier1.length > 0 ? tier1 : tier2.length > 0 ? tier2 : anchors);
    assigned.get(chosen.index)!.push(item.index);
  }
  if (orphanRun.length > 0) orphanRuns.push(orphanRun);

  // ── Assemble groups in scan order ───────────────────────────────────
  const groups: DocumentGroup[] = anchors.map((a) => {
    const invoices = [...new Set(assigned.get(a.index)!)].sort((x, y) => x - y);
    return {
      awbIndex: a.index,
      // Lone anchor: the photo itself carries the invoice (combined-photo
      // convention; for a label-only photo the pair still forms and the
      // extractor reports what it can read).
      invoiceIndices: invoices.length > 0 ? invoices : [a.index],
    };
  });
  for (const run of orphanRuns) groups.push({ awbIndex: null, invoiceIndices: run });
  groups.sort(
    (a, b) =>
      Math.min(a.awbIndex ?? Infinity, ...a.invoiceIndices) -
      Math.min(b.awbIndex ?? Infinity, ...b.invoiceIndices),
  );

  return { groups, droppedAnchors };
}

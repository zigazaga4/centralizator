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
/** Digit-string lengths: below MIN_PARTIAL the read is noise; at or above
 *  FULL the number is a complete AWB identity (real AWBs are 9 digits). */
const MIN_PARTIAL_DIGITS = 3;
const FULL_AWB_DIGITS = 6;

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

/** Digits of an AWB read, or null when too short to mean anything. */
function awbDigits(s: string | null): string | null {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= MIN_PARTIAL_DIGITS ? d : null;
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
    const aNum = awbDigits(a.awbNumber);
    const aFull = aNum !== null && aNum.length >= FULL_AWB_DIGITS ? aNum : null;

    // Compare against kept anchors, nearest in scan order first.
    const byDistance = [...kept].sort(
      (x, y) => Math.abs(x.index - a.index) - Math.abs(y.index - a.index),
    );
    let dupOf: DocInfo | null = null;
    let reason = "";
    for (const b of byDistance) {
      const bNum = awbDigits(b.awbNumber);
      const bFull = bNum !== null && bNum.length >= FULL_AWB_DIGITS ? bNum : null;
      const near = Math.abs(a.index - b.index) <= DUPLICATE_WINDOW;
      const names = nameScore(a, b) >= NAME_MATCH;

      if (aFull !== null && bFull !== null) {
        // Two complete identities: equal → same shipment; different →
        // PROVABLY distinct, no other signal may merge them.
        if (aFull === bFull) {
          dupOf = b;
          reason = `same AWB number ${aFull}`;
          break;
        }
        continue;
      }
      if (aNum !== null && bFull !== null && bFull.endsWith(aNum) && (names || near)) {
        dupOf = b;
        reason = `partial "${aNum}" suffixes ${bFull}`;
        break;
      }
      if (bNum !== null && aFull !== null && aFull.endsWith(bNum) && (names || near)) {
        dupOf = b;
        reason = `partial "${bNum}" suffixes ${aFull}`;
        break;
      }
      if (aNum === null && names && near) {
        dupOf = b;
        reason = "unreadable number, same recipient nearby";
        break;
      }
    }

    if (dupOf === null) {
      kept.push(a);
      continue;
    }

    // Of the duplicate pair, the longer number read is the better anchor.
    const dupNum = awbDigits(dupOf.awbNumber) ?? "";
    let winner = dupOf;
    let loser = a;
    if ((aNum ?? "").length > dupNum.length) {
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

    const tier1 = anchors.filter(
      (a) => overlapScore(itemNames, tokenSet(a.recipientName)) >= NAME_MATCH,
    );
    // Addresses share boilerplate tokens ("str", the town), so within the
    // address tier the HIGHEST overlap wins and distance only breaks ties.
    let tier2: DocInfo[] = [];
    if (tier1.length === 0) {
      const scored = anchors
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

import type { Pair } from "../types";

/* ──────────────────────────────────────────────────────────────────────
 * Pair search
 *
 * A small, pure predicate the queue uses to filter the visible table.
 * Matching is:
 *   • diacritic-insensitive  — "iasi" matches "Iași", "ștefan" ≈ "stefan"
 *   • case-insensitive
 *   • token-AND              — every whitespace-separated term must be
 *                              found somewhere in the pair's text, so
 *                              "ion 12345" narrows to a recipient + AWB.
 *
 * Only "ready" pairs carry extracted text (AWB + invoices); pending /
 * extracting / error / unpaired rows have nothing to match yet, so they
 * fall out of a non-empty search (and are all kept when the query is
 * empty).
 * ────────────────────────────────────────────────────────────────────── */

/** Lower-case + strip diacritics so the search ignores accents. */
const norm = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Every text field of a pair we let the operator search over, flattened
 *  into one normalised haystack. Empty for pairs without extracted data. */
export function pairSearchText(pair: Pair): string {
  if (pair.status.kind !== "ready") return "";
  const { awb, invoices } = pair.status.edits;
  const parts: Array<string | null | undefined> = [
    awb.awb_number,
    awb.recipient_name,
    awb.recipient_phone,
    awb.recipient_address,
    awb.sender_name,
    awb.sender_address,
    awb.service_text,
  ];
  for (const inv of invoices) {
    parts.push(
      inv.invoice_number,
      inv.order_number,
      inv.buyer_name,
      inv.buyer_cui,
      inv.supplier_name,
      inv.supplier_cui,
    );
  }
  return norm(parts.filter(Boolean).join(" "));
}

/** True when `pair` matches `query` (every token found). An empty/blank
 *  query matches everything. */
export function pairMatchesQuery(pair: Pair, query: string): boolean {
  const tokens = norm(query).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = pairSearchText(pair);
  if (!hay) return false;
  return tokens.every((t) => hay.includes(t));
}

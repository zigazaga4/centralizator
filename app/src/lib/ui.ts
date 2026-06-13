/* ──────────────────────────────────────────────────────────────────────
 * Shared UI design tokens
 *
 * Small className fragments that must look identical across components,
 * kept in one place so the affordance can never drift between the queue
 * table and the detail page.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * The "this field is editable" look for the inline spreadsheet cells
 * (number / date / service), used by both the dense queue table
 * (PairsTable) and the roomy detail page (PairDetail).
 *
 * The old bg-coral-50/30 tint was nearly invisible, so a dispatcher had
 * no way to tell a value could be typed over. This gives every editable
 * cell a warm coral fill PLUS a 2 px coral underline (drawn with an
 * inset shadow so the control's height never shifts); hovering deepens
 * both, and focus swaps the underline for a full ring.
 *
 * Font size, padding and layout are intentionally NOT included here —
 * each call site appends its own (text-[13px] + tight padding in the
 * table, text-sm + roomy padding in the detail page) so the two share
 * one affordance without fighting over sizing.
 */
export const EDIT_LOOK =
  "bg-coral-50/70 text-ink-900 outline-none transition " +
  "shadow-[inset_0_-2px_0_0_var(--color-coral-200)] " +
  "hover:bg-coral-100/70 hover:shadow-[inset_0_-2px_0_0_var(--color-coral-400)] " +
  "focus:bg-coral-50 focus:shadow-none focus:ring-2 focus:ring-inset focus:ring-coral-400";

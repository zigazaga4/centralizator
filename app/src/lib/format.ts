/** Romanian-locale RON formatter, used for every monetary value in the UI. */
const ronFmt = new Intl.NumberFormat("ro-RO", {
  style: "currency",
  currency: "RON",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const ron = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? "—" : ronFmt.format(n);

/** Compact RON amount — same ro-RO digits as `ron` but WITHOUT the
 *  currency suffix. For dense cells (e.g. the queue's cost mini-grid)
 *  where several amounts share one cell and a " RON" after each one
 *  is pure visual noise. */
const ronBareFmt = new Intl.NumberFormat("ro-RO", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const ronBare = (n: number | null | undefined): string =>
  n == null || Number.isNaN(n) ? "—" : ronBareFmt.format(n);

/** Ro-locale date formatter (DD.MM.YYYY). */
export const date = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, da] = m;
  return `${da}.${mo}.${y}`;
};

/** Today as a local-TZ ISO date (`YYYY-MM-DD`).
 *
 * Used as the default `Pair.day` and as the initial selected day.
 * We build the string by hand from `getFullYear`/`getMonth`/`getDate`
 * (NOT `toISOString().slice(0,10)`) because the latter converts to
 * UTC first — at 02:00 local in Europe/Bucharest the user would
 * still see "yesterday" in the day tabs, which is exactly the bug
 * a day-grouped UI is meant to avoid.
 */
export const todayIso = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
};

/** Add `n` days to a local-TZ ISO date, returning another local-TZ ISO
 *  date. `n` can be negative. Used by the day-tabs quick-nav buttons
 *  ("Mâine" → +1) and by anything else that needs to walk the calendar
 *  one step at a time.
 *
 *  We hand-rebuild the string the same way as `todayIso` — going
 *  through `Date.prototype.toISOString` would shift back into UTC
 *  and could land us on the wrong calendar day near midnight in
 *  Europe/Bucharest. The Date constructor's `(year, month, day+n)`
 *  form handles month/year roll-over (Dec 31 + 1 → Jan 1) and the
 *  rare leap-day edge correctly. */
export const addDaysIso = (iso: string, n: number): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  // Regex has exactly 3 capture groups — the `!` assertions are safe
  // and only present to satisfy `noUncheckedIndexedAccess`.
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]! + n);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
};

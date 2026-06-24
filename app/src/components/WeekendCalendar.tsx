import { useEffect, useState } from "react";
import { date as fmtDate, todayIso } from "../lib/format";

/* ──────────────────────────────────────────────────────────────────────
 * Weekend-only calendar
 *
 * A small month-grid date picker where ONLY Saturdays and Sundays are
 * selectable — every weekday is rendered but disabled. The operator uses
 * it to say "this one delivery is a weekend run, on THIS weekend day":
 * picking a day sets the pair's delivery date to it, which is what makes
 * the +11,90 weekend surcharge apply (the price keys off the date).
 *
 * Pure presentation + selection: it owns only the visible month. The
 * caller decides what picking a day means (PairDetail patches the pair's
 * delivery_date and re-prices).
 * ────────────────────────────────────────────────────────────────────── */

interface Props {
  /** Currently selected ISO day (highlighted + opens on its month). Null
   *  means the pair isn't a weekend yet → open on the current month. */
  value: string | null;
  /** The user picked a weekend day (ISO `YYYY-MM-DD`). */
  onPick: (iso: string) => void;
  /** Close without picking. */
  onClose: () => void;
}

/** Monday-first weekday headers (Romanian), so Sâ + Du sit in the last
 *  two columns — the only selectable ones. */
const WEEKDAY_HEADERS = ["Lu", "Ma", "Mi", "Jo", "Vi", "Sâ", "Du"] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;

export function WeekendCalendar({ value, onPick, onClose }: Props) {
  // Visible month (year + 0-indexed month), seeded from the current value
  // or today. `view` only ever changes via the prev/next chevrons.
  const [view, setView] = useState<{ y: number; m: number }>(() => {
    const base = value ?? todayIso();
    const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(base);
    if (mm) return { y: +mm[1]!, m: +mm[2]! - 1 };
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  });

  // Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const monthLabel = new Intl.DateTimeFormat("ro-RO", {
    month: "long",
    year: "numeric",
  }).format(new Date(view.y, view.m, 1));

  // Leading blanks so the 1st lands under the right weekday (Monday-first).
  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7; // 0 = Mon
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const today = todayIso();

  const step = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const cells: (number | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/70 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-xs rounded-xl border border-ink-200 bg-canvas-50 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Month navigation */}
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => step(-1)}
            title="Luna anterioară"
            className="rounded-md border border-ink-200 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-ink-900"
          >
            ‹
          </button>
          <span className="text-sm font-semibold capitalize text-ink-900">{monthLabel}</span>
          <button
            type="button"
            onClick={() => step(1)}
            title="Luna următoare"
            className="rounded-md border border-ink-200 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-ink-900"
          >
            ›
          </button>
        </div>

        {/* Weekday headers — weekend columns tinted so it's obvious which
            two are pickable. */}
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase tracking-wide">
          {WEEKDAY_HEADERS.map((h, i) => (
            <span key={h} className={i >= 5 ? "text-coral-600" : "text-ink-400"}>
              {h}
            </span>
          ))}
        </div>

        {/* Day grid — only Sat/Sun are buttons; weekdays are dimmed text. */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (d === null) return <span key={`b${i}`} />;
            const iso = isoOf(view.y, view.m, d);
            const col = i % 7; // 5 = Sat, 6 = Sun (Monday-first)
            const isWeekend = col === 5 || col === 6;
            const isSelected = iso === value;
            const isToday = iso === today;
            if (!isWeekend) {
              return (
                <span
                  key={iso}
                  className="flex h-8 items-center justify-center rounded-md text-[12px] text-ink-300"
                >
                  {d}
                </span>
              );
            }
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onPick(iso)}
                title={`Weekend · ${fmtDate(iso)}`}
                className={`flex h-8 items-center justify-center rounded-md text-[12px] font-medium transition ${
                  isSelected
                    ? "bg-coral-500 text-canvas-50 shadow-sm"
                    : `text-coral-700 hover:bg-coral-100 ${isToday ? "ring-1 ring-coral-300" : ""}`
                }`}
              >
                {d}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-center text-[11px] text-ink-500">
          Doar zilele de weekend (sâmbătă / duminică) pot fi alese.
        </p>
      </div>
    </div>
  );
}

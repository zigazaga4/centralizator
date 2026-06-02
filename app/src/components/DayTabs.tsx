import { useEffect, useRef, useState } from "react";
import { addDaysIso, date as fmtDate, todayIso } from "../lib/format";

export interface DayCount {
  /** ISO YYYY-MM-DD. */
  day: string;
  /** Total pairs on this day (all statuses). */
  count: number;
  /** Pairs that are fully calculated. Shown as a separate badge so the
   *  user sees "12 / 20" — twelve ready out of twenty filed. */
  readyCount: number;
}

interface Props {
  /** Days that already hold at least one pair, in any order — the
   *  component sorts chronologically (oldest left, newest right) so the
   *  natural reading direction matches calendar order. */
  days: DayCount[];
  /** The currently visible day. May or may not be in `days`: if the
   *  user has just picked an empty future day, it's not in the list
   *  yet but still needs to render as the highlighted tab. */
  selectedDay: string;
  /** Called with the ISO day the user clicked / picked. */
  onSelect: (day: string) => void;
}

/* ──────────────────────────────────────────────────────────────────────
 * Day tab strip
 *
 * Above the queue table, like Excel's sheet tabs along the bottom of
 * a workbook. Each tab is a single day; the user clicks one to swap
 * the table to that day's batch. The "+ Ziua nouă" affordance toggles
 * into a native date input so the user can jump to any day — including
 * empty future days they haven't started adding pairs to yet.
 *
 * The component is purely presentational: it doesn't know about pairs,
 * extraction, or the DB. It takes a pre-aggregated `DayCount[]` and
 * fires `onSelect` on every navigation. The owner (App.tsx) decides
 * what "current day" means and how to persist it across sessions.
 * ────────────────────────────────────────────────────────────────────── */
export function DayTabs({ days, selectedDay, onSelect }: Props) {
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  // When the user clicks "+ Ziua nouă", we toggle into picker mode and
  // immediately focus + open the date input. Some browsers ignore
  // `showPicker()` if it's called too early, so we defer with rAF.
  useEffect(() => {
    if (!picking) return;
    const id = requestAnimationFrame(() => {
      const el = pickerRef.current;
      if (!el) return;
      el.focus();
      // showPicker isn't on every WebView, so guard the call.
      const w = el as HTMLInputElement & { showPicker?: () => void };
      try {
        w.showPicker?.();
      } catch {
        /* ignore — focus alone still works */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [picking]);

  // Chronological sort: oldest day on the left, newest on the right,
  // matching how a paper calendar would lay them out.
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));

  // The selected day may not be in `days` if the user just picked an
  // empty future day. Render it as a "pending" tab so the highlight
  // always has somewhere to land.
  const selectedInList = sorted.some((d) => d.day === selectedDay);

  const today = todayIso();
  // One-click "prep tomorrow's batch" target. Always today + 1 (NOT
  // selectedDay + 1) — the natural meaning of "Mâine" is fixed relative
  // to *now*, not to wherever the user happens to be browsing. For
  // arbitrary future days the date picker still handles the rest.
  const tomorrow = addDaysIso(today, 1);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sorted.map((d) => (
        <DayTab
          key={d.day}
          day={d.day}
          count={d.count}
          readyCount={d.readyCount}
          isSelected={d.day === selectedDay}
          isToday={d.day === today}
          onClick={() => onSelect(d.day)}
        />
      ))}

      {!selectedInList && (
        // Selected day with no pairs yet — render as a soft "empty" tab
        // so the user has visual feedback that they're on a fresh day.
        <DayTab
          day={selectedDay}
          count={0}
          readyCount={0}
          isSelected
          isToday={selectedDay === today}
          empty
          onClick={() => onSelect(selectedDay)}
        />
      )}

      {/* Divider before the action affordance, so the "+" feels like a
       *  tool rather than another day. */}
      <span aria-hidden className="mx-1 hidden h-5 w-px bg-ink-200 sm:block" />

      {picking ? (
        <input
          ref={pickerRef}
          type="date"
          defaultValue={selectedDay}
          onBlur={() => setPicking(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPicking(false);
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
              onSelect(v);
              setPicking(false);
            }
          }}
          className="rounded-md border border-coral-400 bg-coral-50 px-2 py-1 text-sm text-ink-900 outline-none focus:ring-2 focus:ring-coral-400"
          title="Alege ziua"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          title="Alege o altă zi"
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-ink-300 bg-canvas-50 px-2.5 py-1 text-[12px] font-medium text-ink-600 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <line x1="12" y1="14" x2="12" y2="18" />
            <line x1="10" y1="16" x2="14" y2="16" />
          </svg>
          <span>Alege ziua</span>
        </button>
      )}

      {selectedDay !== today && (
        // One-click "back to today" shortcut. Hidden when today is
        // already selected (the button would be a no-op).
        <button
          type="button"
          onClick={() => onSelect(today)}
          title="Înapoi la ziua de azi"
          className="rounded-md px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-500 transition hover:bg-canvas-200 hover:text-ink-800"
        >
          Azi
        </button>
      )}

      {selectedDay !== tomorrow && (
        // "Prep tomorrow's batch" shortcut. One click creates (or jumps
        // to, if it already exists) the tab for today + 1. Visually
        // distinct from "Azi": coral-tinted with a `+` glyph so the
        // user reads it as a CREATE action rather than a back-nav.
        <button
          type="button"
          onClick={() => onSelect(tomorrow)}
          title={`Pregăteşte ziua de mâine — ${fmtDate(tomorrow)}`}
          className="inline-flex items-center gap-1 rounded-md border border-dashed border-coral-300 bg-coral-50/60 px-2.5 py-1 text-[12px] font-medium text-coral-700 transition hover:border-coral-500 hover:bg-coral-50 hover:text-coral-800"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>Mâine</span>
        </button>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────── */

function DayTab({
  day,
  count,
  readyCount,
  isSelected,
  isToday,
  empty,
  onClick,
}: {
  day: string;
  count: number;
  readyCount: number;
  isSelected: boolean;
  isToday: boolean;
  empty?: boolean;
  onClick: () => void;
}) {
  // Visual hierarchy:
  //   selected → coral border + coral-50 bg + coral-700 text, bold
  //   today    → keeps an "Azi" sub-label so it's recognisable at a glance
  //   default  → ink-200 border, canvas-50 bg, ink-700 text
  //   empty    → dashed border (tab is for a day the user hasn't filed yet)
  const base =
    "inline-flex items-center gap-2 rounded-md px-2.5 py-1 text-[12px] font-medium transition";
  const ring = isSelected
    ? "border border-coral-500 bg-coral-50 text-coral-700"
    : "border border-ink-200 bg-canvas-50 text-ink-700 hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900";
  const dash = empty ? " border-dashed" : "";

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        empty
          ? `${fmtDate(day)} — nicio pereche încă`
          : `${fmtDate(day)} — ${count} pereche${count === 1 ? "" : "i"} (${readyCount} calculate)`
      }
      className={`${base} ${ring}${dash}`}
    >
      <span className="tabular-nums">{fmtDate(day)}</span>
      {isToday && (
        <span
          className={`rounded px-1 text-[9px] font-bold uppercase tracking-wide ${
            isSelected
              ? "bg-coral-500 text-canvas-50"
              : "bg-ink-200 text-ink-600"
          }`}
        >
          Azi
        </span>
      )}
      {!empty && (
        <span
          className={`rounded px-1 text-[10px] tabular-nums ${
            isSelected
              ? "bg-coral-200/80 text-coral-800"
              : "bg-canvas-200 text-ink-600"
          }`}
        >
          {readyCount === count ? count : `${readyCount}/${count}`}
        </span>
      )}
    </button>
  );
}

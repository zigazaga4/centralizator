import { useCallback, useEffect, useRef, useState } from "react";
import type { CityKey, CollaboratorKey, Pair } from "../types";
import { exportToDocx, exportToPdf, exportToXlsx } from "../lib/export";

type Format = "pdf" | "xlsx" | "docx";

interface Props {
  pairs: Pair[];
  /** ISO YYYY-MM-DD of the day being exported. Used for the suggested
   *  filename (`centralizator-2026-05-30.pdf`) and as the in-document
   *  "Ziua: DD.MM.YYYY" header line. Optional so the menu still works
   *  in any future caller that hasn't day-scoped its pairs. */
  day?: string;
  /** Customer city — drives the per-city total column(s) in the file
   *  (one column, or Tudor + ERA for Iași). Forwarded straight to
   *  `lib/export`; the menu itself never reads it. */
  city: CityKey;
  /** Collaborator — drives the per-collaborator payout column.
   *  Forwarded as-is to `lib/export`. `null` means the city has no
   *  collaborator roster (Constanța) and the export drops the column
   *  entirely. */
  collaborator: CollaboratorKey | null;
  /** Disabled when there's nothing to export (no ready pair yet). */
  disabled: boolean;
}

/* ──────────────────────────────────────────────────────────────────────
 * Export menu
 *
 * Single button → dropdown with three formats. The actual exporters
 * (jspdf / exceljs / docx) are dynamic-imported inside lib/export, so
 * just rendering this component doesn't pull any of them into the
 * bundle. They only download the first time the user picks a format.
 *
 * State machine:
 *   closed → open (click button)
 *   open   → busy:<fmt> (click format)
 *   busy   → idle on success (path saved) or error (shown inline)
 *   closed on click-outside / Escape / successful save
 *
 * The component is intentionally local: it owns its own busy state
 * because the export is fire-and-forget from App's point of view —
 * no need to lift it.
 * ────────────────────────────────────────────────────────────────────── */
export function ExportMenu({ pairs, day, city, collaborator, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /* Click-outside + Escape both close the menu. We only attach the
   * listeners while the menu is open so we don't pay for them on
   * every render. */
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const runExport = useCallback(
    async (fmt: Format) => {
      if (busy) return;
      setError(null);
      setBusy(fmt);
      try {
        const fn =
          fmt === "pdf" ? exportToPdf : fmt === "xlsx" ? exportToXlsx : exportToDocx;
        const path = await fn(pairs, { day, city, collaborator });
        // path === null → user cancelled the save dialog. Treat that
        // as a no-op: close the menu, no error toast.
        setOpen(false);
        if (path) {
          // Soft feedback: a tiny status the user can see on next open.
          // We don't surface a success toast because Tauri's save
          // dialog already provided the "you picked a file" feedback.
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, pairs, day, city, collaborator],
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
        disabled={disabled || !!busy}
        title={
          disabled
            ? "Calculează cel puţin o pereche pentru a putea exporta"
            : "Exportă perechile calculate"
        }
        className="inline-flex items-center gap-2 rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900 disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-canvas-100 disabled:text-ink-400"
      >
        {busy ? (
          <svg
            className="h-4 w-4 animate-spin text-coral-500"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
        <span>{busy ? "Export…" : "Exportă"}</span>
        <svg
          className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-ink-200 bg-canvas-50 shadow-lg"
        >
          <FormatItem
            label="PDF"
            hint="Document tipăribil A4 landscape"
            busy={busy === "pdf"}
            onClick={() => void runExport("pdf")}
            icon={
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </>
            }
          />
          <FormatItem
            label="Word (.docx)"
            hint="Document Microsoft Word editabil"
            busy={busy === "docx"}
            onClick={() => void runExport("docx")}
            icon={
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </>
            }
          />
          <FormatItem
            label="Excel (.xlsx)"
            hint="Foaie cu formule SUM live"
            busy={busy === "xlsx"}
            onClick={() => void runExport("xlsx")}
            icon={
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <line x1="15" y1="3" x2="15" y2="21" />
                <line x1="3" y1="9" x2="21" y2="9" />
                <line x1="3" y1="15" x2="21" y2="15" />
              </>
            }
          />
          {error && (
            <div className="border-t border-ink-200 bg-coral-50 px-3 py-2 text-[11px] leading-snug text-coral-700">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FormatItem({
  label,
  hint,
  busy,
  onClick,
  icon,
}: {
  label: string;
  hint: string;
  busy: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-start gap-3 px-3 py-2 text-left transition hover:bg-canvas-100 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-0.5 text-coral-500">
        {busy ? (
          <svg
            className="h-4 w-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            {icon}
          </svg>
        )}
      </span>
      <span className="flex flex-col">
        <span className="text-sm font-medium text-ink-800">{label}</span>
        <span className="text-[11px] text-ink-500">{hint}</span>
      </span>
    </button>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareExcel } from "../lib/api";
import type { CompareField, CompareReport, CompareRow } from "../types";

/* ──────────────────────────────────────────────────────────────────────
 * Compară Excel
 *
 * Header button that uploads the courier's master export ("Main" .xlsx) and
 * shows, in a modal, how every AWB in it lines up with what this app
 * extracted and priced. The comparison itself runs server-side (POST
 * /compare-excel reads the live pair queue); this component is just the
 * trigger + the result viewer.
 *
 * Two severities drive the colours:
 *   • "alert"  — recipient / weight / extra-km mismatches (likely extraction
 *                errors). Painted coral; they flag the whole row.
 *   • "info"   — road distance / price drifts (Mapbox vs courier, our tariff
 *                vs theirs). Painted amber; shown but never flag the row.
 *
 * The component owns all of its state — it's fire-and-forget from App's view.
 * ────────────────────────────────────────────────────────────────────── */

type Filter = "all" | "diffs" | "flagged";

export function CompareExcelButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CompareReport | null>(null);
  const [filter, setFilter] = useState<Filter>("diffs");
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const rep = await compareExcel(file);
      setReport(rep);
      setOpen(true);
    } catch (err) {
      setError((err as Error).message);
      setOpen(true);
    } finally {
      setBusy(false);
      // Reset so picking the same file again re-triggers onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }, []);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Încarcă exportul „Main” (.xlsx) și compară-l cu datele din aplicație (după numărul AWB)"
        className="inline-flex items-center gap-2 rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900 disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-canvas-100 disabled:text-ink-400"
      >
        {busy ? (
          <svg className="h-4 w-4 animate-spin text-coral-500" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M9 3v18" />
          </svg>
        )}
        <span>{busy ? "Compar…" : "Compară Excel"}</span>
      </button>

      {open && (
        <CompareModal
          report={report}
          error={error}
          filter={filter}
          onFilter={setFilter}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Modal
 * ────────────────────────────────────────────────────────────────────── */

function CompareModal({
  report,
  error,
  filter,
  onFilter,
  onClose,
}: {
  report: CompareReport | null;
  error: string | null;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onClose: () => void;
}) {
  // Escape closes; lock background scroll while open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => {
    if (!report) return [];
    if (filter === "flagged") return report.rows.filter((r) => r.hasDiscrepancy);
    if (filter === "diffs") {
      return report.rows.filter(
        (r) => r.presence !== "both" || r.fields.some((f) => f.status !== "match"),
      );
    }
    return report.rows;
  }, [report, filter]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">Comparație cu Excel „Main”</h2>
            <p className="text-[12px] text-ink-500">
              {report?.fileName ? `${report.fileName} • ` : ""}potrivire după numărul AWB
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-ink-500 transition hover:bg-canvas-200 hover:text-ink-900"
            aria-label="Închide"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        {error ? (
          <div className="m-6 rounded-md border border-coral-300 bg-coral-50 px-4 py-3 text-sm text-coral-700">
            {error}
          </div>
        ) : report ? (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 px-6 py-3">
              <Stat label="AWB în Excel" value={report.summary.excelRows} />
              <Stat label="Perechi în app" value={report.summary.appPairs} />
              <Stat label="Potrivite" value={report.summary.matched} />
              <Stat label="Cu erori" value={report.summary.flagged} tone={report.summary.flagged > 0 ? "alert" : "ok"} />
              <Stat label="Doar în Excel" value={report.summary.excelOnly} tone={report.summary.excelOnly > 0 ? "warn" : "ok"} />
              <Stat label="Doar în app" value={report.summary.appOnly} tone={report.summary.appOnly > 0 ? "warn" : "ok"} />
              <div className="ml-auto flex items-center gap-1 rounded-md border border-ink-200 p-0.5">
                <FilterTab active={filter === "flagged"} onClick={() => onFilter("flagged")}>Erori</FilterTab>
                <FilterTab active={filter === "diffs"} onClick={() => onFilter("diffs")}>Diferențe</FilterTab>
                <FilterTab active={filter === "all"} onClick={() => onFilter("all")}>Toate</FilterTab>
              </div>
            </div>

            <div className="overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-canvas-100 text-left text-[11px] uppercase tracking-wide text-ink-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">AWB</th>
                    <th className="px-4 py-2 font-medium">Destinatar</th>
                    <th className="px-3 py-2 font-medium">Kg</th>
                    <th className="px-3 py-2 font-medium">Extra km</th>
                    <th className="px-3 py-2 font-medium">Distanță stradă</th>
                    <th className="px-3 py-2 font-medium">Preț</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-ink-400">
                        Nicio linie de afișat pentru acest filtru.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => <ReportRow key={`${r.presence}-${r.awb}`} row={r} />)
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="p-10 text-center text-ink-400">Se încarcă…</div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Row + cells
 * ────────────────────────────────────────────────────────────────────── */

function ReportRow({ row }: { row: CompareRow }) {
  if (row.presence !== "both") {
    const onlyExcel = row.presence === "excelOnly";
    return (
      <tr className="border-t border-ink-100 bg-amber-50/40">
        <td className="px-4 py-2 font-mono text-[13px] text-ink-800">{row.awb}</td>
        <td className="px-4 py-2 text-ink-700">{row.recipient ?? "—"}</td>
        <td colSpan={4} className="px-3 py-2">
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            {onlyExcel ? "Doar în Excel (lipsește din app)" : "Doar în app (lipsește din Excel)"}
          </span>
        </td>
      </tr>
    );
  }

  const byKey = (k: string) => row.fields.find((f) => f.key === k);
  return (
    <tr className={`border-t border-ink-100 ${row.hasDiscrepancy ? "bg-coral-50/50" : "hover:bg-canvas-100"}`}>
      <td className="px-4 py-2 font-mono text-[13px] text-ink-800">{row.awb}</td>
      <Cell field={byKey("recipient")} />
      <Cell field={byKey("weight")} />
      <Cell field={byKey("extraKm")} />
      <Cell field={byKey("roadKm")} />
      <Cell field={byKey("price")} />
    </tr>
  );
}

function fmt(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  return typeof v === "number" ? String(v) : v;
}

function Cell({ field }: { field: CompareField | undefined }) {
  if (!field) return <td className="px-3 py-2 text-ink-400">—</td>;

  const match = field.status === "match";
  // Tone: matches stay neutral; alert mismatches go coral; info drifts go
  // amber; missing values render muted/italic.
  const tone =
    match
      ? "text-ink-700"
      : field.status === "missing"
        ? "italic text-ink-400"
        : field.severity === "alert"
          ? "text-coral-700"
          : "text-amber-700";

  return (
    <td className="px-3 py-2 align-top">
      <div className={`flex flex-col leading-tight ${tone}`}>
        <span className="font-medium">{fmt(field.excel)}</span>
        {!match && (
          <span className="text-[12px] opacity-80">
            app: {fmt(field.app)}
          </span>
        )}
        {!match && field.reason && (
          <span className="mt-0.5 text-[11px] italic leading-snug text-ink-500">
            ({field.reason})
          </span>
        )}
      </div>
    </td>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "ok" | "warn" | "alert";
}) {
  const color =
    tone === "alert"
      ? "text-coral-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "ok"
          ? "text-emerald-700"
          : "text-ink-800";
  return (
    <div className="flex flex-col">
      <span className={`text-lg font-semibold ${color}`}>{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[12px] font-medium transition ${
        active ? "bg-coral-500 text-canvas-50" : "text-ink-600 hover:bg-canvas-200"
      }`}
    >
      {children}
    </button>
  );
}

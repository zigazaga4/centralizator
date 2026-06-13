import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CITY_LABEL,
  COLLABORATOR_KEYS,
  COLLABORATOR_LABEL,
  COLLABORATOR_SHORT_LABEL,
  type CityKey,
  type CollaboratorKey,
  type Pair,
} from "../types";
import {
  DEFAULT_EXPORT_SETTINGS,
  exportToDocx,
  exportToPdf,
  exportToXlsx,
  pairInScope,
  type ExportScope,
  type ExportSettings,
} from "../lib/export";

type Format = "pdf" | "xlsx" | "docx";

interface Props {
  /** Pairs of the visible day + store + view, deliberately NOT
   *  filtered by the header's collaborator dropdown — the modal owns
   *  its own collaborator scope, so the user can export EMV's decont
   *  while looking at Stalexone's queue. */
  pairs: Pair[];
  /** ISO YYYY-MM-DD of the day being exported. Used for the suggested
   *  filename (`centralizator-2026-05-30.pdf`) and as the in-document
   *  "Ziua: DD.MM.YYYY" header line. Optional so the menu still works
   *  in any future caller that hasn't day-scoped its pairs. */
  day?: string;
  /** Customer city — drives the per-city total column in the file.
   *  Forwarded straight to `lib/export`; also labels the "Total
   *  client" column checkbox. */
  city: CityKey;
  /** Header-dropdown collaborator — the payout fallback for legacy
   *  pairs uploaded without an assignment. Forwarded as-is to
   *  `lib/export`. `null` means the city has no collaborator roster
   *  (Constanța). */
  collaborator: CollaboratorKey | null;
  /** Disabled when there's nothing to export (no ready pair yet). */
  disabled: boolean;
}

/** Persisted modal configuration — tomorrow's export reopens exactly
 *  as the user left it. */
const LS_SETTINGS = "centralizator.exportSettings";

/** Read + validate the persisted settings. Every field is checked so a
 *  stale or hand-edited blob degrades to the defaults instead of
 *  producing a malformed file.
 *
 *  First run (nothing stored): the scope preselects the header's
 *  collaborator, so combined with `statement` defaulting to ON the
 *  modal opens ready to generate that partner's decont — the decont is
 *  the default export, per the operator's working rule. */
function readStoredSettings(fallbackCollaborator: CollaboratorKey | null): ExportSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) {
      return { ...DEFAULT_EXPORT_SETTINGS, scope: fallbackCollaborator ?? "all" };
    }
    const p = JSON.parse(raw) as Partial<ExportSettings>;
    const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);
    const scope: ExportScope =
      p.scope === "all" ||
      p.scope === "direct" ||
      (COLLABORATOR_KEYS as readonly string[]).includes(p.scope as string)
        ? (p.scope as ExportScope)
        : "all";
    return {
      scope,
      includeUnassigned: bool(p.includeUnassigned, true),
      // The decont preference persists as-is (default ON); whether it
      // takes effect is gated by the partner scope at render/export
      // time, so it re-arms automatically when a partner is picked.
      statement: bool(p.statement, true),
      colDetails: bool(p.colDetails, true),
      colCarrier: bool(p.colCarrier, true),
      colCityTotal: bool(p.colCityTotal, true),
      colCollab: bool(p.colCollab, true),
    };
  } catch {
    return DEFAULT_EXPORT_SETTINGS;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Export settings modal
 *
 * Single button → modal with the export configuration + the three
 * format buttons. The actual exporters (jspdf / exceljs / docx) are
 * dynamic-imported inside lib/export, so just rendering this component
 * doesn't pull any of them into the bundle. They only download the
 * first time the user generates a file.
 *
 * Settings sections:
 *   Perechi incluse — scope filter (all / one collaborator / direct),
 *     each option showing a live count of the ready pairs it matches;
 *   Decont colaborator — rows show only the base transport tariff,
 *     the partner's commission is applied once, at the end;
 *   Coloane — what the table carries (tariff details, carrier
 *     subtotal, client total, per-row payout).
 *
 * State machine:
 *   closed → open (click button)
 *   open   → busy:<fmt> (click a format)
 *   busy   → closed on success (file saved) / open on cancel / error
 *   closed on overlay-click / Escape / ✕ (never while busy)
 * ────────────────────────────────────────────────────────────────────── */
export function ExportMenu({ pairs, day, city, collaborator, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ExportSettings>(() =>
    readStoredSettings(collaborator),
  );

  /* Persist every change so tomorrow's export reopens configured the
   * same way. Quota / private-mode failures are non-fatal. */
  useEffect(() => {
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    } catch {
      /* non-fatal */
    }
  }, [settings]);

  /* Escape closes the modal — unless an export is mid-flight. */
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const scopeIsCollab = settings.scope !== "all" && settings.scope !== "direct";
  const statementOn = settings.statement && scopeIsCollab;

  /* Column flags as the FILE will actually carry them: decont mode
   * forces the base-only shape (mirrors normalizeSettings in
   * lib/export, so the checkboxes never lie about the output). */
  const effCols = statementOn
    ? { details: settings.colDetails, carrier: true, cityTotal: false, collab: false }
    : {
        details: settings.colDetails,
        carrier: settings.colCarrier,
        cityTotal: settings.colCityTotal,
        collab: settings.colCollab,
      };

  /* Live "N" badge per scope option + the footer preview — the same
   * pairInScope predicate the exporters use, so the numbers can never
   * disagree with the generated file. */
  const scopeCount = useCallback(
    (scope: ExportScope) =>
      pairs.filter(
        (p) => p.status.kind === "ready" && pairInScope(p, { ...settings, scope }),
      ).length,
    [pairs, settings],
  );
  const readyCount = useMemo(
    () => scopeCount(settings.scope),
    [scopeCount, settings.scope],
  );

  // The decont preference deliberately survives scope changes: it only
  // takes effect on a partner scope (statementOn gates it), so leaving
  // and re-entering a partner keeps decont as the default behaviour.
  const setScope = (scope: ExportScope) => setSettings((s) => ({ ...s, scope }));

  const runExport = useCallback(
    async (fmt: Format) => {
      if (busy) return;
      setError(null);
      setBusy(fmt);
      try {
        const fn =
          fmt === "pdf" ? exportToPdf : fmt === "xlsx" ? exportToXlsx : exportToDocx;
        const path = await fn(pairs, {
          day,
          city,
          collaborator,
          settings: { ...settings, statement: statementOn },
        });
        // path === null → user cancelled the save dialog; keep the
        // modal open so they can re-pick. A saved file closes it.
        if (path !== null) setOpen(false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [busy, pairs, day, city, collaborator, settings, statementOn],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
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
          <BusySpinner className="h-4 w-4 text-coral-500" />
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
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/70 p-6"
          onClick={() => {
            if (!busy) setOpen(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Setări export"
        >
          <div
            className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-800">
                  Setări export
                </h3>
                <p className="mt-1 text-xs text-ink-500">
                  Alege ce intră în fișier, apoi formatul. Setările se rețin.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !busy && setOpen(false)}
                aria-label="Închide"
                className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-coral-700"
              >
                ✕
              </button>
            </div>

            {/* ── Settings ───────────────────────────────────────── */}
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <section>
                <SectionTitle>Perechi incluse</SectionTitle>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <ScopeChip
                    label="Toate perechile"
                    count={scopeCount("all")}
                    active={settings.scope === "all"}
                    onClick={() => setScope("all")}
                  />
                  {COLLABORATOR_KEYS.map((k) => (
                    <ScopeChip
                      key={k}
                      label={COLLABORATOR_LABEL[k]}
                      count={scopeCount(k)}
                      active={settings.scope === k}
                      onClick={() => setScope(k)}
                    />
                  ))}
                  <ScopeChip
                    label="Directe (fără colaborator)"
                    count={scopeCount("direct")}
                    active={settings.scope === "direct"}
                    onClick={() => setScope("direct")}
                  />
                </div>
                {scopeIsCollab && (
                  <div className="mt-2">
                    <SettingCheck
                      label="Include și perechile nealocate"
                      hint="Perechile vechi, încărcate fără colaborator, intră și ele în fișier."
                      checked={settings.includeUnassigned}
                      onChange={(v) => setSettings((s) => ({ ...s, includeUnassigned: v }))}
                    />
                  </div>
                )}
              </section>

              <section>
                <SectionTitle>Decont colaborator (fișier de plată)</SectionTitle>
                <p className="mt-1 text-[11px] leading-snug text-ink-500">
                  Decontul este fișierul de plată al colaboratorului: fiecare rând arată
                  transportul la tariful de bază, iar comisionul lui se adună o singură
                  dată, la final, sub total.
                </p>
                <div className="mt-2">
                  <SettingCheck
                    label="Generează decont pentru colaborator"
                    hint={
                      scopeIsCollab
                        ? `Fiecare rând arată doar tariful de bază al transportului; comisionul ${COLLABORATOR_SHORT_LABEL[settings.scope as CollaboratorKey]} se aplică o singură dată, la final, sub total.`
                        : "Alege un colaborator la «Perechi incluse» pentru a putea genera decontul lui."
                    }
                    checked={statementOn}
                    disabled={!scopeIsCollab}
                    onChange={(v) => setSettings((s) => ({ ...s, statement: v }))}
                  />
                </div>
              </section>

              <section>
                <SectionTitle>Coloane în fișier</SectionTitle>
                <div className="mt-2 space-y-2">
                  <SettingCheck
                    label="Detalii tarif (Bază, Km+, Inc., Wkd)"
                    hint="Componentele din care se compune tariful de transport."
                    checked={effCols.details}
                    onChange={(v) => setSettings((s) => ({ ...s, colDetails: v }))}
                  />
                  <SettingCheck
                    label="Tarif transport"
                    hint={
                      statementOn
                        ? "Obligatoriu în decont — este tariful de bază al fiecărui rând."
                        : "Subtotalul transportatorului (fără comisioane)."
                    }
                    checked={effCols.carrier}
                    disabled={statementOn}
                    onChange={(v) => setSettings((s) => ({ ...s, colCarrier: v }))}
                  />
                  <SettingCheck
                    label={`Total client (${CITY_LABEL[city]})`}
                    hint={
                      statementOn
                        ? "Exclus din decont — prețul clientului nu apare în fișierul colaboratorului."
                        : "Totalul facturat clientului pentru orașul selectat."
                    }
                    checked={effCols.cityTotal}
                    disabled={statementOn}
                    onChange={(v) => setSettings((s) => ({ ...s, colCityTotal: v }))}
                  />
                  <SettingCheck
                    label="Plată colaborator (pe rând)"
                    hint={
                      statementOn
                        ? "Exclus din decont — comisionul se aplică doar la final, nu pe rânduri."
                        : "Cât primește colaboratorul fiecărui rând (cu comision inclus)."
                    }
                    checked={effCols.collab}
                    disabled={statementOn}
                    onChange={(v) => setSettings((s) => ({ ...s, colCollab: v }))}
                  />
                </div>
              </section>
            </div>

            {/* ── Footer: preview + formats ──────────────────────── */}
            <div className="border-t border-ink-200 bg-canvas-100 px-5 py-4">
              <p
                className={`text-xs ${
                  readyCount === 0 ? "font-medium text-coral-700" : "text-ink-500"
                }`}
              >
                {readyCount === 0
                  ? "Nicio pereche calculată nu corespunde filtrului ales."
                  : `${readyCount} ${readyCount === 1 ? "pereche calculată intră" : "perechi calculate intră"} în export.`}
              </p>
              {error && (
                <p className="mt-2 rounded-md bg-coral-50 px-3 py-2 text-[11px] leading-snug text-coral-700">
                  {error}
                </p>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2">
                <FormatButton
                  label="PDF"
                  hint="A4 landscape"
                  busy={busy === "pdf"}
                  disabled={readyCount === 0 || !!busy}
                  onClick={() => void runExport("pdf")}
                  icon={
                    <>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </>
                  }
                />
                <FormatButton
                  label="Word"
                  hint=".docx editabil"
                  busy={busy === "docx"}
                  disabled={readyCount === 0 || !!busy}
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
                <FormatButton
                  label="Excel"
                  hint="formule SUM live"
                  busy={busy === "xlsx"}
                  disabled={readyCount === 0 || !!busy}
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
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── Modal building blocks ─────────────────────────────────────────── */

function BusySpinner({ className }: { className: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </h4>
  );
}

/** One scope option: label + live count of the ready pairs it matches. */
function ScopeChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
        active
          ? "border-coral-500 bg-coral-50 text-coral-800"
          : "border-ink-200 bg-canvas-50 text-ink-700 hover:border-coral-300 hover:bg-canvas-100"
      }`}
    >
      <span className="truncate">{label}</span>
      <span
        className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
          active ? "bg-coral-500 text-canvas-50" : "bg-canvas-200 text-ink-500"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/** Checkbox row with a label + explanatory hint. Disabled rows keep
 *  showing their effective state (decont forces some on/off). */
function SettingCheck({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 transition ${
        disabled
          ? "cursor-not-allowed border-ink-100 opacity-60"
          : "cursor-pointer border-ink-200 hover:border-coral-300 hover:bg-canvas-100"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-coral-500"
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-ink-800">{label}</span>
        {hint && <span className="text-[11px] leading-snug text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}

/** One of the three generate buttons in the modal footer. */
function FormatButton({
  label,
  hint,
  busy,
  disabled,
  onClick,
  icon,
}: {
  label: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1 rounded-lg border border-ink-200 bg-canvas-50 px-3 py-2.5 transition hover:border-coral-400 hover:bg-canvas-200 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-coral-500">
        {busy ? (
          <BusySpinner className="h-5 w-5" />
        ) : (
          <svg
            className="h-5 w-5"
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
      <span className="text-sm font-medium text-ink-800">{label}</span>
      <span className="text-[10px] leading-none text-ink-500">{hint}</span>
    </button>
  );
}

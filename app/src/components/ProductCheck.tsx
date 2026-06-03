import { useState, type ReactNode, type MouseEvent } from "react";
import type { CheckStatus, ItemCheck, Verification } from "../types";
import { ron } from "../lib/format";

/* ──────────────────────────────────────────────────────────────────────
 * Leroy Merlin product cross-check UI.
 *
 * One reusable widget shared by the queue table (a per-row icon) and the
 * pair detail page (header icon + an inline summary section). The icon
 * states:
 *   • spinner  — verification in flight,
 *   • ⚠ button — a SIZE or WEIGHT mismatch was found (the alarm),
 *   • ✓ button — verified, no mismatch (subtle; still opens the dialog),
 *   • nothing  — not verified (and not currently verifying).
 *
 * Clicking the icon opens a dialog that lists every product: invoice
 * size vs site size, catalog weight, price, brand and a link — with
 * mismatches highlighted. Per the operator's rule, only size/weight
 * mismatches colour the icon; found/not-found/name/price are shown but
 * never alarm.
 * ────────────────────────────────────────────────────────────────────── */

/** Format a millimetre multiset as "100 × 500 × 1000 mm". */
function fmtDims(mm: number[]): string {
  if (!mm || mm.length === 0) return "—";
  return `${mm.join(" × ")} mm`;
}

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** Small coloured verdict chip. */
function StatusChip({ status, labelMap }: { status: CheckStatus; labelMap?: Partial<Record<CheckStatus, string>> }) {
  const text =
    labelMap?.[status] ??
    (status === "match" ? "OK" : status === "mismatch" ? "Diferă" : "n/a");
  const cls =
    status === "mismatch"
      ? "bg-coral-100 text-coral-700"
      : status === "match"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-canvas-200 text-ink-500";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {text}
    </span>
  );
}

/* ─── The icon (table cell + detail header) ─────────────────────────── */

export function ProductBadge({
  verification,
  verifying,
}: {
  verification?: Verification;
  verifying?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (verifying) {
    return (
      <span title="Se verifică produsele pe leroymerlin.ro…" className="inline-flex">
        <svg className="h-4 w-4 animate-spin text-ink-400" viewBox="0 0 24 24" fill="none" aria-label="Se verifică…">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (!verification) return null;

  const warn = verification.hasWarning;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onMouseDown={stop}
        title={
          warn
            ? "Discrepanță produse (dimensiuni/greutate) — click pentru detalii"
            : "Produse verificate pe leroymerlin.ro — click pentru detalii"
        }
        className={`inline-flex h-5 w-5 items-center justify-center rounded transition ${
          warn
            ? "text-coral-600 hover:bg-coral-100"
            : "text-emerald-600 hover:bg-emerald-50"
        }`}
        aria-label={warn ? "Discrepanță produse" : "Produse verificate"}
      >
        {warn ? (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        )}
      </button>
      {open && <ProductCheckDialog verification={verification} onClose={() => setOpen(false)} />}
    </>
  );
}

/* ─── The dialog ────────────────────────────────────────────────────── */

function ProductCheckDialog({
  verification,
  onClose,
}: {
  verification: Verification;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/70 p-6"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseDown={stop}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-ink-200 bg-canvas-50 shadow-2xl"
        onClick={stop}
        onMouseDown={stop}
      >
        <div className="flex items-center justify-between border-b border-ink-200 bg-canvas-100 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-800">
              Verificare produse · leroymerlin.ro
            </h3>
            <p className="text-[11px] text-ink-500">
              Comparăm dimensiunile și greutatea facturii cu pagina produsului.
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-coral-700"
            aria-label="Închide"
          >
            ✕
          </button>
        </div>

        <ProductCheckSummary verification={verification} />
      </div>
    </div>
  );
}

/* ─── Reusable body (dialog + detail page section) ──────────────────── */

export function ProductCheckSummary({ verification }: { verification: Verification }) {
  const v = verification;
  const allGood = !v.hasWarning && v.items.some((it) => it.found);
  return (
    <div className="p-5">
      {/* Verdict banner — a clear green confirmation when everything
          matches the website, or a coral alert when it does not. */}
      {allGood ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12l2.5 2.5L16 9" />
          </svg>
          <span className="text-sm font-medium">
            Tot corespunde site-ului leroymerlin.ro — dimensiunile și greutatea sunt verificate.
          </span>
        </div>
      ) : v.hasWarning ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-coral-300 bg-coral-50 px-4 py-3 text-coral-800">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-sm font-medium">
            Discrepanțe față de site (dimensiuni/greutate) — vezi detaliile de mai jos.
          </span>
        </div>
      ) : null}

      {/* Weight reconciliation */}
      <div className="mb-4 rounded-lg border border-ink-200 bg-canvas-100/60 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
            Greutate AWB vs. catalog
          </span>
          <StatusChip
            status={v.weightStatus}
            labelMap={{ unknown: v.weightCoverage === "full" ? "n/a" : "parțial" }}
          />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-800 tabular-nums">
          <span>AWB: <strong>{v.awbWeightKg} kg</strong></span>
          <span>
            Estimat catalog:{" "}
            <strong>{v.estimatedWeightKg != null ? `${v.estimatedWeightKg} kg` : "—"}</strong>
          </span>
          {v.weightCoverage !== "full" && (
            <span className="text-ink-500">
              ({v.weightCoverage === "none" ? "fără date de greutate" : "acoperire parțială — fără alarmă"})
            </span>
          )}
        </div>
      </div>

      {v.note && <p className="mb-3 text-xs text-ink-500">{v.note}</p>}

      {/* Per-item table */}
      {v.items.length === 0 ? (
        <p className="text-sm text-ink-500">Niciun produs de verificat pe această pereche.</p>
      ) : (
        <div className="space-y-2">
          {v.items.map((it, i) => (
            <ItemCard key={`${it.invoiceIndex}-${it.itemIndex}-${i}`} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-wider text-ink-500">{label}</span>
      <span className="text-sm text-ink-800">{children}</span>
    </div>
  );
}

function ItemCard({ item }: { item: ItemCheck }) {
  const mismatch = item.sizeStatus === "mismatch";
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        mismatch ? "border-coral-300 bg-coral-50/50" : "border-ink-200 bg-canvas-50"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-ink-900">{item.name}</span>
        {item.found ? (
          <StatusChip status={item.sizeStatus} />
        ) : (
          <span className="shrink-0 rounded bg-canvas-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            negăsit
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <Row label="Cod">{item.query || "—"}</Row>
        <Row label="Cant.">
          {item.quantity}
          {item.unit ? ` ${item.unit}` : ""}
        </Row>
        <Row label="Dim. factură">{fmtDims(item.invoiceDimsMm)}</Row>
        <Row label="Dim. site">{item.found ? fmtDims(item.siteDimsMm) : "—"}</Row>
        {item.found && (
          <>
            <Row label="Produs site">{item.siteName || "—"}</Row>
            <Row label="Brand">{item.brand || "—"}</Row>
            <Row label="Greutate site">{item.weightKg != null ? `${item.weightKg} kg` : "—"}</Row>
            <Row label="Preț site">{item.priceBuc != null ? ron(item.priceBuc) : "—"}</Row>
          </>
        )}
      </div>
      {item.url && (
        <div className="mt-2">
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            onClick={stop}
            className="text-xs font-medium text-coral-700 underline decoration-dotted underline-offset-2 hover:text-coral-800"
          >
            Deschide pagina produsului ↗
          </a>
        </div>
      )}
    </div>
  );
}

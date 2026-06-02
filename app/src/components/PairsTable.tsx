import { useEffect, useState, type SyntheticEvent } from "react";
import type { Pair, PairPatch, PairStatus, Service } from "../types";
import { date, ron } from "../lib/format";

const SERVICES: Service[] = ["Express", "Premium", "Prestabilita"];

/* Each width below is chosen so the 16-column grid lines up cleanly
 * even when a row is still pending (no extracted data yet). All
 * fixed-width columns sum to 1360 px (40+56+64+148+148+120+120+72+72
 * +60+88+72+72+72+120+36); the wrapper scrolls horizontally on
 * smaller windows.
 *
 * The two free-text columns (AWB #, Factură #) are `minmax(148px, 1fr)`
 * instead of `148px` so they absorb any width beyond 1360 px. Without
 * this, on a desktop window wider than the grid total the columns stay
 * packed at the left and the row backgrounds, cell borders, and the
 * sticky coral total row visually "stop" mid-page — the table fails to
 * fill the available width. With 1fr on those two columns the grid
 * always spans the full wrapper, and cells, borders, header and footer
 * all extend cleanly to the right edge. */
const GRID =
  "grid grid-cols-[40px_56px_64px_minmax(148px,1fr)_minmax(148px,1fr)_120px_120px_72px_72px_60px_88px_72px_72px_72px_120px_36px]";

interface Props {
  pairs: Pair[];
  onPatchPair: (id: string, patch: PairPatch) => void;
  onRemovePair: (id: string) => void;
  /** Opens the per-pair detail page. The row is the click target — form
   *  controls and the remove button stop propagation, so editing or
   *  deleting never accidentally navigates. */
  onSelectPair: (id: string) => void;
}

/* ──────────────────────────────────────────────────────────────────────
 * Multi-pair spreadsheet
 *
 * The whole queue lives in a single wide grid. Each pair owns ONE row
 * and one status icon. Editable cells (date, service, kg, km, liv.)
 * stay live — every keystroke flows up to App which re-prices that pair
 * alone, in parallel with whatever else is in flight.
 *
 * The footer row sums the billable totals across every "ready" pair.
 * ────────────────────────────────────────────────────────────────────── */
export function PairsTable({ pairs, onPatchPair, onRemovePair, onSelectPair }: Props) {
  // Footer sum is the end-customer billable, not the carrier subtotal.
  const sumTotal = pairs.reduce((acc, p) => {
    return p.status.kind === "ready" ? acc + p.status.breakdown.customerTotal : acc;
  }, 0);
  const readyCount = pairs.filter((p) => p.status.kind === "ready").length;

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
      <div className="min-w-[1360px]">
        <Header />
        {pairs.map((p, i) => (
          <PairRow
            key={p.id}
            index={i}
            pair={p}
            onPatch={(patch) => onPatchPair(p.id, patch)}
            onRemove={() => onRemovePair(p.id)}
            onSelect={() => onSelectPair(p.id)}
          />
        ))}
        <SumRow total={sumTotal} readyCount={readyCount} totalCount={pairs.length} />
      </div>
    </div>
  );
}

/* ─── Header ────────────────────────────────────────────────────────── */

function Header() {
  const cols = [
    { label: "#", align: "center" },
    { label: "Stare", align: "center" },
    { label: "Imagini", align: "center" },
    { label: "AWB", align: "left" },
    { label: "Factură", align: "left" },
    { label: "Data", align: "left" },
    { label: "Serviciu", align: "left" },
    { label: "kg", align: "right" },
    { label: "km", align: "right" },
    { label: "Liv.", align: "right" },
    { label: "Bază", align: "right" },
    { label: "Km+", align: "right" },
    { label: "Inc.", align: "right" },
    { label: "Wkd", align: "right" },
    { label: "Total client", align: "right" },
    { label: "", align: "center" },
  ] as const;

  return (
    <div
      className={`${GRID} sticky top-0 z-10 border-b border-ink-300 bg-canvas-200 text-[11px] font-semibold uppercase tracking-widest text-ink-700`}
    >
      {cols.map((c, i) => (
        <div
          key={i}
          className={`border-r border-ink-300 px-2 py-2 last:border-r-0 ${
            c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"
          }`}
        >
          {c.label}
        </div>
      ))}
    </div>
  );
}

/* ─── A single pair row ─────────────────────────────────────────────── */

function PairRow({
  index,
  pair,
  onPatch,
  onRemove,
  onSelect,
}: {
  index: number;
  pair: Pair;
  onPatch: (patch: PairPatch) => void;
  onRemove: () => void;
  onSelect: () => void;
}) {
  const status = pair.status;
  const isReady = status.kind === "ready";
  const isExtracting = status.kind === "extracting";

  const edits = isReady ? status.edits : null;
  const breakdown = isReady ? status.breakdown : null;
  const service = isReady ? status.service : null;

  const rowBg =
    status.kind === "error"
      ? "bg-coral-50/60 hover:bg-coral-50"
      : isExtracting
      ? "bg-canvas-100/60"
      : "bg-canvas-50 hover:bg-canvas-100";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          // Only navigate when the row itself is the target. If a child
          // input has focus, let it handle the key.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            onSelect();
          }
        }
      }}
      className={`${GRID} cursor-pointer border-b border-ink-200 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral-400 ${rowBg}`}
      title={status.kind === "error" ? status.message : "Click pentru detalii"}
    >
      {/* # */}
      <div className="flex items-center justify-center border-r border-ink-200 bg-canvas-100 px-2 py-2 text-[11px] tabular-nums text-ink-400">
        {index + 1}
      </div>

      {/* Status */}
      <div className="flex items-center justify-center border-r border-ink-200 px-2 py-2">
        <StatusPill status={status} />
      </div>

      {/* Image thumbs */}
      <div className="flex items-center justify-center border-r border-ink-200 px-2 py-1.5">
        <Thumbs files={pair.images} />
      </div>

      {/* AWB # */}
      <div className="flex items-center border-r border-ink-200 px-3 py-2 font-mono text-[12px] text-ink-800">
        {edits?.awb_number || <Dash />}
      </div>

      {/* Factură # */}
      <div className="flex items-center border-r border-ink-200 px-3 py-2 font-mono text-[12px] text-ink-800">
        <span className="flex-1 truncate">{edits?.invoice_number || <Dash />}</span>
        {edits?.invoice_is_duplicate && (
          <span className="ml-1 rounded bg-coral-100 px-1 py-0.5 text-[9px] font-medium uppercase text-coral-700">
            DUP
          </span>
        )}
      </div>

      {/* Data */}
      <div className="border-r border-ink-200">
        {isReady && edits ? (
          <DateCell value={edits.delivery_date} onChange={(v) => onPatch({ delivery_date: v })} />
        ) : (
          <PlaceholderCell />
        )}
      </div>

      {/* Serviciu */}
      <div className="border-r border-ink-200">
        {isReady && service ? (
          <SelectCell
            value={service}
            options={SERVICES}
            onChange={(v) => onPatch({ service: v as Service })}
            hint={
              status.serviceFallback
                ? `AWB: ${edits?.service_text || "—"} → Express`
                : edits?.service_text || undefined
            }
          />
        ) : (
          <PlaceholderCell />
        )}
      </div>

      {/* kg */}
      <div className="border-r border-ink-200">
        {isReady && edits ? (
          <NumberCell
            value={edits.weight_kg}
            step={0.01}
            min={0}
            onChange={(v) => onPatch({ weight_kg: v })}
          />
        ) : (
          <PlaceholderCell numeric />
        )}
      </div>

      {/* km */}
      <div className="border-r border-ink-200">
        {isReady && edits ? (
          <NumberCell
            value={edits.distance_extra_km}
            step={1}
            min={0}
            onChange={(v) => onPatch({ distance_extra_km: v })}
          />
        ) : (
          <PlaceholderCell numeric />
        )}
      </div>

      {/* Livrări */}
      <div className="border-r border-ink-200">
        {isReady && edits ? (
          <NumberCell
            value={edits.num_deliveries}
            step={1}
            min={1}
            integer
            onChange={(v) => onPatch({ num_deliveries: Math.max(1, Math.floor(v)) })}
          />
        ) : (
          <PlaceholderCell numeric />
        )}
      </div>

      {/* Bază — always present once the row is ready */}
      <NumericCell value={breakdown?.baseTariff} />
      {/* Km+ — only applies for >50 km bucket */}
      <ConditionalCell
        value={breakdown?.extraKmCost}
        ready={!!breakdown}
        notAppliedReason="Distanță ≤ 50 km — nu se aplică suplimentul per km."
      />
      {/* Inc. — only applies when num_deliveries > 1 */}
      <ConditionalCell
        value={breakdown?.incrementCost}
        ready={!!breakdown}
        notAppliedReason="O singură livrare — incrementul se aplică doar de la a doua livrare."
      />
      {/* Wkd — only applies on Saturday / Sunday */}
      <ConditionalCell
        value={breakdown?.weekendSurcharge}
        ready={!!breakdown}
        notAppliedReason="Livrare în zi lucrătoare — fără supliment de weekend."
      />

      {/* Total client — what the END customer pays (carrier total
          + Ploiești commission). The carrier subtotal is still in
          PairDetail, but the single column on the queue grid is the
          customer-facing one because that's what the user reads off
          to invoice. */}
      <div
        className={`flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums ${
          breakdown
            ? "bg-coral-50 text-base font-bold text-coral-700"
            : "text-ink-400"
        }`}
        title={
          breakdown
            ? `Tarif transportator ${ron(breakdown.totalVat21)} + comision ${ron(breakdown.commission)}`
            : undefined
        }
      >
        {breakdown ? ron(breakdown.customerTotal) : <Dash />}
      </div>

      {/* Remove */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        title="Șterge pereche"
        className="flex items-center justify-center py-2 text-ink-400 transition hover:text-coral-600"
      >
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
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

/* ─── Footer sum row ────────────────────────────────────────────────── */

function SumRow({
  total,
  readyCount,
  totalCount,
}: {
  total: number;
  readyCount: number;
  totalCount: number;
}) {
  if (totalCount === 0) return null;
  return (
    <div className={`${GRID} sticky bottom-0 bg-coral-500 text-canvas-50`}>
      <div className="border-r border-coral-600 px-2 py-2.5 text-center text-[11px] tabular-nums opacity-80">
        Σ
      </div>
      <div className="col-span-13 border-r border-coral-600 px-3 py-2.5 text-right text-sm font-semibold uppercase tracking-wide">
        Total {readyCount} / {totalCount} perech{totalCount === 1 ? "e" : "i"}
      </div>
      <div className="border-r border-coral-600 px-3 py-2.5 text-right text-base font-bold tabular-nums">
        {ron(total)}
      </div>
      <div />
    </div>
  );
}

/* ─── Primitives ─────────────────────────────────────────────────────── */

function StatusPill({ status }: { status: PairStatus }) {
  switch (status.kind) {
    case "pending":
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-canvas-100"
          title="În aşteptare"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-ink-400" />
        </span>
      );
    case "extracting":
      return (
        <svg className="h-4 w-4 animate-spin text-coral-500" viewBox="0 0 24 24" fill="none" aria-label="Extrag…">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
    case "ready":
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-coral-500 text-canvas-50"
          title="Calculat"
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      );
    case "error":
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-coral-700 text-canvas-50"
          title={status.message}
        >
          !
        </span>
      );
  }
}

function Thumbs({ files }: { files: File[] }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f));
    setUrls(u);
    return () => u.forEach(URL.revokeObjectURL);
  }, [files]);
  return (
    <div className="flex gap-0.5">
      {urls.map((u, i) => (
        <img
          key={u}
          src={u}
          alt={`Imagine ${i + 1}`}
          title={files[i]?.name}
          className="h-9 w-6 rounded-sm object-cover ring-1 ring-ink-200"
        />
      ))}
    </div>
  );
}

function Dash() {
  return <span className="text-ink-400">—</span>;
}

function PlaceholderCell({ numeric }: { numeric?: boolean }) {
  return (
    <div
      className={`flex h-full items-center px-3 py-2 text-ink-400 ${
        numeric ? "justify-end tabular-nums" : ""
      }`}
    >
      —
    </div>
  );
}

function NumericCell({ value, faded }: { value: number | null | undefined; faded?: boolean }) {
  return (
    <div
      className={`flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums ${
        value == null
          ? "text-ink-400"
          : faded
          ? "text-ink-500"
          : "text-ink-900"
      }`}
    >
      {value == null ? "—" : ron(value)}
    </div>
  );
}

/**
 * Conditional surcharge cell: renders "—" both before extraction (no
 * breakdown yet) and when the breakdown says the surcharge doesn't
 * apply (value === 0). The tooltip explains WHY, so the user reads it
 * as "the rule didn't fire" instead of "the column is broken".
 */
function ConditionalCell({
  value,
  ready,
  notAppliedReason,
}: {
  value: number | null | undefined;
  ready: boolean;
  notAppliedReason: string;
}) {
  if (!ready) {
    return (
      <div className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400">
        —
      </div>
    );
  }
  const active = (value ?? 0) > 0;
  return (
    <div
      title={active ? undefined : notAppliedReason}
      className={`flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums ${
        active ? "text-ink-900" : "text-ink-400"
      }`}
    >
      {active ? ron(value!) : "—"}
    </div>
  );
}

/* ─── Editable cell primitives ──────────────────────────────────────── */

/* All three editable primitives stop click/mousedown bubbling so the
 * surrounding row's navigation click never fires when the user is
 * interacting with the field itself. */
const stop = (e: SyntheticEvent) => e.stopPropagation();

function NumberCell({
  value,
  step,
  min,
  integer,
  onChange,
}: {
  value: number;
  step: number;
  min: number;
  integer?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      onClick={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onChange={(e) => {
        const raw = Number(e.target.value);
        if (!Number.isFinite(raw)) return;
        onChange(integer ? Math.floor(raw) : raw);
      }}
      className="block h-full w-full bg-coral-50/30 px-3 py-2 text-right text-sm tabular-nums text-ink-900 outline-none transition focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    />
  );
}

function DateCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="date"
      value={value}
      onClick={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onChange={(e) => onChange(e.target.value)}
      title={date(value)}
      className="block h-full w-full bg-coral-50/30 px-3 py-2 text-sm text-ink-900 outline-none transition focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    />
  );
}

function SelectCell({
  value,
  options,
  onChange,
  hint,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <select
      value={value}
      onClick={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onChange={(e) => onChange(e.target.value)}
      title={hint}
      className="block h-full w-full bg-coral-50/30 px-3 py-2 text-sm text-ink-900 outline-none transition focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

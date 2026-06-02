import { useEffect, useState, type ReactNode } from "react";
import type { Extracted, Pair, PairPatch, PairStatus, Service } from "../types";
import { date, ron } from "../lib/format";

const SERVICES: Service[] = ["Express", "Premium", "Prestabilita"];

interface Props {
  pair: Pair;
  index: number;
  onPatch: (patch: PairPatch) => void;
  onBack: () => void;
  onRemove: () => void;
}

/* ──────────────────────────────────────────────────────────────────────
 * Per-pair detail page
 *
 * Two-column layout:
 *   • Left: the two original images at full size, stacked, with a
 *     "click to view" lightbox.
 *   • Right: a section-by-section spreadsheet with every extracted
 *     field, the invoice items table, and the full Excel column
 *     breakdown (E, H, K, L, M, N, O, P) ending with the billable
 *     total row in coral.
 *
 * For pairs that haven't been processed yet we still render the images
 * and a status placeholder so the user can verify they uploaded the
 * right pair before pressing Calculează.
 * ────────────────────────────────────────────────────────────────────── */
export function PairDetail({ pair, index, onPatch, onBack, onRemove }: Props) {
  const status = pair.status;
  const title =
    status.kind === "ready"
      ? `Pereche #${index + 1} · AWB ${status.edits.awb_number}`
      : `Pereche #${index + 1}`;

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader title={title} status={status} onBack={onBack} onRemove={onRemove} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="lg:col-span-5 xl:col-span-4">
          <ImageGallery files={pair.images} />
        </aside>

        <section className="lg:col-span-7 xl:col-span-8">
          {status.kind === "ready" ? (
            <Spreadsheet
              data={status.edits}
              service={status.service}
              serviceFallback={status.serviceFallback}
              breakdown={status.breakdown}
              onPatch={onPatch}
            />
          ) : (
            <StatusPlaceholder status={status} />
          )}
        </section>
      </div>
    </div>
  );
}

/* ─── Header bar ────────────────────────────────────────────────────── */

function DetailHeader({
  title,
  status,
  onBack,
  onRemove,
}: {
  title: string;
  status: PairStatus;
  onBack: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-canvas-50 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900"
          title="Înapoi la lista de perechi (Esc)"
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
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Înapoi
        </button>
        <h2 className="text-lg font-semibold tracking-tight text-ink-900">{title}</h2>
        <StatusBadge status={status} />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1.5 rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-coral-50 hover:text-coral-700"
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
          Şterge pereche
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: PairStatus }) {
  switch (status.kind) {
    case "pending":
      return (
        <span className="rounded bg-canvas-200 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-ink-600">
          În așteptare
        </span>
      );
    case "extracting":
      return (
        <span className="inline-flex items-center gap-1.5 rounded bg-coral-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-coral-700">
          <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
            <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Procesare
        </span>
      );
    case "ready":
      return (
        <span className="rounded bg-coral-500 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-canvas-50">
          Calculat
        </span>
      );
    case "error":
      return (
        <span className="rounded bg-coral-700 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-canvas-50">
          Eroare
        </span>
      );
  }
}

/* ─── Image gallery ─────────────────────────────────────────────────── */

function ImageGallery({ files }: { files: File[] }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    const list = files.map((f) => URL.createObjectURL(f));
    setUrls(list);
    return () => list.forEach(URL.revokeObjectURL);
  }, [files]);

  // Close lightbox on Esc.
  useEffect(() => {
    if (!zoomed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setZoomed(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  return (
    <>
      <div className="space-y-4">
        {urls.map((u, i) => (
          <figure
            key={u}
            className="overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-ink-200 bg-canvas-100 px-3 py-1.5 text-[11px] uppercase tracking-widest text-ink-500">
              <span>Imagine {i + 1}</span>
              <span className="truncate text-ink-400 normal-case tracking-normal">
                {files[i] ? `${(files[i]!.size / 1024).toFixed(0)} KB` : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setZoomed(u)}
              className="block w-full cursor-zoom-in focus:outline-none"
              title="Click pentru a mări"
            >
              <img src={u} alt={`Imagine ${i + 1}`} className="block w-full" />
            </button>
          </figure>
        ))}
      </div>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/80 p-6"
          onClick={() => setZoomed(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={zoomed}
            alt="Pre-vizualizare mărită"
            className="max-h-full max-w-full cursor-zoom-out object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

/* ─── Status placeholder (non-ready states) ─────────────────────────── */

function StatusPlaceholder({ status }: { status: Exclude<PairStatus, { kind: "ready" }> }) {
  const messages: Record<typeof status.kind, { title: string; body: string }> = {
    pending: {
      title: "Pereche neprocesată",
      body: "Apasă butonul „Calculează” (sau Enter) pentru a extrage datele și a calcula tariful.",
    },
    extracting: {
      title: "Se procesează…",
      body: "Modelul vizual identifică AWB-ul și factura și extrage câmpurile. Aşteaptă câteva secunde.",
    },
    error: {
      title: "Eroare la extracție",
      body: status.kind === "error" ? status.message : "Eroare necunoscută.",
    },
  };
  const m = messages[status.kind];

  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-ink-200 bg-canvas-50 text-center shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-wider text-ink-600">{m.title}</p>
      <p className="max-w-md px-6 text-sm text-ink-500 whitespace-pre-wrap">{m.body}</p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Section-by-section spreadsheet (per-pair version)
 * ────────────────────────────────────────────────────────────────────── */

const ROW_GRID = "grid grid-cols-[44px_minmax(200px,1fr)_minmax(220px,2fr)]";

function Spreadsheet({
  data,
  service,
  serviceFallback,
  breakdown,
  onPatch,
}: {
  data: Extracted;
  service: Service;
  serviceFallback: boolean;
  breakdown: { baseKey: string; weightBucket: string; distanceBucket: string; extraKm: number; baseTariff: number; extraKmCost: number; incrementKey: string; incrementCost: number; weekendSurcharge: number; totalVat19: number; net: number; vat21: number; totalVat21: number; commissionPct: number; commission: number; customerTotal: number };
  onPatch: (patch: PairPatch) => void;
}) {
  let row = 0;
  const r = () => ++row;

  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
      <ColumnHeader />

      <Section title="AWB" />
      <DataRow n={r()} label="Număr AWB" value={data.awb_number} />
      <DataRow n={r()} label="Data livrare" editable>
        <DateCell value={data.delivery_date} onChange={(v) => onPatch({ delivery_date: v })} />
      </DataRow>
      <DataRow
        n={r()}
        label="Serviciu (AWB)"
        value={data.service_text || "—"}
        hint={serviceFallback ? "necunoscut → Express" : undefined}
      />
      <DataRow n={r()} label="Serviciu (calcul)" editable>
        <SelectCell
          value={service}
          options={SERVICES}
          onChange={(v) => onPatch({ service: v as Service })}
        />
      </DataRow>
      <DataRow n={r()} label="Greutate (kg)" editable>
        <NumberCell
          value={data.weight_kg}
          step={0.01}
          min={0}
          onChange={(v) => onPatch({ weight_kg: v })}
        />
      </DataRow>
      <DataRow n={r()} label="Distanță extra (km)" editable>
        <NumberCell
          value={data.distance_extra_km}
          step={1}
          min={0}
          onChange={(v) => onPatch({ distance_extra_km: v })}
        />
      </DataRow>
      <DataRow n={r()} label="Număr livrări" editable>
        <NumberCell
          value={data.num_deliveries}
          step={1}
          min={1}
          integer
          onChange={(v) => onPatch({ num_deliveries: Math.max(1, Math.floor(v)) })}
        />
      </DataRow>
      <DataRow n={r()} label="Tip expediție" value={data.shipment_type} />
      <DataRow n={r()} label="Hub destinație" value={data.hub_destination} />
      <DataRow n={r()} label="Cod conținut" value={data.content_code} />
      <DataRow n={r()} label="Expeditor" value={data.sender_name} />
      <DataRow n={r()} label="Telefon expeditor" value={data.sender_phone} />
      <DataRow n={r()} label="Adresa expeditor" value={data.sender_address} />
      <DataRow n={r()} label="Destinatar" value={data.recipient_name} />
      <DataRow n={r()} label="Telefon destinatar" value={data.recipient_phone} />
      <DataRow n={r()} label="Adresa destinatar" value={data.recipient_address} />

      <Section title="Factură" />
      <DataRow
        n={r()}
        label="Număr factură"
        value={data.invoice_number}
        badge={data.invoice_is_duplicate ? "DUPLICAT" : undefined}
      />
      <DataRow n={r()} label="Data factură" value={date(data.invoice_date)} />
      <DataRow n={r()} label="Furnizor" value={data.supplier_name} />
      <DataRow n={r()} label="CIF furnizor" value={data.supplier_cui} />
      <DataRow n={r()} label="Cumpărător" value={data.buyer_name} />
      <DataRow n={r()} label="CIF cumpărător" value={data.buyer_cui} />
      <DataRow n={r()} label="Nr. comandă" value={data.order_number} />
      <DataRow
        n={r()}
        label="Total fără TVA"
        value={data.invoice_total_net != null ? ron(data.invoice_total_net) : "—"}
        numeric
      />
      <DataRow
        n={r()}
        label="TVA (factură)"
        value={data.invoice_total_vat != null ? ron(data.invoice_total_vat) : "—"}
        numeric
      />
      <DataRow
        n={r()}
        label="Total cu TVA (factură)"
        value={data.invoice_total_gross != null ? ron(data.invoice_total_gross) : "—"}
        numeric
      />

      {data.items.length > 0 && (
        <>
          <Section title={`Articole factură (${data.items.length})`} />
          <ItemsHeader />
          {data.items.map((it, i) => {
            row += 1;
            return <ItemRow key={i} n={row} item={it} />;
          })}
        </>
      )}

      <Section title="Calcul tarif — coloane Excel" />
      <DataRow n={r()} label="Cheie tarif" value={breakdown.baseKey} />
      <DataRow n={r()} label="Bucket greutate" value={breakdown.weightBucket} />
      <DataRow n={r()} label="Bucket distanță" value={breakdown.distanceBucket} />
      <DataRow
        n={r()}
        label="Tarif bază (col. E · TVA 19%)"
        value={ron(breakdown.baseTariff)}
        numeric
      />
      {breakdown.extraKmCost > 0 ? (
        <DataRow
          n={r()}
          label={`Cost km extra (col. H · ${breakdown.extraKm} km × 1.70 × 2)`}
          value={ron(breakdown.extraKmCost)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Cost km extra (col. H)"
          value="— · distanță ≤ 50 km"
          numeric
          muted
        />
      )}
      {breakdown.incrementCost > 0 ? (
        <DataRow
          n={r()}
          label={`Cost increment (col. K · ${breakdown.incrementKey})`}
          value={ron(breakdown.incrementCost)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Cost increment (col. K)"
          value="— · o singură livrare"
          numeric
          muted
        />
      )}
      {breakdown.weekendSurcharge > 0 ? (
        <DataRow
          n={r()}
          label="Supliment weekend (col. L)"
          value={ron(breakdown.weekendSurcharge)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Supliment weekend (col. L)"
          value="— · zi lucrătoare"
          numeric
          muted
        />
      )}
      <DataRow
        n={r()}
        label="Total cu TVA 19% (col. M)"
        value={ron(breakdown.totalVat19)}
        numeric
        muted
      />
      <DataRow n={r()} label="Net (col. N)" value={ron(breakdown.net)} numeric muted />
      <DataRow n={r()} label="TVA 21% (col. O)" value={ron(breakdown.vat21)} numeric muted />
      {/* Carrier subtotal — what Stalexone (transportator) gets.
          Used to be the billable line; now it's an intermediate
          number, surfaced muted so the eye walks to the final
          customer total below. */}
      <DataRow
        n={r()}
        label="Tarif transportator (col. P)"
        value={ron(breakdown.totalVat21)}
        numeric
        muted
      />
      {/* Commission — the percentage and source live in
          `commissionPct`/`commission` so the label stays clean and a
          future tariff tweak re-renders without a UI patch. */}
      <DataRow
        n={r()}
        label="Comision"
        value={ron(breakdown.commission)}
        numeric
        muted
      />
      {/* Bottom line — what the END customer pays. This is the
          number the user reads off to invoice. */}
      <TotalRow n={r()} label="TOTAL CLIENT" value={ron(breakdown.customerTotal)} />
    </div>
  );
}

function ColumnHeader() {
  return (
    <div
      className={`${ROW_GRID} border-b border-ink-300 bg-canvas-200 text-[11px] font-semibold uppercase tracking-widest text-ink-700`}
    >
      <div className="border-r border-ink-300 px-2 py-2 text-center text-ink-400">·</div>
      <div className="border-r border-ink-300 px-3 py-2">A · Câmp</div>
      <div className="px-3 py-2">B · Valoare</div>
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className={`${ROW_GRID} border-b border-t border-ink-200 bg-canvas-200/60`}>
      <div className="border-r border-ink-200 bg-canvas-200 px-2 py-1.5 text-center text-[11px] tabular-nums text-ink-400">
        ▸
      </div>
      <div className="col-span-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-coral-700">
        {title}
      </div>
    </div>
  );
}

interface DataRowProps {
  n: number;
  label: string;
  value?: string | number | null;
  editable?: boolean;
  numeric?: boolean;
  muted?: boolean;
  hint?: string;
  badge?: string;
  children?: ReactNode;
}

function DataRow({ n, label, value, editable, numeric, muted, hint, badge, children }: DataRowProps) {
  return (
    <div
      className={`${ROW_GRID} border-b border-ink-200 text-sm transition hover:bg-canvas-100 ${
        muted ? "bg-canvas-100/60" : "bg-canvas-50"
      }`}
    >
      <div className="flex items-center justify-center border-r border-ink-200 bg-canvas-100 px-2 py-1 text-[11px] tabular-nums text-ink-400">
        {n}
      </div>
      <div className="flex items-center justify-between gap-2 border-r border-ink-200 px-3 py-1 text-ink-700">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] uppercase tracking-wider text-coral-600">{hint}</span>
        )}
      </div>
      <div
        className={`flex items-center ${numeric ? "justify-end" : ""} gap-2 px-3 py-1 ${
          muted ? "text-ink-600" : "text-ink-900"
        } ${numeric ? "tabular-nums" : ""} ${editable ? "p-0" : ""}`}
      >
        {children ?? (
          <>
            <span
              className={
                value === null || value === undefined || value === "" ? "text-ink-400" : ""
              }
            >
              {value === null || value === undefined || value === "" ? "—" : value}
            </span>
            {badge && (
              <span className="rounded bg-coral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-coral-700">
                {badge}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TotalRow({ n, label, value }: { n: number; label: string; value: string }) {
  return (
    <div className={`${ROW_GRID} bg-coral-500 text-canvas-50`}>
      <div className="flex items-center justify-center border-r border-coral-600 px-2 py-2.5 text-[11px] tabular-nums opacity-80">
        {n}
      </div>
      <div className="flex items-center border-r border-coral-600 px-3 py-2.5 text-sm font-semibold uppercase tracking-wide">
        {label}
      </div>
      <div className="flex items-center justify-end px-3 py-2.5 text-xl font-bold tabular-nums">
        {value}
      </div>
    </div>
  );
}

/* ─── Items sub-grid ─────────────────────────────────────────────────── */

const ITEMS_GRID = "grid grid-cols-[44px_minmax(0,1fr)_70px_70px_100px_110px]";

function ItemsHeader() {
  return (
    <div
      className={`${ITEMS_GRID} border-b border-ink-200 bg-canvas-200 text-[11px] font-semibold uppercase tracking-widest text-ink-700`}
    >
      <div className="border-r border-ink-300 px-2 py-1.5 text-center text-ink-400">·</div>
      <div className="border-r border-ink-300 px-3 py-1.5">Produs</div>
      <div className="border-r border-ink-300 px-3 py-1.5 text-right">Cant.</div>
      <div className="border-r border-ink-300 px-3 py-1.5 text-right">U.M.</div>
      <div className="border-r border-ink-300 px-3 py-1.5 text-right">PU net</div>
      <div className="px-3 py-1.5 text-right">Val. net</div>
    </div>
  );
}

function ItemRow({ n, item }: { n: number; item: Extracted["items"][number] }) {
  return (
    <div
      className={`${ITEMS_GRID} border-b border-ink-200 bg-canvas-50 text-sm transition hover:bg-canvas-100`}
    >
      <div className="flex items-center justify-center border-r border-ink-200 bg-canvas-100 px-2 py-1 text-[11px] tabular-nums text-ink-400">
        {n}
      </div>
      <div className="border-r border-ink-200 px-3 py-1 text-ink-800">{item.name}</div>
      <div className="border-r border-ink-200 px-3 py-1 text-right tabular-nums text-ink-800">
        {item.quantity}
      </div>
      <div className="border-r border-ink-200 px-3 py-1 text-right text-ink-700">
        {item.unit ?? "—"}
      </div>
      <div className="border-r border-ink-200 px-3 py-1 text-right tabular-nums text-ink-800">
        {item.unit_price_net.toFixed(2)}
      </div>
      <div className="px-3 py-1 text-right tabular-nums text-ink-800">
        {item.value_net.toFixed(2)}
      </div>
    </div>
  );
}

/* ─── Editable cell primitives ──────────────────────────────────────── */

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
      onChange={(e) => {
        const raw = Number(e.target.value);
        if (!Number.isFinite(raw)) return;
        onChange(integer ? Math.floor(raw) : raw);
      }}
      className="block w-full bg-coral-50/40 px-3 py-1 text-right text-sm tabular-nums text-ink-900 outline-none focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    />
  );
}

function DateCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full bg-coral-50/40 px-3 py-1 text-sm text-ink-900 outline-none focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    />
  );
}

function SelectCell({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full bg-coral-50/40 px-3 py-1 text-sm text-ink-900 outline-none focus:bg-coral-50 focus:ring-2 focus:ring-inset focus:ring-coral-400"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

import { useEffect, useState, type SyntheticEvent } from "react";
import {
  COLLABORATOR_LABEL,
  COLLABORATOR_SHORT_LABEL,
  primaryDispatchSite,
  type CityKey,
  type CityCommissionKey,
  type CollaboratorKey,
  type Extracted,
  type Pair,
  type PairPatch,
  type PairStatus,
  type PricingBreakdown,
  type Service,
} from "../types";
import { date, ron } from "../lib/format";
import { usePairImages } from "../lib/images";
import { ProductBadge } from "./ProductCheck";

const SERVICES: Service[] = ["Express", "Premium", "Prestabilita"];

/* Columns auto-fit to their content, Excel-style. Each track is sized
 * so the cell never clips and never spills past its border, no matter
 * how long the value inside it is.
 *
 * Three kinds of column:
 *
 *  • Icon / fixed columns (#, Stare, Imagini, ✕) stay at a fixed px
 *    width — their content is a fixed-size glyph, never text that grows.
 *
 *  • Editable columns (Data, Serviciu, kg, km, Liv.) stay at a fixed px
 *    width too — they hold <input>/<select> controls, which clip their
 *    own overflow internally and so can never spill past the cell.
 *
 *  • Display columns size to content. The numeric/total columns use
 *    `minmax(<floor>px, max-content)`: at least wide enough for the
 *    header label, but they grow to fit the widest RON value in that
 *    column across every row (e.g. "1.234,56 RON" no longer overflows
 *    an 88 px cell). The two free-text columns (AWB #, Factură #) use
 *    `minmax(max-content, 1fr)`: never narrower than their content (so
 *    long AWB/invoice numbers are shown in full, not truncated) and
 *    they absorb any leftover width so the grid, borders, header and
 *    sticky coral total row all extend cleanly to the right edge.
 *
 * The wrapper keeps `min-w-[1500px]` so the table scrolls horizontally
 * on narrow windows instead of crushing the auto-fit columns. */
const GRID =
  "grid grid-cols-[40px_56px_64px_minmax(max-content,1fr)_minmax(max-content,1fr)_120px_120px_72px_72px_60px_minmax(88px,max-content)_minmax(72px,max-content)_minmax(72px,max-content)_minmax(72px,max-content)_minmax(120px,max-content)_minmax(140px,max-content)_36px]";

interface Props {
  pairs: Pair[];
  /** Customer city the user picked in the header. Drives col 15 (Total
   *  client) — one dispatch site per city (Iași Tudor and Iași ERA are
   *  separate top-level options now). */
  city: CityKey;
  /** Collaborator the user picked in the header. Drives col 16 (Plată
   *  colab.) and its footer sum. `null` means "no collaborator"
   *  (Constanța is the only city in that situation today) — the
   *  column renders "—" and the sum is skipped. */
  collaborator: CollaboratorKey | null;
  onPatchPair: (id: string, patch: PairPatch) => void;
  onRemovePair: (id: string) => void;
  /** Opens the per-pair detail page. The row is the click target — form
   *  controls and the remove button stop propagation, so editing or
   *  deleting never accidentally navigates. */
  onSelectPair: (id: string) => void;
  /** Pair ids whose Leroy Merlin product check is currently running —
   *  drives the per-row spinner before the warning/ok icon resolves. */
  verifyingIds: Set<string>;
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
export function PairsTable({
  pairs,
  city,
  collaborator,
  onPatchPair,
  onRemovePair,
  onSelectPair,
  verifyingIds,
}: Props) {
  // City dropdown → single dispatch-site key. The server already
  // calculates customerTotal for ALL four sites in `breakdown
  // .cityCommissions`, so switching this dropdown is a pure display
  // flip — no recompute.
  const site = primaryDispatchSite(city);

  // Footer sums — one for the selected city's customerTotal, one for
  // the selected collaborator's payout. Walk the queue once and
  // accumulate both in parallel; readyCount falls out of the same pass.
  // When there's no collaborator (city = Constanța) `sumCollab` stays
  // at 0 and the cell renders "—".
  let sumCity = 0;
  let sumCollab = 0;
  let readyCount = 0;
  for (const p of pairs) {
    if (p.status.kind !== "ready") continue;
    readyCount += 1;
    const b = p.status.breakdown;
    // Macara runs carry no commission/collaborator — their bottom line IS the
    // macara total, summed into the same client column.
    if (b.macara?.isMacara) {
      sumCity += (b.macaraByCity?.[site] ?? b.macara).total;
      continue;
    }
    sumCity += b.cityCommissions[site]?.customerTotal ?? 0;
    if (collaborator) {
      sumCollab += b.collaboratorPrices[collaborator]?.total ?? 0;
    }
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
      <div className="min-w-[1500px]">
        <Header collaborator={collaborator} />
        {pairs.map((p, i) => (
          <PairRow
            key={p.id}
            index={i}
            pair={p}
            site={site}
            collaborator={collaborator}
            onPatch={(patch) => onPatchPair(p.id, patch)}
            onRemove={() => onRemovePair(p.id)}
            onSelect={() => onSelectPair(p.id)}
            verifying={verifyingIds.has(p.id)}
          />
        ))}
        <SumRow
          sumCity={sumCity}
          sumCollab={sumCollab}
          collaborator={collaborator}
          readyCount={readyCount}
          totalCount={pairs.length}
        />
      </div>
    </div>
  );
}

/* ─── Header ────────────────────────────────────────────────────────── */

function Header({ collaborator }: { collaborator: CollaboratorKey | null }) {
  // 17 columns. The penultimate one (Plată colab.) needs special
  // rendering — it's a two-line header so the collaborator's name fits
  // even when it's the longest ("Vic Dinamic") without forcing the
  // column wider than its content needs.
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
  ] as const;

  return (
    <div
      className={`${GRID} sticky top-0 z-10 border-b border-ink-300 bg-canvas-200 text-[11px] font-semibold uppercase tracking-widest text-ink-700`}
    >
      {cols.map((c, i) => (
        <div
          key={i}
          className={`border-r border-ink-300 px-2 py-2 ${
            c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left"
          }`}
        >
          {c.label}
        </div>
      ))}
      <div
        className="flex flex-col items-end justify-center border-r border-ink-300 px-2 py-1 leading-tight"
        title={
          collaborator
            ? `Plată colaborator: ${COLLABORATOR_LABEL[collaborator]}`
            : "Constanța · fără colaborator"
        }
      >
        <span>Plată colab.</span>
        <span className="text-[9px] font-medium normal-case tracking-normal text-ink-500">
          {collaborator ? COLLABORATOR_SHORT_LABEL[collaborator] : "—"}
        </span>
      </div>
      <div className="px-2 py-2 text-center" />
    </div>
  );
}

/* ─── A single pair row ─────────────────────────────────────────────── */

function PairRow({
  index,
  pair,
  site,
  collaborator,
  onPatch,
  onRemove,
  onSelect,
  verifying,
}: {
  index: number;
  pair: Pair;
  site: CityCommissionKey;
  collaborator: CollaboratorKey | null;
  onPatch: (patch: PairPatch) => void;
  onRemove: () => void;
  onSelect: () => void;
  verifying: boolean;
}) {
  const status = pair.status;
  const isReady = status.kind === "ready";
  const isExtracting = status.kind === "extracting";

  const edits = isReady ? status.edits : null;
  const breakdown = isReady ? status.breakdown : null;
  const service = isReady ? status.service : null;
  // Macara run → no standard cost columns, no commission/collaborator.
  const isMac = !!breakdown?.macara?.isMacara;

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
        <Thumbs pair={pair} />
      </div>

      {/* AWB # + product-check badge (warning / ok / spinner) */}
      <div className="flex items-center gap-1.5 border-r border-ink-200 px-3 py-2 font-mono text-[12px] text-ink-800">
        <span className="flex-1 whitespace-nowrap">{edits?.awb.awb_number || <Dash />}</span>
        {breakdown?.macara?.isMacara && <MacaraChip warning={breakdown.macara.warning} />}
        <ProductBadge
          verification={status.kind === "ready" ? status.verification : undefined}
          routing={status.kind === "ready" ? status.routing : undefined}
          verifying={verifying}
        />
      </div>

      {/* Factură # — for a pair carrying multiple invoices we show the
          first invoice number with a "+N" badge so the row stays
          single-line. The detail view lists every invoice in full. */}
      <FacturaCell edits={edits} />

      {/* Data */}
      <div className="border-r border-ink-200">
        {isReady && edits ? (
          <DateCell value={edits.awb.delivery_date} onChange={(v) => onPatch({ delivery_date: v })} />
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
                ? `AWB: ${edits?.awb.service_text || "—"} → Express`
                : edits?.awb.service_text || undefined
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
            value={edits.awb.weight_kg}
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
            value={edits.awb.distance_extra_km}
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
            value={edits.awb.num_deliveries}
            step={1}
            min={1}
            integer
            onChange={(v) => onPatch({ num_deliveries: Math.max(1, Math.floor(v)) })}
          />
        ) : (
          <PlaceholderCell numeric />
        )}
      </div>

      {/* Bază / Km+ / Inc. / Wkd — standard transport calc. Macara runs
          carry no standard tariff or commission, so these four cells read
          "—" for a macara row (its price is the macara total only). */}
      {isMac ? (
        <>
          <MacaraNaCell />
          <MacaraNaCell />
          <MacaraNaCell />
          <MacaraNaCell />
        </>
      ) : (
        <>
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
        </>
      )}

      {/* Total client — what the END customer pays for the currently
          selected city. One number per row; the dropdown switches WHICH
          city's number is shown (Ploiești 50.1%, Iași Tudor 33.7%, Iași
          ERA 33.7%, Constanța 33.7%) without recomputing — every city's
          customerTotal is in the breakdown already. */}
      <CityTotalCell breakdown={breakdown} site={site} />

      {/* Plată colab. — what the selected courier-side collaborator
          gets paid for this row. Same coral accent as the customer
          total because both are bottom-line numbers; the column
          header carries the collaborator name so the user knows
          whose total this is. */}
      <CollaboratorTotalCell breakdown={breakdown} collaborator={collaborator} />

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
  sumCity,
  sumCollab,
  collaborator,
  readyCount,
  totalCount,
}: {
  sumCity: number;
  sumCollab: number;
  collaborator: CollaboratorKey | null;
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
      <div className="flex items-center justify-end border-r border-coral-600 px-3 py-2.5 text-right text-base font-bold tabular-nums">
        {ron(sumCity)}
      </div>
      <div
        className="flex items-center justify-end border-r border-coral-600 px-3 py-2.5 text-right text-base font-bold tabular-nums"
        title={collaborator ? undefined : "Constanța · fără colaborator"}
      >
        {collaborator ? ron(sumCollab) : "—"}
      </div>
      <div />
    </div>
  );
}

/* ─── Factură cell ──────────────────────────────────────────────────── */

/**
 * Single-line invoice column for a row.
 *
 * A pair carries N invoices; the cell still needs to fit on one row of
 * the queue table, so we show the FIRST invoice's number, mark it
 * DUPLICAT if applicable, and append a compact "+N" badge when there
 * are more invoices below. The detail view is where the full list
 * lives — this cell exists to identify the row at a glance.
 */
function FacturaCell({ edits }: { edits: Extracted | null }) {
  if (!edits || edits.invoices.length === 0) {
    return (
      <div className="flex items-center border-r border-ink-200 px-3 py-2 font-mono text-[12px] text-ink-800">
        <Dash />
      </div>
    );
  }
  const first = edits.invoices[0]!;
  const extras = edits.invoices.length - 1;
  return (
    <div
      className="flex items-center border-r border-ink-200 px-3 py-2 font-mono text-[12px] text-ink-800"
      title={
        extras > 0
          ? edits.invoices.map((i) => i.invoice_number).join(" · ")
          : undefined
      }
    >
      <span className="flex-1 whitespace-nowrap">{first.invoice_number || <Dash />}</span>
      {first.invoice_is_duplicate && (
        <span className="ml-1 rounded bg-coral-100 px-1 py-0.5 text-[9px] font-medium uppercase text-coral-700">
          DUP
        </span>
      )}
      {extras > 0 && (
        <span
          className="ml-1 rounded bg-ink-200 px-1 py-0.5 text-[9px] font-medium text-ink-700"
          title={`${extras + 1} facturi pe această pereche`}
        >
          +{extras}
        </span>
      )}
    </div>
  );
}

/* ─── City + collaborator total cells ───────────────────────────────── */

/**
 * Customer-total cell. Renders `customerTotal` for the currently-picked
 * city's single dispatch site. One number; the city dropdown picks
 * which one to show.
 */
function CityTotalCell({
  breakdown,
  site,
}: {
  breakdown: PricingBreakdown | null;
  site: CityCommissionKey;
}) {
  if (!breakdown) {
    return (
      <div className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400">
        <Dash />
      </div>
    );
  }
  // Macara run: the client pays the macara total directly (no commission).
  // Use the selected city's macara table (Ploiești + Iași ERA differ from
  // Iași Tudor + Constanța), falling back to the pair's resolved store.
  if (breakdown.macara?.isMacara) {
    const m = breakdown.macaraByCity?.[site] ?? breakdown.macara;
    return (
      <div
        className="flex items-center justify-end border-r border-ink-200 bg-coral-50 px-3 py-2 text-right text-base font-bold tabular-nums text-coral-700"
        title={`Tarif macara (cu TVA, fără comision) — ${m.distanceBucket ?? "—"}, ${m.pallets} palet(i)`}
      >
        {ron(m.total)}
      </div>
    );
  }
  const carrierTip = `Tarif transportator ${ron(breakdown.carrierTotal)}`;
  const row = breakdown.cityCommissions[site];
  return (
    <div
      className="flex items-center justify-end border-r border-ink-200 bg-coral-50 px-3 py-2 text-right text-base font-bold tabular-nums text-coral-700"
      title={
        row
          ? `${carrierTip} + comision ${ron(row.commission)} (${(row.pct * 100).toFixed(1)} %)`
          : carrierTip
      }
    >
      {row ? ron(row.customerTotal) : <Dash />}
    </div>
  );
}

/** Collaborator payout cell — single number, mirrors the customer-total
 *  cell's coral accent so both bottom-line numbers read at the same
 *  visual weight. Renders "—" when no collaborator is configured for
 *  the city (Constanța) so the column still aligns. */
function CollaboratorTotalCell({
  breakdown,
  collaborator,
}: {
  breakdown: PricingBreakdown | null;
  collaborator: CollaboratorKey | null;
}) {
  // Macara runs pay no collaborator bonus (EMV Macara = preț întreg / Macara
  // Ploiești = scădem lunar) — the per-row payout column does not apply.
  if (breakdown?.macara?.isMacara) {
    return (
      <div
        className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400"
        title="Macara · fără comision colaborator"
      >
        —
      </div>
    );
  }
  if (!collaborator) {
    return (
      <div
        className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400"
        title="Constanța · fără colaborator"
      >
        —
      </div>
    );
  }
  if (!breakdown) {
    return (
      <div className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400">
        <Dash />
      </div>
    );
  }
  const row = breakdown.collaboratorPrices[collaborator];
  return (
    <div
      className="flex items-center justify-end border-r border-ink-200 bg-coral-50/60 px-3 py-2 text-right text-base font-bold tabular-nums text-coral-700"
      title={
        row
          ? `${COLLABORATOR_LABEL[collaborator]} · bonus ${ron(row.bonus)} (${(row.pct * 100).toFixed(1)} %)`
          : COLLABORATOR_LABEL[collaborator]
      }
    >
      {row ? ron(row.total) : <Dash />}
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

function Thumbs({ pair }: { pair: Pair }) {
  // Lazy: hydrated pairs stream their bytes from the server-side image
  // endpoint (cached in-app); local pairs resolve instantly from their
  // Files. While loading we show one skeleton per expected image so
  // the row keeps its final width and nothing jumps.
  const { files, loading } = usePairImages(pair);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f));
    setUrls(u);
    return () => u.forEach(URL.revokeObjectURL);
  }, [files]);
  if (loading) {
    const expected = pair.imageRefs?.length ?? 0;
    return (
      <div className="flex gap-0.5">
        {Array.from({ length: expected }, (_, i) => (
          <div
            key={i}
            className="h-9 w-6 animate-pulse rounded-sm bg-ink-200/60 ring-1 ring-ink-200"
          />
        ))}
      </div>
    );
  }
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

/** Standard-cost cell rendered for a macara row: muted "—" (macara has no
 *  base tariff / km / increment / weekend — only the macara total). */
function MacaraNaCell() {
  return (
    <div
      title="Macara · fără tarif standard / comision"
      className="flex items-center justify-end border-r border-ink-200 px-3 py-2 text-right tabular-nums text-ink-400"
    >
      —
    </div>
  );
}

/** Compact macara marker shown next to the AWB number in the queue. Coral
 *  + ⚠ when the macara is only on the invoice (the AWB doesn't declare it),
 *  neutral when the AWB itself names macara. */
function MacaraChip({ warning }: { warning: boolean }) {
  return (
    <span
      title={
        warning
          ? "Macara pe factură, dar AWB-ul nu o specifică — verifică AWB-ul"
          : "Macara (specificată pe AWB)"
      }
      className={`shrink-0 whitespace-nowrap rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        warning ? "bg-coral-600 text-canvas-50" : "bg-ink-200 text-ink-700"
      }`}
    >
      {warning ? "⚠ macara" : "macara"}
    </span>
  );
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

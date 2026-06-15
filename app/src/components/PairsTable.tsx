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
import { date, ron, ronBare } from "../lib/format";
import { usePairImages } from "../lib/images";
import { EDIT_LOOK } from "../lib/ui";
import { ProductBadge } from "./ProductCheck";

const SERVICES: Service[] = ["Express", "Premium", "Prestabilita"];

/* The queue is a DENSE spreadsheet: 11 tracks instead of the old 17.
 * Related values share one cell — AWB + factură + destinatar stack
 * inside "Documente", data + serviciu stack in one editable column,
 * and the four standard cost components + descărcare collapse into a
 * single labeled mini-grid ("Costuri") — so each row carries MORE
 * information while the table fits a laptop window without the
 * horizontal scroll the old 1500 px layout forced.
 *
 * Track sizing rules:
 *
 *  • Icon / fixed columns (#, Imagini, ✕) stay at a fixed px width —
 *    their content is a fixed-size glyph, never text that grows. The
 *    Imagini cell is an overlapping stack capped at 3 tiles (2 thumbs +
 *    a "+N" counter when there are more), so its footprint is constant
 *    no matter how many documents ride the pair.
 *
 *  • Editable columns (Data/Serviciu, kg, km, Liv.) stay at a fixed px
 *    width too — they hold <input>/<select> controls, which clip their
 *    own overflow internally and so can never spill past the cell.
 *
 *  • "Documente" takes `minmax(0,1.4fr)` and truncates INTERNALLY —
 *    a long AWB / invoice number can never push the grid wider; the
 *    full values live in the tooltip and the detail page.
 *
 *  • "Costuri" sizes to its five fixed mini-columns (`max-content`),
 *    and the two money columns use `minmax(<floor>px, max-content)`
 *    so the widest RON value always fits without clipping.
 *
 * The wrapper keeps `min-w-[1080px]` so very narrow windows scroll
 * horizontally instead of crushing the editable columns. */
const GRID =
  "grid grid-cols-[44px_72px_minmax(0,1.4fr)_132px_72px_72px_56px_max-content_minmax(108px,max-content)_minmax(108px,max-content)_56px]";

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
    // Each pair pays ITS OWN collaborator (assigned in the upload flow);
    // unassigned legacy pairs fall back to the header selection.
    const rowCollab = p.collaborator ?? collaborator;
    if (rowCollab) {
      sumCollab += b.collaboratorPrices[rowCollab]?.total ?? 0;
    }
  }

  return (
    <div className="space-y-2.5">
      {pairs.length > 0 && <StatusLegend />}
      <div className="overflow-x-auto rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
        <div className="min-w-[1080px]">
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
    </div>
  );
}

/* ─── Header ────────────────────────────────────────────────────────── */

function Header({ collaborator }: { collaborator: CollaboratorKey | null }) {
  // 11 columns. The penultimate one (Plată colab.) needs special
  // rendering — it's a two-line header so the collaborator's name fits
  // even when it's the longest ("Vic Dinamic") without forcing the
  // column wider than its content needs.
  const cols: { label: string; align: "left" | "right" | "center"; title?: string }[] = [
    { label: "#", align: "center", title: "Poziție în zi + starea perechii (vezi legenda de sus)" },
    { label: "Imagini", align: "center", title: "Documentele scanate ale perechii" },
    { label: "Documente", align: "left", title: "Nr. AWB, factură și destinatar" },
    {
      label: "Data / Serviciu",
      align: "left",
      title: "Data livrării și tipul de serviciu — se pot edita",
    },
    { label: "kg", align: "right", title: "Greutate (kg) — se poate edita" },
    { label: "km", align: "right", title: "Distanță extra peste 50 km — se poate edita" },
    { label: "Liv.", align: "right", title: "Număr de livrări — se poate edita" },
    {
      label: "Costuri",
      align: "left",
      title:
        "Costuri standard de transport — Bază: tarif de bază · Km+: supliment distanță · Inc.: incremente (livrări / greutate / marfă voluminoasă) · Wkd: supliment weekend · Desc.: taxă descărcare",
    },
    { label: "Total client", align: "right", title: "Cât plătește clientul (cu bonus inclus)" },
  ];

  return (
    <div
      className={`${GRID} sticky top-0 z-10 border-b border-ink-300 bg-canvas-200 text-[11px] font-semibold uppercase tracking-widest text-ink-700`}
    >
      {cols.map((c, i) => (
        <div
          key={i}
          title={c.title}
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

  // Error rows must be impossible to miss (they mean money didn't get a
  // price): a solid coral fill PLUS a 4 px coral-600 left stripe, drawn
  // with an inset shadow so the grid never shifts. Extracting/ready stay
  // calm so the eye lands on the row that actually needs attention.
  const rowBg =
    status.kind === "error"
      ? "bg-coral-100 shadow-[inset_4px_0_0_0_var(--color-coral-600)] hover:bg-coral-100"
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
      className={`${GRID} group min-h-[52px] cursor-pointer border-b border-ink-200 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-coral-400 ${rowBg}`}
      title={status.kind === "error" ? status.message : "Click pentru detalii"}
    >
      {/* # + status — one narrow column, row number above the icon */}
      <div className="flex flex-col items-center justify-center gap-1 border-r border-ink-100 bg-canvas-100 px-1 py-1.5">
        <span className="text-[10px] tabular-nums text-ink-400">{index + 1}</span>
        <StatusPill kind={status.kind} message={status.kind === "error" ? status.message : undefined} />
      </div>

      {/* Image thumbs */}
      <div className="flex items-center justify-center border-r border-ink-100 px-2 py-1.5">
        <Thumbs pair={pair} />
      </div>

      {/* Documente — AWB + marker chips (macara / voluminos / product
          check) on the first line, invoice number(s) on the second,
          destinatar on the third. Everything truncates instead of
          widening the column, so the grid can never overflow. */}
      <div className="flex min-w-0 flex-col justify-center gap-0.5 border-r border-ink-100 px-3 py-1.5">
        {status.kind === "error" ? (
          /* A failed pair states the problem right in the row instead of
             three empty dashes, with the full reason in the tooltip and a
             one-line hint on how to retry. */
          <div className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-coral-700">
              ⚠ Eroare la calcul
            </span>
            <p className="truncate text-[11px] text-coral-600" title={status.message}>
              {status.message}
            </p>
            <p className="text-[10px] text-ink-400">Apasă „Calculează” pentru a reîncerca.</p>
          </div>
        ) : (
          <>
            {/* flex-wrap: when macara + voluminos + product-check chips all
                land on one narrow row, they wrap under the AWB instead of
                spilling past the cell. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span
                className="min-w-0 max-w-full truncate font-mono text-[12px] font-medium text-ink-800"
                title={edits?.awb.awb_number || undefined}
              >
                {edits?.awb.awb_number || <Dash />}
              </span>
              {breakdown?.macara?.isMacara && <MacaraChip warning={breakdown.macara.warning} />}
              {(breakdown?.bulkyUnits ?? 0) > 0 && (
                <VoluminosChip
                  units={breakdown!.bulkyUnits!}
                  transports={breakdown!.bulkyTransports ?? 0}
                />
              )}
              <ProductBadge
                verification={status.kind === "ready" ? status.verification : undefined}
                routing={status.kind === "ready" ? status.routing : undefined}
                verifying={verifying}
                pairId={pair.id}
              />
            </div>
            <InvoiceLine edits={edits} />
            {edits?.awb.recipient_name && (
              <div
                className="truncate text-[10px] text-ink-400"
                title={edits.awb.recipient_address ?? undefined}
              >
                {edits.awb.recipient_name}
              </div>
            )}
          </>
        )}
      </div>

      {/* Data + Serviciu — stacked editable pair in one column */}
      <div className="flex flex-col divide-y divide-ink-100 border-r border-ink-100">
        {isReady && edits ? (
          <DateCell value={edits.awb.delivery_date} onChange={(v) => onPatch({ delivery_date: v })} />
        ) : (
          <PlaceholderCell />
        )}
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
      <div className="border-r border-ink-100">
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
      <div className="border-r border-ink-100">
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
      <div className="border-r border-ink-100">
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

      {/* Costuri — the standard transport calc as one compact labeled
          mini-grid (Bază / Km+ / Inc. / Wkd / Desc.). Macara runs carry
          no standard tariff or commission, so the cell explains itself
          instead of showing five dashes. */}
      <CostsCell breakdown={breakdown} isMac={isMac} />

      {/* Total client — what the END customer pays for the currently
          selected city. One number per row; the dropdown switches WHICH
          city's number is shown (Ploiești 50.1%, Iași Tudor 33.7%, Iași
          ERA 33.7%, Constanța 33.7%) without recomputing — every city's
          customerTotal is in the breakdown already. */}
      <CityTotalCell breakdown={breakdown} site={site} />

      {/* Plată colab. — what this pair's OWN collaborator (assigned in
          the upload flow) gets paid; unassigned legacy pairs fall back
          to the header selection. Same coral accent as the customer
          total because both are bottom-line numbers; an assigned row
          carries the partner's name so ownership reads per row. */}
      <CollaboratorTotalCell
        breakdown={breakdown}
        collaborator={pair.collaborator ?? collaborator}
        assigned={!!pair.collaborator}
      />

      {/* Open + remove. The whole row opens the detail page on click; the
          chevron is a PERSISTENT "deschide" cue so the row visibly reads
          as clickable (it brightens on hover and, being a plain child of
          the row, opens on click too). The X deletes and only appears on
          hover, with stopPropagation so deleting never navigates. */}
      <div className="flex items-center justify-end gap-0.5 pr-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Șterge pereche"
          className="flex items-center justify-center rounded p-0.5 text-ink-400 opacity-0 transition hover:text-coral-600 focus-visible:opacity-100 group-hover:opacity-100"
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
        <span
          title="Deschide perechea pentru detalii"
          aria-hidden
          className="flex items-center justify-center text-ink-300 transition group-hover:text-coral-500"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </div>
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
      <div className="col-span-7 border-r border-coral-600 px-3 py-2.5 text-right text-sm font-semibold uppercase tracking-wide">
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

/* ─── Invoice line (inside the Documente cell) ──────────────────────── */

/**
 * Compact invoice strip under the AWB number.
 *
 * A pair carries N invoices; the row needs one line, so we show the
 * FIRST invoice's number, mark it DUPLICAT if applicable, and append a
 * "+N" badge when more invoices ride the same AWB. The detail view is
 * where the full list lives — this line identifies the row at a glance.
 */
function InvoiceLine({ edits }: { edits: Extracted | null }) {
  if (!edits || edits.invoices.length === 0) {
    return (
      <div className="font-mono text-[11px] leading-tight">
        <Dash />
      </div>
    );
  }
  const first = edits.invoices[0]!;
  const extras = edits.invoices.length - 1;
  return (
    <div
      className="flex min-w-0 items-center gap-1 font-mono text-[11px] leading-tight text-ink-500"
      title={
        extras > 0
          ? edits.invoices.map((i) => i.invoice_number).join(" · ")
          : first.invoice_number || undefined
      }
    >
      <span className="truncate">{first.invoice_number || <Dash />}</span>
      {first.invoice_is_duplicate && (
        <span className="shrink-0 rounded bg-coral-100 px-1 py-0.5 text-[9px] font-medium uppercase text-coral-700">
          DUP
        </span>
      )}
      {extras > 0 && (
        <span
          className="shrink-0 rounded bg-ink-200 px-1 py-0.5 text-[9px] font-medium text-ink-700"
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
      <div className="flex items-center justify-end border-r border-ink-100 px-3 py-2 text-right tabular-nums text-ink-400">
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
        className="flex items-center justify-end border-r border-ink-100 bg-coral-50 px-3 py-2 text-right text-base font-bold tabular-nums text-coral-700"
        title={`Tarif macara (cu TVA, fără bonus) — ${m.distanceBucket ?? "—"}, ${m.pallets} palet(i)`}
      >
        {ron(m.total)}
      </div>
    );
  }
  const carrierTip = `Tarif transportator ${ron(breakdown.carrierTotal)}`;
  const row = breakdown.cityCommissions[site];
  return (
    <div
      className="flex items-center justify-end border-r border-ink-100 bg-coral-50 px-3 py-2 text-right text-base font-bold tabular-nums text-coral-700"
      title={
        row
          ? `${carrierTip} + bonus ${ron(row.commission)} (${(row.pct * 100).toFixed(1)} %)`
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
 *  the city (Constanța) so the column still aligns. `assigned` marks a
 *  pair with its OWN upload-time collaborator: the partner's short name
 *  renders under the amount so row ownership is visible at a glance. */
function CollaboratorTotalCell({
  breakdown,
  collaborator,
  assigned,
}: {
  breakdown: PricingBreakdown | null;
  collaborator: CollaboratorKey | null;
  assigned?: boolean;
}) {
  // Macara runs pay no collaborator bonus (EMV Macara = preț întreg / Macara
  // Ploiești = scădem lunar) — the per-row payout column does not apply.
  if (breakdown?.macara?.isMacara) {
    return (
      <div
        className="flex items-center justify-end border-r border-ink-100 px-3 py-2 text-right tabular-nums text-ink-400"
        title="Macara · fără bonus colaborator"
      >
        —
      </div>
    );
  }
  if (!collaborator) {
    return (
      <div
        className="flex items-center justify-end border-r border-ink-100 px-3 py-2 text-right tabular-nums text-ink-400"
        title="Constanța · fără colaborator"
      >
        —
      </div>
    );
  }
  if (!breakdown) {
    return (
      <div className="flex items-center justify-end border-r border-ink-100 px-3 py-2 text-right tabular-nums text-ink-400">
        <Dash />
      </div>
    );
  }
  const row = breakdown.collaboratorPrices[collaborator];
  return (
    <div
      className="flex flex-col items-end justify-center border-r border-ink-100 bg-coral-50/60 px-3 py-2 text-right"
      title={
        (row
          ? `${COLLABORATOR_LABEL[collaborator]} · bonus ${ron(row.bonus)} (${(row.pct * 100).toFixed(1)} %)`
          : COLLABORATOR_LABEL[collaborator]) +
        (assigned ? " · alocat la încărcare" : "")
      }
    >
      <span className="text-base font-bold tabular-nums text-coral-700">
        {row ? ron(row.total) : <Dash />}
      </span>
      {assigned && (
        <span className="text-[9px] font-semibold uppercase tracking-wider text-coral-600/70">
          {COLLABORATOR_SHORT_LABEL[collaborator]}
        </span>
      )}
    </div>
  );
}

/* ─── Primitives ─────────────────────────────────────────────────────── */

function StatusPill({ kind, message }: { kind: PairStatus["kind"]; message?: string }) {
  switch (kind) {
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
          title={message}
        >
          !
        </span>
      );
    case "unpaired":
      // Unpaired docs render in their own strip, never in the table —
      // this case only exists so the switch stays exhaustive.
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-coral-400 bg-coral-50 text-coral-700"
          title="Document neîmperecheat"
        >
          ?
        </span>
      );
  }
}

/* ─── Status legend ─────────────────────────────────────────────────── */

/**
 * A one-line key above the table so the status icons explain themselves —
 * a dispatcher shouldn't have to learn what the dot, spinner, check and
 * "!" mean by trial and error. It reuses the exact StatusPill glyphs (one
 * source of truth) and ends with a small swatch teaching that the
 * coral-tinted cells in the table can be typed over.
 */
function StatusLegend() {
  const items: { kind: PairStatus["kind"]; label: string }[] = [
    { kind: "pending", label: "În aşteptare" },
    { kind: "extracting", label: "Se procesează" },
    { kind: "ready", label: "Calculat" },
    { kind: "error", label: "Eroare" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-ink-500">
      <span className="font-semibold uppercase tracking-wider text-ink-400">Stare</span>
      {items.map((it) => (
        <span key={it.kind} className="inline-flex items-center gap-1.5">
          <StatusPill kind={it.kind} />
          {it.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5 text-ink-400 sm:ml-auto">
        <span className="inline-block h-3.5 w-6 rounded-sm bg-coral-50/70 shadow-[inset_0_-2px_0_0_var(--color-coral-300)]" />
        câmpurile colorate se pot edita
      </span>
    </div>
  );
}

/**
 * How many thumbnails to actually render for `total` images.
 *
 * The stack shows at most 3 tiles: up to 3 real thumbs when everything
 * fits, or 2 thumbs + a "+N" counter tile when there are more. That
 * makes the cell's footprint a CONSTANT (3 tiles max, overlapped), so
 * a pair with 10 documents occupies exactly the same width as a pair
 * with 3 — the old uncapped row of thumbs grew past the 64 px column
 * with the 3rd image and bled into "Documente".
 */
function visibleThumbCount(total: number): number {
  return total <= 3 ? total : 2;
}

function Thumbs({ pair }: { pair: Pair }) {
  // Lazy: hydrated pairs stream their bytes from the server-side image
  // endpoint (cached in-app); local pairs resolve instantly from their
  // Files. While loading we show one skeleton per VISIBLE tile so the
  // row keeps its final width and nothing jumps when the bytes land.
  const { files, loading } = usePairImages(pair);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const u = files.map((f) => URL.createObjectURL(f));
    setUrls(u);
    return () => u.forEach(URL.revokeObjectURL);
  }, [files]);

  const total = loading ? pair.imageRefs?.length ?? 0 : urls.length;
  if (total === 0) return <Dash />;
  const visible = visibleThumbCount(total);
  const extra = total - visible;
  // Every tile after the first overlaps the previous one (-ml-4 = 16 px
  // of a 28 px tile), avatar-stack style. Worst case: 28 + 12 + 12 =
  // 52 px — always inside the 72 px track minus its padding.
  const tile = (i: number) =>
    `h-10 w-7 shrink-0 rounded-md ring-2 ring-canvas-50 ${i > 0 ? "-ml-4" : ""}`;

  return (
    <div className="flex items-center" title={`${total} imagin${total === 1 ? "e" : "i"}`}>
      {loading
        ? Array.from({ length: visible }, (_, i) => (
            <div key={i} className={`${tile(i)} animate-pulse bg-ink-200/60`} />
          ))
        : urls.slice(0, visible).map((u, i) => (
            <img
              key={u}
              src={u}
              alt={`Imagine ${i + 1} din ${total}`}
              title={files[i]?.name}
              className={`${tile(i)} object-cover shadow-sm`}
            />
          ))}
      {extra > 0 && (
        <span
          className={`${tile(visible)} flex items-center justify-center bg-ink-700/90 text-[10px] font-semibold tabular-nums text-canvas-50`}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

function Dash() {
  return <span className="text-ink-400">—</span>;
}

/**
 * The five standard cost components in ONE cell — a labeled mini-grid
 * (Bază / Km+ / Inc. / Wkd / Desc.) instead of five table columns. The
 * row gains the descărcare tax (never visible in the queue before)
 * while the table loses four column borders' worth of width.
 *
 * Inactive components render a muted "—" with a tooltip explaining WHY
 * the rule didn't fire, so the cell reads as "not applied", never as
 * "broken". A macara row explains itself instead of dashing out — it
 * has no standard tariff at all.
 */
function CostsCell({
  breakdown,
  isMac,
}: {
  breakdown: PricingBreakdown | null;
  isMac: boolean;
}) {
  if (isMac) {
    return (
      <div
        className="flex items-center border-r border-ink-100 px-3 py-1.5 text-[11px] italic text-ink-400"
        title="Macara — fără tarif standard / bonus; prețul rândului este tariful macara."
      >
        macara · fără tarif standard
      </div>
    );
  }
  const parts = [
    {
      label: "Bază",
      value: breakdown?.baseTariff ?? null,
      offHint: "Tarif de bază — apare după calcul.",
    },
    {
      label: "Km+",
      value: breakdown?.extraKmCost ?? null,
      offHint: "Distanță ≤ 50 km — nu se aplică suplimentul per km.",
    },
    {
      label: "Inc.",
      value: breakdown?.incrementCost ?? null,
      offHint:
        "Fără incremente — o singură livrare, ≤ 1200 kg și fără marfă voluminoasă peste pragul de 24 bucăți.",
    },
    {
      label: "Wkd",
      value: breakdown?.weekendSurcharge ?? null,
      offHint: "Livrare în zi lucrătoare — fără supliment de weekend.",
    },
    {
      label: "Desc.",
      value: breakdown?.unloadingTax ?? null,
      offHint: "Fără taxă de descărcare.",
    },
  ] as const;
  return (
    <div className="flex items-center gap-3 border-r border-ink-100 px-3 py-1.5">
      {parts.map((p) => {
        const active = breakdown != null && (p.value ?? 0) > 0;
        return (
          <div
            key={p.label}
            className="flex min-w-[40px] flex-col items-end"
            title={active ? `${p.label}: ${ron(p.value)}` : breakdown ? p.offHint : undefined}
          >
            <span className="text-[9px] font-semibold uppercase tracking-wider text-ink-400">
              {p.label}
            </span>
            <span
              className={`text-[11px] leading-tight tabular-nums ${
                active ? "text-ink-900" : "text-ink-300"
              }`}
            >
              {active ? ronBare(p.value) : "—"}
            </span>
          </div>
        );
      })}
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

/** Voluminos marker — shown whenever the invoice carries bulky-but-light
 *  goods (polistiren / vată). Coral ⚠ when the 24-piece rule actually
 *  fired and extra transports are billed; amber notice when the goods
 *  are present but under the threshold (no surcharge, still worth the
 *  user's eye). The tooltip carries the exact piece count. */
function VoluminosChip({ units, transports }: { units: number; transports: number }) {
  const billed = transports > 0;
  return (
    <span
      title={
        billed
          ? `Marfă voluminoasă (polistiren / vată): ${units} bucăți → ${transports} transport${
              transports === 1 ? "" : "uri"
            } suplimentar${transports === 1 ? "" : "e"} facturat${transports === 1 ? "" : "e"}`
          : `Marfă voluminoasă (polistiren / vată): ${units} bucăți — sub pragul de 24, fără transport suplimentar`
      }
      className={`shrink-0 whitespace-nowrap rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        billed ? "bg-coral-600 text-canvas-50" : "bg-amber-100 text-amber-800"
      }`}
    >
      {billed ? `⚠ voluminos ×${transports}` : "voluminos"}
    </span>
  );
}

function PlaceholderCell({ numeric }: { numeric?: boolean }) {
  return (
    <div
      className={`flex h-full min-h-0 flex-1 items-center px-3 py-1 text-ink-400 ${
        numeric ? "justify-end tabular-nums" : ""
      }`}
    >
      —
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
      className={`${EDIT_LOOK} block h-full w-full cursor-text px-2 py-2 text-right text-[13px] tabular-nums`}
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
      className={`${EDIT_LOOK} block min-h-0 w-full flex-1 cursor-text px-2 py-1 text-[13px]`}
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
      className={`${EDIT_LOOK} block min-h-0 w-full flex-1 cursor-pointer px-2 py-1 text-[13px]`}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

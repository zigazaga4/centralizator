import { useEffect, useState, type ReactNode } from "react";
import {
  CITY_COMMISSION_KEYS,
  CITY_COMMISSION_LABEL,
  COLLABORATOR_LABEL,
  primaryDispatchSite,
  type CityKey,
  type CollaboratorKey,
  type Extracted,
  type Invoice,
  type Pair,
  type PairPatch,
  type PairStatus,
  type PricingBreakdown,
  type Routing,
  type Service,
  type Verification,
} from "../types";
import { date, ron } from "../lib/format";
import { usePairImages } from "../lib/images";
import { ProductBadge, ProductCheckSummary, hasAnyWarning } from "./ProductCheck";

const SERVICES: Service[] = ["Express", "Premium", "Prestabilita"];

interface Props {
  pair: Pair;
  index: number;
  /** Customer-city selection from the app header. The detail page
   *  shows every city's breakdown, but the highlighted bottom-line
   *  TOTAL CLIENT mirrors whatever is selected here. */
  city: CityKey;
  /** Collaborator selection from the app header. Per the user's brief
   *  ("only that collaborator should be calculated"), the detail page
   *  shows ONLY this collaborator's payout row + bottom-line total.
   *  `null` means the picked city has no collaborator (Constanța) —
   *  the per-collaborator section is hidden entirely in that case. */
  collaborator: CollaboratorKey | null;
  /** True while this pair's Leroy Merlin product check is in flight. */
  verifying?: boolean;
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
export function PairDetail({
  pair,
  index,
  city,
  collaborator,
  verifying,
  onPatch,
  onBack,
  onRemove,
}: Props) {
  const status = pair.status;
  const verification = status.kind === "ready" ? status.verification : undefined;
  const routing = status.kind === "ready" ? status.routing : undefined;
  const title =
    status.kind === "ready"
      ? `Pereche #${index + 1} · AWB ${status.edits.awb.awb_number}`
      : `Pereche #${index + 1}`;

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader
        title={title}
        status={status}
        verification={verification}
        routing={routing}
        verifying={verifying}
        onBack={onBack}
        onRemove={onRemove}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <aside className="lg:col-span-5 xl:col-span-4">
          <ImageGallery pair={pair} />
        </aside>

        <section className="lg:col-span-7 xl:col-span-8 space-y-6">
          {status.kind === "ready" ? (
            <>
              {status.breakdown.macara?.warning && <MacaraWarningBanner />}
              <Spreadsheet
                data={status.edits}
                service={status.service}
                serviceFallback={status.serviceFallback}
                breakdown={status.breakdown}
                routing={status.routing}
                city={city}
                collaborator={collaborator}
                onPatch={onPatch}
              />
              {(verification || routing) && (
                <div className="overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
                  <div className="flex items-center justify-between border-b border-ink-200 bg-canvas-200/60 px-4 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-coral-700">
                      Verificare produse + km
                    </span>
                    {hasAnyWarning(verification, routing) ? (
                      <span className="rounded bg-coral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-coral-700">
                        Discrepanță
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                        ✓ Tot corespunde
                      </span>
                    )}
                  </div>
                  <ProductCheckSummary verification={verification} routing={routing} />
                </div>
              )}
            </>
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
  verification,
  routing,
  verifying,
  onBack,
  onRemove,
}: {
  title: string;
  status: PairStatus;
  verification?: Verification;
  routing?: Routing;
  verifying?: boolean;
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
        <ProductBadge verification={verification} routing={routing} verifying={verifying} />
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

function ImageGallery({ pair }: { pair: Pair }) {
  // Lazy: bytes stream in per-image from the server (cached in-app
  // after the first load); local pairs resolve instantly. While
  // loading, one skeleton card per expected image keeps the layout.
  const { files, loading } = usePairImages(pair);
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

  if (loading) {
    const expected = pair.imageRefs?.length ?? 1;
    return (
      <div className="space-y-4">
        {Array.from({ length: expected }, (_, i) => (
          <div
            key={i}
            className="h-48 animate-pulse rounded-xl border border-ink-200 bg-canvas-100"
            title={`Se încarcă imaginea ${i + 1}…`}
          />
        ))}
      </div>
    );
  }

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

/* ─── Macara warning (separate alarm) ───────────────────────────────── */

/**
 * Standalone, loud warning for the macara mismatch the operator asked to be
 * flagged on its own: a macara line is on the INVOICE, but the AWB "Serviciu"
 * does NOT say macara (it reads "standard" or similar). Kept deliberately
 * separate from the product/km verification banner — this is its own alarm.
 */
function MacaraWarningBanner() {
  return (
    <div className="flex items-start gap-3 rounded-xl border-2 border-coral-400 bg-coral-50 px-4 py-3 text-coral-800 shadow-sm">
      <svg className="mt-0.5 h-6 w-6 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide">Atenție · macara pe factură</p>
        <p className="mt-0.5 text-sm">
          Factura conține „macara”, dar AWB-ul nu specifică macara la „Serviciu”.
          Verifică AWB-ul: dacă transportul este cu macara, serviciul de pe AWB ar trebui să fie macara.
        </p>
      </div>
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
  routing,
  city,
  collaborator,
  onPatch,
}: {
  data: Extracted;
  service: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
  routing?: Routing;
  city: CityKey;
  collaborator: CollaboratorKey | null;
  onPatch: (patch: PairPatch) => void;
}) {
  let row = 0;
  const r = () => ++row;
  // Each city now maps to exactly one dispatch site (the four series
  // from `PRETURI COLABORATORI.ods` are top-level options, not stacked
  // under "Iași"). One coral TOTAL CLIENT row at the bottom.
  const site = primaryDispatchSite(city);
  const collabRow = collaborator ? breakdown.collaboratorPrices[collaborator] : null;
  // Macara runs are priced ONLY off the macara table — no standard tariff,
  // no commission, no collaborator payout. For those pairs we hide the whole
  // commission machinery and show the macara calc as the bottom line.
  const macara = breakdown.macara;
  const isMacara = !!macara?.isMacara;

  // Split for readability — the spreadsheet renders the AWB section
  // once, then loops through every invoice as its own section. Pricing
  // depends only on `awb`; the invoices are display-only billable
  // documents.
  const { awb, invoices } = data;
  const multipleInvoices = invoices.length > 1;

  // Origin store (centralizator) + how the billed km was determined.
  const storeLabel = routing?.store ? CITY_COMMISSION_LABEL[routing.store] : "—";
  const kmHint =
    routing?.source === "mapbox"
      ? `Mapbox · ${storeLabel} → livrare (AWB indica ${routing.awbKm} km)`
      : routing
        ? `km de pe AWB${routing.note ? ` · ${routing.note}` : ""}`
        : undefined;

  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-canvas-50 shadow-sm">
      <ColumnHeader />

      <Section title="AWB" />
      <DataRow n={r()} label="Număr AWB" value={awb.awb_number} />
      <DataRow
        n={r()}
        label="Magazin (centralizator)"
        value={storeLabel}
        hint={
          routing
            ? routing.storeSource === "expeditor"
              ? "din Expeditor"
              : routing.storeSource === "nearest"
                ? "cel mai apropiat"
                : "nedeterminat"
            : undefined
        }
      />
      <DataRow n={r()} label="Data livrare" editable>
        <DateCell value={awb.delivery_date} onChange={(v) => onPatch({ delivery_date: v })} />
      </DataRow>
      <DataRow
        n={r()}
        label="Serviciu (AWB)"
        value={awb.service_text || "—"}
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
          value={awb.weight_kg}
          step={0.01}
          min={0}
          onChange={(v) => onPatch({ weight_kg: v })}
        />
      </DataRow>
      <DataRow n={r()} label="Distanță extra (km)" editable hint={kmHint}>
        <NumberCell
          value={awb.distance_extra_km}
          step={1}
          min={0}
          onChange={(v) => onPatch({ distance_extra_km: v })}
        />
      </DataRow>
      <DataRow n={r()} label="Număr livrări" editable>
        <NumberCell
          value={awb.num_deliveries}
          step={1}
          min={1}
          integer
          onChange={(v) => onPatch({ num_deliveries: Math.max(1, Math.floor(v)) })}
        />
      </DataRow>
      <DataRow n={r()} label="Tip expediție" value={awb.shipment_type} />
      <DataRow n={r()} label="Hub destinație" value={awb.hub_destination} />
      <DataRow n={r()} label="Cod conținut" value={awb.content_code} />
      <DataRow n={r()} label="Expeditor" value={awb.sender_name} />
      <DataRow n={r()} label="Telefon expeditor" value={awb.sender_phone} />
      <DataRow n={r()} label="Adresa expeditor" value={awb.sender_address} />
      <DataRow n={r()} label="Destinatar" value={awb.recipient_name} />
      <DataRow n={r()} label="Telefon destinatar" value={awb.recipient_phone} />
      <DataRow n={r()} label="Adresa destinatar" value={awb.recipient_address} />

      {/* One Factură section per attached invoice. Header is numbered
          when there's more than one so the user can pair each section
          back to its image in the gallery on the left. */}
      {invoices.map((inv, i) => {
        const heading = multipleInvoices
          ? `Factură ${i + 1} / ${invoices.length}`
          : "Factură";
        const rows: ReactNode[] = [];
        rows.push(
          <DataRow
            key="num"
            n={r()}
            label="Număr factură"
            value={inv.invoice_number}
            badge={inv.invoice_is_duplicate ? "DUPLICAT" : undefined}
          />,
        );
        rows.push(<DataRow key="date" n={r()} label="Data factură" value={date(inv.invoice_date)} />);
        rows.push(<DataRow key="supplier" n={r()} label="Furnizor" value={inv.supplier_name} />);
        rows.push(<DataRow key="supplier_cui" n={r()} label="CIF furnizor" value={inv.supplier_cui} />);
        rows.push(<DataRow key="buyer" n={r()} label="Cumpărător" value={inv.buyer_name} />);
        rows.push(<DataRow key="buyer_cui" n={r()} label="CIF cumpărător" value={inv.buyer_cui} />);
        rows.push(<DataRow key="order" n={r()} label="Nr. comandă" value={inv.order_number} />);
        rows.push(
          <DataRow
            key="net"
            n={r()}
            label="Total fără TVA"
            value={inv.invoice_total_net != null ? ron(inv.invoice_total_net) : "—"}
            numeric
          />,
        );
        rows.push(
          <DataRow
            key="vat"
            n={r()}
            label="TVA (factură)"
            value={inv.invoice_total_vat != null ? ron(inv.invoice_total_vat) : "—"}
            numeric
          />,
        );
        rows.push(
          <DataRow
            key="gross"
            n={r()}
            label="Total cu TVA (factură)"
            value={inv.invoice_total_gross != null ? ron(inv.invoice_total_gross) : "—"}
            numeric
          />,
        );

        const itemNodes: ReactNode[] = [];
        if (inv.items.length > 0) {
          itemNodes.push(<ItemsHeader key="hdr" />);
          for (let k = 0; k < inv.items.length; k++) {
            row += 1;
            const it = inv.items[k]!;
            itemNodes.push(<ItemRow key={`it-${k}`} n={row} item={it} />);
          }
        }

        return (
          <div key={i}>
            <Section title={heading} />
            {rows}
            {inv.items.length > 0 && (
              <>
                <Section title={`Articole factură (${inv.items.length})`} />
                {itemNodes}
              </>
            )}
          </div>
        );
      })}

      {/* Standard transport calc + the whole commission machinery. Hidden
          entirely for macara runs, which carry no commission. */}
      {!isMacara && (
      <>
      <Section title="Calcul tarif" />
      <DataRow n={r()} label="Cheie tarif" value={breakdown.baseKey} />
      <DataRow n={r()} label="Bucket greutate" value={breakdown.weightBucket} />
      <DataRow n={r()} label="Bucket distanță" value={breakdown.distanceBucket} />
      <DataRow
        n={r()}
        label="Tarif bază"
        value={ron(breakdown.baseTariff)}
        numeric
      />
      {breakdown.extraKmCost > 0 ? (
        <DataRow
          n={r()}
          label={`Cost km extra (${breakdown.extraKm} km × 1.90 × 2)`}
          value={ron(breakdown.extraKmCost)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Cost km extra"
          value="— · distanță ≤ 50 km"
          numeric
          muted
        />
      )}
      {breakdown.incrementCost > 0 ? (
        <DataRow
          n={r()}
          label={`Cost increment (${breakdown.incrementKey})`}
          value={ron(breakdown.incrementCost)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Cost increment"
          value="— · o singură livrare"
          numeric
          muted
        />
      )}
      {breakdown.weekendSurcharge > 0 ? (
        <DataRow
          n={r()}
          label="Supliment weekend"
          value={ron(breakdown.weekendSurcharge)}
          numeric
        />
      ) : (
        <DataRow
          n={r()}
          label="Supliment weekend"
          value="— · zi lucrătoare"
          numeric
          muted
        />
      )}
      {/* Unloading tax ("descărcare") — a SEPARATE flat fee (210 RON cu TVA
          each, 177.69 fără TVA), not commissioned. Shown whenever a
          qualifying unloading was detected; muted "—" otherwise. */}
      {breakdown.unloadingTax > 0 ? (
        <DataRow
          n={r()}
          label={`Taxă descărcare (${breakdown.unloadingCount} × 210 lei cu TVA)`}
          value={ron(breakdown.unloadingTax)}
          numeric
          hint={breakdown.unloadingCount > breakdown.unloadingUnits ? "+1 / transport >1200 kg" : "taxă separată"}
        />
      ) : (
        <DataRow
          n={r()}
          label="Taxă descărcare"
          value="— · fără descărcare"
          numeric
          muted
        />
      )}

      {/* Carrier subtotal — what Stalexone (transportator) gets. The
          shared base every city and collaborator total grosses up
          from; surfaced muted so the eye walks to the per-city +
          per-collab tables below. */}
      <DataRow
        n={r()}
        label="Tarif transportator"
        value={ron(breakdown.carrierTotal)}
        numeric
        muted
      />

      {/* ── Per-city customer totals ────────────────────────────────
          Always shows all four dispatch sites so the user can compare
          Ploiești vs Iași (Tudor) vs Iași (ERA) vs Constanța at a
          glance. The bottom-line TOTAL CLIENT row uses the single
          dispatch site for the city the user selected in the header. */}
      <Section title="Tarif client per oraș" />
      {CITY_COMMISSION_KEYS.map((k) => {
        const cr = breakdown.cityCommissions[k];
        const isSelected = k === site;
        return (
          <DataRow
            key={k}
            n={r()}
            label={CITY_COMMISSION_LABEL[k]}
            value={
              cr
                ? `${(cr.pct * 100).toFixed(1)} % · comision ${ron(cr.commission)} → ${ron(cr.customerTotal)}`
                : "—"
            }
            numeric
            muted={!isSelected}
            hint={isSelected ? "selectat" : undefined}
          />
        );
      })}

      {/* ── Per-collaborator payout ────────────────────────────────
          Only the SELECTED collaborator is shown ("only that
          collaborator should be calculated"). When the city is
          Constanța (no collaborator roster) the whole section is
          skipped — the bottom line is just the customer total. */}
      {collaborator && collabRow && (
        <>
          <Section title="Plată colaborator" />
          <DataRow
            n={r()}
            label={COLLABORATOR_LABEL[collaborator]}
            value={`${(collabRow.pct * 100).toFixed(1)} % · bonus ${ron(collabRow.bonus)} → ${ron(collabRow.total)}`}
            numeric
          />
        </>
      )}

      {/* ── Bottom-line totals ──────────────────────────────────────
          ONE coral row for the customer-facing total of the selected
          city's single dispatch site, then ONE coral row for the
          courier-side payout when a collaborator is picked. Constanța
          skips the payout row entirely since it has no partner. */}
      <TotalRow
        n={r()}
        label={`TOTAL CLIENT · ${CITY_COMMISSION_LABEL[site]}`}
        value={
          breakdown.cityCommissions[site]
            ? ron(breakdown.cityCommissions[site].customerTotal)
            : "—"
        }
      />
      {collaborator && collabRow && (
        <TotalRow
          n={r()}
          label={`PLATĂ COLABORATOR · ${COLLABORATOR_LABEL[collaborator]}`}
          value={ron(collabRow.total)}
        />
      )}
      </>
      )}

      {/* Macara (crane) — its own table (cu TVA), no commission. For a macara
          pair this REPLACES the standard calc + commission above: the macara
          total is the bottom line. */}
      {isMacara && macara && (
        <>
          <Section title="Macara · sursă (cu TVA)" />
          <DataRow
            n={r()}
            label="Sursă macara"
            value={macara.onAwb ? "specificat pe AWB" : "doar pe factură"}
            hint={macara.warning ? "verifică AWB" : undefined}
          />
          <DataRow n={r()} label="Paleți (macara)" value={String(macara.pallets)} />

          {/* Macara tariff for EVERY city — the rate table differs by dispatch
              site (Ploiești + Iași ERA on one table, Iași Tudor + Constanța on
              the other). The selected city is highlighted; the bottom line
              uses it. No commission applies to any of these. */}
          <Section title="Tarif macara per oraș (cu TVA)" />
          {CITY_COMMISSION_KEYS.map((k) => {
            const m = breakdown.macaraByCity?.[k];
            const isSelected = k === site;
            return (
              <DataRow
                key={k}
                n={r()}
                label={CITY_COMMISSION_LABEL[k]}
                value={
                  m
                    ? `${m.distanceBucket ?? "—"} · bază ${ron(m.basePrice)}${
                        m.runs && m.runs > 1 ? ` (${m.runs} curse)` : ""
                      }${m.kmCost > 0 ? ` + km ${ron(m.kmCost)}` : ""} + descărcare ${ron(
                        m.unloadCost,
                      )} → ${ron(m.total)}`
                    : "—"
                }
                numeric
                muted={!isSelected}
                hint={isSelected ? "selectat" : undefined}
              />
            );
          })}

          <TotalRow
            n={r()}
            label={`TOTAL MACARA · ${CITY_COMMISSION_LABEL[site]}`}
            value={ron((breakdown.macaraByCity?.[site] ?? macara).total)}
          />
        </>
      )}
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

function ItemRow({ n, item }: { n: number; item: Invoice["items"][number] }) {
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

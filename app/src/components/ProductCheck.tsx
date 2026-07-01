import { useState, type ReactNode, type MouseEvent } from "react";
import { CITY_COMMISSION_LABEL, type Awb, type CheckStatus, type ItemCheck, type Routing, type Verification } from "../types";
import { ron } from "../lib/format";
import { RouteMapModal } from "./RouteMapModal";

/** True when the AWB itself is missing a pricing-relevant field (the vision
 *  model found no weight and/or km field printed on the document at all —
 *  see `weight_kg_missing` / `distance_extra_km_missing`). Distinct from a
 *  Leroy Merlin catalog mismatch or a Mapbox km disagreement: this means the
 *  number shown is a 0 fallback, not a real reading, and pricing on it is
 *  unverified until the operator fills in the real value from the paper AWB. */
export function hasMissingAwbData(awb?: Awb): boolean {
  return !!awb?.weight_kg_missing || !!awb?.distance_extra_km_missing;
}

/**
 * Does this pair deserve the warning icon? Three independent sources feed
 * the single alarm the operator watches:
 *   • a product discrepancy (size/weight vs leroymerlin.ro),
 *   • a km discrepancy (our Mapbox shortest-road km vs the AWB's printed
 *     km) — the operator's rule is that ANY difference is flagged, and
 *   • the AWB itself is missing weight and/or km (some templates, e.g. a
 *     'couriermanager' proof-of-delivery slip, never print one of these
 *     fields — the shown number is a 0 fallback, not a real reading).
 */
export function hasAnyWarning(verification?: Verification, routing?: Routing, awb?: Awb): boolean {
  return !!verification?.hasWarning || !!routing?.kmWarning || hasMissingAwbData(awb);
}

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
  routing,
  awb,
  verifying,
  pairId,
}: {
  verification?: Verification;
  routing?: Routing;
  /** AWB fields — surfaces weight_kg_missing / distance_extra_km_missing. */
  awb?: Awb;
  verifying?: boolean;
  /** When given, the km box can open the route-map modal for this pair. */
  pairId?: string;
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

  const kmWarn = !!routing?.kmWarning;
  const awbDataWarn = hasMissingAwbData(awb);
  // Show the icon when there's anything to show — a product report to open,
  // a km discrepancy, or missing AWB data to flag.
  if (!verification && !kmWarn && !awbDataWarn) return null;

  const warn = hasAnyWarning(verification, routing, awb);
  const title = warn
    ? [
        verification?.hasWarning ? "discrepanță produse (dimensiuni/greutate)" : null,
        kmWarn ? "diferență de km (AWB vs Mapbox)" : null,
        awbDataWarn ? "date lipsă pe AWB (kg/km)" : null,
      ]
        .filter(Boolean)
        .join(" + ") + " — click pentru detalii"
    : (verification ? "Produse + km verificate" : "Km verificat") + " — click pentru detalii";

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        onMouseDown={stop}
        title={title}
        className={`inline-flex h-5 w-5 items-center justify-center rounded transition ${
          warn
            ? "text-coral-600 hover:bg-coral-100"
            : "text-emerald-600 hover:bg-emerald-50"
        }`}
        aria-label={warn ? "Discrepanță" : "Verificat"}
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
      {open && (
        <ProductCheckDialog
          verification={verification}
          routing={routing}
          pairId={pairId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/* ─── The dialog ────────────────────────────────────────────────────── */

function ProductCheckDialog({
  verification,
  routing,
  awb,
  pairId,
  onClose,
}: {
  verification?: Verification;
  routing?: Routing;
  awb?: Awb;
  pairId?: string;
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

        <ProductCheckSummary verification={verification} routing={routing} awb={awb} pairId={pairId} />
      </div>
    </div>
  );
}

/* ─── Reusable body (dialog + detail page section) ──────────────────── */

export function ProductCheckSummary({
  verification,
  routing,
  awb,
  pairId,
}: {
  verification?: Verification;
  routing?: Routing;
  awb?: Awb;
  pairId?: string;
}) {
  const v = verification;
  const prodWarn = !!v?.hasWarning;
  const kmWarn = !!routing?.kmWarning;
  const awbDataWarn = hasMissingAwbData(awb);
  const anyWarn = prodWarn || kmWarn || awbDataWarn;
  const prodAllGood = !!v && !v.hasWarning && v.items.some((it) => it.found);

  // What the coral banner should call out — products, km, missing data, any
  // combination.
  const warnBits = [
    prodWarn ? "dimensiuni/greutate față de site" : null,
    kmWarn ? "km (AWB vs Mapbox)" : null,
    awbDataWarn ? "date lipsă pe AWB (kg/km)" : null,
  ].filter(Boolean);

  return (
    <div className="p-5">
      {/* Verdict banner — coral when anything is off, green when products
          check out and there's no km gap. */}
      {anyWarn ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-coral-300 bg-coral-50 px-4 py-3 text-coral-800">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-sm font-medium">
            Discrepanțe ({warnBits.join(" și ")}) — vezi detaliile de mai jos.
          </span>
        </div>
      ) : prodAllGood ? (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
          <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12l2.5 2.5L16 9" />
          </svg>
          <span className="text-sm font-medium">
            Tot corespunde site-ului leroymerlin.ro — dimensiunile și greutatea sunt verificate.
          </span>
        </div>
      ) : null}

      {/* Missing AWB data — the vision model found no weight and/or km field
          printed on the document at all. Shown first: an unverified/fabricated
          input is a more direct pricing risk than the km/product cross-checks
          below it. */}
      <MissingAwbDataCheck awb={awb} />

      {/* Km reconciliation — our Mapbox shortest-road km vs the AWB's printed
          km. Any gap is a warning per the operator's rule. */}
      <KmCheck routing={routing} pairId={pairId} />

      {v && (
        <>
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
        </>
      )}
    </div>
  );
}

/**
 * Missing-AWB-data box. Some AWB templates never print one of the two
 * pricing-relevant fields at all — most notably a 'couriermanager'-branded
 * proof-of-delivery slip, which has no 'Distanță extra (km)' field anywhere
 * on the page. The vision model sets `weight_kg`/`distance_extra_km` to 0 in
 * that case (a fallback, not a reading) and flags it via the matching
 * `_missing` boolean. Rendered only when at least one is actually missing —
 * an ordinary AWB with a real 0 (e.g. a genuinely short delivery) never
 * shows this box, because `_missing` is false in that case.
 */
function MissingAwbDataCheck({ awb }: { awb?: Awb }) {
  if (!hasMissingAwbData(awb)) return null;
  const missing = [
    awb?.weight_kg_missing ? "Greutate (kg)" : null,
    awb?.distance_extra_km_missing ? "Distanță extra (km)" : null,
  ].filter(Boolean) as string[];
  return (
    <div className="mb-4 rounded-lg border border-coral-300 bg-coral-50/60 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
          Date lipsă pe AWB
        </span>
        <StatusChip status="mismatch" labelMap={{ mismatch: "Nesigur" }} />
      </div>
      <p className="mt-1 text-sm text-ink-800">
        {missing.join(" și ")} nu {missing.length > 1 ? "apar" : "apare"} tipărit{missing.length > 1 ? "e" : ""} pe
        acest AWB — valoarea de mai sus (0) e o valoare implicită, nu o citire reală.
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Verifică documentul fizic (unele curieri, ex. un aviz de livrare "couriermanager", nu tipăresc deloc
        acest câmp) și completează valoarea corectă mai sus — prețul se recalculează imediat.
      </p>
    </div>
  );
}

/**
 * Km reconciliation box — mirrors the weight box. Shows the AWB's printed
 * km next to our Mapbox shortest-road km (store → delivery), the signed
 * gap, and a Diferă/OK chip. Rendered only when we actually computed a
 * Mapbox route; on an AWB fallback there is nothing to reconcile.
 */
function KmCheck({ routing, pairId }: { routing?: Routing; pairId?: string }) {
  const [mapOpen, setMapOpen] = useState(false);
  if (!routing || routing.mapboxKm == null) return null;
  const diff = routing.kmDiff ?? routing.mapboxKm - routing.awbKm;
  const warn = !!routing.kmWarning;
  const storeLabel = routing.store ? CITY_COMMISSION_LABEL[routing.store] : "—";
  const sign = diff > 0 ? "+" : "";
  return (
    <div
      className={`mb-4 rounded-lg border px-4 py-3 ${
        warn ? "border-coral-300 bg-coral-50/60" : "border-ink-200 bg-canvas-100/60"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-600">
          Distanță AWB vs. Mapbox
        </span>
        <StatusChip status={warn ? "mismatch" : "match"} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-800 tabular-nums">
        <span>AWB: <strong>{routing.awbKm} km</strong></span>
        <span>Mapbox: <strong>{routing.mapboxKm} km</strong></span>
        <span className={warn ? "font-semibold text-coral-700" : "text-ink-500"}>
          Diferență: {sign}{Math.round(diff * 10) / 10} km
        </span>
        <span className="text-ink-500">({storeLabel} → livrare, drum rutier cel mai scurt)</span>
      </div>
      {routing.approxGeocode && (
        <p className="mt-1.5 text-xs text-amber-700">
          ⚠ Strada nu a fost găsită în {routing.geocodedPlace ?? "localitate"} — km-ul Mapbox e
          măsurat până la centrul localității.
        </p>
      )}
      {pairId && (
        <div className="mt-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMapOpen(true);
            }}
            onMouseDown={stop}
            className="rounded-md border border-ink-300 bg-canvas-50 px-2.5 py-1 text-xs font-medium text-ink-700 transition hover:border-coral-400 hover:text-coral-700"
          >
            🗺 Vezi ruta pe hartă
          </button>
        </div>
      )}
      {mapOpen && pairId && (
        <RouteMapModal pairId={pairId} routing={routing} onClose={() => setMapOpen(false)} />
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

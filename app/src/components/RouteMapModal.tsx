import { useEffect, useState, type MouseEvent } from "react";
import { fetchRouteMap } from "../lib/api";
import { CITY_COMMISSION_LABEL, type Routing } from "../types";

/**
 * Modal showing the Mapbox-routed road (origin store → delivery point) for
 * one pair — what the operator opens from a km warning to SEE the route the
 * Mapbox km came from. The image is rendered server-side (static map + the
 * shortest-road polyline + pins on both ends) and streamed as bytes, so no
 * Mapbox token ever ships in this bundle.
 */
export function RouteMapModal({
  pairId,
  routing,
  onClose,
}: {
  pairId: string;
  routing?: Routing;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    fetchRouteMap(pairId)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [pairId]);

  const stop = (e: MouseEvent) => e.stopPropagation();
  const storeLabel = routing?.store ? CITY_COMMISSION_LABEL[routing.store] : "magazin";
  const diff =
    routing?.mapboxKm != null
      ? Math.round(((routing.kmDiff ?? routing.mapboxKm - routing.awbKm) ?? 0) * 10) / 10
      : null;

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
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-ink-200 bg-canvas-50 shadow-2xl"
        onClick={stop}
        onMouseDown={stop}
      >
        <div className="flex items-center justify-between border-b border-ink-200 bg-canvas-100 px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-800">
              Ruta pe hartă · {storeLabel} → livrare
            </h3>
            <p className="text-[11px] text-ink-500">
              Drumul rutier cel mai scurt (Mapbox, fără drumuri de pământ).
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

        <div className="p-5">
          {routing && (
            <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-800 tabular-nums">
              <span>
                AWB: <strong>{routing.awbKm} km</strong>
              </span>
              {routing.mapboxKm != null && (
                <span>
                  Mapbox: <strong>{routing.mapboxKm} km</strong>
                </span>
              )}
              {diff != null && (
                <span className={routing.kmWarning ? "font-semibold text-coral-700" : "text-ink-500"}>
                  Diferență: {diff > 0 ? "+" : ""}
                  {diff} km
                </span>
              )}
              {routing.deliveryAddress && (
                <span className="text-ink-500">📍 {routing.deliveryAddress}</span>
              )}
            </div>
          )}
          {routing?.approxGeocode && (
            <p className="mb-3 text-xs text-amber-700">
              ⚠ Strada nu a fost găsită în{" "}
              {routing.geocodedPlace ?? "localitate"} — ruta e desenată până la centrul
              localității.
            </p>
          )}

          {error ? (
            <p className="rounded-lg border border-coral-300 bg-coral-50 px-4 py-3 text-sm text-coral-800">
              Harta nu a putut fi încărcată: {error}
            </p>
          ) : src ? (
            <img
              src={src}
              alt="Ruta magazin → livrare"
              className="w-full rounded-lg border border-ink-200"
            />
          ) : (
            <div className="flex h-64 items-center justify-center">
              <svg
                className="h-6 w-6 animate-spin text-ink-400"
                viewBox="0 0 24 24"
                fill="none"
                aria-label="Se încarcă harta…"
              >
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
                <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

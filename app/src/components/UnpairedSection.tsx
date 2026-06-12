import { useEffect, useState } from "react";
import type { Pair, UnpairedDocType } from "../types";
import { usePairImages } from "../lib/images";
import { Spinner } from "./Spinner";

/**
 * Unpaired-document handling — the day's scans the server could not link
 * to a shipment by recipient name or address. The system never guesses
 * by photo position (by command), so these surface to the operator in
 * two pieces:
 *
 *   • `UnpairedAlert` — a compact warning pill above the queue. The
 *     table stays clean; the pill just says "N documente fără pereche"
 *     and opens the resolver.
 *   • `UnpairedModal` — the manual pairing system: every orphan photo
 *     shown large (click to zoom full-screen), multi-select the ones
 *     that belong to ONE shipment (the AWB label + its invoices) and
 *     press "Creează perechea". The App builds a real pending pair from
 *     the selected images, deletes the orphan rows, and runs the same
 *     extraction + pricing the desktop flow already uses — the vision
 *     model decides which image is the AWB, so even a misclassified
 *     orphan pairs correctly.
 *
 * Each orphan is a single-image row in the same pairs store (status
 * "unpaired"), so hydration, live SSE updates, and deletion all reuse
 * the existing plumbing — these components are display + selection only.
 */

const DOC_LABEL: Record<UnpairedDocType, string> = {
  awb: "AWB fără factură",
  invoice: "Factură fără AWB",
  unknown: "Necitibil",
};

const DOC_HINT: Record<UnpairedDocType, string> = {
  awb: "Eticheta de transport nu a găsit nicio factură cu același destinatar sau aceeași adresă.",
  invoice: "Factura nu a găsit niciun AWB cu același cumpărător sau aceeași adresă.",
  unknown: "Imaginea nu a putut fi citită — verifică ce document este.",
};

/* ─── Alert pill ────────────────────────────────────────────────────── */

export function UnpairedAlert({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Deschide documentele neîmperecheate pentru a le lega manual"
      className="flex items-center gap-3 rounded-xl border border-coral-300 bg-coral-50 px-4 py-2.5 text-left shadow-sm transition hover:border-coral-400 hover:bg-coral-100"
    >
      <WarningIcon className="h-5 w-5 shrink-0 text-coral-600" />
      <span className="text-sm font-semibold text-coral-700">
        {count} document{count === 1 ? "" : "e"} fără pereche
      </span>
      <span className="text-[11px] text-ink-500">
        Sistemul nu le-a putut lega după nume sau adresă — apasă pentru a le împerechea manual.
      </span>
      <span className="ml-auto shrink-0 rounded-md bg-coral-500 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-canvas-50">
        Împerechează
      </span>
    </button>
  );
}

/* ─── Manual pairing modal ──────────────────────────────────────────── */

interface ModalProps {
  /** Unpaired rows for the visible day (status.kind === "unpaired"). */
  items: Pair[];
  onClose: () => void;
  onRemove: (id: string) => void;
  /** Build a real pair from these orphan rows (≥2). Resolves true when
   *  the pair was created (the source rows are gone by then). */
  onPair: (ids: string[]) => Promise<boolean>;
}

export function UnpairedModal({ items, onClose, onRemove, onPair }: ModalProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  // Drop selections whose rows disappeared (deleted / just paired).
  useEffect(() => {
    setSelected((cur) => cur.filter((id) => items.some((p) => p.id === id)));
  }, [items]);

  // Esc closes the zoom first, then the modal — never both at once.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setZoomed((z) => {
        if (z !== null) return null;
        onClose();
        return z;
      });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const pair = async () => {
    if (selected.length < 2 || pairing) return;
    setPairing(true);
    try {
      const ok = await onPair(selected);
      if (ok) setSelected([]);
    } finally {
      setPairing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-ink-900/70 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-ink-200 bg-canvas-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-ink-200 bg-canvas-50 px-5 py-3">
          <WarningIcon className="h-5 w-5 shrink-0 text-coral-600" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-900">
              Împerechere manuală · {items.length} document{items.length === 1 ? "" : "e"}
            </h2>
            <p className="truncate text-[11px] text-ink-500">
              Click pe imagine pentru zoom · bifează eticheta AWB și facturile aceluiași transport,
              apoi apasă „Creează perechea”.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Închide (Esc)"
            className="ml-auto shrink-0 rounded-md border border-ink-300 px-2.5 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-ink-900"
          >
            ✕
          </button>
        </header>

        <div className="grid flex-1 gap-4 overflow-y-auto p-5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          {items.map((p) => (
            <OrphanCard
              key={p.id}
              pair={p}
              order={selected.indexOf(p.id)}
              onToggle={() => toggle(p.id)}
              onZoom={setZoomed}
              onRemove={() => onRemove(p.id)}
            />
          ))}
        </div>

        <footer className="flex items-center gap-3 border-t border-ink-200 bg-canvas-50 px-5 py-3">
          <span className="text-sm text-ink-600">
            {selected.length === 0
              ? "Nimic selectat."
              : `${selected.length} selectat${selected.length === 1 ? "" : "e"}${
                  selected.length < 2 ? " — mai alege cel puțin un document." : ""
                }`}
          </span>
          <button
            type="button"
            onClick={() => void pair()}
            disabled={selected.length < 2 || pairing}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-coral-500 px-4 py-1.5 text-sm font-medium text-canvas-50 shadow-sm transition hover:bg-coral-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
            title="Creează o pereche din documentele selectate și calculeaz-o"
          >
            {pairing ? (
              <Spinner label="Creez perechea…" />
            ) : (
              <span>Creează perechea{selected.length >= 2 ? ` (${selected.length})` : ""}</span>
            )}
          </button>
        </footer>
      </div>

      {/* Full-screen zoom — the whole point: read the paper, decide the pair. */}
      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/90 p-6"
          onClick={(e) => {
            e.stopPropagation();
            setZoomed(null);
          }}
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
    </div>
  );
}

/* ─── One orphan document card ──────────────────────────────────────── */

function OrphanCard({
  pair,
  order,
  onToggle,
  onZoom,
  onRemove,
}: {
  pair: Pair;
  /** Position in the current selection (-1 = not selected). */
  order: number;
  onToggle: () => void;
  onZoom: (url: string) => void;
  onRemove: () => void;
}) {
  const docType: UnpairedDocType =
    pair.status.kind === "unpaired" ? pair.status.docType : "unknown";
  const { files, loading } = usePairImages(pair);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const f = files[0];
    if (!f) return;
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [files]);

  const name = files[0]?.name ?? pair.imageRefs?.[0]?.name ?? "";
  const isSelected = order >= 0;

  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg border bg-canvas-50 shadow-sm transition ${
        isSelected ? "border-coral-500 ring-2 ring-coral-400" : "border-ink-200"
      }`}
      title={DOC_HINT[docType]}
    >
      <div className="relative">
        {loading || !url ? (
          <div className="h-52 w-full animate-pulse bg-ink-200/60" />
        ) : (
          <img
            src={url}
            alt={name}
            onClick={() => onZoom(url)}
            className="h-52 w-full cursor-zoom-in object-cover"
          />
        )}
        {/* Selection toggle — big and separate from the zoom target. */}
        <button
          type="button"
          onClick={onToggle}
          title={isSelected ? "Scoate din pereche" : "Adaugă la pereche"}
          className={`absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full border-2 text-sm font-bold shadow transition ${
            isSelected
              ? "border-coral-500 bg-coral-500 text-canvas-50"
              : "border-ink-300 bg-canvas-50/90 text-transparent hover:border-coral-400"
          }`}
        >
          {isSelected ? order + 1 : "✓"}
        </button>
        <span className="absolute right-2 top-2 rounded bg-ink-900/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-canvas-50">
          {DOC_LABEL[docType]}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <span className="truncate font-mono text-[10px] text-ink-500" title={name}>
          {name}
        </span>
        <button
          type="button"
          onClick={onRemove}
          title="Șterge documentul"
          className="shrink-0 rounded p-1 text-ink-400 transition hover:bg-coral-100 hover:text-coral-600"
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
    </div>
  );
}

/* ─── Shared icon ───────────────────────────────────────────────────── */

function WarningIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

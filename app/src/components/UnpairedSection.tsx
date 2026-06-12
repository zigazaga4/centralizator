import { useEffect, useState } from "react";
import type { Pair, UnpairedDocType } from "../types";
import { usePairImages } from "../lib/images";

/**
 * The day's UNPAIRED documents — scans the server could not link to a
 * shipment by recipient name or address. The system never guesses by
 * photo position (by command), so instead of silently dropping these
 * it surfaces them here: the operator sees exactly which papers are
 * orphaned, re-photographs the shipment properly (label + invoices
 * together, names readable) or deletes the stray.
 *
 * Each entry is a single-image row in the same pairs store (status
 * "unpaired"), so live SSE updates, hydration, and deletion all reuse
 * the existing plumbing — this component is display-only.
 */

const DOC_LABEL: Record<UnpairedDocType, string> = {
  awb: "AWB fără factură",
  invoice: "Factură fără AWB",
  unknown: "Necitibil",
};

const DOC_HINT: Record<UnpairedDocType, string> = {
  awb: "Eticheta de transport nu a găsit nicio factură cu același destinatar sau aceeași adresă.",
  invoice: "Factura nu a găsit niciun AWB cu același cumpărător sau aceeași adresă.",
  unknown: "Imaginea nu a putut fi citită — refotografiază documentul.",
};

interface Props {
  /** Unpaired rows for the visible day (status.kind === "unpaired"). */
  items: Pair[];
  onRemove: (id: string) => void;
}

export function UnpairedSection({ items, onRemove }: Props) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-xl border border-coral-300 bg-coral-50/40 shadow-sm">
      <header className="flex items-baseline gap-3 border-b border-coral-200 px-4 py-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-coral-700">
          Documente neîmperecheate ({items.length})
        </h2>
        <p className="text-[11px] text-ink-500">
          Sistemul nu le-a putut lega după nume sau adresă — verifică-le și refotografiază
          transportul (AWB + facturi împreună) sau șterge-le.
        </p>
      </header>
      <div className="flex flex-wrap gap-3 p-4">
        {items.map((p) => (
          <UnpairedCard key={p.id} pair={p} onRemove={() => onRemove(p.id)} />
        ))}
      </div>
    </section>
  );
}

function UnpairedCard({ pair, onRemove }: { pair: Pair; onRemove: () => void }) {
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

  return (
    <div
      className="flex w-40 flex-col overflow-hidden rounded-lg border border-coral-200 bg-canvas-50 shadow-sm"
      title={DOC_HINT[docType]}
    >
      {loading || !url ? (
        <div className="h-32 w-full animate-pulse bg-ink-200/60" />
      ) : (
        <img src={url} alt={name} className="h-32 w-full object-cover" />
      )}
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-coral-700">
            {DOC_LABEL[docType]}
          </div>
          <div className="truncate font-mono text-[10px] text-ink-500" title={name}>
            {name}
          </div>
        </div>
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

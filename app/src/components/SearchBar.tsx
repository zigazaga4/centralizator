/* ──────────────────────────────────────────────────────────────────────
 * Queue search bar
 *
 * Filters the visible day's table by any of the pair's text fields (see
 * the info popover for the full list). Diacritic- and case-insensitive,
 * token-AND matching lives in lib/search.ts; this component is the input
 * chrome + a clear button + a hover "what can I search?" hint + an
 * optional result count.
 * ────────────────────────────────────────────────────────────────────── */

/** The fields the search looks at — shown in the hover info popover so the
 *  operator knows what to type. Mirrors `pairSearchText` in lib/search.ts. */
const SEARCHABLE_FIELDS = [
  "Număr AWB",
  "Destinatar (nume, telefon, adresă)",
  "Expeditor (nume, adresă)",
  "Număr factură",
  "Număr comandă",
  "Cumpărător + CIF",
  "Furnizor + CIF",
] as const;

export function SearchBar({
  value,
  onChange,
  count,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Match count to show while filtering; null hides the badge. */
  count: number | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex flex-1 items-center">
        {/* Magnifier */}
        <svg
          className="pointer-events-none absolute left-3 h-4 w-4 text-ink-400"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Caută după AWB, destinatar, factură…"
          aria-label="Caută în perechile zilei"
          className="w-full rounded-lg border border-ink-200 bg-canvas-50 py-2 pl-9 pr-9 text-sm text-ink-900 shadow-sm outline-none transition placeholder:text-ink-400 focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="Șterge căutarea"
            aria-label="Șterge căutarea"
            className="absolute right-2 flex h-6 w-6 items-center justify-center rounded-md text-ink-400 transition hover:bg-canvas-200 hover:text-ink-700"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {count !== null && (
        <span className="shrink-0 whitespace-nowrap text-[12px] tabular-nums text-ink-500">
          {count} {count === 1 ? "rezultat" : "rezultate"}
        </span>
      )}

      {/* Info button — hover (or focus) reveals what the search covers. */}
      <div className="group relative shrink-0">
        <button
          type="button"
          aria-label="Ce pot căuta?"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-ink-200 bg-canvas-50 text-ink-500 transition hover:border-coral-400 hover:text-coral-700"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>
        {/* Tooltip — shown on hover/focus of the group. */}
        <div className="invisible absolute right-0 top-full z-30 mt-2 w-64 rounded-lg border border-ink-200 bg-canvas-50 p-3 text-left opacity-0 shadow-xl transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
          <p className="mb-1.5 text-[12px] font-semibold text-ink-900">Poți căuta după:</p>
          <ul className="space-y-0.5 text-[11px] text-ink-600">
            {SEARCHABLE_FIELDS.map((f) => (
              <li key={f} className="flex items-start gap-1.5">
                <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-coral-400" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-ink-200 pt-2 text-[10px] text-ink-500">
            Ignoră diacriticele și majusculele. Mai multe cuvinte = toate trebuie găsite.
          </p>
        </div>
      </div>
    </div>
  );
}

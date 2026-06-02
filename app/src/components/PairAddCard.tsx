import { useCallback, useRef, useState } from "react";

interface Props {
  /** Called once per discovered (image, image) pair. Drop 6 files → fires 3 times. */
  onAddPair: (pair: File[]) => void;
  /** Whether to render the big hero variant (empty state) or the compact bar. */
  hero?: boolean;
}

/**
 * Persistent "+ Add a pair" card. Sits above the table and stays put as
 * the queue grows. Supports three input methods:
 *
 *   • click  → OS file picker (multiple)
 *   • drop   → drag-and-drop one or many files
 *   • paste  → Ctrl+V images from clipboard
 *
 * Batching: any even number of dropped images is split into consecutive
 * pairs of two, and each pair fires `onAddPair` once. An odd file at
 * the end is reported as a warning so the user can re-add it.
 */
export function PairAddCard({ onAddPair, hero }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const handle = useCallback(
    (incoming: FileList | File[]) => {
      const imgs = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
      if (imgs.length === 0) {
        setWarning("Niciun fișier imagine detectat.");
        return;
      }
      if (imgs.length === 1) {
        setWarning("Selectează DOUĂ imagini deodată pentru o pereche.");
        return;
      }
      // Split into consecutive pairs. Drop the trailing odd one with a hint.
      let added = 0;
      for (let i = 0; i + 1 < imgs.length; i += 2) {
        onAddPair([imgs[i]!, imgs[i + 1]!]);
        added += 1;
      }
      const leftover = imgs.length % 2 === 1;
      setWarning(
        leftover
          ? `Am adăugat ${added} pereche${added === 1 ? "" : "i"} — ultima imagine a fost ignorată (număr impar).`
          : null,
      );
    },
    [onAddPair],
  );

  return (
    <div className="space-y-2">
      <div
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handle(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          const imgs = Array.from(e.clipboardData.items)
            .filter((i) => i.type.startsWith("image/"))
            .map((i) => i.getAsFile())
            .filter((f): f is File => !!f);
          if (imgs.length) handle(imgs);
        }}
        role="button"
        tabIndex={0}
        aria-label="Adaugă o pereche AWB + Factură"
        className={`cursor-pointer rounded-2xl border-2 border-dashed bg-canvas-50 shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-coral-400 ${
          over
            ? "border-coral-500 bg-coral-50"
            : "border-ink-200 hover:border-coral-400 hover:bg-canvas-200"
        } ${hero ? "px-8 py-12 text-center" : "flex items-center justify-between gap-4 px-5 py-3"}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handle(e.target.files);
            e.target.value = "";
          }}
        />

        {hero ? (
          <>
            <div className="mb-5 flex items-center justify-center">
              <div className="rounded-full bg-coral-500 p-4 text-canvas-50 shadow-sm">
                <svg
                  className="h-7 w-7"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" x2="12" y1="3" y2="15" />
                </svg>
              </div>
            </div>
            <p className="text-base font-medium text-ink-900">
              Adaugă prima pereche AWB + Factură
            </p>
            <p className="mt-1.5 text-sm text-ink-500">
              Două imagini deodată — modelul identifică automat care e care.
              Repetă pentru fiecare pereche.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-coral-500 text-canvas-50">
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-ink-900">
                  Adaugă o pereche
                </p>
                <p className="text-xs text-ink-500">
                  AWB + Factură (în orice ordine) · drop N×2 imagini pentru N perechi
                </p>
              </div>
            </div>
            <span className="hidden text-[11px] uppercase tracking-widest text-ink-400 sm:inline">
              Click · drag · paste
            </span>
          </>
        )}
      </div>

      {warning && (
        <p className="rounded-md bg-coral-100 px-3 py-1.5 text-xs font-medium text-coral-700">
          {warning}
        </p>
      )}
    </div>
  );
}

import { useCallback, useRef, useState } from "react";

interface Props {
  /** Called once per drop. The dropped files form a single pair:
   *  one AWB image + one or more invoice images. */
  onAddPair: (pair: File[]) => void;
  /** Whether to render the big hero variant (empty state) or the compact bar. */
  hero?: boolean;
}

/** Hard cap mirrored from the server's `MAX_IMAGES` in routes/extract.ts.
 *  Keeps any single pair under the vision model's token budget. */
const MAX_IMAGES_PER_PAIR = 12;

/**
 * Persistent "+ Add a pair" card. Sits above the table and stays put as
 * the queue grows. Supports three input methods:
 *
 *   • click  → OS file picker (multiple)
 *   • drop   → drag-and-drop one or many files
 *   • paste  → Ctrl+V images from clipboard
 *
 * One pair per drop. The dropped images form a single (1 AWB +
 * N-1 invoices) bundle — the vision model identifies which one is the
 * AWB and treats the rest as invoices in the same order they were
 * dropped. The previous "N×2 images = N pairs" batching is gone now
 * that a pair can carry more than two images.
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
        setWarning("O singură imagine — selectează cel puțin DOUĂ (1 AWB + 1 factură).");
        return;
      }
      if (imgs.length > MAX_IMAGES_PER_PAIR) {
        setWarning(
          `Prea multe imagini (${imgs.length}). Maxim ${MAX_IMAGES_PER_PAIR} per pereche — am ignorat surplusul.`,
        );
        onAddPair(imgs.slice(0, MAX_IMAGES_PER_PAIR));
        return;
      }
      const invoices = imgs.length - 1;
      setWarning(
        invoices === 1
          ? null
          : `Pereche cu ${invoices} facturi — modelul identifică AWB-ul automat.`,
      );
      onAddPair(imgs);
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
        aria-label="Adaugă o pereche AWB + Facturi"
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
              Adaugă prima pereche AWB + Facturi
            </p>
            <p className="mt-1.5 text-sm text-ink-500">
              Drop AWB-ul + una sau mai multe facturi deodată — modelul
              identifică automat care e care. O pereche per drop.
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
                  1 AWB + 1 sau mai multe facturi (în orice ordine) · o pereche per drop
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

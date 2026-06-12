import { useCallback, useRef, useState } from "react";
import {
  COLLABORATOR_KEYS,
  COLLABORATOR_LABEL,
  type CollaboratorKey,
} from "../types";

interface Props {
  /** Sends the dropped photos into THE one ingestion flow (/scan-batch):
   *  the server classifies every image, pairs them by recipient
   *  name/address, prices the pairs and surfaces leftovers as unpaired.
   *  The collaborator is the one picked in the upload modal — every pair
   *  the batch produces is stamped with it. Resolves true when the
   *  upload was accepted. */
  onScan: (images: File[], collaborator: CollaboratorKey | null) => Promise<boolean>;
  /** Whether to render the big hero variant (empty state) or the compact bar. */
  hero?: boolean;
}

/** Hard cap mirrored from the server's `MAX_BATCH_IMAGES` in
 *  routes/scan-batch.ts. One drop = one batch. */
const MAX_IMAGES = 120;

/** localStorage key for the last collaborator picked in the upload modal —
 *  preselected next time so the common case is one click on "Trimite". */
const LS_UPLOAD_COLLABORATOR = "centralizator.uploadCollaborator";

function readStoredCollaborator(): CollaboratorKey | null {
  try {
    const s = localStorage.getItem(LS_UPLOAD_COLLABORATOR);
    if (s && (COLLABORATOR_KEYS as readonly string[]).includes(s)) {
      return s as CollaboratorKey;
    }
  } catch {
    /* localStorage may be disabled — fall through. */
  }
  return null;
}

/**
 * Persistent "+ Adaugă documente" card. Sits above the table and stays
 * put as the queue grows. Supports three input methods:
 *
 *   • click  → OS file picker (multiple)
 *   • drop   → drag-and-drop one or many files
 *   • paste  → Ctrl+V images from clipboard
 *
 * There is ONE ingestion flow (by command): every photo — from the
 * phone scanner or from this card — goes through /scan-batch, where
 * the AI classifies each image and deterministic code pairs them by
 * the recipient name/address printed on the paper. The user does not
 * group anything by hand: drop the whole stack, the pairs stream into
 * the table live, and whatever cannot be paired shows up in the
 * unpaired pill for manual resolution.
 */
export function PairAddCard({ onScan, hero }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  // Files validated and waiting for the collaborator pick — non-null
  // while the modal is open. The upload only fires from `doSend`.
  const [pending, setPending] = useState<File[] | null>(null);

  /** Validate the incoming files and open the collaborator modal —
   *  the assignment happens IN the flow, before anything is uploaded. */
  const handle = useCallback(
    (incoming: FileList | File[]) => {
      if (sending || pending) return; // one upload at a time — the next drop waits
      const imgs = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
      if (imgs.length === 0) {
        setNotice({ kind: "warn", text: "Niciun fișier imagine detectat." });
        return;
      }
      if (imgs.length > MAX_IMAGES) {
        setNotice({
          kind: "warn",
          text: `Prea multe imagini (${imgs.length}). Maxim ${MAX_IMAGES} per trimitere.`,
        });
        return;
      }
      setNotice(null);
      setPending(imgs);
    },
    [sending, pending],
  );

  /** The actual upload — fired by the modal's confirm with the chosen
   *  collaborator. Saves the choice as next time's default. */
  const doSend = useCallback(
    (imgs: File[], collaborator: CollaboratorKey | null) => {
      setPending(null);
      try {
        if (collaborator) localStorage.setItem(LS_UPLOAD_COLLABORATOR, collaborator);
        else localStorage.removeItem(LS_UPLOAD_COLLABORATOR);
      } catch {
        /* best-effort — losing this only forgets the default */
      }
      setSending(true);
      void onScan(imgs, collaborator)
        .then((ok) => {
          setNotice(
            ok
              ? {
                  kind: "ok",
                  text: `${imgs.length} imagine${imgs.length === 1 ? "" : "i"} trimise pentru ${
                    collaborator ? COLLABORATOR_LABEL[collaborator] : "plată directă (fără colaborator)"
                  } — fiecare imagine este citită separat, apoi împerecheată după destinatar; perechile apar automat în tabel.`,
                }
              : {
                  kind: "warn",
                  text: "Trimiterea a eșuat — verifică conexiunea și încearcă din nou.",
                },
          );
        })
        .finally(() => setSending(false));
    },
    [onScan],
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
        aria-label="Adaugă documente (AWB-uri și facturi)"
        className={`cursor-pointer rounded-2xl border-2 border-dashed bg-canvas-50 shadow-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-coral-400 ${
          over
            ? "border-coral-500 bg-coral-50"
            : "border-ink-200 hover:border-coral-400 hover:bg-canvas-200"
        } ${sending ? "pointer-events-none opacity-60" : ""} ${hero ? "px-8 py-12 text-center" : "flex items-center justify-between gap-4 px-5 py-3"}`}
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
              {sending ? "Se trimit imaginile…" : "Adaugă documente"}
            </p>
            <p className="mt-1.5 text-sm text-ink-500">
              Drop toate pozele deodată (AWB-uri + facturi, în orice ordine) —
              fiecare imagine este citită separat, apoi împerecheată după
              destinatar și calculată automat.
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
                  {sending ? "Se trimit imaginile…" : "Adaugă documente"}
                </p>
                <p className="text-xs text-ink-500">
                  oricâte poze deodată · împerechere automată după destinatar
                </p>
              </div>
            </div>
            <span className="hidden text-[11px] uppercase tracking-widest text-ink-400 sm:inline">
              Click · drag · paste
            </span>
          </>
        )}
      </div>

      {notice && (
        <p
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
            notice.kind === "ok"
              ? "bg-canvas-200 text-ink-700"
              : "bg-coral-100 text-coral-700"
          }`}
        >
          {notice.text}
        </p>
      )}

      {/* Collaborator assignment — the gate every upload passes through */}
      {pending && (
        <CollaboratorPickModal
          count={pending.length}
          onCancel={() => setPending(null)}
          onConfirm={(c) => doSend(pending, c)}
        />
      )}
    </div>
  );
}

/**
 * Modal shown right after a drop/pick/paste: WHOSE documents are these?
 * The chosen collaborator is sent with the batch and stamped on every
 * pair it produces, so the queue files each pair under the right
 * partner from the start. Last choice arrives preselected.
 */
function CollaboratorPickModal({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: (collaborator: CollaboratorKey | null) => void;
}) {
  const [choice, setChoice] = useState<CollaboratorKey | null>(readStoredCollaborator);

  const option = (key: CollaboratorKey | null, label: string) => {
    const active = choice === key;
    return (
      <button
        key={key ?? "direct"}
        type="button"
        onClick={() => setChoice(key)}
        className={`flex w-full items-center justify-between rounded-lg border px-4 py-2.5 text-left text-sm font-medium transition ${
          active
            ? "border-coral-500 bg-coral-50 text-coral-800"
            : "border-ink-200 bg-canvas-50 text-ink-700 hover:border-coral-300 hover:bg-canvas-100"
        }`}
      >
        <span>{label}</span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full border ${
            active ? "border-coral-500 bg-coral-500" : "border-ink-300"
          }`}
        >
          {active && (
            <svg className="h-2.5 w-2.5 text-canvas-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/70 p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Alege colaboratorul"
    >
      <div
        className="w-full max-w-md rounded-xl border border-ink-200 bg-canvas-50 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-800">
              Pentru ce colaborator sunt documentele?
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              Toate perechile din acest lot ({count} imagine{count === 1 ? "" : "i"}) se
              salvează pe colaboratorul ales.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Renunță"
            className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-coral-700"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {COLLABORATOR_KEYS.map((k) => option(k, COLLABORATOR_LABEL[k]))}
          {option(null, "Direct (fără colaborator)")}
        </div>

        <button
          type="button"
          onClick={() => onConfirm(choice)}
          className="mt-4 w-full rounded-lg bg-coral-500 px-4 py-2.5 text-sm font-semibold text-canvas-50 shadow-sm transition hover:bg-coral-600"
        >
          Trimite ({count} imagine{count === 1 ? "" : "i"})
        </button>
      </div>
    </div>
  );
}

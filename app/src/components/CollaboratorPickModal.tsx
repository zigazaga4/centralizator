import { useState } from "react";
import { COLLABORATOR_KEYS, collaboratorLabel, getCustomCollaborators } from "../types";

/**
 * Collaborator picker modal — the single "whose documents/pairs are
 * these?" gate, shared by every flow that assigns a collaborator:
 *
 *   • PairAddCard — on drop/pick/paste, before the upload reaches
 *     /scan-batch (the assignment happens IN the upload flow);
 *   • UnpairedModal — before manually-built or AI-suggested pairs are
 *     sent to the OCR model, so the operator confirms (or corrects) the
 *     collaborator the orphans were uploaded under.
 *
 * The component is pure copy + selection: the caller supplies the
 * title, subtitle and confirm label, plus an `initial` preselect (the
 * remembered upload choice, or the collaborator inherited from the
 * orphan rows). It never reads localStorage itself — persistence is
 * the caller's job, so the same modal serves contexts with different
 * defaults.
 */
interface Props {
  /** Heading question, e.g. "Pentru ce colaborator sunt documentele?" */
  title: string;
  /** Optional one-line explanation under the title. */
  subtitle?: string;
  /** Confirm-button text, e.g. "Trimite (3 imagini)". */
  confirmLabel: string;
  /** Preselected option — the remembered/inherited collaborator, or
   *  null for "Direct (fără colaborator)". */
  initial?: string | null;
  onCancel: () => void;
  onConfirm: (collaborator: string | null) => void;
}

export function CollaboratorPickModal({
  title,
  subtitle,
  confirmLabel,
  initial = null,
  onCancel,
  onConfirm,
}: Props) {
  const [choice, setChoice] = useState<string | null>(initial);

  const option = (key: string | null, label: string) => {
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/70 p-6"
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
              {title}
            </h3>
            {subtitle && <p className="mt-1 text-xs text-ink-500">{subtitle}</p>}
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
          {[...COLLABORATOR_KEYS, ...getCustomCollaborators().map((c) => c.key)].map((k) =>
            option(k, collaboratorLabel(k)),
          )}
          {option(null, "Direct (fără colaborator)")}
        </div>

        <button
          type="button"
          onClick={() => onConfirm(choice)}
          className="mt-4 w-full rounded-lg bg-coral-500 px-4 py-2.5 text-sm font-semibold text-canvas-50 shadow-sm transition hover:bg-coral-600"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}

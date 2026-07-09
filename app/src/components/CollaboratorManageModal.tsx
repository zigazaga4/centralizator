import { useEffect, useState } from "react";
import {
  CITY_LABEL,
  collaboratorBonusPct,
  collaboratorLabel,
  collaboratorsForCity,
  isBuiltinCollaborator,
  type CityKey,
} from "../types";

/**
 * Manage the collaborators of one city: edit any partner's commission bonus
 * (built-in or custom) and add new ones. Bonuses are shown/entered as PERCENT
 * and stored as a fraction. Every change hits the server, which re-prices the
 * whole ready queue, so the caller re-fetches collaborators + pairs on
 * `onChanged` (folded into the on* callbacks below).
 */
interface Props {
  city: CityKey;
  /** Create a collaborator for this city (bonusPct is a FRACTION). */
  onCreate: (label: string, bonusPct: number) => Promise<void>;
  /** Set a collaborator's bonus (FRACTION), built-in or custom. */
  onSetBonus: (key: string, bonusPct: number) => Promise<void>;
  /** Delete a custom collaborator (or revert a built-in to its default). */
  onDelete: (key: string) => Promise<void>;
  onClose: () => void;
}

/** "25" → 0.25 (percent string → fraction). Blank/garbage → 0. */
function parsePct(s: string): number {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? Math.max(0, n) / 100 : 0;
}
/** 0.301 → "30.1" (fraction → percent string, one decimal, no trailing .0). */
function fmtPct(fraction: number): string {
  return String(Math.round(fraction * 1000) / 10);
}

export function CollaboratorManageModal({ city, onCreate, onSetBonus, onDelete, onClose }: Props) {
  const keys = collaboratorsForCity(city);
  const [newName, setNewName] = useState("");
  const [newPct, setNewPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addNew = () => {
    const label = newName.trim();
    if (!label || busy) return;
    void run(async () => {
      await onCreate(label, parsePct(newPct));
      setNewName("");
      setNewPct("");
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/70 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Gestionează colaboratorii"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-ink-200 bg-canvas-50 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-ink-800">
              Colaboratori · {CITY_LABEL[city]}
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              Editează comisionul (%) sau adaugă un colaborator. Modificările se aplică imediat pe toate perechile.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Închide"
            className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1 text-sm text-ink-700 transition hover:border-coral-400 hover:text-coral-700"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-md bg-coral-50 px-2.5 py-1.5 text-xs text-coral-700">{error}</div>
        )}

        <div className="mt-3 space-y-1.5">
          {keys.length === 0 && (
            <p className="text-xs text-ink-400">Niciun colaborator pentru acest oraș.</p>
          )}
          {keys.map((key) => (
            <CollaboratorRow
              key={key}
              label={collaboratorLabel(key)}
              pct={collaboratorBonusPct(key)}
              builtin={isBuiltinCollaborator(key)}
              busy={busy}
              onSave={(p) => run(() => onSetBonus(key, p))}
              onDelete={() => run(() => onDelete(key))}
            />
          ))}
        </div>

        <div className="mt-4 flex items-end gap-2 border-t border-ink-200 pt-3">
          <label className="flex-1">
            <span className="text-[10px] uppercase tracking-wider text-ink-500">Colaborator nou</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNew()}
              placeholder="Ex: Popescu Ion"
              disabled={busy}
              className="mt-0.5 w-full rounded-md border border-ink-300 bg-canvas-50 px-2 py-1.5 text-sm text-ink-800 outline-none focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
            />
          </label>
          <label className="w-24">
            <span className="text-[10px] uppercase tracking-wider text-ink-500">Comision %</span>
            <input
              value={newPct}
              onChange={(e) => setNewPct(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNew()}
              placeholder="0"
              inputMode="decimal"
              disabled={busy}
              className="mt-0.5 w-full rounded-md border border-ink-300 bg-canvas-50 px-2 py-1.5 text-right text-sm tabular-nums text-ink-800 outline-none focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
            />
          </label>
          <button
            type="button"
            onClick={addNew}
            disabled={busy || !newName.trim()}
            className="rounded-md bg-coral-500 px-3 py-1.5 text-sm font-semibold text-canvas-50 shadow-sm transition hover:bg-coral-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Adaugă
          </button>
        </div>
      </div>
    </div>
  );
}

function CollaboratorRow({
  label,
  pct,
  builtin,
  busy,
  onSave,
  onDelete,
}: {
  label: string;
  pct: number;
  builtin: boolean;
  busy: boolean;
  onSave: (bonusPct: number) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(fmtPct(pct));
  // Resync when the effective bonus changes underneath us (e.g. after the
  // server re-prices and the parent re-fetches).
  useEffect(() => setDraft(fmtPct(pct)), [pct]);

  const commit = () => {
    const next = parsePct(draft);
    if (Math.abs(next - pct) > 1e-9) onSave(next);
    else setDraft(fmtPct(pct));
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-canvas-50 px-3 py-1.5">
      <span className="flex-1 truncate text-sm text-ink-800">
        {label}
        {!builtin && (
          <span className="ml-1.5 rounded bg-canvas-200 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-500">
            nou
          </span>
        )}
      </span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            setDraft(fmtPct(pct));
            e.currentTarget.blur();
          }
        }}
        disabled={busy}
        inputMode="decimal"
        aria-label={`Comision ${label}`}
        className="w-16 rounded border border-ink-300 bg-canvas-50 px-2 py-1 text-right text-sm tabular-nums text-ink-800 outline-none focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
      />
      <span className="text-xs text-ink-400">%</span>
      {!builtin && (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          title="Șterge colaboratorul"
          aria-label={`Șterge ${label}`}
          className="rounded p-1 text-ink-400 transition hover:text-coral-600 disabled:opacity-40"
        >
          ✕
        </button>
      )}
    </div>
  );
}

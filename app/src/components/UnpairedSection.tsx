import { useEffect, useState } from "react";
import type { CollaboratorKey, Pair, UnpairedDocType } from "../types";
import { usePairImages } from "../lib/images";
import { suggestPairs } from "../lib/api";
import { Spinner } from "./Spinner";
import { CollaboratorPickModal } from "./CollaboratorPickModal";
import { SearchBar } from "./SearchBar";
import { pairMatchesQuery } from "../lib/search";

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
 *   • AI suggestions — the "Împerechere AI" button ships ALL the orphan
 *     photos to the model in one call (POST /pairs/suggest) and shows
 *     its pairing PROPOSALS under the grid. The operator rearranges them
 *     by drag-and-drop (photo ↔ group ↔ pool) and only the explicit
 *     "Trimite perechile la OCR" button turns the groups into real pairs
 *     through the same manual flow — nothing reaches the queue before.
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
  /** Build a real pair from these orphan rows (≥2) under the chosen
   *  collaborator. Resolves true when the pair was created (the source
   *  rows are gone by then). */
  onPair: (ids: string[], collaborator: CollaboratorKey | null) => Promise<boolean>;
  /** Existing (non-unpaired) pairs of the day the selected orphans can be
   *  attached to. */
  existingPairs: Pair[];
  /** Attach the selected orphan(s) to an existing pair — appended as invoices,
   *  the pair re-read + re-priced server-side, the orphan rows removed. */
  onAttach: (pairId: string, sourceIds: string[]) => Promise<void>;
  /** Re-run the AI pairing over ALL of the day's unpaired documents. */
  onRetry: () => Promise<void>;
}

/** One AI-suggested (then human-rearranged) group of orphan-row ids.
 *  Lives only in the modal — becomes a real pair on "Trimite la OCR". */
interface SuggestedGroup {
  ids: string[];
  evidence: string | null;
}

export function UnpairedModal({ items, onClose, onRemove, onPair, existingPairs, onAttach, onRetry }: ModalProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  // Send-to-existing-pair: `picking` opens the pair-picker, `attaching` guards
  // the in-flight attach. `retrying` guards the "re-run AI pairing" pass.
  const [picking, setPicking] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** AI proposals: null = not requested yet; [] = asked, none found. */
  const [groups, setGroups] = useState<SuggestedGroup[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  /** The "send to OCR" pass is in flight (pairs being created). */
  const [sending, setSending] = useState(false);
  /** Collaborator pick gate: non-null while the modal is open, holding
   *  the id-groups queued to become pairs (one for manual, N for the AI
   *  batch) plus the default collaborator inherited from the orphans. */
  const [pendingSend, setPendingSend] = useState<{
    kind: "manual" | "ocr";
    groups: string[][];
    initial: CollaboratorKey | null;
  } | null>(null);

  // Drop selections + suggestion members whose rows disappeared
  // (deleted / just paired); empty groups dissolve.
  useEffect(() => {
    setSelected((cur) => cur.filter((id) => items.some((p) => p.id === id)));
    setGroups((cur) =>
      cur === null
        ? cur
        : cur
            .map((g) => ({ ...g, ids: g.ids.filter((id) => items.some((p) => p.id === id)) }))
            .filter((g) => g.ids.length > 0),
    );
  }, [items]);

  // A document inside a suggested group leaves the manual selection —
  // the two mechanisms never claim the same photo at once.
  useEffect(() => {
    if (groups === null) return;
    const inGroup = new Set(groups.flatMap((g) => g.ids));
    setSelected((cur) => cur.filter((id) => !inGroup.has(id)));
  }, [groups]);

  // Esc closes, in order: the collaborator gate, then the zoom, then
  // the modal — never two layers at once.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (pendingSend) {
        setPendingSend(null);
        return;
      }
      if (picking) {
        setPicking(false);
        return;
      }
      setZoomed((z) => {
        if (z !== null) return null;
        onClose();
        return z;
      });
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pendingSend, picking]);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  /** Collaborator inherited from a set of orphan rows: the first
   *  non-null assignment (every orphan of a batch carries the same one,
   *  stamped at upload). Null when none of them was assigned. */
  const inheritedCollaborator = (ids: string[]): CollaboratorKey | null => {
    for (const id of ids) {
      const p = items.find((x) => x.id === id);
      if (p?.collaborator) return p.collaborator;
    }
    return null;
  };

  /** Manual "Creează perechea" — open the collaborator gate for the
   *  selected group; the pair is created on confirm. One document is
   *  allowed: a lone AWB (label without an invoice) still prices on its
   *  own. Two+ is the normal AWB + invoice(s) case. */
  const pair = () => {
    if (selected.length < 1 || pairing || pendingSend) return;
    setPendingSend({ kind: "manual", groups: [selected], initial: inheritedCollaborator(selected) });
  };

  /** Re-run the AI pairing over EVERY unpaired document of the day. Useful
   *  after adding more orphans: the server re-reads them all and pairs what it
   *  can; the rest stream back as unpaired. */
  const retry = async () => {
    if (items.length < 1 || retrying || sending || pairing) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch (err) {
      console.error("retry pairing failed:", err);
    } finally {
      setRetrying(false);
    }
  };

  /** Attach the selected orphan(s) to an existing pair chosen in the picker. */
  const attach = async (pairId: string) => {
    if (selected.length < 1 || attaching) return;
    setAttaching(true);
    try {
      await onAttach(pairId, selected);
      setSelected([]);
      setPicking(false);
    } catch (err) {
      console.error("attach to existing pair failed:", err);
    } finally {
      setAttaching(false);
    }
  };

  /** "Împerechere AI" — ship every orphan's photo to the model in one
   *  call and lay its proposals out under the grid. Pure read. */
  const suggest = async () => {
    if (items.length < 2 || suggesting || sending) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const sugg = await suggestPairs(items.map((p) => p.id));
      setGroups(sugg.map((s) => ({ ids: [s.awbId, ...s.invoiceIds], evidence: s.evidence })));
    } catch (err) {
      setGroups(null);
      setSuggestError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  /** Drag-and-drop move: pull `id` out of every group, then drop it into
   *  group `target` (`null` = back to the unassigned pool). */
  const moveTo = (id: string, target: number | null) =>
    setGroups((cur) => {
      if (cur === null) return cur;
      const next = cur.map((g) => ({ ...g, ids: g.ids.filter((x) => x !== id) }));
      if (target !== null && next[target]) {
        next[target] = { ...next[target], ids: [...next[target].ids, id] };
      }
      return next.filter((g) => g.ids.length > 0);
    });

  /** Undo one whole suggestion — its documents return to the pool. */
  const dissolve = (gi: number) =>
    setGroups((cur) => (cur === null ? cur : cur.filter((_, i) => i !== gi)));

  // Only complete groups (AWB + at least one more document) ride to OCR.
  const readyGroups = (groups ?? []).filter((g) => g.ids.length >= 2);

  /** "Trimite perechile la OCR" — open the collaborator gate for the
   *  whole approved batch; the pairs are created on confirm. */
  const sendToOcr = () => {
    if (readyGroups.length === 0 || sending || pairing || pendingSend) return;
    const groups = readyGroups.map((g) => g.ids);
    setPendingSend({ kind: "ocr", groups, initial: inheritedCollaborator(groups.flat()) });
  };

  /** Confirmed the collaborator — every queued group becomes a real
   *  pair through the same manual flow (insert + extract + price) under
   *  the chosen collaborator, all in parallel. Only NOW do they appear
   *  in the queue/excel view; a failed group keeps its rows and stays
   *  listed for a retry. */
  const confirmSend = async (collaborator: CollaboratorKey | null) => {
    if (!pendingSend) return;
    const { kind, groups } = pendingSend;
    setPendingSend(null);
    if (kind === "manual") {
      setPairing(true);
      try {
        const ok = await onPair(groups[0]!, collaborator);
        if (ok) setSelected([]);
      } finally {
        setPairing(false);
      }
    } else {
      setSending(true);
      try {
        await Promise.all(groups.map((ids) => onPair(ids, collaborator)));
      } finally {
        setSending(false);
      }
    }
  };

  // Pool = orphans not claimed by any suggestion (all of them pre-AI).
  const grouped = new Set((groups ?? []).flatMap((g) => g.ids));
  const pool = items.filter((p) => !grouped.has(p.id));
  const byId = new Map(items.map((p) => [p.id, p] as const));

  return (
    <>
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
              Click pe imagine pentru zoom · bifează eticheta AWB și facturile aceluiași transport
              (sau doar un AWB singur, fără factură), apoi apasă „Creează perechea”.
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

        <div
          className="flex-1 overflow-y-auto"
          /* Dropping anywhere outside a suggestion card returns the
             dragged document to the unassigned pool. */
          onDragOver={(e) => {
            if (groups !== null) e.preventDefault();
          }}
          onDrop={(e) => {
            const id = e.dataTransfer.getData("text/plain");
            if (id) moveTo(id, null);
          }}
        >
          {pool.length > 0 && (
            <div className="grid gap-4 p-5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
              {pool.map((p) => (
                <OrphanCard
                  key={p.id}
                  pair={p}
                  order={selected.indexOf(p.id)}
                  draggable={groups !== null}
                  onToggle={() => toggle(p.id)}
                  onZoom={setZoomed}
                  onRemove={() => onRemove(p.id)}
                />
              ))}
            </div>
          )}
          {pool.length === 0 && items.length > 0 && (
            <p className="px-5 pt-4 text-center text-xs text-ink-500">
              Toate documentele sunt în perechile sugerate — trage o imagine aici pentru a o scoate.
            </p>
          )}

          {/* AI suggestions — proposals only, until "Trimite la OCR". */}
          {(groups !== null || suggesting || suggestError !== null) && (
            <section className="border-t border-ink-200 p-5">
              <header className="mb-3 flex items-center gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-900">
                  Perechi sugerate de AI{groups !== null ? ` · ${groups.length}` : ""}
                </h3>
                <span className="text-[11px] text-ink-500">
                  Trage imaginile între perechi pentru a corecta sugestiile.
                </span>
                {groups !== null && groups.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void sendToOcr()}
                    disabled={readyGroups.length === 0 || sending || pairing}
                    title="Creează perechile aprobate și trimite-le la citire + calcul — abia atunci apar în tabel"
                    className="ml-auto inline-flex shrink-0 items-center gap-2 rounded-md bg-coral-500 px-4 py-1.5 text-sm font-medium text-canvas-50 shadow-sm transition hover:bg-coral-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
                  >
                    {sending ? (
                      <Spinner label="Trimit la OCR…" />
                    ) : (
                      <span>Trimite perechile la OCR ({readyGroups.length})</span>
                    )}
                  </button>
                )}
              </header>
              {suggestError !== null && (
                <p className="mb-3 rounded-md border border-coral-300 bg-coral-50 px-3 py-2 text-xs text-coral-700">
                  {suggestError}
                </p>
              )}
              {suggesting ? (
                <div className="flex items-center gap-2 py-4 text-sm text-ink-600">
                  <Spinner label="AI analizează documentele și caută perechi…" />
                </div>
              ) : groups !== null && groups.length === 0 ? (
                <p className="py-2 text-sm text-ink-600">
                  AI nu a găsit nicio pereche cu dovezi vizibile — împerechează manual mai sus.
                </p>
              ) : (
                groups !== null && (
                  <div className="flex flex-col gap-3">
                    {groups.map((g, gi) => (
                      <SuggestedGroupCard
                        key={`${gi}-${g.ids.join("/")}`}
                        group={g}
                        index={gi}
                        byId={byId}
                        onDrop={(id) => moveTo(id, gi)}
                        onDissolve={() => dissolve(gi)}
                        onZoom={setZoomed}
                      />
                    ))}
                  </div>
                )
              )}
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-ink-200 bg-canvas-50 px-5 py-3">
          <button
            type="button"
            onClick={() => void retry()}
            disabled={items.length < 1 || retrying || suggesting || sending || pairing}
            title="Trimite toate documentele fără pereche înapoi la AI pentru o nouă citire + împerechere — util după ce ai adăugat documente noi"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-ink-300 px-4 py-1.5 text-sm font-medium text-ink-700 transition hover:border-coral-400 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-400"
          >
            {retrying ? <Spinner label="Reîncerc împerecherea…" /> : <span>🔄 Reîncearcă împerecherea (AI)</span>}
          </button>
          <button
            type="button"
            onClick={() => void suggest()}
            disabled={items.length < 2 || suggesting || sending || retrying}
            title="Trimite toate documentele fără pereche la AI o singură dată — modelul propune perechi după ce vede pe hârtii"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-ink-300 px-4 py-1.5 text-sm font-medium text-ink-700 transition hover:border-coral-400 hover:text-ink-900 disabled:cursor-not-allowed disabled:text-ink-400"
          >
            {suggesting ? <Spinner label="AI caută perechi…" /> : <span>✨ Împerechere AI</span>}
          </button>
          <span className="text-sm text-ink-600">
            {selected.length === 0
              ? "Nimic selectat."
              : selected.length === 1
                ? "1 selectat — AWB singur, fără factură."
                : `${selected.length} selectate.`}
          </span>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={selected.length < 1 || existingPairs.length === 0 || attaching || pairing}
            title="Trimite documentele selectate într-o pereche care există deja — se adaugă ca facturi și perechea se recalculează"
            className="ml-auto inline-flex items-center gap-2 rounded-md border border-coral-300 bg-coral-50 px-4 py-1.5 text-sm font-medium text-coral-700 transition hover:border-coral-400 hover:bg-coral-100 disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-canvas-100 disabled:text-ink-400"
          >
            {attaching ? (
              <Spinner label="Atașez…" />
            ) : (
              <span>Trimite la o pereche{selected.length >= 1 ? ` (${selected.length})` : ""}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => void pair()}
            disabled={selected.length < 1 || pairing}
            className="inline-flex items-center gap-2 rounded-md bg-coral-500 px-4 py-1.5 text-sm font-medium text-canvas-50 shadow-sm transition hover:bg-coral-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
            title="Creează o pereche nouă din documentele selectate (un singur AWB e suficient) și calculeaz-o"
          >
            {pairing ? (
              <Spinner label="Creez perechea…" />
            ) : (
              <span>Creează perechea{selected.length >= 1 ? ` (${selected.length})` : ""}</span>
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

      {/* Pair-picker — choose which existing pair the selected orphan(s)
          attach to. Sibling so its overlay clicks don't bubble into the
          unpaired modal's close handler. */}
      {picking && (
        <PairPickModal
          pairs={existingPairs}
          count={selected.length}
          busy={attaching}
          onPick={(pairId) => void attach(pairId)}
          onCancel={() => setPicking(false)}
        />
      )}

      {/* Collaborator gate — the pairs are filed (and sent to OCR) under
          the partner confirmed here, pre-filled from the upload-time
          assignment. Rendered as a sibling so its overlay clicks don't
          bubble into the unpaired modal's close handler. */}
      {pendingSend && (
        <CollaboratorPickModal
          title={
            pendingSend.groups.length === 1
              ? "Pentru ce colaborator este perechea?"
              : "Pentru ce colaborator sunt perechile?"
          }
          subtitle={
            pendingSend.groups.length === 1
              ? "Perechea se trimite la citire (OCR) și se salvează pe colaboratorul ales."
              : `Cele ${pendingSend.groups.length} perechi se trimit la citire (OCR) și se salvează pe colaboratorul ales.`
          }
          confirmLabel={
            pendingSend.groups.length === 1
              ? "Trimite perechea la OCR"
              : `Trimite ${pendingSend.groups.length} perechi la OCR`
          }
          initial={pendingSend.initial}
          onCancel={() => setPendingSend(null)}
          onConfirm={(c) => void confirmSend(c)}
        />
      )}
    </>
  );
}

/* ─── Pick an existing pair to attach the selected documents to ──────── */

function PairPickModal({
  pairs,
  count,
  busy,
  onPick,
  onCancel,
}: {
  /** Candidate target pairs (the day's non-unpaired pairs). */
  pairs: Pair[];
  /** How many documents will be attached — shown in the header. */
  count: number;
  /** An attach is in flight — disables the list. */
  busy: boolean;
  onPick: (pairId: string) => void;
  onCancel: () => void;
}) {
  // Filter the candidate pairs by the same AWB / recipient / invoice search
  // the queue uses (lib/search). Empty query shows every pair; a query keeps
  // only ready pairs whose text matches (pending pairs have nothing to match).
  const [query, setQuery] = useState("");
  const q = query.trim();
  const shown = q ? pairs.filter((p) => pairMatchesQuery(p, query)) : pairs;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/70 p-6"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-ink-200 bg-canvas-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-ink-200 bg-canvas-50 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-900">
            Trimite {count} document{count === 1 ? "" : "e"} la o pereche
          </h2>
          <p className="text-[11px] text-ink-500">
            Alege perechea — documentele se adaugă ca facturi și perechea se recalculează.
          </p>
        </header>
        {pairs.length > 0 && (
          <div className="border-b border-ink-200 bg-canvas-50 px-3 py-2">
            <SearchBar value={query} onChange={setQuery} count={q ? shown.length : null} />
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-3">
          {pairs.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-500">
              Nicio pereche existentă în această zi.
            </p>
          ) : shown.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-500">
              Nicio pereche nu se potrivește căutării „{query}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {shown.map((p) => {
                const awb = p.status.kind === "ready" ? p.status.edits.awb : null;
                const invCount = p.status.kind === "ready" ? p.status.edits.invoices.length : 0;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onPick(p.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink-200 bg-canvas-50 px-3 py-2 text-left transition hover:border-coral-400 hover:bg-coral-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink-900">
                          {awb ? `AWB ${awb.awb_number || "—"}` : "Pereche în așteptare"}
                        </span>
                        <span className="block truncate text-[11px] text-ink-500">
                          {awb?.recipient_name || "destinatar necunoscut"} · {invCount} factur
                          {invCount === 1 ? "ă" : "i"}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-md bg-coral-500 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-canvas-50">
                        {busy ? "…" : "Alege"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <footer className="flex justify-end border-t border-ink-200 bg-canvas-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-ink-300 bg-canvas-50 px-4 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 disabled:opacity-60"
          >
            Anulează
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ─── One orphan document card ──────────────────────────────────────── */

function OrphanCard({
  pair,
  order,
  draggable = false,
  onToggle,
  onZoom,
  onRemove,
}: {
  pair: Pair;
  /** Position in the current selection (-1 = not selected). */
  order: number;
  /** Once AI suggestions exist, pool cards can be dragged into a group. */
  draggable?: boolean;
  onToggle: () => void;
  onZoom: (url: string) => void;
  onRemove: () => void;
}) {
  const docType: UnpairedDocType =
    pair.status.kind === "unpaired" ? pair.status.docType : "unknown";
  const { url, loading, name } = useFirstImageUrl(pair);
  const isSelected = order >= 0;

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", pair.id)}
      className={`flex flex-col overflow-hidden rounded-lg border bg-canvas-50 shadow-sm transition ${
        isSelected ? "border-coral-500 ring-2 ring-coral-400" : "border-ink-200"
      } ${draggable ? "cursor-grab" : ""}`}
      title={draggable ? "Trage cardul într-o pereche sugerată" : DOC_HINT[docType]}
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

/* ─── One AI-suggested pair (drag-and-drop editable) ────────────────── */

const MINI_LABEL: Record<UnpairedDocType, string> = {
  awb: "AWB",
  invoice: "Factură",
  unknown: "?",
};

function SuggestedGroupCard({
  group,
  index,
  byId,
  onDrop,
  onDissolve,
  onZoom,
}: {
  group: SuggestedGroup;
  index: number;
  /** Live orphan rows by id — vanished members are pruned upstream. */
  byId: Map<string, Pair>;
  /** A document was dropped onto this group. */
  onDrop: (id: string) => void;
  /** Undo the whole suggestion — documents return to the pool. */
  onDissolve: () => void;
  onZoom: (url: string) => void;
}) {
  const incomplete = group.ids.length < 2;
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation(); // the scroll container's drop = "back to pool"
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDrop(id);
      }}
      className={`rounded-lg border bg-canvas-50 p-3 shadow-sm transition ${
        incomplete ? "border-dashed border-coral-400" : "border-ink-200"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-800">
          Pereche {index + 1} · {group.ids.length} document{group.ids.length === 1 ? "" : "e"}
        </span>
        {incomplete && (
          <span className="text-[11px] text-coral-600">
            incompletă — trage aici încă un document
          </span>
        )}
        <button
          type="button"
          onClick={onDissolve}
          title="Desfă perechea — documentele revin în listă"
          className="ml-auto shrink-0 rounded p-1 text-ink-400 transition hover:bg-coral-100 hover:text-coral-600"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {group.ids.map((id) => {
          const p = byId.get(id);
          return p ? <MiniThumb key={id} pair={p} onZoom={onZoom} /> : null;
        })}
      </div>
      {group.evidence && (
        <p className="mt-2 text-[11px] italic text-ink-500" title="Dovada citită de AI pe documente">
          Dovadă: {group.evidence}
        </p>
      )}
    </div>
  );
}

/** Small draggable thumbnail of one orphan inside a suggested group. */
function MiniThumb({ pair, onZoom }: { pair: Pair; onZoom: (url: string) => void }) {
  const docType: UnpairedDocType =
    pair.status.kind === "unpaired" ? pair.status.docType : "unknown";
  const { url, name } = useFirstImageUrl(pair);
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", pair.id)}
      title={`${name} — trage pentru a muta în altă pereche sau înapoi în listă`}
      className="relative w-24 shrink-0 cursor-grab overflow-hidden rounded-md border border-ink-200 bg-canvas-100"
    >
      {url ? (
        <img
          src={url}
          alt={name}
          draggable={false}
          onClick={() => onZoom(url)}
          className="h-28 w-full cursor-zoom-in object-cover"
        />
      ) : (
        <div className="h-28 w-full animate-pulse bg-ink-200/60" />
      )}
      <span className="absolute left-1 top-1 rounded bg-ink-900/70 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-canvas-50">
        {MINI_LABEL[docType]}
      </span>
    </div>
  );
}

/* ─── Shared first-image URL hook ───────────────────────────────────── */

/** Object-URL (+ display name) of a pair's first photo — shared by the
 *  big orphan cards and the small suggestion thumbs. Revoked on change. */
function useFirstImageUrl(pair: Pair): { url: string | null; loading: boolean; name: string } {
  const { files, loading } = usePairImages(pair);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const f = files[0];
    if (!f) return;
    const u = URL.createObjectURL(f);
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [files]);
  return { url, loading, name: files[0]?.name ?? pair.imageRefs?.[0]?.name ?? "" };
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DayTabs, type DayCount } from "./components/DayTabs";
import { ExportMenu } from "./components/ExportMenu";
import { PairAddCard } from "./components/PairAddCard";
import { PairsTable } from "./components/PairsTable";
import { PairDetail } from "./components/PairDetail";
import { Spinner } from "./components/Spinner";
import { UpdateBanner } from "./components/UpdateBanner";
import { extractAndPrice, reprice, verifyProducts } from "./lib/api";
import {
  deletePair,
  insertPair,
  loadAllPairs,
  persistPairStatus,
} from "./lib/db";
import { date as fmtDate, todayIso } from "./lib/format";
import {
  CITY_KEYS,
  CITY_LABEL,
  COLLABORATOR_KEYS,
  COLLABORATOR_LABEL,
  COLLABORATORS_BY_CITY,
  defaultCollaboratorFor,
  isCollaboratorValidForCity,
  type CityKey,
  type CollaboratorKey,
  type Extracted,
  type Pair,
  type PairPatch,
  type PairStatus,
} from "./types";

/** localStorage key for the last-viewed day. Survives reloads so the
 *  user lands on the day they were working on, not a random default. */
const LS_SELECTED_DAY = "centralizator.selectedDay";

/** localStorage keys for the customer-city + collaborator dropdowns.
 *  Both are global — one choice applies to the whole queue — and they
 *  survive reloads so a user who invoices the same partner every day
 *  doesn't reselect on every launch. */
const LS_SELECTED_CITY = "centralizator.selectedCity";
const LS_SELECTED_COLLABORATOR = "centralizator.selectedCollaborator";

function readEnumLS<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored && (allowed as readonly string[]).includes(stored)) return stored as T;
  } catch {
    /* localStorage may be disabled — fall through. */
  }
  return fallback;
}

/** Maximum number of vision calls allowed in flight at once. The
 *  OpenRouter side can handle more but six is plenty for a courier
 *  hand-batching a day's paperwork, and well under common rate limits. */
const PARALLEL_LIMIT = 6;
const REPRICE_DEBOUNCE_MS = 250;

/** crypto.randomUUID is available in modern WebView2 / browsers; the
 *  fallback only kicks in on truly ancient runtimes. */
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export default function App() {
  // Master queue. Each pair owns its full life-cycle (pending → extracting
  // → ready/error). The vision model decides which image is the AWB and
  // which is the invoice when the pair actually runs.
  const [pairs, setPairs] = useState<Pair[]>([]);

  // Which pair (if any) is currently being viewed in detail mode.
  // `null` → show the queue table; a pair id → show that pair's full
  // page with both images and the section-by-section spreadsheet.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Initial hydration from SQLite. Hidden behind a tiny splash so the
  // empty-hero state doesn't flash before the loaded queue paints.
  const [hydrating, setHydrating] = useState(true);

  // Pair ids whose Leroy Merlin product check is currently running. Drives
  // the per-row spinner that precedes the warning/ok icon. Purely runtime
  // (never persisted) — a reload just shows the stored verification, or
  // nothing for pairs that were never verified.
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());

  // The day the user is currently viewing. The queue is grouped into
  // one bucket per day (like Excel sheet tabs) and `selectedDay` drives
  // which bucket the table, the totals, the Calculează action, and the
  // export all operate on. New pairs added on this day inherit it as
  // their filing day.
  //
  // Initial value comes from localStorage (so a relaunch lands on the
  // day they were working on); we re-validate it once after hydration
  // — if the stored day is stale (no pairs AND not today), we drop back
  // to today rather than stranding the user on an empty past day.
  const [selectedDay, setSelectedDay] = useState<string>(() => {
    try {
      const stored = localStorage.getItem(LS_SELECTED_DAY);
      if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
    } catch {
      /* localStorage may be disabled — fall through to today. */
    }
    return todayIso();
  });

  useEffect(() => {
    try {
      localStorage.setItem(LS_SELECTED_DAY, selectedDay);
    } catch {
      /* best-effort — losing this only forgets the day across reloads */
    }
  }, [selectedDay]);

  /* ── Customer-city + collaborator selection (global, persisted) ────── */

  const [selectedCity, setSelectedCity] = useState<CityKey>(() =>
    readEnumLS(LS_SELECTED_CITY, CITY_KEYS, "Ploiesti"),
  );

  /**
   * Selected collaborator — nullable because Constanța has NO
   * collaborator roster (the ODS source lists none for that city).
   * Hydrating from localStorage uses the city at mount time to
   * validate; if the stored value isn't valid for the current city,
   * we fall back to the city's first collaborator (or `null` for
   * Constanța, which means "direct, no partner").
   */
  const [selectedCollaborator, setSelectedCollaborator] = useState<CollaboratorKey | null>(() => {
    const city = readEnumLS(LS_SELECTED_CITY, CITY_KEYS, "Ploiesti");
    const stored = (() => {
      try {
        const s = localStorage.getItem(LS_SELECTED_COLLABORATOR);
        if (s && (COLLABORATOR_KEYS as readonly string[]).includes(s)) {
          return s as CollaboratorKey;
        }
      } catch {
        /* fall through */
      }
      return null;
    })();
    if (stored && isCollaboratorValidForCity(stored, city)) return stored;
    return defaultCollaboratorFor(city);
  });

  useEffect(() => {
    try {
      localStorage.setItem(LS_SELECTED_CITY, selectedCity);
    } catch {
      /* best-effort */
    }
  }, [selectedCity]);

  useEffect(() => {
    try {
      if (selectedCollaborator) {
        localStorage.setItem(LS_SELECTED_COLLABORATOR, selectedCollaborator);
      } else {
        localStorage.removeItem(LS_SELECTED_COLLABORATOR);
      }
    } catch {
      /* best-effort */
    }
  }, [selectedCollaborator]);

  /**
   * When the city changes, auto-correct the collaborator if it's no
   * longer valid for the new city. Picking "Iași" while "Stalexone"
   * (a Ploiești partner) was selected resets to EMV; picking
   * "Constanța" wipes the selection entirely (null = direct).
   *
   * Runs only on `selectedCity` change — never on its own
   * (`selectedCollaborator` is intentionally NOT in deps to avoid an
   * infinite ping-pong with `setSelectedCollaborator`).
   */
  useEffect(() => {
    setSelectedCollaborator((cur) =>
      isCollaboratorValidForCity(cur, selectedCity)
        ? cur
        : defaultCollaboratorFor(selectedCity),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCity]);

  // Live ref so callbacks (runAll, repricePair, keydown handler) always
  // see the freshest pairs without re-creating themselves on every
  // change. We also write to it synchronously inside every mutator so
  // two events in the same tick (e.g. batched drops, fast typing)
  // compose against the latest state, not React's last-committed state.
  const pairsRef = useRef(pairs);
  useEffect(() => {
    pairsRef.current = pairs;
  });

  // One debounce timer per pair, scoped to the App so each row's edits
  // queue its own re-price without blocking siblings.
  const repriceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /* ── Mutator helper ───────────────────────────────────────────────── */

  /** Apply a new pairs array to BOTH the ref (synchronously, for the
   *  next mutator in this tick) and React state (for the next render). */
  const commit = useCallback((next: Pair[]) => {
    pairsRef.current = next;
    setPairs(next);
  }, []);

  /* ── Hydrate from SQLite on first mount ───────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadAllPairs();
        if (cancelled) return;
        if (loaded.length > 0) {
          commit(loaded);
          // Re-validate `selectedDay` once we know which days actually
          // have pairs. The user's most common confusion after restart
          // was "where's my data?" when the persisted day pointed at
          // an empty tab. Smart-snap: if selectedDay has no pairs but
          // SOME day does, land on the most recent day-with-pairs so
          // the data is visible the moment hydration finishes. We only
          // snap when the selected day is empty — if the user was on
          // a day that has pairs, we respect that choice.
          const selectedHasPairs = loaded.some((p) => p.day === selectedDay);
          if (!selectedHasPairs) {
            // Most-recent day-with-pairs by ISO string (lexical sort
            // works because the format is YYYY-MM-DD). Falls back to
            // today if somehow no day had pairs (shouldn't happen
            // given loaded.length > 0).
            const days = [...new Set(loaded.map((p) => p.day))].sort();
            const mostRecent = days[days.length - 1] ?? todayIso();
            if (mostRecent !== selectedDay) setSelectedDay(mostRecent);
          }
        }
      } catch (err) {
        console.error("Failed to hydrate pairs from SQLite:", err);
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally only run this on mount. `selectedDay` is read
    // inside but we don't want re-hydration whenever the user changes
    // it — only the initial validation pass matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit]);

  /* ── Queue mutations ──────────────────────────────────────────────── */

  const addPair = useCallback(
    (files: File[]) => {
      // New pairs inherit the currently-viewed day so a drop on
      // "tomorrow's tab" files under tomorrow without an extra click.
      // PairAddCard already clamps to MAX_IMAGES_PER_PAIR (12), so we
      // accept whatever it hands over. A pair carries one AWB plus N-1
      // invoices; the vision model decides which slot is which.
      const newPair: Pair = {
        id: uuid(),
        day: selectedDay,
        images: files,
        status: { kind: "pending" },
      };
      // Optimistic add — the row appears in the UI immediately so the
      // user sees their drop without waiting for the network. We then
      // persist with the in-house retry from lib/db.ts; if even the
      // retried POST fails (server down for >2.5 s, or hard rejection),
      // we flip the row to "error" so the user SEES it didn't stick.
      // Without this, a failed insert would leave a phantom pair that
      // calculates to "ready" and then vanishes on the next launch
      // because the server never had its row.
      commit([...pairsRef.current, newPair]);
      void (async () => {
        try {
          await insertPair(newPair);
        } catch (err) {
          const msg = (err as Error).message;
          console.error("Failed to persist new pair:", err);
          commit(
            pairsRef.current.map((p) =>
              p.id === newPair.id
                ? {
                    ...p,
                    status: {
                      kind: "error",
                      message: `Salvare eșuată — re-adaugă perechea: ${msg}`,
                    } as PairStatus,
                  }
                : p,
            ),
          );
        }
      })();
    },
    [commit, selectedDay],
  );

  const removePair = useCallback(
    (id: string) => {
      const t = repriceTimers.current.get(id);
      if (t) clearTimeout(t);
      repriceTimers.current.delete(id);
      commit(pairsRef.current.filter((p) => p.id !== id));
      // Pop out of detail view if the removed pair was the one being shown.
      setSelectedId((cur) => (cur === id ? null : cur));
      void deletePair(id).catch((err) =>
        console.error("Failed to delete pair from DB:", err),
      );
    },
    [commit],
  );

  /** Clear every pair on the currently-viewed day only. Other days are
   *  untouched — the user's batch from yesterday survives a "reset
   *  today" click. We loop `deletePair` rather than wiring a new
   *  whole-day DB helper because pair counts are small (~20) and per-
   *  pair DELETE is already optimised by the FK cleanup. */
  const resetDay = useCallback(() => {
    const toDelete = pairsRef.current.filter((p) => p.day === selectedDay);
    if (toDelete.length === 0) return;
    for (const p of toDelete) {
      const t = repriceTimers.current.get(p.id);
      if (t) clearTimeout(t);
      repriceTimers.current.delete(p.id);
    }
    commit(pairsRef.current.filter((p) => p.day !== selectedDay));
    // Detail view of a deleted pair would dangle; pop back to queue.
    setSelectedId((cur) =>
      cur && toDelete.some((p) => p.id === cur) ? null : cur,
    );
    for (const p of toDelete) {
      void deletePair(p.id).catch((err) =>
        console.error("Failed to delete pair from DB:", err),
      );
    }
  }, [commit, selectedDay]);

  /* ── Status transitions (shared by run + reprice) ─────────────────── */

  /** In-memory only — flip the row's status without touching the DB.
   *  Used for optimistic transitions (e.g. "extracting") and for the
   *  final UI update AFTER an awaited persist has confirmed. */
  const setStatusLocal = useCallback(
    (id: string, status: PairStatus) => {
      commit(
        pairsRef.current.map((p) => (p.id === id ? { ...p, status } : p)),
      );
    },
    [commit],
  );

  /**
   * Persist a status AND commit the same status to memory ATOMICALLY:
   *   • If the server PUT succeeds (with the retry from lib/db.ts),
   *     the in-memory pair flips to that status.
   *   • If the server PUT fails terminally, the in-memory pair flips
   *     to an "error" status with the failure message so the user
   *     SEES that the calculation didn't stick — instead of the old
   *     fire-and-forget "ready" lie that vanished on next launch.
   *
   * "extracting" is the one state we deliberately don't persist — it's
   * an optimistic UI flip; use `setStatusLocal` for that. If the app
   * dies mid-call, rehydrate brings the row back as "pending" so the
   * user can retry.
   *
   * Returns true on persisted success, false on terminal persist
   * failure (UI is now showing an error row). Callers can use this to
   * branch — e.g. the run pool should NOT mark the pair "ready" if
   * persist failed.
   */
  const persistAndSet = useCallback(
    async (id: string, status: PairStatus): Promise<boolean> => {
      if (status.kind === "extracting") {
        setStatusLocal(id, status);
        return true;
      }
      try {
        await persistPairStatus(id, status);
        setStatusLocal(id, status);
        return true;
      } catch (err) {
        const msg = (err as Error).message;
        console.error("Failed to persist status:", err);
        const errStatus: PairStatus = {
          kind: "error",
          message: `Salvare eșuată — recalculează: ${msg}`,
        };
        // Best-effort error persist (also retries internally). If THIS
        // fails too, at least the in-memory UI is honest. We do NOT
        // recurse — one round of retries is enough.
        try {
          await persistPairStatus(id, errStatus);
        } catch (errErr) {
          console.error("Failed to persist error status too:", errErr);
        }
        setStatusLocal(id, errStatus);
        return false;
      }
    },
    [setStatusLocal],
  );

  /* ── Per-pair edit + debounced re-price ───────────────────────────── */

  const repricePair = useCallback(
    async (id: string) => {
      const pair = pairsRef.current.find((p) => p.id === id);
      if (!pair || pair.status.kind !== "ready") return;
      const { service, edits } = pair.status;
      try {
        const b = await reprice({
          service,
          weight_kg: edits.awb.weight_kg,
          distance_km: edits.awb.distance_extra_km,
          num_deliveries: edits.awb.num_deliveries,
          delivery_date: edits.awb.delivery_date,
        });
        // Re-fetch the current pair: the user may have kept typing during
        // the round-trip, so we apply the new breakdown on top of whatever
        // edits are now current. We persist-then-commit so a transient
        // PUT failure doesn't leave the UI showing a fresh breakdown the
        // server never received.
        const cur = pairsRef.current.find((p) => p.id === id);
        if (!cur || cur.status.kind !== "ready") return;
        await persistAndSet(id, { ...cur.status, breakdown: b });
      } catch (err) {
        await persistAndSet(id, { kind: "error", message: (err as Error).message });
      }
    },
    [persistAndSet],
  );

  const patchPair = useCallback(
    (id: string, patch: PairPatch) => {
      const cur = pairsRef.current.find((p) => p.id === id);
      if (!cur || cur.status.kind !== "ready") return;

      const curAwb = cur.status.edits.awb;
      const nextStatus: PairStatus = {
        kind: "ready",
        service: patch.service ?? cur.status.service,
        serviceFallback: cur.status.serviceFallback,
        edits: {
          ...cur.status.edits,
          awb: {
            ...curAwb,
            weight_kg: patch.weight_kg ?? curAwb.weight_kg,
            distance_extra_km:
              patch.distance_extra_km ?? curAwb.distance_extra_km,
            num_deliveries: patch.num_deliveries ?? curAwb.num_deliveries,
            delivery_date: patch.delivery_date ?? curAwb.delivery_date,
          },
        },
        breakdown: cur.status.breakdown,
      };
      // Optimistically reflect the edit in the UI so typing stays
      // responsive, then persist in the background. `persistAndSet`
      // will commit again on success (no-op visually) or flip to
      // "error" on failure so the user knows their edit didn't stick.
      setStatusLocal(id, nextStatus);
      void persistAndSet(id, nextStatus);

      const prev = repriceTimers.current.get(id);
      if (prev) clearTimeout(prev);
      repriceTimers.current.set(
        id,
        setTimeout(() => repricePair(id), REPRICE_DEBOUNCE_MS),
      );
    },
    [persistAndSet, setStatusLocal, repricePair],
  );

  /* ── Extraction (single + bounded-parallel pool) ──────────────────── */

  /**
   * Cross-check a ready pair's products against leroymerlin.ro, then
   * merge the result into its status and persist it. Runs in the
   * background after the price lands (so the price is never blocked by
   * the slower search+scrape). Failure is non-fatal: the pair stays
   * "ready" with no verification rather than flipping to error. The
   * server caches by product code, so repeat codes resolve instantly.
   */
  const verifyPairProducts = useCallback(
    async (id: string, extracted: Extracted) => {
      setVerifyingIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      try {
        const verification = await verifyProducts(extracted);
        // Re-read: the user may have edited/repriced during the round-trip.
        // Merge onto the CURRENT ready status so we don't clobber edits.
        const cur = pairsRef.current.find((p) => p.id === id);
        if (cur && cur.status.kind === "ready") {
          await persistAndSet(id, { ...cur.status, verification });
        }
      } catch (err) {
        console.error("Verificarea produselor a eșuat:", err);
      } finally {
        setVerifyingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [persistAndSet],
  );

  const runOne = useCallback(
    async (id: string, images: File[]) => {
      try {
        const res = await extractAndPrice(images);
        // Persist FIRST, then flip UI to "ready". This is the central
        // fix for the "calculate-then-restart-and-data-is-gone" bug —
        // the old fire-and-forget would show "ready" even if the PUT
        // failed, so the next launch re-hydrated as "pending" and the
        // calculation was effectively lost. Now: a terminal persist
        // failure surfaces as an "error" row (via persistAndSet's
        // catch arm) so the user knows to retry instead of trusting a
        // ghost result.
        const ok = await persistAndSet(id, {
          kind: "ready",
          service: res.resolvedService,
          serviceFallback: res.serviceFallback,
          edits: res.extracted,
          breakdown: res.breakdown,
        });
        // Auto-trigger the Leroy Merlin product check once the price is
        // saved. Fire-and-forget: it updates the pair again when it lands.
        if (ok) void verifyPairProducts(id, res.extracted);
      } catch (err) {
        await persistAndSet(id, { kind: "error", message: (err as Error).message });
      }
    },
    [persistAndSet, verifyPairProducts],
  );

  const runAll = useCallback(async () => {
    // Scoped to the visible day: pressing Calculează processes the
    // batch the user is currently looking at, not every leftover
    // pending pair across every day in history.
    const toRun = pairsRef.current.filter(
      (p) =>
        p.day === selectedDay &&
        (p.status.kind === "pending" || p.status.kind === "error"),
    );
    if (toRun.length === 0) return;

    // Optimistic transition so the UI flips to "extracting" immediately,
    // before the first HTTP round-trip resolves. NOT persisted — see
    // the comment on persistAndSet (and rowToStatus in server db.ts
    // coerces any "extracting" row back to "pending" on rehydrate).
    const ids = new Set(toRun.map((p) => p.id));
    commit(
      pairsRef.current.map((p) =>
        ids.has(p.id) ? { ...p, status: { kind: "extracting" } } : p,
      ),
    );

    // Bounded-concurrency pool: N workers drain a shared queue. With
    // limit=6, six OpenRouter calls actually fly at the same time
    // (true parallelism on the network side), and the seventh waits
    // for any of those to land. Saves the user from blowing up the
    // rate limit when they batch 30+ pairs.
    const queue = [...toRun];
    const limit = Math.min(PARALLEL_LIMIT, queue.length);
    const workers = Array.from({ length: limit }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (!next) return;
        await runOne(next.id, next.images);
      }
    });
    await Promise.all(workers);
  }, [commit, runOne, selectedDay]);

  /* ── Global keyboard shortcuts ───────────────────────────────────── */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const inField =
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable === true;

      // Esc → leave detail view (only when not typing in a field).
      if (e.key === "Escape" && !inField) {
        setSelectedId((cur) => (cur === null ? cur : null));
        return;
      }

      // Enter → run pending/error pairs FOR THE CURRENTLY VIEWED DAY.
      if (e.key === "Enter") {
        // Inside an editable cell, plain Enter belongs to the field;
        // Ctrl/Cmd+Enter overrides and runs the whole batch.
        if (inField && !(e.ctrlKey || e.metaKey)) return;
        const hasRunnable = pairsRef.current.some(
          (p) =>
            p.day === selectedDay &&
            (p.status.kind === "pending" || p.status.kind === "error"),
        );
        if (!hasRunnable) return;
        e.preventDefault();
        void runAll();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runAll, selectedDay]);

  /* ── Day-aware derived views ─────────────────────────────────────── */

  // Pairs on the visible day. Drives the queue table, the totals, and
  // the buttons; the export menu only sees these.
  const dayPairs = useMemo(
    () => pairs.filter((p) => p.day === selectedDay),
    [pairs, selectedDay],
  );

  // One DayCount per day that holds at least one pair, ordered by ISO
  // string. The tabs strip is purely a function of this.
  const dayCounts = useMemo<DayCount[]>(() => {
    const m = new Map<string, { count: number; readyCount: number }>();
    for (const p of pairs) {
      const c = m.get(p.day) ?? { count: 0, readyCount: 0 };
      c.count += 1;
      if (p.status.kind === "ready") c.readyCount += 1;
      m.set(p.day, c);
    }
    return Array.from(m.entries()).map(([day, v]) => ({ day, ...v }));
  }, [pairs]);

  // Header counters — scoped to current day so "Calculează (N)" tells
  // the truth about what pressing the button will run.
  const counts = useMemo(() => {
    const c = { pending: 0, extracting: 0, ready: 0, error: 0 };
    for (const p of dayPairs) c[p.status.kind] += 1;
    return c;
  }, [dayPairs]);

  // Spinner counts extractions across ALL days: if the user started a
  // batch on day A then switched to day B, A's extractions are still in
  // flight and the spinner should keep reflecting them, not lie.
  const globalExtracting = useMemo(
    () => pairs.filter((p) => p.status.kind === "extracting").length,
    [pairs],
  );

  const runnable = counts.pending + counts.error;
  const anyExtracting = counts.extracting > 0;

  // Resolve the currently-selected pair (and its index for the title)
  // *within the visible day*. Pair indices match what the user sees in
  // the day's table, not a global queue position. Lookups stay linear
  // — pair counts are dozens at most, not thousands.
  const selectedIdx = selectedId ? dayPairs.findIndex((p) => p.id === selectedId) : -1;
  const selectedPair = selectedIdx >= 0 ? dayPairs[selectedIdx] : null;
  const inDetail = !!selectedPair;

  return (
    <div className="flex h-full flex-col bg-canvas-100 text-ink-900">
      <header className="flex items-center justify-between border-b border-ink-200 bg-canvas-50 px-8 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">Centralizator</h1>
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink-500">
            Stalexone Trans
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* UpdateBanner self-hides when there's no update. Mounted
              in the header so every screen surfaces the prompt. */}
          <UpdateBanner />
          {globalExtracting > 0 && (
            <Spinner
              label={`Procesez ${globalExtracting} pereche${globalExtracting === 1 ? "" : "i"}…`}
            />
          )}
          {/* Global selectors: which customer city to invoice for, and
              which collaborator to pay. Both apply to the entire queue
              (table totals, footer sums, exports). The collaborator
              roster is city-dependent (sourced from
              PRETURI COLABORATORI.ods): Ploiești has 3 partners, Iași
              has 2, Constanța has none. */}
          <HeaderSelect<CityKey>
            label="Oraș"
            value={selectedCity}
            options={CITY_KEYS}
            labelFor={(k) => CITY_LABEL[k]}
            onChange={setSelectedCity}
            title="Oraș client — alege ce variantă de tarif client să afişeze tabelul"
          />
          <CollaboratorSelect
            city={selectedCity}
            value={selectedCollaborator}
            onChange={setSelectedCollaborator}
          />
          {dayPairs.length > 0 && (
            <ExportMenu
              pairs={dayPairs}
              day={selectedDay}
              city={selectedCity}
              collaborator={selectedCollaborator}
              disabled={counts.ready === 0}
            />
          )}
          {dayPairs.length > 0 && (
            <button
              type="button"
              onClick={resetDay}
              title={`Şterge toate perechile pentru ${fmtDate(selectedDay)}`}
              className="rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900"
            >
              Goleşte ziua
            </button>
          )}
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={runnable === 0 || anyExtracting}
            className="inline-flex items-center gap-2 rounded-md bg-coral-500 px-4 py-1.5 text-sm font-medium text-canvas-50 shadow-sm transition hover:bg-coral-600 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
            title={`Calculează perechile din ${fmtDate(selectedDay)} în paralel (Enter)`}
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
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span>Calculează{runnable > 0 ? ` (${runnable})` : ""}</span>
            <kbd className="ml-1 rounded border border-coral-400 bg-coral-600 px-1 font-mono text-[10px] tracking-tight">
              ↵
            </kbd>
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-6 sm:p-8">
        {hydrating ? (
          <HydratingSplash />
        ) : inDetail && selectedPair ? (
          /* Detail view stays focused — no day tabs here so the user
           * isn't tempted to switch days mid-review of a single pair. */
          <PairDetail
            pair={selectedPair}
            index={selectedIdx}
            city={selectedCity}
            collaborator={selectedCollaborator}
            verifying={verifyingIds.has(selectedPair.id)}
            onPatch={(patch) => patchPair(selectedPair.id, patch)}
            onBack={() => setSelectedId(null)}
            onRemove={() => removePair(selectedPair.id)}
          />
        ) : pairs.length === 0 ? (
          /* True first-run: no pairs anywhere. Show the hero with
           * today's date so the user knows where the first pair will
           * file. Day machinery only appears after the first add. */
          <div className="mx-auto w-full max-w-3xl pt-12">
            <h2 className="mb-3 text-center text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
              Adaugă perechi pentru {fmtDate(selectedDay)}
            </h2>
            <p className="mx-auto mb-10 max-w-lg text-center text-sm text-ink-600">
              Adaugă câte o pereche (sau N×2 imagini deodată pentru N perechi),
              apoi apasă{" "}
              <kbd className="rounded border border-ink-200 bg-canvas-50 px-1 font-mono text-[11px] text-ink-700">
                ↵ Enter
              </kbd>{" "}
              ori butonul{" "}
              <span className="font-medium text-coral-700">Calculează</span>{" "}
              pentru a le procesa în paralel. Fiecare zi îşi are propria
              filă — paperwork-ul de mâine stă separat de cel de azi.
            </p>
            <PairAddCard hero onAddPair={addPair} />
          </div>
        ) : (
          /* Standard queue view. Day tabs always on top once at least
           * one pair exists, then the add-card, then either the
           * day's table or an empty-day notice. */
          <>
            <DayTabs
              days={dayCounts}
              selectedDay={selectedDay}
              onSelect={setSelectedDay}
            />
            <PairAddCard onAddPair={addPair} />
            {dayPairs.length === 0 ? (
              <EmptyDayNotice day={selectedDay} />
            ) : (
              <PairsTable
                pairs={dayPairs}
                city={selectedCity}
                collaborator={selectedCollaborator}
                verifyingIds={verifyingIds}
                onPatchPair={patchPair}
                onRemovePair={removePair}
                onSelectPair={setSelectedId}
              />
            )}
            <p className="text-center text-[11px] uppercase tracking-widest text-ink-400">
              Click pe orice rând pentru detalii complete · <kbd className="rounded border border-ink-200 bg-canvas-50 px-1 font-mono text-[10px] text-ink-700">Esc</kbd> pentru a reveni · perechile sunt salvate automat
            </p>
          </>
        )}
      </main>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Tiny full-page splash for the brief moment between mount and the
 * SQLite handle returning the persisted queue. Without this, a user
 * with saved pairs sees an empty hero "Adaugă prima pereche" flash for
 * a few hundred ms before the queue paints — confusing.
 * ────────────────────────────────────────────────────────────────────── */

function HydratingSplash() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-500">
      <svg className="h-6 w-6 animate-spin text-coral-500" viewBox="0 0 24 24" fill="none" aria-label="Se încarcă…">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p className="text-sm uppercase tracking-widest">Încarc perechile salvate…</p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Soft notice for a day the user has navigated to but hasn't filed
 * any pairs on yet. Lives below the add-card so the next thing on the
 * screen explains both why the table is missing and how to fill it.
 * ────────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────────────────────────────────────
 * HeaderSelect — labelled dropdown used for the two global selectors
 * (customer city, collaborator) in the app header.
 *
 * Generic over the option type so the same component drives both the
 * 3-way City picker and the 5-way Collaborator picker. The label sits
 * above the select as a tiny uppercase caption so the bar reads
 * "Oraș · Colaborator · Exportă · Calculează" at a glance instead of
 * a row of unlabelled controls. The current selection is shown by
 * looking up `labelFor(value)` — the option keys stay machine-friendly
 * (no diacritics) while the visible text is the Romanian display name.
 * ────────────────────────────────────────────────────────────────────── */
function HeaderSelect<T extends string>({
  label,
  value,
  options,
  labelFor,
  onChange,
  title,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labelFor: (key: T) => string;
  onChange: (next: T) => void;
  title?: string;
}) {
  return (
    <label
      className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-500"
      title={title}
    >
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1.5 text-sm font-medium normal-case tracking-normal text-ink-800 outline-none transition hover:border-coral-400 focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {labelFor(o)}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * CollaboratorSelect — city-aware variant of HeaderSelect for the
 * collaborator picker.
 *
 * The roster is read from `COLLABORATORS_BY_CITY` per the user's ODS
 * source. When the picked city has no collaborators (Constanța), the
 * select renders a disabled "Direct (fără colaborator)" placeholder
 * instead of an empty list — clearer than a phantom dropdown that
 * does nothing on click. The labels show the full "<Company>
 * (<person>)" string so the user recognises the partner; the data key
 * stays the machine-friendly company name.
 * ────────────────────────────────────────────────────────────────────── */
function CollaboratorSelect({
  city,
  value,
  onChange,
}: {
  city: CityKey;
  value: CollaboratorKey | null;
  onChange: (next: CollaboratorKey | null) => void;
}) {
  const options = COLLABORATORS_BY_CITY[city];
  const empty = options.length === 0;
  return (
    <label
      className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-500"
      title={
        empty
          ? "Constanța — fără colaborator (plată directă)"
          : "Colaborator — alege ce variantă de plată să afişeze tabelul"
      }
    >
      <span>Colaborator</span>
      {empty ? (
        <span className="rounded-md border border-dashed border-ink-300 bg-canvas-100 px-2 py-1.5 text-sm font-medium normal-case tracking-normal text-ink-500">
          Direct (fără colaborator)
        </span>
      ) : (
        <select
          value={value ?? ""}
          onChange={(e) => onChange((e.target.value || null) as CollaboratorKey | null)}
          className="rounded-md border border-ink-300 bg-canvas-50 px-2 py-1.5 text-sm font-medium normal-case tracking-normal text-ink-800 outline-none transition hover:border-coral-400 focus:border-coral-400 focus:ring-2 focus:ring-coral-200"
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {COLLABORATOR_LABEL[o]}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

function EmptyDayNotice({ day }: { day: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 bg-canvas-50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-700">
        Nicio pereche pentru {fmtDate(day)}.
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Adaugă deasupra o pereche AWB + Factură (sau drop N×2 imagini pentru N
        perechi) pentru a începe ziua.
      </p>
    </div>
  );
}

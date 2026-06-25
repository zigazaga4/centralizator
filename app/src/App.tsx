import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DayTabs, type DayCount } from "./components/DayTabs";
import { ExportMenu } from "./components/ExportMenu";
import { CompareExcelButton } from "./components/CompareExcelButton";
import { PairAddCard } from "./components/PairAddCard";
import { PairsTable } from "./components/PairsTable";
import { SearchBar } from "./components/SearchBar";
import { UnpairedAlert, UnpairedModal } from "./components/UnpairedSection";
import { PairDetail } from "./components/PairDetail";
import { Spinner } from "./components/Spinner";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  attachToPair as attachToPairApi,
  detachInvoice as detachInvoiceApi,
  dismantlePair as dismantlePairApi,
  extractAndPrice,
  reprice,
  retryUnpaired as retryUnpairedApi,
  scanBatch,
  verifyProducts,
} from "./lib/api";
import {
  deletePair,
  deletePairsByDay,
  insertPair,
  loadAllPairs,
  persistPairStatus,
} from "./lib/db";
import { loadPairImages, prefetchPairImages } from "./lib/images";
import { subscribePairLive } from "./lib/live";
import { date as fmtDate, todayIso } from "./lib/format";
import { pairMatchesQuery } from "./lib/search";
import {
  CITY_KEYS,
  CITY_LABEL,
  COLLABORATOR_KEYS,
  COLLABORATOR_LABEL,
  COLLABORATORS_BY_CITY,
  defaultCollaboratorFor,
  isCollaboratorValidForCity,
  primaryDispatchSite,
  type CityKey,
  type CollaboratorKey,
  type Extracted,
  type Pair,
  type PairPatch,
  type PairStatus,
  type StoreKey,
} from "./types";

/**
 * The origin store a pair is filed under (its centralizator bucket), or
 * null when it isn't decided yet (pending / extracting / error, or a
 * ready pair whose Expeditor couldn't be matched). Unassigned pairs are
 * shown in EVERY store view so a freshly added/scanned pair is never
 * hidden before the AI files it.
 */
function storeOf(pair: Pair): StoreKey | null {
  if (pair.status.kind !== "ready") return null;
  return pair.status.store ?? pair.status.routing?.store ?? null;
}

/**
 * Top-level list the queue is split into: ordinary deliveries vs. macara
 * (crane) deliveries. The user flips between the two with a segmented
 * Standard/Macara switch; each is its own working list.
 */
export type ViewMode = "standard" | "macara";

/** True once a pair's ready breakdown classifies it as a macara (crane) run. */
function isMacaraPair(pair: Pair): boolean {
  return pair.status.kind === "ready" && !!pair.status.breakdown.macara?.isMacara;
}

/**
 * Does this pair belong in the active list? A READY pair shows only in the
 * list matching its macara state (macara runs in "Macara", everything else
 * in "Standard"). A pair that hasn't been priced yet (pending / extracting /
 * error) isn't classified, so it shows in BOTH lists — same principle as an
 * unfiled store, so a freshly added pair is never hidden before the AI
 * decides where it goes. Once it goes ready it snaps to the correct list.
 */
function inView(pair: Pair, view: ViewMode): boolean {
  if (pair.status.kind !== "ready") return true;
  return isMacaraPair(pair) === (view === "macara");
}

/** localStorage key for the last-viewed day. Survives reloads so the
 *  user lands on the day they were working on, not a random default. */
const LS_SELECTED_DAY = "centralizator.selectedDay";

/** localStorage keys for the customer-city + collaborator dropdowns.
 *  Both are global — one choice applies to the whole queue — and they
 *  survive reloads so a user who invoices the same partner every day
 *  doesn't reselect on every launch. */
const LS_SELECTED_CITY = "centralizator.selectedCity";
const LS_SELECTED_COLLABORATOR = "centralizator.selectedCollaborator";

/** localStorage key for the Standard/Macara list switch — survives reloads
 *  so the user stays on the list they were working in. */
const LS_SELECTED_VIEW = "centralizator.selectedView";

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

/** How long a locally-written pair ignores the live echo of its OWN write
 *  before it accepts server events again. Long enough to cover the save
 *  round-trip + the 250 ms reprice debounce, short enough that another PC's
 *  change to the same pair shows up within seconds. */
const LOCAL_ECHO_TTL_MS = 8_000;

/** Background re-sync cadence — the periodic safety net that guarantees
 *  convergence to the server's latest state even if a live event is missed
 *  (dropped frame, sleep/wake, proxy hiccup). */
const RECONCILE_POLL_MS = 20_000;

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

  // Whether the manual-pairing modal (unpaired documents) is open.
  const [unpairedOpen, setUnpairedOpen] = useState(false);

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

  /* ── Active centralizator (store) ─────────────────────────────────── */

  // The top "Oraș" dropdown now switches between the four stores' separate
  // excels (Ploiești, Iași Tudor, Iași ERA, Constanța), not just the
  // displayed commission column. `activeStore` is the store the selected
  // city maps to 1:1.
  const activeStore = useMemo<StoreKey>(() => primaryDispatchSite(selectedCity), [selectedCity]);

  // Standard vs. Macara list. Two top-level buttons switch between them; each
  // behaves like its own workbook (its own day tabs, table, totals, export).
  // Persisted so a relaunch keeps the user on the list they were working in.
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    readEnumLS<ViewMode>(LS_SELECTED_VIEW, ["standard", "macara"], "standard"),
  );
  useEffect(() => {
    try {
      localStorage.setItem(LS_SELECTED_VIEW, viewMode);
    } catch {
      /* localStorage may be disabled — ignore. */
    }
  }, [viewMode]);

  /** Does this pair belong in the active centralizator? A pair filed to
   *  the active store shows here; an unassigned pair (no store yet) shows
   *  in every store so it's never lost before the AI files it. */
  const inActiveStore = useCallback(
    (p: Pair) => {
      const s = storeOf(p);
      return s === null || s === activeStore;
    },
    [activeStore],
  );

  /** Does this pair belong in the active Standard/Macara list? */
  const inActiveView = useCallback((p: Pair) => inView(p, viewMode), [viewMode]);

  /**
   * Does this pair belong to the selected collaborator? The assignment is
   * made IN THE UPLOAD FLOW (phone/desktop modal) and persisted on the
   * pair — the header dropdown filters by it. Two never-hide rules:
   *   • an UNASSIGNED pair (legacy / direct upload) shows under every
   *     collaborator, same principle as an unfiled store, and
   *   • when no collaborator is selected (Constanța = direct), nothing
   *     is filtered out — the store filter already scopes the queue.
   */
  const inActiveCollaborator = useCallback(
    (p: Pair) => {
      const c = p.collaborator ?? null;
      return c === null || selectedCollaborator === null || c === selectedCollaborator;
    },
    [selectedCollaborator],
  );

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

  // Live feed (SSE) connection state — drives the header "Live" pill.
  const [liveConnected, setLiveConnected] = useState(false);

  // Pairs THIS PC wrote very recently (id → epoch ms). Used ONLY to suppress
  // the live echo of our OWN write for a short window, so a slightly-older
  // server snapshot can't clobber a fresher local edit. CRITICAL for
  // multi-PC: unlike a permanent "ownership" flag, these entries EXPIRE — once
  // the window passes, every server event applies again, so another PC's later
  // edits and deletes always flow in and every client converges to the latest
  // state.
  const localWrites = useRef<Map<string, number>>(new Map());
  const markLocal = useCallback((id: string) => {
    localWrites.current.set(id, Date.now());
  }, []);
  /** Did WE write this pair within the echo window? Self-expiring read. */
  const isLocalEcho = useCallback((id: string): boolean => {
    const t = localWrites.current.get(id);
    if (t === undefined) return false;
    if (Date.now() - t > LOCAL_ECHO_TTL_MS) {
      localWrites.current.delete(id);
      return false;
    }
    return true;
  }, []);

  // The first SSE connect coincides with mount hydration, which already
  // pulls the full queue — so we skip the catch-up reconcile on it and only
  // reconcile on RE-connects (where events may have been missed while down).
  const sawFirstConnect = useRef(false);

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
          // Background warm: stream every pair's images into the in-app
          // cache (visible day first) so thumbnails fill progressively
          // and opening any pair is instant. Fire-and-forget.
          void prefetchPairImages(loaded, selectedDay);
          // Re-validate `selectedDay` once we know which days actually
          // have pairs. The user's most common confusion after restart
          // was "where's my data?" when the persisted day pointed at
          // an empty tab. Smart-snap: if selectedDay has no pairs but
          // SOME day does, land on the most recent day-with-pairs so
          // the data is visible the moment hydration finishes. We only
          // snap when the selected day is empty — if the user was on
          // a day that has pairs, we respect that choice.
          let targetDay = selectedDay;
          if (!loaded.some((p) => p.day === targetDay)) {
            // Most-recent day-with-pairs by ISO string (lexical sort
            // works because the format is YYYY-MM-DD). Falls back to
            // today if somehow no day had pairs (shouldn't happen
            // given loaded.length > 0).
            const days = [...new Set(loaded.map((p) => p.day))].sort();
            targetDay = days[days.length - 1] ?? todayIso();
            if (targetDay !== selectedDay) setSelectedDay(targetDay);
          }
          // Smart-snap the CITY too. The paired table is filtered by the
          // active store, but a fresh install defaults to Ploiești — so on a
          // machine whose data lives in another centralizator (e.g. Constanța)
          // the table looked EMPTY while the store-agnostic "documente fără
          // pereche" still showed, which reads as "only unpaired appear". If
          // the current city has NO ready pair visible on the target day but
          // another city does, land on the city holding the most, so the data
          // shows immediately. Only snaps when the current city is empty — a
          // city the user is deliberately on that has pairs is respected.
          const readyOnDay = loaded.filter(
            (p) => p.day === targetDay && p.status.kind === "ready",
          );
          if (readyOnDay.length > 0) {
            const curStore = primaryDispatchSite(selectedCity);
            // A ready pair shows in the current city when its store matches OR
            // it has no store yet (unfiled pairs show everywhere) — mirror
            // `inActiveStore` exactly so the check matches what the user sees.
            const curHasReady = readyOnDay.some((p) => {
              const s = storeOf(p);
              return s === null || s === curStore;
            });
            if (!curHasReady) {
              const countForCity = (city: CityKey): number => {
                const store = primaryDispatchSite(city);
                return readyOnDay.filter((p) => storeOf(p) === store).length;
              };
              const best = [...CITY_KEYS].sort((a, b) => countForCity(b) - countForCity(a))[0];
              if (best && best !== selectedCity && countForCity(best) > 0) {
                setSelectedCity(best);
              }
            }
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

  /* ── Live feed (SSE) — phone scans & other clients stream in ──────── */

  /**
   * Re-pull the authoritative server list and make the local queue MIRROR it,
   * so every PC always shows the latest state. This is the catch-up path for a
   * reconnect, a missed live event, a sleep/wake, or a remote "clear day":
   *   • a server pair we don't have    → add it;
   *   • a server pair that's newer      → adopt its status/day (keep our
   *     already-decoded image Files), by `updatedAt` last-write-wins;
   *   • a local pair the server lost    → remove it (deleted on another PC).
   * The ONLY things kept against the server are (a) pairs we wrote in the last
   * few seconds (`isLocalEcho`, so an in-flight edit isn't clobbered) and (b)
   * optimistic local-only pairs the server hasn't acknowledged yet
   * (`updatedAt` 0/undefined), which must never be removed as "missing".
   */
  const reconcile = useCallback(async () => {
    try {
      const server = await loadAllPairs();
      const serverIds = new Set(server.map((p) => p.id));
      const cur = pairsRef.current;
      const byId = new Map(cur.map((p) => [p.id, p] as const));
      let changed = false;
      for (const sp of server) {
        if (isLocalEcho(sp.id)) continue; // our own very recent write — keep local briefly
        const ex = byId.get(sp.id);
        if (!ex) {
          byId.set(sp.id, sp);
          changed = true;
        } else if (
          (sp.updatedAt ?? 0) > (ex.updatedAt ?? 0) ||
          ex.status.kind !== sp.status.kind ||
          ex.day !== sp.day
        ) {
          byId.set(sp.id, { ...ex, day: sp.day, status: sp.status, updatedAt: sp.updatedAt });
          changed = true;
        }
      }
      const removed = new Set<string>();
      for (const p of cur) {
        if (serverIds.has(p.id)) continue;
        if (isLocalEcho(p.id)) continue; // we just wrote it — the server has it momentarily
        if ((p.updatedAt ?? 0) === 0) continue; // optimistic local-only — never seen by the server yet
        byId.delete(p.id);
        removed.add(p.id);
        changed = true;
      }
      if (changed) commit([...byId.values()]);
      if (removed.size > 0) setSelectedId((curId) => (curId && removed.has(curId) ? null : curId));
    } catch (err) {
      console.warn("[live] reconcile failed:", err);
    }
  }, [commit, isLocalEcho]);

  useEffect(() => {
    const stop = subscribePairLive({
      onStatus: (connected) => {
        setLiveConnected(connected);
        if (connected) {
          // Skip the redundant fetch on the very first connect (mount
          // hydration covers it); reconcile only on genuine re-connects.
          if (sawFirstConnect.current) void reconcile();
          else sawFirstConnect.current = true;
        }
      },
      onCreated: (pair) => {
        if (isLocalEcho(pair.id)) return; // our own insert echo
        // A freshly server-created pair is, by definition, being processed —
        // show the spinner immediately instead of a "pending/needs-calc"
        // flash. The follow-up extracting/ready events refine it.
        const display: Pair =
          pair.status.kind === "pending" ? { ...pair, status: { kind: "extracting" } } : pair;
        const cur = pairsRef.current;
        if (cur.some((p) => p.id === pair.id)) {
          commit(cur.map((p) => (p.id === pair.id ? display : p)));
        } else {
          commit([...cur, display]);
        }
      },
      onUpdated: (id, day, status, updatedAt) => {
        if (isLocalEcho(id)) return; // our own write echo
        const cur = pairsRef.current;
        const ex = cur.find((p) => p.id === id);
        if (!ex) {
          // Update for a pair we never saw created (missed event) — catch up.
          void reconcile();
          return;
        }
        // Out-of-order safety: ignore an echo older than what we already show.
        if ((updatedAt ?? 0) < (ex.updatedAt ?? 0)) return;
        commit(cur.map((p) => (p.id === id ? { ...p, day, status, updatedAt } : p)));
      },
      onDeleted: (id) => {
        // A delete is authoritative even for a pair we touched — another PC
        // removing it (or clearing its day) must always win or it lingers as a
        // ghost. Our own delete echo is just a harmless no-op here.
        commit(pairsRef.current.filter((p) => p.id !== id));
        setSelectedId((curId) => (curId === id ? null : curId));
      },
      onCleared: () => {
        void reconcile();
      },
    });
    return stop;
  }, [commit, reconcile, isLocalEcho]);

  /* ── Convergence safety net ───────────────────────────────────────── */

  // "Always show the latest state across PCs": even if a live event is missed
  // (a dropped frame, a sleep/wake, a proxy hiccup), poll the authoritative
  // list on a timer AND whenever the window regains focus or becomes visible,
  // so every client converges within seconds without a manual refresh.
  useEffect(() => {
    const iv = window.setInterval(() => void reconcile(), RECONCILE_POLL_MS);
    const onFocus = () => void reconcile();
    const onVisible = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reconcile]);

  /* ── Queue mutations ──────────────────────────────────────────────── */

  /**
   * THE one ingestion flow (by command) — the desktop add card sends its
   * photos to /scan-batch, exactly like the phone scanner: the server
   * dedups, classifies each image, pairs them by the recipient
   * name/address printed on the paper, prices every pair and surfaces
   * the leftovers as unpaired rows. Everything streams back into this
   * app live over SSE — no local pair is created here, no second flow.
   * New pairs are filed under the currently-viewed day so a drop on
   * "tomorrow's tab" files under tomorrow without an extra click.
   */
  const scanImages = useCallback(
    async (files: File[], collaborator: CollaboratorKey | null): Promise<boolean> => {
      try {
        await scanBatch(files, selectedDay, collaborator);
        return true;
      } catch (err) {
        console.error("scan-batch upload failed:", err);
        return false;
      }
    },
    [selectedDay],
  );

  /**
   * Remove a wrongly-matched invoice from a ready pair. The server detaches
   * it into a new "unpaired" document and re-prices the source pair without
   * it; we apply both results locally for instant feedback (the SSE echoes
   * are idempotent: the source pair merges by last-write-wins, the new
   * unpaired row merges by id). Resolves on success, rejects on failure so
   * the detail view can surface the error.
   */
  const detachInvoice = useCallback(
    async (pairId: string, invoiceIndex: number) => {
      const { pair, unpaired } = await detachInvoiceApi(pairId, invoiceIndex);
      const cur = pairsRef.current;
      let next = cur.map((p) => (p.id === pair.id ? pair : p));
      if (!next.some((p) => p.id === unpaired.id)) next = [...next, unpaired];
      commit(next);
    },
    [commit],
  );

  /**
   * Dismantle a whole pair — the operator removed its LAST invoice. The server
   * turns every document (the AWB and the invoice) back into its own unpaired
   * row and deletes the pair; we drop the pair locally and add the new orphans
   * (idempotent with the SSE echoes). Pops the detail view if it was open.
   */
  const dismantlePair = useCallback(
    async (pairId: string) => {
      const { unpaired } = await dismantlePairApi(pairId);
      let next = pairsRef.current.filter((p) => p.id !== pairId);
      for (const u of unpaired) if (!next.some((p) => p.id === u.id)) next = [...next, u];
      commit(next);
      setSelectedId((cur) => (cur === pairId ? null : cur));
    },
    [commit],
  );

  /**
   * Attach unpaired document(s) to an existing pair. The server appends their
   * photos, re-reads + re-prices the pair, and removes the orphan rows; we
   * apply the updated pair and drop the consumed orphans.
   */
  const attachToPair = useCallback(
    async (pairId: string, sourceIds: string[]) => {
      const { pair, removed } = await attachToPairApi(pairId, sourceIds);
      const gone = new Set(removed);
      const next = pairsRef.current
        .map((p) => (p.id === pair.id ? pair : p))
        .filter((p) => !gone.has(p.id));
      commit(next);
    },
    [commit],
  );

  /**
   * Re-run the AI pairing over the day's unpaired documents. Fire-and-forget on
   * the server; the live feed streams the re-paired results in and prunes the
   * old orphan rows (the server deletes them). Rejects so the modal can surface
   * a failure.
   */
  const retryUnpaired = useCallback(async (day: string) => {
    await retryUnpairedApi(day);
  }, []);

  const removePair = useCallback(
    (id: string) => {
      markLocal(id);
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
    [commit, markLocal],
  );

  /** "Goleşte ziua" clears the ENTIRE selected day on the server: every
   *  pair filed under it, across all stores and collaborators, calculated
   *  and unpaired alike. A two-step confirm guards the irreversible wipe. */
  const [confirmingReset, setConfirmingReset] = useState(false);
  const confirmResetTimer = useRef<number | null>(null);
  /** First click arms the confirm; it auto-disarms so a forgotten armed
   *  state never lingers as a one-click hazard. */
  const armReset = useCallback(() => {
    setConfirmingReset(true);
    if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
    confirmResetTimer.current = window.setTimeout(() => setConfirmingReset(false), 4000);
  }, []);
  const cancelReset = useCallback(() => {
    setConfirmingReset(false);
    if (confirmResetTimer.current) clearTimeout(confirmResetTimer.current);
  }, []);
  /** Server-FIRST: one atomic DELETE removes the whole day server-side, so
   *  a failure leaves the UI truthful (nothing dropped locally) instead of
   *  optimistically hiding pairs the server still holds. On success we drop
   *  them locally; the per-pair pair-deleted pushes keep other clients in
   *  sync. */
  const resetDay = useCallback(async () => {
    cancelReset();
    const doomed = pairsRef.current.filter((p) => p.day === selectedDay);
    if (doomed.length === 0) return;
    try {
      await deletePairsByDay(selectedDay);
    } catch (err) {
      console.error("Goleşte ziua: clearing the day on the server failed:", err);
      return;
    }
    for (const p of doomed) {
      const t = repriceTimers.current.get(p.id);
      if (t) clearTimeout(t);
      repriceTimers.current.delete(p.id);
    }
    const gone = new Set(doomed.map((p) => p.id));
    commit(pairsRef.current.filter((p) => !gone.has(p.id)));
    // Detail view of a deleted pair would dangle; pop back to the queue.
    setSelectedId((cur) => (cur && gone.has(cur) ? null : cur));
  }, [cancelReset, commit, selectedDay]);
  // Switching day tabs disarms any pending confirm — never carry a
  // "confirm clear" from one day onto another.
  useEffect(() => {
    setConfirmingReset(false);
  }, [selectedDay]);

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
      // We're about to write this pair — own it so the live echo of this
      // very write doesn't bounce back and overwrite a fresher local edit.
      markLocal(id);
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
    [setStatusLocal, markLocal],
  );

  /* ── Per-pair edit + debounced re-price ───────────────────────────── */

  const repricePair = useCallback(
    async (id: string, override?: { macaraForceNormal?: boolean; forceWeekend?: boolean }) => {
      const pair = pairsRef.current.find((p) => p.id === id);
      if (!pair || pair.status.kind !== "ready") return;
      const { service, edits, breakdown } = pair.status;
      // Dispatch store drives the per-city macara table; carry it forward.
      const macaraStore = pair.status.store ?? pair.status.routing?.store ?? null;
      try {
        const b = await reprice({
          service,
          weight_kg: edits.awb.weight_kg,
          distance_km: edits.awb.distance_extra_km,
          num_deliveries: edits.awb.num_deliveries,
          delivery_date: edits.awb.delivery_date,
          // Carry the unloading count forward — it's derived from the invoice
          // (not user-editable here), so a live re-price must preserve it or
          // the separate unloading tax would silently vanish.
          unloading_units: breakdown.unloadingUnits,
          // Same for macara: detected from the AWB/invoice at extraction time
          // (not editable here), so carry the signals forward or the separate
          // macara line + warning would vanish on the first edit. `?.` guards
          // breakdowns persisted before macara existed.
          macara_on_awb: breakdown.macara?.onAwb ?? false,
          macara_on_invoice: breakdown.macara?.onInvoice ?? false,
          macara_pallets: breakdown.macara?.pallets ?? 0,
          macara_runs: breakdown.macara?.runs ?? 0,
          macara_store: macaraStore,
          // The operator's macara→normal override: an explicit value from the
          // toggle wins; otherwise carry the persisted decision forward so it
          // survives unrelated edits (weight, km, …).
          macara_force_normal:
            override?.macaraForceNormal ?? (breakdown.macara?.forcedNormal ?? false),
          // Weekend is a manual per-pair switch — never derived from a date.
          // An explicit value from the toggle wins; otherwise carry the
          // persisted flag forward so an unrelated edit (weight, km, …) doesn't
          // silently un-weekend the pair.
          force_weekend: override?.forceWeekend ?? (breakdown.weekendForced ?? false),
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
      // The macara→normal override is NOT an AWB field — it rides in the
      // breakdown. Flip it optimistically so the toggle + the standard/macara
      // sections switch instantly; the server recomputes the real totals on
      // the immediate re-price below.
      const macaraToggle = patch.macara_force_normal !== undefined;
      const force = !!patch.macara_force_normal;
      const curBreakdown = cur.status.breakdown;
      const curMac = curBreakdown.macara;
      const detected = curMac
        ? curMac.detected ?? (curMac.onAwb || curMac.onInvoice)
        : false;
      const nextBreakdown =
        macaraToggle && curMac
          ? {
              ...curBreakdown,
              macara: {
                ...curMac,
                forcedNormal: force && detected,
                isMacara: detected && !force,
                warning: force ? false : curMac.warning,
              },
            }
          : curBreakdown;

      const weekendToggle = patch.force_weekend !== undefined;
      const weekendOn = !!patch.force_weekend;
      // Flip ONLY the switch's boolean state optimistically so the toggle
      // responds instantly. Every monetary value — the +11,90 surcharge AND
      // the dependent totals (carrier, city commissions, collaborator prices)
      // — is recomputed by the SERVER on the immediate re-price below, so the
      // client never shows a self-computed price.
      const nextBreakdownWk = weekendToggle
        ? { ...nextBreakdown, weekend: weekendOn, weekendForced: weekendOn }
        : nextBreakdown;

      // Spread the prior ready status so store / routing / verification
      // survive a hand-edit; only service + the edited AWB fields (+ the
      // optimistic macara flip) change.
      const nextStatus: PairStatus = {
        ...cur.status,
        service: patch.service ?? cur.status.service,
        breakdown: nextBreakdownWk,
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
      };
      // Optimistically reflect the edit in the UI so typing stays
      // responsive, then persist in the background. `persistAndSet`
      // will commit again on success (no-op visually) or flip to
      // "error" on failure so the user knows their edit didn't stick.
      setStatusLocal(id, nextStatus);
      void persistAndSet(id, nextStatus);

      const prev = repriceTimers.current.get(id);
      if (prev) clearTimeout(prev);
      if (macaraToggle) {
        // A discrete click, not typing — re-price immediately with the
        // explicit override so the toggle never lags behind the totals.
        repriceTimers.current.delete(id);
        void repricePair(id, { macaraForceNormal: force });
      } else if (weekendToggle) {
        // Same for the weekend switch: a discrete click, re-price now with
        // the explicit flag so the +11,90 lands instantly.
        repriceTimers.current.delete(id);
        void repricePair(id, { forceWeekend: weekendOn });
      } else {
        repriceTimers.current.set(
          id,
          setTimeout(() => repricePair(id), REPRICE_DEBOUNCE_MS),
        );
      }
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
    async (pair: Pair) => {
      const { id } = pair;
      try {
        // Hydrated pairs hold lazy refs, not Files — resolve them first
        // (instant when the prefetch already warmed the cache).
        // ONE image is valid — a combined photo (label clipped onto its
        // invoice) carries both documents; the model splits the halves.
        const images = await loadPairImages(pair);
        if (images.length < 1) {
          throw new Error("Imaginile perechii nu au putut fi încărcate de pe server.");
        }
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
          // Origin store (centralizator bucket) + how the km was routed.
          store: res.routing.store,
          routing: res.routing,
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

  /**
   * Manual pairing — the human resolves what the linker refused to guess.
   *
   * Takes the ids of ≥2 UNPAIRED rows the user selected in the modal and
   * turns them into ONE real pair, reusing the desktop flow end to end:
   * load the orphan images, insert a fresh pending pair (server first, so
   * the photos are never orphaned by a crash mid-swap), delete the source
   * rows, then run the same extract + price call the Calculează button
   * uses — the vision model decides which image is the AWB, so even a
   * misclassified orphan ends up in the right slot.
   *
   * Returns true when the pair was created (the modal clears its
   * selection); false leaves everything untouched for a retry.
   *
   * `collaborator` is chosen in the modal's pick gate right before the
   * pair is sent to OCR (defaulting to the collaborator the orphans
   * were uploaded under), so the operator confirms or corrects the
   * assignment as the pair enters the queue.
   */
  const pairManually = useCallback(
    async (ids: string[], collaborator: CollaboratorKey | null): Promise<boolean> => {
      const docs = ids
        .map((id) => pairsRef.current.find((p) => p.id === id))
        .filter((p): p is Pair => !!p && p.status.kind === "unpaired");
      // One document is valid: a lone AWB (label without an invoice) still
      // prices — the tariff comes from the AWB. Two+ is the normal AWB +
      // invoice(s) case. Zero is nothing to do.
      if (docs.length < 1) return false;

      // AWB-classified docs first — the stored-image convention every
      // view uses (selection order is kept within each kind).
      const rank = (p: Pair) =>
        p.status.kind === "unpaired" && p.status.docType === "awb" ? 0 : 1;
      const ordered = [...docs].sort((a, b) => rank(a) - rank(b));

      let files: File[];
      try {
        files = (await Promise.all(ordered.map((d) => loadPairImages(d)))).flat();
      } catch (err) {
        console.error("Manual pairing: failed to load orphan images:", err);
        return false;
      }
      if (files.length < 1) return false;

      const newPair: Pair = {
        id: uuid(),
        day: docs[0]!.day,
        // The collaborator confirmed in the OCR-send modal — files the
        // hand-built pair under the right partner from the first save.
        collaborator,
        images: files,
        status: { kind: "pending" },
      };
      markLocal(newPair.id);
      try {
        // Server FIRST: only after the new pair (with its image bytes) is
        // safely stored do we retire the orphan rows.
        await insertPair(newPair);
      } catch (err) {
        console.error("Manual pairing: failed to persist the new pair:", err);
        return false;
      }
      const doomed = new Set(ids);
      commit([...pairsRef.current.filter((p) => !doomed.has(p.id)), newPair]);
      for (const id of ids) {
        markLocal(id);
        void deletePair(id).catch((err) =>
          console.error("Manual pairing: failed to delete orphan row:", err),
        );
      }
      // Straight to calculation — the user paired it to get a price.
      setStatusLocal(newPair.id, { kind: "extracting" });
      void runOne(newPair);
      return true;
    },
    [commit, markLocal, setStatusLocal, runOne],
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
        await runOne(next);
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

  // Pairs on the visible day AND in the active centralizator. Drives the
  // queue table, the totals, and the buttons. Unpaired documents are NOT
  // pairs — they live in their own strip below.
  const dayPairs = useMemo(
    () =>
      pairs.filter(
        (p) =>
          p.day === selectedDay &&
          p.status.kind !== "unpaired" &&
          inActiveStore(p) &&
          inActiveView(p) &&
          inActiveCollaborator(p),
      ),
    [pairs, selectedDay, inActiveStore, inActiveView, inActiveCollaborator],
  );

  // Free-text search over the day's pairs (AWB, recipient, invoice, …).
  // Scoped to whatever `dayPairs` already shows, so it composes with the
  // store / view / collaborator filters instead of fighting them.
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const visiblePairs = useMemo(
    () => (trimmedQuery ? dayPairs.filter((p) => pairMatchesQuery(p, trimmedQuery)) : dayPairs),
    [dayPairs, trimmedQuery],
  );

  // Pairs the EXPORT modal can draw from: day + store + view scoped, but
  // deliberately NOT filtered by the header's collaborator dropdown — the
  // modal owns its own collaborator scope setting, so the user can export
  // any partner's file (or a decont) regardless of the current view filter.
  const exportPairs = useMemo(
    () =>
      pairs.filter(
        (p) =>
          p.day === selectedDay &&
          p.status.kind !== "unpaired" &&
          inActiveStore(p) &&
          inActiveView(p),
      ),
    [pairs, selectedDay, inActiveStore, inActiveView],
  );

  // Documents the scanner could not pair by name/address on this day.
  // Store- and view-independent: an orphan paper belongs to the DAY, and
  // it must stay visible until a human resolves it.
  const dayUnpaired = useMemo(
    () => pairs.filter((p) => p.day === selectedDay && p.status.kind === "unpaired"),
    [pairs, selectedDay],
  );

  // Candidate targets for "send to an existing pair": the day's real pairs
  // (anything that is not an unpaired orphan). Deliberately NOT filtered by
  // store/view so the operator can attach to any pair of the day.
  const attachTargets = useMemo(
    () => pairs.filter((p) => p.day === selectedDay && p.status.kind !== "unpaired"),
    [pairs, selectedDay],
  );

  // The modal lives only while there is something to resolve; once the
  // last orphan is paired or deleted the flag resets, so a FUTURE scan's
  // orphans never pop the modal open uninvited.
  useEffect(() => {
    if (dayUnpaired.length === 0) setUnpairedOpen(false);
  }, [dayUnpaired.length]);

  // Counts behind the Standard/Macara switch, scoped to the selected day +
  // store. An undecided (not-yet-priced) pair shows in both lists, so it is
  // counted in both — the badge reflects exactly what each list will show.
  const modeCounts = useMemo(() => {
    let standard = 0;
    let macara = 0;
    for (const p of pairs) {
      if (p.day !== selectedDay || !inActiveStore(p) || !inActiveCollaborator(p)) continue;
      if (p.status.kind === "unpaired") continue; // orphans are not pairs — they have their own pill
      if (inView(p, "macara")) macara += 1;
      if (inView(p, "standard")) standard += 1;
    }
    return { standard, macara };
  }, [pairs, selectedDay, inActiveStore, inActiveCollaborator]);

  // One DayCount per day that holds at least one pair IN THE ACTIVE
  // centralizator, ordered by ISO string. Scoping the tabs to the active
  // store makes each store feel like its own workbook; unassigned pairs
  // count in every store (they show everywhere until filed).
  const dayCounts = useMemo<DayCount[]>(() => {
    const m = new Map<string, { count: number; readyCount: number }>();
    for (const p of pairs) {
      if (!inActiveStore(p) || !inActiveView(p) || !inActiveCollaborator(p)) continue;
      const c = m.get(p.day) ?? { count: 0, readyCount: 0 };
      // Unpaired orphans keep the day's tab alive (so they stay reachable)
      // but are NOT counted — the warning pill is their counter.
      if (p.status.kind !== "unpaired") {
        c.count += 1;
        if (p.status.kind === "ready") c.readyCount += 1;
      }
      m.set(p.day, c);
    }
    return Array.from(m.entries()).map(([day, v]) => ({ day, ...v }));
  }, [pairs, inActiveStore, inActiveView, inActiveCollaborator]);

  // Header counters — scoped to current day so "Calculează (N)" tells
  // the truth about what pressing the button will run.
  const counts = useMemo(() => {
    const c = { pending: 0, extracting: 0, ready: 0, error: 0 };
    for (const p of dayPairs) {
      // dayPairs already excludes "unpaired"; the guard narrows the type.
      if (p.status.kind !== "unpaired") c[p.status.kind] += 1;
    }
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
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-ink-200 bg-canvas-50 px-6 py-3.5">
        {/* Identity + live status — "which app, is it connected, is work
            in flight" all sit together on the left. */}
        <div className="flex items-center gap-3">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">Centralizator</h1>
            <span className="hidden text-[11px] uppercase tracking-[0.18em] text-ink-500 sm:inline">
              Stalexone Trans
            </span>
          </div>
          {/* Live-feed indicator — green when the SSE stream is connected,
              so the user knows phone scans will appear in real time. */}
          <LivePill connected={liveConnected} />
          {/* UpdateBanner self-hides when there's no update. */}
          <UpdateBanner />
          {globalExtracting > 0 && (
            <Spinner
              label={`Procesez ${globalExtracting} pereche${globalExtracting === 1 ? "" : "i"}…`}
            />
          )}
        </div>

        {/* Scope filters + actions. Filters first (they decide WHAT the
            screen shows), then the secondary tools, then the primary
            Calculează. The whole cluster wraps as one block on narrow
            windows instead of overflowing the bar. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* The two global selectors live in one tinted pill so they read
              as the queue's scope control, not as stray captions. Both
              apply to the entire queue (table totals, footer sums,
              exports); the collaborator roster is city-dependent (sourced
              from PRETURI COLABORATORI.ods): Ploiești has 3 partners,
              Iași has 2, Constanța has none. */}
          <div className="flex items-center gap-3 rounded-lg border border-ink-200 bg-canvas-100 px-3 py-1.5 shadow-sm">
            <HeaderSelect<CityKey>
              label="Oraș"
              value={selectedCity}
              options={CITY_KEYS}
              labelFor={(k) => CITY_LABEL[k]}
              onChange={setSelectedCity}
              title="Magazin / centralizator — schimbă între cele 4 magazine (fiecare cu tabelul și exportul lui); perechile se filtrează după magazinul din care au plecat"
            />
            <span aria-hidden className="h-5 w-px bg-ink-200" />
            <CollaboratorSelect
              city={selectedCity}
              value={selectedCollaborator}
              onChange={setSelectedCollaborator}
            />
          </div>

          {/* Secondary tools — compare against the courier's master file,
              export the day, clear the day. Grouped tight so they read as
              one toolbar, set apart from the primary action. */}
          <div className="flex items-center gap-2">
            {/* Cross-check the courier's master export against our data.
                Always available — the server compares the whole pair queue
                (joined on AWB number), independent of the selected day. */}
            <CompareExcelButton />
            {exportPairs.length > 0 && (
              <ExportMenu
                pairs={exportPairs}
                day={selectedDay}
                city={selectedCity}
                collaborator={selectedCollaborator}
                disabled={!exportPairs.some((p) => p.status.kind === "ready")}
              />
            )}
            {pairs.some((p) => p.day === selectedDay) &&
              (confirmingReset ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={resetDay}
                    title={`Şterge definitiv toate perechile pentru ${fmtDate(selectedDay)} de pe server`}
                    className="rounded-md border border-coral-600 bg-coral-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-coral-600"
                  >
                    Confirmă golirea
                  </button>
                  <button
                    type="button"
                    onClick={cancelReset}
                    title="Renunță"
                    className="rounded-md border border-ink-300 bg-canvas-50 px-2.5 py-1.5 text-sm text-ink-600 transition hover:bg-canvas-200 hover:text-ink-900"
                  >
                    Renunță
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={armReset}
                  title={`Şterge toate perechile pentru ${fmtDate(selectedDay)} (toate magazinele) de pe server`}
                  className="rounded-md border border-ink-300 bg-canvas-50 px-3 py-1.5 text-sm text-ink-700 transition hover:border-coral-400 hover:bg-canvas-200 hover:text-ink-900"
                >
                  Goleşte ziua
                </button>
              ))}
          </div>

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
            collaborator={selectedPair.collaborator ?? selectedCollaborator}
            verifying={verifyingIds.has(selectedPair.id)}
            onPatch={(patch) => patchPair(selectedPair.id, patch)}
            onDetachInvoice={(invoiceIndex) => detachInvoice(selectedPair.id, invoiceIndex)}
            onDismantle={() => dismantlePair(selectedPair.id)}
            onBack={() => setSelectedId(null)}
            onRemove={() => removePair(selectedPair.id)}
          />
        ) : (
          /* Standard queue view — the spreadsheet is shown straight away,
           * empty or not, so freshly scanned phone pairs stream into it
           * live. Day tabs on top, then the compact add-card, then the
           * table (its column headers stand in for the "empty" state). */
          <>
            <ModeToggle mode={viewMode} counts={modeCounts} onChange={setViewMode} />
            <DayTabs
              days={dayCounts}
              selectedDay={selectedDay}
              onSelect={setSelectedDay}
            />
            <PairAddCard
              onScan={scanImages}
              hero={dayPairs.length === 0 && dayUnpaired.length === 0}
            />
            {/* Orphan documents the server refused to guess into a pair —
                a warning pill above the queue; the modal is the manual
                pairing system (zoom + select + create pair). */}
            <UnpairedAlert count={dayUnpaired.length} onOpen={() => setUnpairedOpen(true)} />
            {unpairedOpen && dayUnpaired.length > 0 && (
              <UnpairedModal
                items={dayUnpaired}
                onClose={() => setUnpairedOpen(false)}
                onRemove={removePair}
                onPair={pairManually}
                existingPairs={attachTargets}
                onAttach={attachToPair}
                onRetry={() => retryUnpaired(selectedDay)}
              />
            )}
            {/* Search the day's pairs. Only useful once there's something to
                filter; hidden on an empty day so it doesn't clutter the hero. */}
            {dayPairs.length > 0 && (
              <SearchBar
                value={query}
                onChange={setQuery}
                count={trimmedQuery ? visiblePairs.length : null}
              />
            )}
            <PairsTable
              pairs={visiblePairs}
              city={selectedCity}
              collaborator={selectedCollaborator}
              verifyingIds={verifyingIds}
              onPatchPair={patchPair}
              onRemovePair={removePair}
              onSelectPair={setSelectedId}
            />
            {trimmedQuery && visiblePairs.length === 0 && (
              <p className="rounded-lg border border-dashed border-ink-200 bg-canvas-50 px-4 py-6 text-center text-sm text-ink-500">
                Niciun rezultat pentru „{trimmedQuery}” în această zi.
              </p>
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
 * ModeToggle — the top-level Standard/Macara list switch.
 *
 * A segmented control: two buttons, the active one filled coral. Each
 * carries a count badge for the selected day + store so the user sees how
 * many pairs sit in each list before switching. Macara (crane) runs live in
 * their own list; everything else stays in Standard. Pairs that haven't been
 * priced yet show in both, so a fresh drop is never hidden until the AI
 * decides where it belongs.
 * ────────────────────────────────────────────────────────────────────── */
function ModeToggle({
  mode,
  counts,
  onChange,
}: {
  mode: ViewMode;
  counts: { standard: number; macara: number };
  onChange: (m: ViewMode) => void;
}) {
  const tabs: { key: ViewMode; label: string; count: number }[] = [
    { key: "standard", label: "Standard", count: counts.standard },
    { key: "macara", label: "Macara", count: counts.macara },
  ];
  return (
    <div
      role="tablist"
      aria-label="Listă standard sau macara"
      className="inline-flex self-start rounded-lg border border-ink-200 bg-canvas-50 p-1 shadow-sm"
    >
      {tabs.map((t) => {
        const active = t.key === mode;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition ${
              active
                ? "bg-coral-500 text-canvas-50 shadow-sm"
                : "text-ink-600 hover:bg-canvas-200 hover:text-ink-900"
            }`}
            title={
              t.key === "macara"
                ? "Perechile cu macara (livrare cu macara)"
                : "Perechile standard (fără macara)"
            }
          >
            <span>{t.label}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${
                active ? "bg-coral-600 text-canvas-50" : "bg-canvas-200 text-ink-500"
              }`}
            >
              {t.count}
            </span>
          </button>
        );
      })}
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
/* ──────────────────────────────────────────────────────────────────────
 * LivePill — tiny header badge for the live SSE feed.
 *
 * Green dot + "Live" when the stream is connected (phone scans land in real
 * time); a muted amber "Reconectare…" while the client is backing off and
 * retrying. Purely informational — the queue still works offline, it just
 * won't stream until the dot goes green again.
 * ────────────────────────────────────────────────────────────────────── */
function LivePill({ connected }: { connected: boolean }) {
  return (
    <span
      className={
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em] " +
        (connected
          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
          : "border-amber-300 bg-amber-50 text-amber-700")
      }
      title={
        connected
          ? "Conectat la flux — scanările din telefon apar în timp real"
          : "Reconectare la fluxul live…"
      }
    >
      <span
        className={
          "inline-block h-2 w-2 rounded-full " +
          (connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500")
        }
      />
      {connected ? "Live" : "Reconectare…"}
    </span>
  );
}

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
 * source (+ the Constanța five at 10 %). If a city ever has an empty
 * roster again, the select renders a disabled "Direct (fără
 * colaborator)" placeholder instead of an empty list — clearer than a
 * phantom dropdown that does nothing on click. The labels show the full "<Company>
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
          ? "Oraș fără colaborator (plată directă)"
          : "Colaborator — filtrează perechile alocate acestui colaborator (alocarea se face la încărcare); perechile vechi, fără alocare, apar peste tot"
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


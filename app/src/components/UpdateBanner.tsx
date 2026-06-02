import { useCallback, useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/* ──────────────────────────────────────────────────────────────────────
 * Update banner
 *
 * Lives in the header. On mount it asks the Tauri updater plugin
 * whether a newer signed release is sitting on GitHub. The plugin
 * fetches the configured `latest.json` endpoint (see
 * tauri.conf.json → plugins.updater.endpoints), compares versions,
 * and either returns an Update handle or null.
 *
 * State machine:
 *   idle       — initial; checks in background, no UI.
 *   checking   — background probe in flight (no UI either; we don't
 *                want to spam the header with a spinner the user
 *                didn't ask for).
 *   available  — a newer release exists. Banner appears: version,
 *                "Instalează", and a "Mai târziu" dismiss.
 *   downloading— installer is streaming in; progress percentage in
 *                the banner.
 *   ready      — download done, install finished, asking the user
 *                to confirm the relaunch.
 *   error      — checked / downloaded but something failed. Shown
 *                inline so the user can see what blew up without
 *                opening DevTools.
 *   dismissed  — user clicked "Mai târziu". Suppressed for the rest
 *                of this session; the next launch checks again.
 *
 * Outside a Tauri WebView the `check()` import resolves to a stub
 * that throws on call; we swallow that quietly so dev in plain Vite
 * just shows nothing (matching the rest of the app's "best effort"
 * Tauri-only features).
 * ────────────────────────────────────────────────────────────────────── */

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string }
  | { kind: "dismissed" };

/** Format a possibly-null percent into a human string ("42%" or "…"). */
function fmtPercent(p: number | null): string {
  if (p === null || Number.isNaN(p)) return "…";
  return `${Math.round(Math.max(0, Math.min(100, p)))}%`;
}

export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: "idle" });

  /* ── Background check on mount ────────────────────────────────────
   * We intentionally don't await `check()` synchronously — the
   * network round-trip can take seconds against GitHub, and we don't
   * want to delay the first paint of the queue. The promise resolves
   * in the background; if there's nothing new we stay in `idle` and
   * the user never sees the banner. */
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "checking" });
    void (async () => {
      try {
        const update = await check();
        if (cancelled) return;
        if (update) {
          console.info(`[updater] new version available: ${update.version}`);
          setState({ kind: "available", update });
        } else {
          setState({ kind: "idle" });
        }
      } catch (err) {
        // Most common error path: running in plain `vite dev` (no
        // Tauri WebView). Swallow silently — no point lecturing the
        // user about a background check that's never going to work.
        if (cancelled) return;
        const msg = (err as Error).message ?? String(err);
        if (/IPC|not.*supported|undefined/i.test(msg)) {
          setState({ kind: "idle" });
          return;
        }
        console.warn("[updater] check failed:", err);
        setState({ kind: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Install action ──────────────────────────────────────────────
   * `downloadAndInstall` streams the installer, calls the
   * progress callback per chunk, then runs the platform-native
   * install step (NSIS exec on Windows). Once it resolves we ask
   * the user to confirm the relaunch so they don't lose work
   * mid-task. */
  const install = useCallback(async (update: Update) => {
    let downloaded = 0;
    let contentLength: number | null = null;

    setState({ kind: "downloading", update, percent: null });

    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? null;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setState({
              kind: "downloading",
              update,
              percent:
                contentLength && contentLength > 0
                  ? (downloaded / contentLength) * 100
                  : null,
            });
            break;
          case "Finished":
            // The install step runs next inside downloadAndInstall;
            // we'll flip to "ready" after the promise resolves.
            break;
        }
      });
      setState({ kind: "ready", version: update.version });
    } catch (err) {
      console.error("[updater] install failed:", err);
      setState({ kind: "error", message: (err as Error).message });
    }
  }, []);

  const doRelaunch = useCallback(async () => {
    try {
      await relaunch();
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, []);

  /* ── Render ────────────────────────────────────────────────────── */

  if (state.kind === "idle" || state.kind === "checking" || state.kind === "dismissed") {
    return null;
  }

  if (state.kind === "available") {
    return (
      <Pill tone="info">
        <span className="font-medium">Versiune nouă: {state.update.version}</span>
        <button
          type="button"
          onClick={() => void install(state.update)}
          className="rounded-md bg-coral-500 px-2 py-0.5 text-[11px] font-medium text-canvas-50 transition hover:bg-coral-600"
        >
          Instalează
        </button>
        <button
          type="button"
          onClick={() => setState({ kind: "dismissed" })}
          className="text-[11px] text-ink-500 underline-offset-2 transition hover:text-ink-700 hover:underline"
        >
          Mai târziu
        </button>
      </Pill>
    );
  }

  if (state.kind === "downloading") {
    return (
      <Pill tone="info">
        <span className="font-medium">
          Descarcă {state.update.version} ({fmtPercent(state.percent)})
        </span>
      </Pill>
    );
  }

  if (state.kind === "ready") {
    return (
      <Pill tone="success">
        <span className="font-medium">Actualizare {state.version} gata</span>
        <button
          type="button"
          onClick={() => void doRelaunch()}
          className="rounded-md bg-coral-500 px-2 py-0.5 text-[11px] font-medium text-canvas-50 transition hover:bg-coral-600"
        >
          Repornește
        </button>
      </Pill>
    );
  }

  // error
  return (
    <Pill tone="error">
      <span title={state.message}>Actualizare eșuată</span>
      <button
        type="button"
        onClick={() => setState({ kind: "dismissed" })}
        className="text-[11px] text-ink-500 underline-offset-2 transition hover:text-ink-700 hover:underline"
      >
        Închide
      </button>
    </Pill>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * Tone-aware pill — keeps the visual language consistent with the
 * rest of the header (Spinner, ExportMenu, Calculează). Three tones:
 * info (default coral-tinged), success (green-tinged), error (coral
 * red). All three share the same outer chrome so the banner doesn't
 * jump as state transitions.
 * ────────────────────────────────────────────────────────────────────── */
function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "info" | "success" | "error";
}) {
  const toneCls =
    tone === "success"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : tone === "error"
        ? "border-coral-300 bg-coral-50 text-coral-800"
        : "border-ink-200 bg-canvas-50 text-ink-800";
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[12px] ${toneCls}`}
    >
      {children}
    </div>
  );
}

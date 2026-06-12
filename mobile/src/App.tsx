import { useCallback, useEffect, useRef, useState } from "react";
import { scanBatch, health } from "./lib/api";
import {
  captureFrame,
  ensureCameraPermission,
  fileToCaptured,
  startStream,
  stopStream,
  type CapturedImage,
} from "./lib/camera";
import { detect } from "./lib/scanner";
import { loadTestBatch } from "./lib/testImages";
import {
  COLLABORATOR_KEYS,
  COLLABORATOR_LABEL,
  type CollaboratorKey,
} from "@shared/collaborators";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; count: number }
  | { kind: "error"; message: string };

type CamState = "starting" | "ready" | "denied" | "error";

// Temporal stability so "green" means sure, not a one-frame fluke.
// Quick to lock (detection is now reliable), slower to drop → calm + steady.
const LOCK_ON = 2; // consecutive confident frames to light the frame green
const LOCK_OFF = 3; // consecutive misses to drop the lock (hysteresis)

/** localStorage key for the last-used collaborator — preselected the next
 *  time the picker opens, so a courier who always scans for the same
 *  partner confirms with one tap. */
const LS_COLLABORATOR = "centralizator.collaborator";

function readStoredCollaborator(): CollaboratorKey | null {
  try {
    const s = localStorage.getItem(LS_COLLABORATOR);
    if (s && (COLLABORATOR_KEYS as readonly string[]).includes(s)) {
      return s as CollaboratorKey;
    }
  } catch {
    /* localStorage may be unavailable — fall through. */
  }
  return null;
}

/** Draw the always-on viewfinder: four corner brackets framing the target
 *  zone, plus a faint rectangle. White while searching, green when locked.
 *  Drawn in the overlay's own CSS-pixel space (decoupled from the video),
 *  so the frame is always centred and fully visible. */
function drawGuide(canvas: HTMLCanvasElement, locked: boolean): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const gx0 = W * 0.08;
  const gx1 = W * 0.92;
  const gy0 = H * 0.15;
  const gy1 = H * 0.84;
  const L = Math.min(W, H) * 0.07;
  const t = Math.max(4, Math.min(W, H) * 0.012);
  const color = locked ? "#22c55e" : "rgba(255,255,255,0.9)";

  // Faint full rectangle.
  ctx.save();
  ctx.globalAlpha = locked ? 0.3 : 0.14;
  ctx.lineWidth = Math.max(1, t * 0.4);
  ctx.strokeStyle = color;
  ctx.strokeRect(gx0, gy0, gx1 - gx0, gy1 - gy0);
  ctx.restore();

  // Corner brackets.
  ctx.lineWidth = t;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  const corner = (x: number, y: number, dx: number, dy: number) => {
    ctx.beginPath();
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
    ctx.stroke();
  };
  corner(gx0, gy0, 1, 1);
  corner(gx1, gy0, -1, 1);
  corner(gx0, gy1, 1, -1);
  corner(gx1, gy1, -1, -1);
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const detCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Loop-owned counters/flags (refs to avoid stale closures + per-frame renders).
  const lockedRef = useRef(false);
  const readyStreakRef = useRef(0);
  const missStreakRef = useRef(0);

  const [camState, setCamState] = useState<CamState>("starting");
  const [camError, setCamError] = useState("");
  const [locked, setLocked] = useState(false);

  const [images, setImages] = useState<CapturedImage[]>([]);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [online, setOnline] = useState<boolean | null>(null);
  const [justCaptured, setJustCaptured] = useState(false);

  // Collaborator assignment — picked in a modal right before the upload,
  // so every pair the batch produces lands on the right partner. The
  // last choice is remembered as next time's default.
  const [collaborator, setCollaborator] = useState<CollaboratorKey | null>(readStoredCollaborator);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    try {
      if (collaborator) localStorage.setItem(LS_COLLABORATOR, collaborator);
      else localStorage.removeItem(LS_COLLABORATOR);
    } catch {
      /* best-effort — losing this only forgets the default */
    }
  }, [collaborator]);

  // Connection dot — probe on mount, then every 20s.
  useEffect(() => {
    let alive = true;
    const ping = () => health().then((ok) => alive && setOnline(ok));
    ping();
    const t = setInterval(ping, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Clear the "Sent ✓" banner shortly after it shows.
  useEffect(() => {
    if (send.kind !== "sent") return;
    const t = setTimeout(() => setSend({ kind: "idle" }), 3500);
    return () => clearTimeout(t);
  }, [send]);

  /** One detect + guide-render pass. */
  const tick = useCallback(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay) return;

    // Keep the overlay's pixel buffer matched to its on-screen size.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const tw = Math.max(1, Math.round(overlay.clientWidth * dpr));
    const th = Math.max(1, Math.round(overlay.clientHeight * dpr));
    if (overlay.width !== tw || overlay.height !== th) {
      overlay.width = tw;
      overlay.height = th;
    }

    let ready = false;
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      let det = detCanvasRef.current;
      if (!det) {
        det = document.createElement("canvas");
        detCanvasRef.current = det;
      }
      const detW = 480;
      const detH = Math.max(1, Math.round((detW * vh) / vw));
      if (det.width !== detW || det.height !== detH) {
        det.width = detW;
        det.height = detH;
      }
      const dctx = det.getContext("2d", { willReadFrequently: true });
      if (dctx) {
        dctx.drawImage(video, 0, 0, detW, detH);
        ready = detect(det).ready;
      }
    }

    // Hysteresis: slow to lock, slightly slower to unlock → calm + sure.
    if (ready) {
      readyStreakRef.current += 1;
      missStreakRef.current = 0;
    } else {
      missStreakRef.current += 1;
      readyStreakRef.current = 0;
    }
    let next = lockedRef.current;
    if (!next && readyStreakRef.current >= LOCK_ON) next = true;
    else if (next && missStreakRef.current >= LOCK_OFF) next = false;

    if (next !== lockedRef.current) {
      lockedRef.current = next;
      setLocked(next);
      if (next) navigator.vibrate?.(30);
    }

    drawGuide(overlay, next);
  }, []);

  // Boot the camera, then the detection loop.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await ensureCameraPermission();
      if (cancelled) return;
      if (!ok) {
        setCamState("denied");
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      try {
        const stream = await startStream(video);
        if (cancelled) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        setCamState("ready");
      } catch (err) {
        setCamState("error");
        setCamError((err as Error).message);
        return;
      }
      loopRef.current = window.setInterval(tick, 160);
    })();

    return () => {
      cancelled = true;
      if (loopRef.current) clearInterval(loopRef.current);
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [tick]);

  const addImage = useCallback((img: CapturedImage) => {
    setImages((prev) => [...prev, img]);
    setSend({ kind: "idle" });
  }, []);

  const onShutter = useCallback(async () => {
    const video = videoRef.current;
    if (!video || camState !== "ready") return;
    try {
      const img = await captureFrame(video);
      navigator.vibrate?.(40);
      addImage(img);
      setJustCaptured(true);
      setTimeout(() => setJustCaptured(false), 850);
    } catch (err) {
      setSend({ kind: "error", message: (err as Error).message });
    }
  }, [camState, addImage]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  // "Trimite" opens the collaborator picker — the actual upload happens
  // in `doSend` once the user confirms whose documents these are.
  const onSend = useCallback(() => {
    if (images.length < 2 || send.kind === "sending") return;
    setPickerOpen(true);
  }, [images.length, send.kind]);

  /** The real upload, fired by the picker's confirm button. Saves the
   *  chosen collaborator as the next default, then ships the batch. */
  const doSend = useCallback(
    async (chosen: CollaboratorKey | null) => {
      if (images.length < 2 || send.kind === "sending") return;
      setPickerOpen(false);
      setCollaborator(chosen);
      setSend({ kind: "sending" });
      try {
        const res = await scanBatch(images.map((i) => i.file), chosen);
        for (const i of images) URL.revokeObjectURL(i.previewUrl);
        setImages([]);
        setSend({ kind: "sent", count: res.imageCount });
      } catch (err) {
        setSend({ kind: "error", message: (err as Error).message });
      }
    },
    [images, send.kind],
  );

  // Fire the bundled six-image sample batch (3 AWB+invoice pairs) at the
  // server — a one-tap end-to-end check that needs no scanning. Uses the
  // remembered collaborator (test data, no extra modal friction).
  const onTest = useCallback(async () => {
    if (send.kind === "sending") return;
    setSend({ kind: "sending" });
    try {
      const files = await loadTestBatch();
      const res = await scanBatch(files, collaborator);
      setSend({ kind: "sent", count: res.imageCount });
    } catch (err) {
      setSend({ kind: "error", message: (err as Error).message });
    }
  }, [send.kind, collaborator]);

  const retryCamera = useCallback(() => window.location.reload(), []);

  // Top hint pill.
  let hint: { text: string; tone: "neutral" | "good" | "warn" } = {
    text: "Apropie documentul ca să umple cadrul",
    tone: "neutral",
  };
  if (justCaptured) hint = { text: "✓ Capturat", tone: "good" };
  else if (camState === "starting") hint = { text: "Se pornește camera…", tone: "neutral" };
  else if (camState === "denied") hint = { text: "Acces la cameră refuzat — atinge pentru a reîncerca", tone: "warn" };
  else if (camState === "error") hint = { text: camError || "Eroare la cameră", tone: "warn" };
  else if (locked) hint = { text: "Document detectat — apasă pe buton ca să fotografiezi", tone: "good" };

  const hintColor =
    hint.tone === "good" ? "bg-emerald-600/90" : hint.tone === "warn" ? "bg-amber-600/90" : "bg-slate-900/80";

  const camFailed = camState === "denied" || camState === "error";

  return (
    <div className="relative h-full w-full overflow-hidden bg-black text-slate-100">
      {/* Live camera */}
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" playsInline muted autoPlay />
      {/* Fixed viewfinder frame (its own CSS-pixel space) */}
      <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      {/* Readability gradients */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/80 to-transparent" />

      {/* Capture flash */}
      {justCaptured && <div className="pointer-events-none absolute inset-0 animate-pulse bg-white/30" />}

      {/* Top bar: hint + connection dot */}
      <div
        className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3"
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
      >
        <button
          type="button"
          onClick={camState === "denied" ? retryCamera : undefined}
          className={`max-w-[78%] rounded-full px-3.5 py-2 text-sm font-medium shadow-lg ${hintColor}`}
        >
          {hint.text}
        </button>
        <div className="flex flex-col items-end gap-2">
          <span
            className="flex items-center gap-1.5 rounded-full bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-300"
            title={online === null ? "Verific..." : online ? "Conectat" : "Fără conexiune"}
          >
            <span
              className={
                "inline-block h-2.5 w-2.5 rounded-full " +
                (online === null ? "bg-slate-500" : online ? "bg-emerald-400" : "bg-rose-500")
              }
            />
            {online === null ? "..." : online ? "OK" : "Offline"}
          </span>
          <button
            type="button"
            onClick={onTest}
            disabled={send.kind === "sending"}
            className="rounded-full bg-indigo-600/90 px-3 py-1.5 text-xs font-semibold shadow-lg active:scale-95 disabled:opacity-50"
          >
            {send.kind === "sending" ? "..." : "🧪 Test"}
          </button>
        </div>
      </div>

      {/* Camera-unavailable fallback */}
      {camFailed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-center">
          <div className="text-5xl">📷</div>
          <p className="max-w-xs text-sm text-slate-300">
            Nu am acces la cameră. Activează permisiunea camerei, sau alege pozele din galerie.
          </p>
          <div className="flex gap-3">
            <button onClick={retryCamera} className="rounded-xl bg-slate-700 px-4 py-2.5 text-sm font-semibold">
              Reîncearcă camera
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold"
            >
              Alege poze
            </button>
          </div>
        </div>
      )}

      {/* Bottom controls */}
      <div
        className="absolute inset-x-0 bottom-0 px-4 pt-3"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        {send.kind === "error" && (
          <div className="mb-3 rounded-lg bg-rose-700/90 px-3 py-2 text-center text-sm">{send.message}</div>
        )}
        {send.kind === "sent" && (
          <div className="mb-3 rounded-lg bg-emerald-600/90 px-3 py-2 text-center text-sm font-medium">
            ✓ Trimis ({send.count} {send.count === 1 ? "poză" : "poze"}). Serverul le procesează.
          </div>
        )}

        {/* Captured thumbnails */}
        {images.length > 0 && (
          <ul className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {images.map((img, idx) => (
              <li key={img.id} className="relative shrink-0">
                <img
                  src={img.previewUrl}
                  alt={`Pagina ${idx + 1}`}
                  className="h-16 w-12 rounded-md border border-white/20 object-cover"
                />
                <span className="absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[10px] font-bold">
                  {idx + 1}
                </span>
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-xs font-bold"
                  aria-label="Șterge"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Shutter + send row */}
        <div className="flex items-center justify-between">
          <div className="w-24 text-sm text-slate-300">
            {images.length > 0 ? `${images.length} ${images.length === 1 ? "poză" : "poze"}` : ""}
          </div>

          <button
            onClick={onShutter}
            disabled={camState !== "ready"}
            aria-label="Fotografiază"
            className={
              "relative flex h-20 w-20 items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-40 " +
              (locked ? "scale-105" : "")
            }
          >
            <span
              className={
                "absolute inset-0 rounded-full border-4 " + (locked ? "border-emerald-400" : "border-white/80")
              }
            />
            <span className={"h-16 w-16 rounded-full " + (locked ? "bg-emerald-400" : "bg-white")} />
          </button>

          <div className="flex w-24 justify-end">
            <button
              onClick={onSend}
              disabled={images.length < 2 || send.kind === "sending"}
              className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold active:scale-95 disabled:opacity-40"
            >
              {send.kind === "sending" ? "..." : `Trimite${images.length ? ` (${images.length})` : ""}`}
            </button>
          </div>
        </div>
        {images.length === 1 && (
          <p className="mt-2 text-center text-xs text-slate-400">
            Mai adaugă cel puțin o pagină (un AWB și o factură).
          </p>
        )}
      </div>

      {/* Hidden fallback file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = e.target.files;
          if (list) for (const f of Array.from(list)) addImage(fileToCaptured(f));
          e.target.value = "";
        }}
      />

      {/* Collaborator picker — the gate every upload passes through */}
      {pickerOpen && (
        <CollaboratorPicker
          initial={collaborator}
          count={images.length}
          onCancel={() => setPickerOpen(false)}
          onConfirm={doSend}
        />
      )}
    </div>
  );
}

/**
 * Bottom-sheet modal shown when the courier taps "Trimite": pick WHOSE
 * documents these are, then confirm. Every pair the server builds from
 * this batch is stamped with the chosen collaborator, so the desktop
 * queue files it under the right partner automatically. The last choice
 * arrives preselected (localStorage) — the common case is one tap on
 * "Trimite" inside the sheet.
 */
function CollaboratorPicker({
  initial,
  count,
  onCancel,
  onConfirm,
}: {
  initial: CollaboratorKey | null;
  count: number;
  onCancel: () => void;
  onConfirm: (chosen: CollaboratorKey | null) => void;
}) {
  const [choice, setChoice] = useState<CollaboratorKey | null>(initial);

  const option = (key: CollaboratorKey | null, label: string) => {
    const active = choice === key;
    return (
      <button
        key={key ?? "direct"}
        type="button"
        onClick={() => setChoice(key)}
        className={
          "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm font-medium transition active:scale-[0.99] " +
          (active
            ? "border-emerald-400 bg-emerald-600/25 text-emerald-200"
            : "border-white/15 bg-white/5 text-slate-200")
        }
      >
        <span>{label}</span>
        <span
          className={
            "flex h-5 w-5 items-center justify-center rounded-full border " +
            (active ? "border-emerald-400 bg-emerald-500" : "border-white/30")
          }
        >
          {active && (
            <svg className="h-3 w-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
      </button>
    );
  };

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col justify-end bg-black/70"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Alege colaboratorul"
    >
      <div
        className="rounded-t-2xl bg-slate-900 px-4 pt-4 shadow-2xl"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Pentru ce colaborator sunt documentele?
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Toate perechile din acest lot se salvează pe colaboratorul ales.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Renunță"
            className="rounded-full bg-white/10 px-2.5 py-1 text-sm text-slate-300"
          >
            ✕
          </button>
        </div>

        <div className="mt-3 max-h-[50vh] space-y-2 overflow-y-auto pb-1">
          {COLLABORATOR_KEYS.map((k) => option(k, COLLABORATOR_LABEL[k]))}
          {option(null, "Direct (fără colaborator)")}
        </div>

        <button
          type="button"
          onClick={() => onConfirm(choice)}
          className="mt-3 w-full rounded-xl bg-emerald-600 px-4 py-3.5 text-base font-semibold text-white active:scale-[0.99]"
        >
          Trimite ({count} {count === 1 ? "poză" : "poze"})
        </button>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, useCallback } from "react";
import { scanBatch, health } from "./lib/api";
import {
  captureFromCamera,
  fileToCaptured,
  isNative,
  type CapturedImage,
} from "./lib/camera";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; count: number }
  | { kind: "error"; message: string };

export default function App() {
  const [images, setImages] = useState<CapturedImage[]>([]);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [online, setOnline] = useState<boolean | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const native = isNative();

  // Connection dot — probe once on mount, then every 20s.
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

  const addImage = useCallback((img: CapturedImage) => {
    setImages((prev) => [...prev, img]);
    setSend({ kind: "idle" });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const move = useCallback((id: string, dir: -1 | 1) => {
    setImages((prev) => {
      const i = prev.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }, []);

  const onAddPage = useCallback(async () => {
    if (native) {
      try {
        const img = await captureFromCamera();
        if (img) addImage(img);
      } catch (err) {
        // User cancel throws on some platforms — only surface real errors.
        const msg = (err as Error).message ?? "";
        if (!/cancel/i.test(msg)) setSend({ kind: "error", message: msg });
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [native, addImage]);

  const onFilesPicked = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      for (const f of Array.from(list)) addImage(fileToCaptured(f));
    },
    [addImage],
  );

  const onSend = useCallback(async () => {
    if (images.length < 2 || send.kind === "sending") return;
    setSend({ kind: "sending" });
    try {
      const res = await scanBatch(images.map((i) => i.file));
      for (const i of images) {
        if (i.previewUrl.startsWith("blob:")) URL.revokeObjectURL(i.previewUrl);
      }
      setImages([]);
      setSend({ kind: "sent", count: res.imageCount });
    } catch (err) {
      setSend({ kind: "error", message: (err as Error).message });
    }
  }, [images, send.kind]);

  const sending = send.kind === "sending";

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <div>
          <h1 className="text-base font-semibold">Centralizator Scanner</h1>
          <p className="text-xs text-slate-400">Scanează AWB-uri și facturi</p>
        </div>
        <span
          className="flex items-center gap-1.5 text-xs text-slate-400"
          title={online === null ? "Verific..." : online ? "Conectat" : "Fără conexiune"}
        >
          <span
            className={
              "inline-block h-2.5 w-2.5 rounded-full " +
              (online === null ? "bg-slate-500" : online ? "bg-emerald-400" : "bg-rose-500")
            }
          />
          {online === null ? "..." : online ? "Server OK" : "Offline"}
        </span>
      </header>

      {/* Banners */}
      {send.kind === "sent" && (
        <div className="bg-emerald-600/90 px-4 py-2 text-center text-sm font-medium">
          ✓ Trimis ({send.count} {send.count === 1 ? "poză" : "poze"}). Serverul le procesează.
        </div>
      )}
      {send.kind === "error" && (
        <div className="bg-rose-700/90 px-4 py-2 text-center text-sm">
          Eroare: {send.message}
        </div>
      )}

      {/* Pages */}
      <main className="flex-1 overflow-y-auto p-4">
        {images.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
            <div className="text-5xl">📄</div>
            <p className="mt-3 max-w-xs text-sm">
              Apasă <span className="font-semibold text-slate-200">Adaugă pagină</span> și
              fotografiază pe rând AWB-urile și facturile, în ordine. Serverul le grupează
              automat.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {images.map((img, idx) => (
              <li
                key={img.id}
                className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800"
              >
                <img
                  src={img.previewUrl}
                  alt={`Pagina ${idx + 1}`}
                  className="h-36 w-full object-cover"
                />
                <span className="absolute left-1.5 top-1.5 rounded-md bg-slate-900/80 px-2 py-0.5 text-xs font-semibold">
                  {idx + 1}
                </span>
                <button
                  onClick={() => removeImage(img.id)}
                  className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-rose-600/90 text-sm font-bold active:scale-95"
                  aria-label="Șterge pagina"
                >
                  ✕
                </button>
                <div className="flex border-t border-slate-700">
                  <button
                    onClick={() => move(img.id, -1)}
                    disabled={idx === 0}
                    className="flex-1 py-1.5 text-sm text-slate-300 disabled:opacity-30 active:bg-slate-700"
                    aria-label="Mută înainte"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(img.id, 1)}
                    disabled={idx === images.length - 1}
                    className="flex-1 border-l border-slate-700 py-1.5 text-sm text-slate-300 disabled:opacity-30 active:bg-slate-700"
                    aria-label="Mută înapoi"
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>

      {/* Hidden web file input (native uses the Camera plugin instead) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          onFilesPicked(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Action bar */}
      <footer
        className="border-t border-slate-700 bg-slate-900 p-3"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <div className="flex gap-3">
          <button
            onClick={onAddPage}
            disabled={sending}
            className="flex-1 rounded-xl bg-slate-700 py-3 text-sm font-semibold active:scale-[0.99] disabled:opacity-50"
          >
            📷 Adaugă pagină
          </button>
          <button
            onClick={onSend}
            disabled={images.length < 2 || sending}
            className="flex-1 rounded-xl bg-emerald-600 py-3 text-sm font-semibold active:scale-[0.99] disabled:opacity-40"
          >
            {sending ? "Se trimite..." : `Trimite (${images.length})`}
          </button>
        </div>
        {images.length === 1 && (
          <p className="mt-2 text-center text-xs text-slate-400">
            Mai adaugă cel puțin o pagină (un AWB și o factură).
          </p>
        )}
      </footer>
    </div>
  );
}

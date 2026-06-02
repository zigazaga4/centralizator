import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Tauri 2 exposes the host via env vars during dev so the WebView can
// reach the Vite server. We honor those exactly to avoid CORS quirks.
const host = process.env.TAURI_DEV_HOST;

// The Fastify server writes its chosen port here at boot. We read it on
// every API request (via the proxy's `router` callback) so the start
// order between the server and Vite is irrelevant and server restarts
// on different ports are picked up live.
const PORT_FILE = resolve(__dirname, "../.api-port");
const FALLBACK_API_PORT = 3000;

function readApiPort(): number {
  if (!existsSync(PORT_FILE)) return FALLBACK_API_PORT;
  const raw = readFileSync(PORT_FILE, "utf8").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : FALLBACK_API_PORT;
}

export default defineConfig({
  plugins: [react(), tailwind()],
  clearScreen: false,
  server: {
    host: host || false,
    port: 5173,
    strictPort: true,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${FALLBACK_API_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        // `router` is consulted per-request, so we get the freshest port
        // from .api-port without restarting Vite.
        router: () => `http://127.0.0.1:${readApiPort()}`,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});

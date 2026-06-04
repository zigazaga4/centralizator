/**
 * Fastify entry — boots the server, registers CORS for the Tauri WebView,
 * and mounts the extract/price routes.
 *
 * Port discovery:
 *   - If $PORT is set, we bind that exact port (and fail loud if it's taken
 *     — the operator clearly wanted that port).
 *   - Otherwise we scan 3000..3099 for the first free TCP port and bind it.
 *   - The chosen port is written to <repo-root>/.api-port so Vite's proxy
 *     (and any other client) can discover it without env coordination.
 */

import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import extractRoutes from "./routes/extract.js";
import pairRoutes from "./routes/pairs.js";
import verifyRoutes from "./routes/verify.js";
import scanBatchRoutes from "./routes/scan-batch.js";
import { closeDb } from "./db.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT_SCAN_START = 3000;
const PORT_SCAN_END = 3099;
// <repo>/server/src/index.ts → up 3 → <repo>
const PORT_FILE = resolve(import.meta.dirname, "../../.api-port");

const app = Fastify({
  logger: { transport: { target: "pino-pretty" } },
  bodyLimit: 25 * 1024 * 1024, // 25 MB headroom for high-DPI invoice scans
});

/**
 * CORS — must allow every HTTP verb the pair queue uses, not just
 * GET/POST. The WebView fires a preflight OPTIONS for any non-simple
 * request (PUT, DELETE, requests with custom headers like x-api-key),
 * and if the verb isn't in `Access-Control-Allow-Methods` the browser
 * BLOCKS the actual request and `fetch` throws "Load failed" — silently
 * losing every persisted status transition and every pair deletion.
 *
 * Endpoints in play:
 *   GET    /pairs                (list)
 *   POST   /pairs                (insertPair)
 *   PUT    /pairs/:id/status     (persistPairStatus)   ← was blocked
 *   DELETE /pairs/:id            (deletePair)          ← was blocked
 *   DELETE /pairs                (deleteAllPairs)      ← was blocked
 *   POST   /extract-and-price    (vision OCR)
 *   POST   /price                (reprice)
 *   GET    /health               (liveness probe)
 *
 * PATCH is included for forward compatibility — cheap, and Fastify
 * doesn't echo verbs that no route handles, so it costs nothing.
 */
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

await app.register(multipart, {
  // `files` must cover the phone scan-batch (a whole day's stack), not
  // just a single 1-AWB-plus-a-few-invoices pair. fileSize stays per-file.
  limits: { fileSize: 20 * 1024 * 1024, files: 60 },
});

/**
 * Shared-secret gate. Every route requires the secret EXCEPT:
 *   - any OPTIONS request (CORS preflight — browsers send it without headers)
 *   - GET /health (so monitors and proxies can probe liveness unauthenticated)
 *
 * The secret arrives via `x-api-key: <key>` OR `Authorization: Bearer <key>`.
 * Comparison is constant-time: we pad the candidate to the secret's length so
 * timingSafeEqual gets equal-length buffers, and we still run the compare on
 * mismatched lengths so a wrong-length key takes the same time as a right-
 * length-wrong-value key. No early returns leak information about which arm
 * of the check failed.
 *
 * If CENTRALIZATOR_API_KEY is unset we log a loud warning ONCE at boot and
 * let every request through — that's the dev-loop escape hatch so a fresh
 * clone doesn't lock you out.
 */
const apiKeyRaw = process.env.CENTRALIZATOR_API_KEY?.trim();
const apiKeyBuf = apiKeyRaw ? Buffer.from(apiKeyRaw, "utf8") : null;

if (!apiKeyBuf) {
  app.log.warn(
    "CENTRALIZATOR_API_KEY is unset — server is running OPEN. " +
      "Set CENTRALIZATOR_API_KEY in .env to lock down every non-health route.",
  );
}

function extractClientKey(req: { headers: Record<string, unknown> }): string | null {
  const x = req.headers["x-api-key"];
  if (typeof x === "string" && x.length > 0) return x;
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m?.[1]?.trim();
    if (token) return token;
  }
  return null;
}

app.addHook("onRequest", async (req, reply) => {
  // CORS preflight — never carries credentials, must always be allowed.
  if (req.method === "OPTIONS") return;
  // Liveness probe stays open so monitors and reverse proxies keep working.
  if (req.method === "GET" && req.url.split("?")[0] === "/health") return;
  // Dev-loop escape hatch — no secret configured, no gate.
  if (!apiKeyBuf) return;

  const candidate = extractClientKey(req);
  const candidateBuf = candidate ? Buffer.from(candidate, "utf8") : Buffer.alloc(0);

  // Pad to the secret's length so timingSafeEqual sees equal-length inputs;
  // track the length mismatch separately so we still reject it.
  const padded = Buffer.alloc(apiKeyBuf.length);
  candidateBuf.copy(padded, 0, 0, Math.min(candidateBuf.length, apiKeyBuf.length));
  const sameLength = candidateBuf.length === apiKeyBuf.length;
  const sameBytes = timingSafeEqual(padded, apiKeyBuf);

  if (!sameLength || !sameBytes) {
    reply.code(401).send({ error: "Unauthorized." });
    return reply;
  }
});

app.get("/health", async () => ({
  ok: true,
  model: process.env.OPENROUTER_MODEL ?? "google/gemini-3.5-flash",
}));

await app.register(extractRoutes);
await app.register(pairRoutes);
await app.register(verifyRoutes);
await app.register(scanBatchRoutes);

/**
 * Race-free port probe — open a throw-away TCP server on the candidate
 * port; if it binds, the port is free RIGHT NOW. There is still a sliver
 * of race window between this probe and the real listen() below, which
 * is why the surrounding loop retries on EADDRINUSE.
 */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const probe = net.createServer();
    probe.once("error", () => res(false));
    probe.once("listening", () => probe.close(() => res(true)));
    probe.listen(port, host);
  });
}

async function listenWithDiscovery(
  server: FastifyInstance,
  host: string,
): Promise<number> {
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;

  // If $PORT is set AND free, honour it. If it's set but busy, log a hint
  // and fall through to the discovery scan — the operator clearly wants the
  // server to come up; refusing to start would be hostile.
  if (envPort !== undefined && Number.isFinite(envPort)) {
    if (await isPortFree(envPort, host)) {
      try {
        await server.listen({ port: envPort, host });
        return envPort;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      }
    }
    server.log.warn(`$PORT=${envPort} is busy — falling back to auto-discovery (${PORT_SCAN_START}..${PORT_SCAN_END}).`);
  }

  for (let p = PORT_SCAN_START; p <= PORT_SCAN_END; p++) {
    if (!(await isPortFree(p, host))) continue;
    try {
      await server.listen({ port: p, host });
      return p;
    } catch (err) {
      // Lost the micro-race against another process; move on.
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw new Error(`No free port in ${PORT_SCAN_START}..${PORT_SCAN_END}`);
}

function writePortFile(port: number) {
  mkdirSync(dirname(PORT_FILE), { recursive: true });
  writeFileSync(PORT_FILE, String(port), "utf8");
}

function clearPortFile() {
  try { unlinkSync(PORT_FILE); } catch { /* missing is fine */ }
}

// Drop the port file on any clean shutdown so Vite never proxies to a
// dead listener after we exit.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    clearPortFile();
    // Close the Fastify server first (drains in-flight requests),
    // then checkpoint + close the SQLite handle so WAL is flushed.
    app.close().finally(() => {
      try { closeDb(); } catch { /* already closed is fine */ }
      process.exit(0);
    });
  });
}
process.once("exit", clearPortFile);

try {
  const port = await listenWithDiscovery(app, HOST);
  writePortFile(port);
  app.log.info(`Centralizator server ready on http://${HOST}:${port}`);
  app.log.info(`Discovery file: ${PORT_FILE}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

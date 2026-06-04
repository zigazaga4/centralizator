/**
 * GET /events — Server-Sent Events stream of pair lifecycle changes.
 *
 * The desktop app opens this once and keeps it open. Every time a pair is
 * created, re-priced, or deleted — whether by the desktop itself, a phone
 * scan batch, or any future client — the change is pushed down this stream
 * so the queue updates LIVE, no polling, no manual refresh.
 *
 * Why SSE (not WebSocket): the traffic is strictly one-way (server → client),
 * SSE rides plain HTTP/1.1 so it sails through the same reverse proxy and
 * auth hook as every other route, and the browser/WebView reconnect story is
 * trivial. We don't need bidirectional frames; the client mutates via the
 * existing REST endpoints.
 *
 * Auth: this route is NOT exempt from the shared-secret hook. The desktop
 * client sends `x-api-key` on the fetch that opens the stream (it uses a
 * streaming `fetch`, not the header-less `EventSource`), so the same gate
 * that protects /pairs protects the live feed — no key in the query string,
 * nothing to leak in proxy logs.
 *
 * Framing: standard `data: <json>\n\n` per event, plus a `: ping` comment
 * every 25 s. The heartbeat keeps idle intermediaries (nginx, Cloudflare)
 * from culling a quiet connection, and lets the client notice a dead socket
 * promptly. `X-Accel-Buffering: no` tells nginx not to buffer the stream.
 */

import type { FastifyInstance } from "fastify";
import { subscribePairEvents, type PairEvent } from "../events.js";

/** Heartbeat cadence. Comfortably under the 30–60 s idle timeout common to
 *  reverse proxies, so a silent queue never looks like a dead connection. */
const HEARTBEAT_MS = 25_000;

export default async function eventRoutes(app: FastifyInstance) {
  app.get("/events", (req, reply) => {
    // Take ownership of the raw socket — Fastify will not try to serialise
    // or end the response; we own the lifecycle from here.
    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy/WebView response buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    });
    // An initial comment flushes headers and opens the stream right away.
    res.write(": connected\n\n");

    const send = (event: PairEvent) => {
      // One write per event. If the socket is backed up or gone, `write`
      // throwing must not crash the server — swallow and let the close
      // handler clean up.
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        cleanup();
      }
    };

    const unsubscribe = subscribePairEvents(send);

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);
    // Don't let the heartbeat timer hold the process open on shutdown.
    heartbeat.unref?.();

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* already torn down */
      }
    }

    // Client navigated away / app closed / network dropped.
    req.raw.on("close", cleanup);
    req.raw.on("error", cleanup);

    app.log.info("events: client subscribed to live pair stream");
  });
}

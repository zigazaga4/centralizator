import type { ExtractResponse, PricingBreakdown, PricingRequest } from "../types";

/**
 * In dev, Vite proxies /api/* to the Fastify server on localhost:3000.
 * In a packaged Tauri build we'll point this at the deployed server URL
 * via VITE_API_BASE. Default to "/api" so dev works out of the box.
 */
const BASE = import.meta.env.VITE_API_BASE ?? "/api";

/**
 * Shared API key — sent on every request as `x-api-key`. Baked into
 * the bundle at build time from `VITE_CENTRALIZATOR_API_KEY`. The
 * server's `/health` endpoint is the only one exempt from this check;
 * everything else returns 401 without a valid header. When the var
 * is unset (local dev against an unsecured server) we omit the
 * header and the server's `registerAuth` falls through to its
 * open-mode warning.
 */
const API_KEY = import.meta.env.VITE_CENTRALIZATOR_API_KEY as string | undefined;
function authHeaders(): Record<string, string> {
  return API_KEY ? { "x-api-key": API_KEY } : {};
}

/**
 * Send both images in one multipart request under a generic `images`
 * field. The server hands them to the vision model unlabelled — the
 * model decides which one is the AWB and which is the invoice based on
 * visible content.
 */
export async function extractAndPrice(images: File[]): Promise<ExtractResponse> {
  if (images.length < 2) {
    throw new Error("extractAndPrice needs exactly two images.");
  }
  const form = new FormData();
  for (const img of images.slice(0, 2)) form.append("images", img);
  // Don't set Content-Type — the browser must compute the multipart
  // boundary itself. Auth header rides alongside.
  const res = await fetch(`${BASE}/extract-and-price`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`extract-and-price failed (${res.status}): ${body}`);
  }
  return res.json();
}

export async function reprice(req: PricingRequest): Promise<PricingBreakdown> {
  const res = await fetch(`${BASE}/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`price failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { breakdown: PricingBreakdown };
  return data.breakdown;
}

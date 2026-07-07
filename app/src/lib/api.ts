import type { CompareReport, CustomCollaborator, Extracted, ExtractResponse, Pair, PairSuggestion, PricingBreakdown, PricingRequest, Verification } from "../types";
import { wirePairToClient, type WirePair } from "./db";

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
 * Send N images (1 AWB + 1..N invoices) in one multipart request
 * under a generic `images` field. The server hands them to the vision
 * model unlabelled — the model decides which one is the AWB; all
 * others are invoices, in the order they appeared in the form.
 */
export async function extractAndPrice(images: File[]): Promise<ExtractResponse> {
  if (images.length < 1) {
    throw new Error("extractAndPrice needs at least one image.");
  }
  const form = new FormData();
  for (const img of images) form.append("images", img);
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

/**
 * THE single ingestion flow — desktop and phone alike. Uploads any
 * number of photos to /scan-batch, where the server dedups them,
 * classifies each one (AWB / invoice / combined / junk), links them
 * into shipments by recipient name or address, prices every pair and
 * surfaces the leftovers as unpaired rows. Results stream back into
 * the app live (SSE) — this call only confirms the upload was accepted.
 */
export async function scanBatch(
  images: File[],
  day: string,
  collaborator: string | null = null,
): Promise<{ batchId: string; imageCount: number }> {
  if (images.length < 1) throw new Error("scanBatch needs at least one image.");
  const form = new FormData();
  // The day tab the user is looking at — the server files the resulting
  // pairs under it (the phone omits this and gets "today").
  form.append("day", day);
  // The collaborator picked in the upload modal — every pair this batch
  // produces is stamped with it server-side (omitted = direct).
  if (collaborator) form.append("collaborator", collaborator);
  for (const img of images) form.append("files", img);
  const res = await fetch(`${BASE}/scan-batch`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`scan-batch failed (${res.status}): ${body}`);
  }
  return res.json();
}

/**
 * Ask the AI to propose pairings over the day's unpaired documents.
 * Sends the orphan-row ids; the SERVER pulls the photos from its own DB
 * (no image bytes ride this request) and ships them all to the model in
 * one call. Pure read — nothing is created until the operator approves
 * the groups and sends them to OCR through the manual-pairing flow.
 */
export async function suggestPairs(ids: string[]): Promise<PairSuggestion[]> {
  if (ids.length < 2) throw new Error("suggestPairs needs at least two documents.");
  const res = await fetch(`${BASE}/pairs/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new Error(msg ?? `pairs/suggest failed (${res.status})`);
  }
  const data = (await res.json()) as { suggestions: PairSuggestion[] };
  return data.suggestions;
}

/**
 * Pull one wrongly-matched invoice out of a ready pair. The invoice becomes
 * its own "unpaired" document (so the operator can re-pair or delete it) and
 * the source pair is re-priced + re-verified server-side without it. Returns
 * both the updated source pair and the new unpaired document, already in the
 * client `Pair` shape so the caller can apply them to the queue immediately
 * (the SSE feed echoes the same changes to every other client).
 */
export async function detachInvoice(
  pairId: string,
  invoiceIndex: number,
): Promise<{ pair: Pair; unpaired: Pair }> {
  const res = await fetch(`${BASE}/pairs/${encodeURIComponent(pairId)}/detach-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ invoiceIndex }),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg ?? `detach-invoice failed (${res.status})`);
  }
  const data = (await res.json()) as { pair: WirePair; unpaired: WirePair };
  return { pair: wirePairToClient(data.pair), unpaired: wirePairToClient(data.unpaired) };
}

/**
 * Dismantle a whole pair: every document (the AWB and each invoice) goes back
 * to "documente fără pereche" as its own row, and the pair is deleted. Fired
 * when the operator removes the LAST invoice from a pair. Returns the new
 * unpaired documents so the caller can drop the pair and add them at once.
 */
export async function dismantlePair(pairId: string): Promise<{ unpaired: Pair[] }> {
  const res = await fetch(`${BASE}/pairs/${encodeURIComponent(pairId)}/dismantle`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg ?? `dismantle failed (${res.status})`);
  }
  const data = (await res.json()) as { unpaired: WirePair[] };
  return { unpaired: data.unpaired.map(wirePairToClient) };
}

/**
 * Attach one or more unpaired documents to an EXISTING pair. Their photos are
 * appended to the pair as extra invoices, the whole pair is re-read + re-priced
 * server-side, and the orphan rows are removed. Returns the updated pair and the
 * ids that were consumed so the caller can apply both at once.
 */
export async function attachToPair(
  pairId: string,
  sourceIds: string[],
): Promise<{ pair: Pair; removed: string[] }> {
  const res = await fetch(`${BASE}/pairs/${encodeURIComponent(pairId)}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ sourceIds }),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg ?? `attach failed (${res.status})`);
  }
  const data = (await res.json()) as { pair: WirePair; removed: string[] };
  return { pair: wirePairToClient(data.pair), removed: data.removed };
}

/**
 * Re-run the AI pairing over ALL of a day's unpaired documents. The server
 * re-reads each one and runs them back through the same pairing pipeline a
 * phone scan uses; documents that now pair up become real pairs, the rest come
 * back as unpaired. Fire-and-forget on the server (202) — results stream in
 * over the live feed. Returns how many documents were re-submitted.
 */
export async function retryUnpaired(day: string): Promise<{ count: number }> {
  const res = await fetch(`${BASE}/pairs/retry-unpaired`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ day }),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg ?? `retry-unpaired failed (${res.status})`);
  }
  const data = (await res.json()) as { count: number };
  return { count: data.count };
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

/**
 * Per-day weekend override.
 *
 * `getWeekendDays` returns every filing day (ISO) the operator has marked
 * as a weekend, so the desktop can light up the toggle and enforce the
 * surcharge on pairs as they land. `setWeekendDay` marks (or clears) one
 * day; the server persists it and prices new scans on that day with the
 * +11,90 surcharge automatically.
 *
 * `getWeekendDays` tolerates an older server that predates the endpoint:
 * it returns [] on a 404 so the app keeps working until the server is
 * updated.
 */
export async function getWeekendDays(): Promise<string[]> {
  const res = await fetch(`${BASE}/pairs/weekend-days`, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`weekend-days failed (${res.status})`);
  const data = (await res.json()) as { days?: string[] };
  return data.days ?? [];
}

export async function setWeekendDay(day: string, force: boolean): Promise<void> {
  const res = await fetch(`${BASE}/pairs/day/${encodeURIComponent(day)}/weekend`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ force }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`set weekend day failed (${res.status}): ${body}`);
  }
}

/* ── User-created collaborators (Constanța-only today) ───────────────── */

/** The operator's runtime-added collaborators (the built-in roster is static
 *  in types.ts and NOT returned here). */
export async function listCollaborators(): Promise<CustomCollaborator[]> {
  const res = await fetch(`${BASE}/collaborators`, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list collaborators failed (${res.status})`);
  const data = (await res.json()) as { collaborators?: CustomCollaborator[] };
  return data.collaborators ?? [];
}

/** Create a new collaborator from an operator-typed name (Constanța-only). */
export async function createCollaborator(
  label: string,
  city = "Constanta",
): Promise<CustomCollaborator> {
  const res = await fetch(`${BASE}/collaborators`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ label, city }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`create collaborator failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { collaborator: CustomCollaborator };
  return data.collaborator;
}

/** Remove a user-created collaborator by key. */
export async function deleteCollaborator(key: string): Promise<void> {
  const res = await fetch(`${BASE}/collaborators/${encodeURIComponent(key)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`delete collaborator failed (${res.status}): ${body}`);
  }
}

/**
 * Cross-check a pair's invoice products against leroymerlin.ro. Called
 * after a pair goes "ready"; the returned verification is merged into
 * the pair's status and persisted so the warning icon survives reloads.
 * Slower than pricing (search + scrape), but cached server-side so
 * repeat product codes are instant.
 */
/**
 * Upload the courier's master export (.xlsx) and get back a field-by-field
 * comparison against the app's ready pairs, joined on AWB number. Read-only —
 * the server persists nothing. The whole sheet rides as one multipart file.
 */
export async function compareExcel(file: File): Promise<CompareReport> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/compare-excel`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`compare-excel failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { report: CompareReport };
  return data.report;
}

/**
 * Fetch the routed-road map image (origin store → delivery point) for one
 * pair. The server draws it via Mapbox's Static Images API and proxies the
 * bytes, so no map token ships in this bundle. Returns a Blob ready for
 * `URL.createObjectURL`; throws with the server's Romanian error message
 * when the route can't be drawn (no store, address not found, …).
 */
export async function fetchRouteMap(pairId: string): Promise<Blob> {
  const res = await fetch(`${BASE}/pairs/${encodeURIComponent(pairId)}/route-map`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    let msg: string | null = null;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? null;
    } catch {
      /* non-JSON error body — fall through to the generic message */
    }
    throw new Error(msg ?? `route-map failed (${res.status})`);
  }
  return await res.blob();
}

export async function verifyProducts(extracted: Extracted): Promise<Verification> {
  const res = await fetch(`${BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ extracted }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`verify failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { verification: Verification };
  return data.verification;
}

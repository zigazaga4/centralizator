/**
 * Shared scan-batch client.
 *
 * Lives outside any single app so the phone scanner uses the exact same
 * contract the server speaks, and a future desktop or web client can
 * import the same function instead of re-implementing the upload. The
 * config (base URL + optional api key) is injected by the caller, so this
 * module stays free of any framework or env coupling.
 */

export interface ApiConfig {
  /** Server origin, no trailing slash, e.g. "https://api.example.com" or
   *  "http://76.13.248.144:3600". */
  baseUrl: string;
  /** Shared secret sent as `x-api-key`. Omit against an open dev server. */
  apiKey?: string;
}

/** The server's 202 acknowledgement. The phone shows only that it was
 *  accepted; the actual pairs are produced in the background. */
export interface ScanBatchResponse {
  batchId: string;
  imageCount: number;
  status: string;
}

function authHeaders(cfg: ApiConfig): Record<string, string> {
  return cfg.apiKey ? { "x-api-key": cfg.apiKey } : {};
}

/** Optional batch metadata that rides the multipart upload as fields. */
export interface ScanBatchOptions {
  /** Filing day (YYYY-MM-DD). Omit → the server files under "today". */
  day?: string;
  /** Collaborator the whole batch belongs to — picked by the user in the
   *  upload flow. Every pair the batch produces is stamped with it.
   *  Omit / null = direct (no collaborator). The server validates the
   *  key against its canonical roster. */
  collaborator?: string | null;
}

/**
 * Upload an ordered stack of scanned documents in ONE multipart request.
 * The server groups them into pairs and processes each in the background,
 * so this resolves as soon as the upload is accepted (HTTP 202), not when
 * extraction finishes.
 */
export async function scanBatch(
  files: File[],
  cfg: ApiConfig,
  opts?: ScanBatchOptions,
): Promise<ScanBatchResponse> {
  if (files.length < 2) {
    throw new Error("Trimite cel puțin două poze (cel puțin un AWB și o factură).");
  }
  const form = new FormData();
  // Metadata fields first, then the photos. Field name and order are
  // preserved server-side; the grouping AI uses the scan order to bind
  // each AWB to its invoices.
  if (opts?.day) form.append("day", opts.day);
  if (opts?.collaborator) form.append("collaborator", opts.collaborator);
  for (const f of files) form.append("images", f);

  const res = await fetch(`${cfg.baseUrl}/scan-batch`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`scan-batch failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<ScanBatchResponse>;
}

/** Liveness probe — used to show a connection status dot on the phone. */
export async function health(cfg: ApiConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Thin env wrapper around the shared scan-batch client. The shared module
 * (../../shared/scan.ts) holds the actual contract; here we only bind it
 * to this app's build-time config.
 */
import {
  scanBatch as sharedScanBatch,
  health as sharedHealth,
  type ApiConfig,
  type ScanBatchResponse,
} from "@shared/scan";

const cfg: ApiConfig = {
  baseUrl: (import.meta.env.VITE_API_BASE ?? "http://localhost:3600").replace(/\/+$/, ""),
  apiKey: import.meta.env.VITE_CENTRALIZATOR_API_KEY,
};

export function scanBatch(
  files: File[],
  collaborator?: string | null,
): Promise<ScanBatchResponse> {
  return sharedScanBatch(files, cfg, { collaborator });
}

export function health(): Promise<boolean> {
  return sharedHealth(cfg);
}

export type { ScanBatchResponse };

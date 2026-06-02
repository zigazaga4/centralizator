/**
 * Mirrors the server's response shapes. We keep the contract here in the
 * client so the UI compiles independently of the server build; any drift
 * between the two surfaces at code review (matching field names) or at
 * runtime (the server's Zod schema rejects bad shapes).
 */

export type Service = "Express" | "Premium" | "Prestabilita";
export type WeightBucket =
  | "0-200kg" | "200-500kg" | "500-800kg" | "800-1200kg" | ">1200kg";
export type DistanceBucket =
  | "0-15 km" | "15-20 km" | "20-30 km" | "30-50 km" | ">50 km";

export interface InvoiceItem {
  name: string;
  ean?: string | null;
  reference?: string | null;
  unit?: string | null;
  quantity: number;
  unit_price_net: number;
  value_net: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
}

export interface Extracted {
  awb_number: string;
  delivery_date: string;
  service_text: string;
  shipment_type?: string | null;
  weight_kg: number;
  distance_extra_km: number;
  num_deliveries: number;
  content_code?: string | null;
  hub_destination?: string | null;
  sender_name?: string | null;
  sender_phone?: string | null;
  sender_address?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  recipient_address?: string | null;

  invoice_number: string;
  invoice_date: string;
  invoice_is_duplicate?: boolean;
  supplier_name?: string | null;
  supplier_cui?: string | null;
  buyer_name?: string | null;
  buyer_cui?: string | null;
  order_number?: string | null;
  items: InvoiceItem[];
  invoice_total_net?: number | null;
  invoice_total_vat?: number | null;
  invoice_total_gross?: number | null;
}

export interface PricingBreakdown {
  weightBucket: WeightBucket;
  distanceBucket: DistanceBucket;
  baseKey: string;
  incrementKey: string;
  extraKm: number;
  weekend: boolean;
  baseTariff: number;
  extraKmCost: number;
  incrementTariff: number;
  incrementCost: number;
  weekendSurcharge: number;
  totalVat19: number;
  net: number;
  vat21: number;
  /**
   * Carrier subtotal — what Stalexone (the carrier) gets, gross of
   * VAT @ 21%. Used to be the billable line; now it's the carrier's
   * cut and the UI labels it "Tarif transportator".
   */
  totalVat21: number;
  /** Ploiești commission rate, currently 0.501 (50.1 %). */
  commissionPct: number;
  /** Ploiești commission, in RON. */
  commission: number;
  /**
   * What the END customer pays. This is now the billable bottom
   * line — `totalVat21 + commission`. Surfaced in the UI as
   * "Total client" / "De plătit"; replaces every prior use of
   * `totalVat21` as the customer-facing total.
   */
  customerTotal: number;
}

export interface ExtractResponse {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
}

export interface PricingRequest {
  service: Service;
  weight_kg: number;
  distance_km: number;
  num_deliveries: number;
  delivery_date: string;
}

/* ──────────────────────────────────────────────────────────────────────
 * Queue model — one entry per (AWB + Factură) pair.
 *
 * The user assembles the queue first (drop pairs one at a time, or many
 * at once), then triggers extraction for all of them in parallel. Each
 * pair carries its own life-cycle independently:
 *
 *   pending → extracting → ready
 *                         ↘ error
 *
 * "ready" pairs hold both the server's authoritative breakdown AND a
 * local `edits` mirror so the user can hand-correct anything OCR got
 * wrong; the pricing engine re-runs server-side on debounce, per-row.
 * ────────────────────────────────────────────────────────────────────── */

export type PairStatus =
  | { kind: "pending" }
  | { kind: "extracting" }
  | {
      kind: "ready";
      service: Service;
      serviceFallback: boolean;
      edits: Extracted;
      breakdown: PricingBreakdown;
    }
  | { kind: "error"; message: string };

export interface Pair {
  /** Stable id — survives re-renders, re-orders, and removals. */
  id: string;
  /**
   * Filing day in local-TZ ISO form (`YYYY-MM-DD`). The user organises
   * the queue by day — one tab per day, like an Excel workbook — so
   * Monday's paperwork lives in one bucket and Tuesday's in another.
   *
   * Defaults to whatever day the user is viewing when they drop the
   * images. NOT to be confused with `Extracted.delivery_date`, which
   * is the *courier's* delivery date as read off the AWB — the two
   * frequently match but are conceptually independent (you might be
   * filing yesterday's paperwork today).
   */
  day: string;
  /** Exactly two images, in submit order. The vision model decides AWB vs invoice. */
  images: File[];
  status: PairStatus;
}

export type PairPatch = {
  service?: Service;
  weight_kg?: number;
  distance_extra_km?: number;
  num_deliveries?: number;
  delivery_date?: string;
};

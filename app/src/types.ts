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

/* ──────────────────────────────────────────────────────────────────────
 * City + collaborator keys
 *
 * The pricing engine returns commissions for FOUR dispatch sites
 * (Ploiești, two Iași sites, Constanța) and bonuses for FIVE
 * collaborators. The user-facing city dropdown has only THREE options
 * though — Iași is a single choice that fans out into both Iași dispatch
 * sites at render time. Keeping these two key sets separate (CityKey vs
 * CityCommissionKey) makes the asymmetry explicit; the UI always picks
 * one of three, the data always carries four.
 * ────────────────────────────────────────────────────────────────────── */

/** Dropdown choices — what the user picks. Three options. */
export type CityKey = "Ploiesti" | "Iasi" | "Constanta";

/** Data-side keys — what the server actually keys its commission map on.
 *  Four entries because Iași splits into Tudor + ERA dispatch sites. */
export type CityCommissionKey = "Ploiesti" | "IasiTudor" | "IasiERA" | "Constanta";

/** The five courier-collaborator partners. Each runs their own bonus
 *  schedule on top of the carrier subtotal. */
export type CollaboratorKey =
  | "Stalexone"
  | "EMV"
  | "Bitlo"
  | "VicDinamicExpert"
  | "Tiberiu";

/** Romanian display label for each dropdown city. */
export const CITY_LABEL: Record<CityKey, string> = {
  Ploiesti: "Ploiești",
  Iasi: "Iași",
  Constanta: "Constanța",
};

/** Romanian display label for each dispatch-site key (4-way breakdown). */
export const CITY_COMMISSION_LABEL: Record<CityCommissionKey, string> = {
  Ploiesti: "Ploiești",
  IasiTudor: "Iași Tudor",
  IasiERA: "Iași ERA",
  Constanta: "Constanța",
};

/** "<Company> (<person>)" label per collaborator — the contact-name
 *  cue helps the user recognise the partner at a glance from the
 *  dropdown. Display only; the data key stays the company name. */
export const COLLABORATOR_LABEL: Record<CollaboratorKey, string> = {
  Stalexone: "Stalexone (Ștefan)",
  EMV: "EMV (Escariu)",
  Bitlo: "Bitlo (George)",
  VicDinamicExpert: "Vic Dinamic Expert (Bogdan)",
  Tiberiu: "Tiberiu (Dube)",
};

/** Compact label used in tight spaces (PairsTable column header,
 *  PDF/XLSX/DOCX header rows). Drops the contact-name parenthetical
 *  and abbreviates "Vic Dinamic Expert" → "Vic Dinamic" so the column
 *  stays narrow without truncation. */
export const COLLABORATOR_SHORT_LABEL: Record<CollaboratorKey, string> = {
  Stalexone: "Stalexone",
  EMV: "EMV",
  Bitlo: "Bitlo",
  VicDinamicExpert: "Vic Dinamic",
  Tiberiu: "Tiberiu",
};

/**
 * Per-city collaborator roster.
 *
 * Source: `PRETURI COLABORATORI.ods` — col 2 = Ploiești, col 3 =
 * Iași Tudor, col 4 = Iași ERA, col 5 = Constanța. The ODS lists
 * collaborators in each city's column; we read them off directly:
 *
 *   • Ploiești: Stalexone (Ștefan) 25 %, Vic Dinamic Expert (Bogdan) 25 %,
 *     Tiberiu (Dube) 29 %. (The "Macara Ploiești · scădem lunar 2000 LEI"
 *     line is a monthly flat adjustment, not a per-row collaborator, so
 *     it's NOT in the dropdown.)
 *   • Iași: EMV (Escariu) 30.1 % serves Iași Tudor, Bitlo (George) 12 %
 *     serves Iași ERA. The city dropdown unifies Iași as one option, so
 *     both partners are listed; the user picks whichever the row was
 *     dispatched through.
 *   • Constanța: no per-row collaborator. Empty list — the dropdown
 *     shows "Direct (fără colaborator)" and the Plată-colab. column
 *     drops to "—".
 *
 * Iași Tudor's EMV-Macara and Iași ERA's EMV-Macara are *macara* (crane)
 * variants paid at PREȚ ÎNTREG (full price, no bonus), which is identical
 * to the carrier subtotal — they're a no-op pricing-wise and so the
 * dropdown skips them.
 */
export const COLLABORATORS_BY_CITY: Record<CityKey, readonly CollaboratorKey[]> = {
  Ploiesti: ["Stalexone", "VicDinamicExpert", "Tiberiu"],
  Iasi: ["EMV", "Bitlo"],
  Constanta: [],
};

/**
 * First collaborator for a city — the default selection when the
 * user changes city. Returns `null` for Constanța (no roster), in
 * which case the UI surfaces "direct, no collaborator" everywhere.
 */
export function defaultCollaboratorFor(city: CityKey): CollaboratorKey | null {
  return COLLABORATORS_BY_CITY[city][0] ?? null;
}

/**
 * Whether the currently-selected collaborator is still valid for the
 * picked city. Used by App.tsx to auto-correct the selection when the
 * user switches city (e.g. picking Iași while Stalexone — a Ploiești
 * partner — is selected forces a reset to EMV).
 */
export function isCollaboratorValidForCity(
  collaborator: CollaboratorKey | null,
  city: CityKey,
): boolean {
  if (collaborator === null) return COLLABORATORS_BY_CITY[city].length === 0;
  return (COLLABORATORS_BY_CITY[city] as readonly CollaboratorKey[]).includes(collaborator);
}

/** Ordered city options for the dropdown. */
export const CITY_KEYS: readonly CityKey[] = ["Ploiesti", "Iasi", "Constanta"];

/** Ordered dispatch-site keys, used by full-breakdown views (PairDetail
 *  + exports). */
export const CITY_COMMISSION_KEYS: readonly CityCommissionKey[] = [
  "Ploiesti",
  "IasiTudor",
  "IasiERA",
  "Constanta",
];

/** Ordered collaborator options for the dropdown. */
export const COLLABORATOR_KEYS: readonly CollaboratorKey[] = [
  "Stalexone",
  "EMV",
  "Bitlo",
  "VicDinamicExpert",
  "Tiberiu",
];

/**
 * Map a user-facing city choice to the 1-or-2 dispatch-site keys that
 * should be rendered for it. Ploiești / Constanța → single entry; Iași
 * fans out into Tudor + ERA. Centralising this here keeps every
 * surface — table cell, footer sum, detail page, export — consistent.
 */
export function dispatchSitesFor(city: CityKey): CityCommissionKey[] {
  return city === "Iasi" ? ["IasiTudor", "IasiERA"] : [city];
}

/** Per-dispatch-site commission row. `pct` is the multiplier the
 *  carrier subtotal is grossed up by; `commission = totalVat21 × pct`;
 *  `customerTotal = totalVat21 × (1 + pct)`. */
export interface CityCommissionRow {
  pct: number;
  commission: number;
  customerTotal: number;
}

/** Per-collaborator bonus row. `pct` is the bonus rate, `bonus` is its
 *  RON amount, `total` is what the collaborator gets paid in total. */
export interface CollaboratorPriceRow {
  pct: number;
  bonus: number;
  total: number;
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
   * VAT @ 21%. The shared base every per-city customer total and
   * per-collaborator payout grosses up from. Surfaced in the UI as
   * "Tarif transportator".
   */
  totalVat21: number;
  /**
   * Per-dispatch-site customer totals. Four entries even though the
   * dropdown only has three — Iași splits into Tudor + ERA, which the
   * UI stacks when the user picks "Iași". Math is server-side:
   * `customerTotal = totalVat21 × (1 + pct)`.
   */
  cityCommissions: Record<CityCommissionKey, CityCommissionRow>;
  /**
   * Per-collaborator payouts. The user picks one in the header
   * dropdown and the table + detail page show that one's total.
   * Math is server-side: `total = totalVat21 × (1 + pct)`.
   */
  collaboratorPrices: Record<CollaboratorKey, CollaboratorPriceRow>;
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

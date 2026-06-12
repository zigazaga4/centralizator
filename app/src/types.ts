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
export type MacaraDistanceBucket =
  | "0-10 km" | "10-15 km" | "0-15 km" | "15-20 km" | "20-30 km" | "30-50 km" | ">50 km";

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
  /** Physical size of one unit as printed on the invoice line, e.g.
   *  "10 x 100 x 50 cm". Cross-checked against leroymerlin.ro. */
  dimensions?: string | null;
}

/* ──────────────────────────────────────────────────────────────────────
 * Product verification (Leroy Merlin cross-check). Mirrors the server's
 * VerificationSchema. The warning icon fires only on a size or weight
 * mismatch; everything else is shown in the dialog but never alarms.
 * ────────────────────────────────────────────────────────────────────── */

export type CheckStatus = "match" | "mismatch" | "unknown";

export interface ItemCheck {
  invoiceIndex: number;
  itemIndex: number;
  name: string;
  query: string | null;
  invoiceDimsMm: number[];
  quantity: number;
  unit?: string | null;
  found: boolean;
  url?: string | null;
  siteName?: string | null;
  brand?: string | null;
  priceBuc?: number | null;
  weightKg?: number | null;
  siteDimsMm: number[];
  sizeStatus: CheckStatus;
}

export interface Verification {
  checkedAt: number;
  items: ItemCheck[];
  awbWeightKg: number;
  estimatedWeightKg: number | null;
  weightCoverage: "full" | "partial" | "none";
  weightStatus: CheckStatus;
  hasWarning: boolean;
  note?: string | null;
}

/**
 * The AWB side. Every pricing-relevant field lives here — pricing.ts on
 * the server reads exclusively from this struct.
 */
export interface Awb {
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
}

/**
 * One invoice attached to a pair. Multiple invoices may share the
 * same AWB — same delivery, several billable documents.
 */
export interface Invoice {
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

/**
 * One AWB + one or more invoices. Pricing depends only on `awb`; the
 * invoices are attached billable documents the detail view lists.
 */
export interface Extracted {
  awb: Awb;
  invoices: Invoice[];
}

/* ──────────────────────────────────────────────────────────────────────
 * City + collaborator keys
 *
 * Direct port of the `PRETURI COLABORATORI.ods` sheet, one column per
 * series:
 *
 *     col 2  PLOIESTI  : LUAM 50.1%
 *     col 3  IASI      : LUAM 33.7%
 *     col 4  IASI 2    : LUAM 33.7%
 *     col 5  CONSTANTA : LUAM 33.7%
 *
 * Each column is its OWN dispatch series with its OWN collaborator
 * roster — Iași is two distinct series (not a unified dropdown that
 * stacks two sites), because EMV serves the first Iași series and
 * Bitlo serves the second. Mixing them under a single "Iași" choice
 * (the previous design) made the table show two cells per row and
 * caused the "collaborators look mixed" symptom the user reported.
 *
 * The four user-facing city options map 1-to-1 to the four data-side
 * cityCommissions keys, so the dropdown is a pure DISPLAY switch —
 * the server already calculates all four city totals and all five
 * collaborator payouts in one extract-and-price call.
 * ────────────────────────────────────────────────────────────────────── */

/** Dropdown choices = ODS columns. Four options, one per series. */
export type CityKey = "Ploiesti" | "Iasi" | "Iasi2" | "Constanta";

/** Data-side keys the server returns in `breakdown.cityCommissions`.
 *  Same cardinality as `CityKey` (4) but with the original dispatch-site
 *  names from `TARIFE MACARA` — "IasiTudor" for the first Iași series
 *  (EMV) and "IasiERA" for the second (Bitlo). Kept distinct from
 *  CityKey so the user-facing label (Iași / Iași 2) stays decoupled
 *  from the dispatch-site identifier the server emits. */
export type CityCommissionKey = "Ploiesti" | "IasiTudor" | "IasiERA" | "Constanta";

/** The five courier-collaborator partners. Each runs their own bonus
 *  schedule on top of the carrier subtotal. */
export type CollaboratorKey =
  | "Stalexone"
  | "EMV"
  | "Bitlo"
  | "VicDinamicExpert"
  | "Tiberiu";

/** Romanian display label for each dropdown city.
 *  "Iași (Tudor)" / "Iași (ERA)" carry the dispatch-site identity so
 *  the user knows which series is which without having to memorise
 *  the column ordering from the ODS. */
export const CITY_LABEL: Record<CityKey, string> = {
  Ploiesti: "Ploiești",
  Iasi: "Iași (Tudor)",
  Iasi2: "Iași (ERA)",
  Constanta: "Constanța",
};

/** Romanian display label for each dispatch-site key. Same strings as
 *  CITY_LABEL — kept as a separate constant because the data-side
 *  keys (IasiTudor/IasiERA) and the user-facing keys (Iasi/Iasi2) are
 *  different types, even though every entry resolves to the same
 *  visible label. */
export const CITY_COMMISSION_LABEL: Record<CityCommissionKey, string> = {
  Ploiesti: "Ploiești",
  IasiTudor: "Iași (Tudor)",
  IasiERA: "Iași (ERA)",
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
 * Per-series collaborator roster — column-by-column read of the ODS.
 *
 *   col 2  Ploiești   →  Stalexone (Ștefan) 25 %, Vic Dinamic Expert
 *                        (Bogdan) 25 %, Tiberiu (Dube) 29 %.
 *                        (The "Macara Ploiești · scădem lunar 2000 LEI"
 *                        entry is a monthly flat adjustment, not a
 *                        per-row collaborator — excluded from this
 *                        dropdown.)
 *   col 3  Iași        →  EMV (Escariu) 30.1 %.
 *                        (The "EMV Macara · PREȚ ÎNTREG" entry is a
 *                        no-bonus crane variant — excluded.)
 *   col 4  Iași 2      →  Bitlo (George) 12 %.
 *                        (Same "EMV Macara · PREȚ ÎNTREG" exclusion.)
 *   col 5  Constanța   →  none.  Dropdown shows "Direct (fără
 *                        colaborator)" and the Plată-colab. column
 *                        drops to "—".
 */
export const COLLABORATORS_BY_CITY: Record<CityKey, readonly CollaboratorKey[]> = {
  Ploiesti: ["Stalexone", "VicDinamicExpert", "Tiberiu"],
  Iasi: ["EMV"],
  Iasi2: ["Bitlo"],
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
 * user switches city (picking "Iași (Tudor)" while Stalexone — a
 * Ploiești partner — is selected forces a reset to EMV).
 */
export function isCollaboratorValidForCity(
  collaborator: CollaboratorKey | null,
  city: CityKey,
): boolean {
  if (collaborator === null) return COLLABORATORS_BY_CITY[city].length === 0;
  return (COLLABORATORS_BY_CITY[city] as readonly CollaboratorKey[]).includes(collaborator);
}

/** Ordered city options for the dropdown. */
export const CITY_KEYS: readonly CityKey[] = ["Ploiesti", "Iasi", "Iasi2", "Constanta"];

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
 * Map a user-facing city choice to the SINGLE dispatch-site key that
 * provides its customerTotal. 1-to-1 mapping (the old "stack two Iași
 * sites under one option" was wrong — Iași is two independent series
 * with different collaborators per the ODS).
 *
 * Centralising this here keeps every surface — table cell, footer sum,
 * detail page, export — consistent.
 */
export function dispatchSitesFor(city: CityKey): CityCommissionKey[] {
  switch (city) {
    case "Ploiesti":  return ["Ploiesti"];
    case "Iasi":      return ["IasiTudor"];
    case "Iasi2":     return ["IasiERA"];
    case "Constanta": return ["Constanta"];
  }
}

/**
 * Single-dispatch-site convenience for the common case (every CityKey
 * now maps 1:1 to one CityCommissionKey). Keeps `dispatchSitesFor` as
 * the array API for surfaces that still want a loopable shape, but
 * lets new call sites just `cityCommissions[primaryDispatchSite(city)]`
 * without an array index.
 */
export function primaryDispatchSite(city: CityKey): CityCommissionKey {
  return dispatchSitesFor(city)[0]!;
}

/** Per-dispatch-site commission row. `pct` is the multiplier the
 *  carrier subtotal is grossed up by; `commission = carrierTotal × pct`;
 *  `customerTotal = carrierTotal × (1 + pct)`. */
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

/**
 * Macara (crane delivery) breakdown — mirrors the server's MacaraBreakdown.
 * A SEPARATE track (RON cu TVA): priced off the dedicated "Tarife livrare
 * macara" table, NOT commissioned and NOT folded into any carrier/customer/
 * collaborator total. `warning` is the operator's separate alarm: macara is
 * on the invoice but the AWB does not declare it.
 */
export interface MacaraBreakdown {
  isMacara: boolean;
  onAwb: boolean;
  onInvoice: boolean;
  warning: boolean;
  pallets: number;
  /** Crane truck runs = ceil(pallets / 8); the delivery price + per-km scale
   *  by this. Optional for back-compat with breakdowns persisted earlier. */
  runs?: number;
  distanceBucket: MacaraDistanceBucket | null;
  extraKm: number;
  basePrice: number;
  /** Per-km tur-retur rate used (5 for Iași Tudor/Constanța, 4,5 for
   *  Ploiești/Iași ERA). */
  perKm: number;
  kmCost: number;
  unloadPerPallet: number;
  unloadCost: number;
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
  /** Bulky-but-light units (polistiren / vată) counted across all
   *  invoices on this AWB. Optional: breakdowns persisted before the
   *  voluminos rule don't carry it — read through `?? 0`. */
  bulkyUnits?: number;
  /** Extra truck transports forced by the bulky units: 0 below 24
   *  pieces, then one per started block of 24 (24 → 1, 25 → 2). Each
   *  extra transport bills one increment tariff plus its own round of
   *  the per-km surcharge. Optional like `bulkyUnits`. */
  bulkyTransports?: number;
  /** Standard unloading fees detected on the shipment (base count, before
   *  the >1200 kg multiplier). 0 when no unloading applies. */
  unloadingUnits: number;
  /** Total unloading fees billed (incl. the >1200 kg multiplier). */
  unloadingCount: number;
  /** Unloading tax in RON WITH VAT = unloadingCount × 210. COMPLETELY
   *  separate: not commissioned and NOT folded into any total — reported on
   *  its own and handled separately by the operator. */
  unloadingTax: number;
  /** Unloading tax WITHOUT VAT = unloadingCount × 177.69 (reference). */
  unloadingTaxNet: number;
  /**
   * Macara (crane delivery) breakdown — a SEPARATE track (RON cu TVA), not
   * commissioned and not folded into any total. Optional because pairs
   * priced before macara was added (persisted breakdowns) don't carry it;
   * always read it through `?.`. `macara.isMacara` is false for an ordinary
   * delivery.
   */
  macara?: MacaraBreakdown;
  /** Macara priced for every city, so the detail page + table can show the
   *  macara tariff per city. Optional for breakdowns persisted before this
   *  existed — read through `?.`. */
  macaraByCity?: Record<CityCommissionKey, MacaraBreakdown>;
  /**
   * Carrier subtotal — what Stalexone (the carrier) gets, RON with VAT
   * included at the current rate. The shared base every per-city
   * customer total and per-collaborator payout grosses up from.
   * Surfaced in the UI as "Tarif transportator".
   */
  carrierTotal: number;
  /**
   * All-in comparable total (cu TVA) = carrierTotal + unloadingTax +
   * macara.total. Folds the descărcare + crane tracks back in so it matches
   * the courier portal's single price line. Used by the Excel cross-check.
   * Optional so an older persisted breakdown (pre-grandTotal) still loads.
   */
  grandTotal?: number;
  /**
   * Per-dispatch-site customer totals. Four entries even though the
   * dropdown only has three — Iași splits into Tudor + ERA, which the
   * UI stacks when the user picks "Iași". Math is server-side:
   * `customerTotal = carrierTotal × (1 + pct)`.
   */
  cityCommissions: Record<CityCommissionKey, CityCommissionRow>;
  /**
   * Per-collaborator payouts. The user picks one in the header
   * dropdown and the table + detail page show that one's total.
   * Math is server-side: `total = carrierTotal × (1 + pct)`.
   */
  collaboratorPrices: Record<CollaboratorKey, CollaboratorPriceRow>;
}

/* ──────────────────────────────────────────────────────────────────────
 * Origin store + routed distance
 *
 * Every shipment leaves from ONE Leroy Merlin store, read from the AWB
 * Expeditor. That store is the centralizator the pair is filed under (the
 * top dropdown switches between them) AND the route origin for the Mapbox
 * km. `Routing` mirrors the server's schema.ts Routing.
 * ────────────────────────────────────────────────────────────────────── */

/** The dispatch-store keys = the data-side commission keys. */
export type StoreKey = CityCommissionKey;

export interface Routing {
  /** Origin store / centralizator bucket. Null when undetermined. */
  store: StoreKey | null;
  /** How the store was decided. */
  storeSource: "expeditor" | "nearest" | "none";
  /** Km the price was built from. */
  distanceKm: number;
  /** Whether `distanceKm` is a live Mapbox route or the AWB's printed km. */
  source: "mapbox" | "awb";
  /** Km printed on the AWB ('Distanță extra'), kept for reference. */
  awbKm: number;
  /** Mapbox-routed km when computed; null on any fallback. */
  mapboxKm: number | null;
  /** Signed difference (mapboxKm − awbKm) when both are known; null on
   *  any fallback. Positive ⇒ our route is longer than the AWB printed. */
  kmDiff?: number | null;
  /** True when the Mapbox-routed km differs from the AWB's printed km —
   *  surfaces in the warning component like a product discrepancy. */
  kmWarning?: boolean;
  /** Delivery address text that was geocoded. */
  deliveryAddress: string | null;
  /** Geocoded delivery point the Mapbox km was measured to (when resolved).
   *  Absent on older pairs and on geocode fallbacks. */
  destLng?: number | null;
  destLat?: number | null;
  /** True when the street wasn't found in the address's locality and the
   *  km is measured to the locality's center instead. */
  approxGeocode?: boolean;
  /** Locality/place name the geocoder actually resolved into. */
  geocodedPlace?: string | null;
  /** True only when geocode + route both succeeded. */
  resolved: boolean;
  /** Short Romanian note explaining a fallback, for the UI. */
  note: string | null;
}

export interface ExtractResponse {
  extracted: Extracted;
  resolvedService: Service;
  serviceFallback: boolean;
  breakdown: PricingBreakdown;
  /** Origin store + the routed distance the price was built from. */
  routing: Routing;
}

export interface PricingRequest {
  service: Service;
  weight_kg: number;
  distance_km: number;
  num_deliveries: number;
  delivery_date: string;
  /** Standard unloading fees on the shipment, preserved across live edits
   *  so the unloading tax survives a re-price. The >1200 kg multiplier is
   *  re-applied server-side. Optional; defaults to 0. */
  unloading_units?: number;
  /** Macara signals carried across live edits so the separate macara
   *  breakdown + warning survive a re-price. Paleți are not user-editable
   *  here, so they ride along unchanged. Optional; default "no macara". */
  macara_on_awb?: boolean;
  macara_on_invoice?: boolean;
  macara_pallets?: number;
  /** Crane truck runs (count of "LIVRARE MACARA" lines). Carried across edits
   *  so the multi-run macara price survives a re-price. */
  macara_runs?: number;
  /** Dispatch store the macara run leaves from — selects the macara rate
   *  table. Carried so a re-price keeps the right per-city macara price. */
  macara_store?: StoreKey | null;
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

/** What kind of document an unpaired row holds — drives its badge. */
export type UnpairedDocType = "awb" | "invoice" | "unknown";

/** One AI-suggested pairing over the unpaired pool (POST /pairs/suggest):
 *  the orphan-row ids of the AWB photo and its invoice photo(s), plus the
 *  printed evidence the model cited. Suggestions only — the operator
 *  rearranges them by drag-and-drop and sends them to OCR explicitly. */
export interface PairSuggestion {
  awbId: string;
  invoiceIds: string[];
  evidence: string | null;
}

export type PairStatus =
  | { kind: "pending" }
  | { kind: "extracting" }
  /** A scanned document the server could NOT pair by name/address. One
   *  image, never priced — shown in the day's "unpaired" strip until a
   *  human resolves (re-scans or deletes) it. */
  | { kind: "unpaired"; docType: UnpairedDocType }
  | {
      kind: "ready";
      service: Service;
      serviceFallback: boolean;
      edits: Extracted;
      breakdown: PricingBreakdown;
      /** Origin store = the centralizator this pair is filed under
       *  (derived from the AWB Expeditor). Null when undetermined. */
      store?: StoreKey | null;
      /** How the distance + store were resolved (Mapbox vs AWB fallback). */
      routing?: Routing;
      /** Leroy Merlin product cross-check. Arrives shortly AFTER the
       *  price (a follow-up call), so a freshly-ready pair may not have
       *  it yet. `verification.hasWarning` drives the warning icon. */
      verification?: Verification;
    }
  | { kind: "error"; message: string };

/**
 * A lazy handle to one server-stored image. The hydrate payload carries
 * only this metadata — the actual bytes stream from
 * `GET /pairs/:pairId/images/:slot` when a component first needs them
 * (and are cached in-app after that). Immutable per (pairId, slot).
 */
export interface PairImageRef {
  pairId: string;
  slot: number;
  name: string;
  mimeType: string;
  size: number;
}

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
  /** N images in submit order (one AWB + one or more invoices). The
   *  vision model decides which one is the AWB; all others are
   *  invoices, ordered as the user dropped them.
   *
   *  For pairs created on THIS device the Files are populated up
   *  front. For pairs hydrated from the server this array starts
   *  EMPTY — the bytes live behind `imageRefs` and are streamed in
   *  lazily (see lib/images.ts) so the queue paints instantly. */
  images: File[];
  /** Lazy image handles for server-hydrated pairs. Absent on pairs
   *  created locally (those already hold real Files in `images`). */
  imageRefs?: PairImageRef[];
  status: PairStatus;
}

export type PairPatch = {
  service?: Service;
  weight_kg?: number;
  distance_extra_km?: number;
  num_deliveries?: number;
  delivery_date?: string;
};

/* ──────────────────────────────────────────────────────────────────────
 * Excel cross-check (POST /compare-excel)
 *
 * Mirrors the server's `CompareReport` (server/src/compare.ts). The courier's
 * master export is joined to our ready pairs on the AWB number; each shared AWB
 * yields a per-field comparison. "alert" fields (recipient, weight, extra km)
 * flag extraction errors; the "info" field (road km) is expected to drift.
 * ────────────────────────────────────────────────────────────────────── */

export type CompareFieldStatus = "match" | "mismatch" | "missing";
export type CompareFieldSeverity = "alert" | "info";
export type ComparePresence = "both" | "excelOnly" | "appOnly";

export interface CompareField {
  key: string;
  label: string;
  excel: string | number | null;
  app: string | number | null;
  status: CompareFieldStatus;
  severity: CompareFieldSeverity;
  note?: string;
  /** Deterministic cause of the difference, rendered in parentheses. */
  reason?: string;
}

export interface CompareRow {
  awb: string;
  recipient: string | null;
  presence: ComparePresence;
  fields: CompareField[];
  hasDiscrepancy: boolean;
}

export interface CompareReport {
  generatedAt: number;
  fileName: string | null;
  summary: {
    excelRows: number;
    appPairs: number;
    matched: number;
    excelOnly: number;
    appOnly: number;
    withDiscrepancies: number;
    flagged: number;
  };
  rows: CompareRow[];
}

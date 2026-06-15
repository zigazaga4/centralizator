import {
  CITY_COMMISSION_LABEL,
  COLLABORATOR_SHORT_LABEL,
  primaryDispatchSite,
  type CityKey,
  type CityCommissionKey,
  type CollaboratorKey,
  type Pair,
} from "../types";
import { date as fmtDate, ron as fmtRon } from "./format";

/* Type-only handle on docx's TableCell so we can annotate the local
 * cell-builder helper. The runtime `TableCell` binding comes from a
 * dynamic `import("docx")` inside exportToDocx so the library still
 * doesn't load until the user actually picks the format. */
import type { TableCell as DocxTableCell } from "docx";

/* Type-only handle on jspdf-autotable's Styles shape so the per-column
 * style map below carries proper literal types (e.g. `fontStyle: "bold"`
 * narrowed to `FontStyle`, not widened to `string`). The runtime
 * binding still comes from the dynamic `import("jspdf-autotable")`
 * inside exportToPdf. */
import type { Styles as JsPdfStyles } from "jspdf-autotable";

/* ──────────────────────────────────────────────────────────────────────
 * Export module
 *
 * One projection layer + three lazy-loaded exporters (PDF, XLSX, DOCX).
 * Each exporter builds an in-memory file from the same `Row[]`, hands
 * the bytes to Tauri's native save dialog, then writes through the
 * fs plugin when the user confirms a path. Cancel returns null and
 * the caller treats that as a no-op.
 *
 * The heavy libraries (jspdf, jspdf-autotable, exceljs, docx) are
 * dynamic-imported so they only ship to the WebView when the user
 * actually clicks Export — the cold-start bundle stays slim even
 * with three formats wired up.
 *
 * Only "ready" pairs contribute. Pending / extracting / error rows
 * are silently skipped because their numeric columns would be blank
 * and break Excel formulas and PDF totals. The "#" column in the
 * exports keeps the original queue index so the user can still see
 * which row in the app a given printed line came from.
 * ────────────────────────────────────────────────────────────────────── */

/** Firm letterhead printed on every exported file. This is the company
 *  that operates the app and bills the end customer. It is NOT a
 *  collaborator. Partners (Stalexone, EMV, Bitlo, etc.) only ever appear
 *  in the per-row payout column or as a decont's named collaborator,
 *  never as the firm. */
const FIRM_NAME = "Ambient Intermed";

/* ── Export settings ──────────────────────────────────────────────── */

/** Which pairs the file includes. "all" = every pair handed in;
 *  "direct" = only pairs uploaded without a collaborator; a
 *  CollaboratorKey = only that partner's pairs. */
export type ExportScope = CollaboratorKey | "direct" | "all";

/** The knobs of the export-settings modal. Persisted in localStorage
 *  by ExportMenu; every exporter receives them through ExportOptions
 *  so all three formats honour the exact same configuration. */
export interface ExportSettings {
  /** Pair filter — see ExportScope. */
  scope: ExportScope;
  /** When scope is a collaborator: also include the legacy/direct
   *  pairs that were uploaded without an assignment. */
  includeUnassigned: boolean;
  /** Decont colaborator: every row shows ONLY the base transport
   *  tariff (no commission); the partner's commission is applied once,
   *  at the end, under the totals row. Client totals and per-row
   *  payouts are forced off — the file is meant to be handed to the
   *  partner, and client pricing must not leak into it. */
  statement: boolean;
  /** Tariff breakdown columns (Bază / Km+ / Inc. / Wkd). */
  colDetails: boolean;
  /** Carrier subtotal column (Tarif transp.). */
  colCarrier: boolean;
  /** Customer-total column for the selected city. */
  colCityTotal: boolean;
  /** Per-row collaborator payout column. */
  colCollab: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  scope: "all",
  includeUnassigned: true,
  // Decont is the DEFAULT export mode: base tariff per row, commission
  // applied once at the end. It only takes effect when a collaborator
  // anchors it (a partner scope, or the header pick as fallback) — the
  // modal gates on that, but the preference itself starts on.
  statement: true,
  colDetails: true,
  colCarrier: true,
  colCityTotal: true,
  colCollab: true,
};

/** Scope predicate — shared with the modal's live pair counts so the
 *  preview number always matches what the file will actually hold. */
export function pairInScope(p: Pair, settings: ExportSettings): boolean {
  if (settings.scope === "all") return true;
  const c = p.collaborator ?? null;
  if (settings.scope === "direct") return c === null;
  return c === settings.scope || (settings.includeUnassigned && c === null);
}

/** Statement mode hard-implies its column shape: the base tariff IS the
 *  row's money column and nothing commission- or client-side may appear.
 *  `stmtOn` is the EFFECTIVE decont flag (a single-collaborator scope is
 *  required), computed by the caller; the returned settings are
 *  normalized to match it so a stale persisted blob, or a non-collaborator
 *  scope, can never produce a decont that leaks client prices. */
function normalizeSettings(s: ExportSettings, stmtOn: boolean): ExportSettings {
  if (!stmtOn) return { ...s, statement: false };
  return { ...s, statement: true, colCarrier: true, colCityTotal: false, colCollab: false };
}

interface Row {
  idx: number;          // 1-based index in the original queue
  awb: string;
  factura: string;      // "INV-123" or "INV-123 (DUP)"
  date: string;         // ISO yyyy-mm-dd; formatters at the edge turn it human-readable
  service: string;
  kg: number;
  km: number;
  livrari: number;
  baza: number;
  kmExtra: number;      // 0 means "didn't apply" — kept numeric so Excel can still SUM
  increment: number;
  weekend: number;
  carrier: number;      // carrier subtotal (carrierTotal) = the BASE transport tariff
  /** Customer total for the selected city's single dispatch site.
   *  Every CityKey maps 1-to-1 to a CityCommissionKey now (Iași Tudor
   *  and Iași ERA are top-level options, not stacked), so this is a
   *  scalar instead of a vector. */
  cityTotal: number;
  /** Payout of the row's EFFECTIVE collaborator — the pair's own
   *  upload-time assignment, falling back to the scope/header pick —
   *  or `null` when no collaborator applies to the row. */
  collabTotal: number | null;
  /** Bonus (commission) part of that payout. The decont footer sums
   *  these instead of re-deriving pct × base, so the bottom line is
   *  exactly Σ of what the server priced per row. */
  collabBonus: number | null;
}

/** The three bottom lines of a collaborator statement (decont). */
export interface StatementSummary {
  collaborator: CollaboratorKey;
  /** Compact display label of the partner. */
  label: string;
  /** Bonus rate (0.25 = 25%) — display only; sums come from the rows. */
  pct: number;
  /** Σ carrierTotal across exported rows — base, no commission. */
  baseTotal: number;
  /** Σ per-row bonus — the commission, applied once at the end. */
  commission: number;
  /** baseTotal + commission = what the partner is owed. */
  payTotal: number;
}

interface Projection {
  rows: Row[];
  /** Sum across all rows for the selected city's customer total. */
  cityTotal: number;
  /** Sum across all rows for the collaborator-payout column, or
   *  `null` when no row resolved to a collaborator. */
  collabTotal: number | null;
  /** Header label for the city-total column ("Total Ploiești" /
   *  "Total Iași (Tudor)" / "Total Iași (ERA)" / "Total Constanța"). */
  cityHeader: string;
  /** Header label for the collaborator-payout column: named after the
   *  single collaborator the rows resolve to, generic ("Plată colab.")
   *  when the file mixes several, `null` when no row has one (the
   *  column is then omitted entirely). */
  collabHeader: string | null;
  /** The dispatch-site key the selected city maps to — used by the
   *  XLSX worksheet name and the suggested filename. */
  site: CityCommissionKey;
  readyCount: number;
  totalCount: number;
  generatedAt: Date;
  /** Normalized settings the projection was built with. */
  settings: ExportSettings;
  /** Non-null only in statement (decont) mode. */
  statement: StatementSummary | null;
}

/** Optional metadata threaded through every exporter. `day` is the
 *  ISO YYYY-MM-DD the caller is exporting (the visible day-tab in the
 *  UI). It changes the suggested filename and adds a "Ziua: ..." line
 *  to the in-document header so the printed page identifies which
 *  day's batch it represents.
 *
 *  `city` comes from the global header dropdown and drives which
 *  customer-total column the exported file shows; it defaults to
 *  Ploiești so any legacy caller that doesn't pass it still gets a
 *  sensible file. Which collaborator a row is attributed to comes from
 *  the pair's OWN assignment (and, for a single-collaborator scope,
 *  that scope), never a header pick. `settings` carries the export-modal
 *  configuration; omitted falls back to DEFAULT_EXPORT_SETTINGS. */
export interface ExportOptions {
  day?: string;
  city?: CityKey;
  settings?: ExportSettings;
}

/** Pure: flatten the queue into a structured row list + grand totals.
 *  Used by all three exporters. Exposed for tests / debugging.
 *
 *  `city` decides the customer-total column; `settings.scope` filters
 *  which pairs participate; each row's payout follows the pair's OWN
 *  collaborator with the scope/header pick as the fallback for
 *  unassigned legacy pairs (the same rule the in-app table applies).
 *  In statement mode every row is priced against the statement
 *  collaborator and the projection carries the decont summary. */
export function pairsToRows(
  pairs: Pair[],
  city: CityKey = "Ploiesti",
  settingsIn: ExportSettings = DEFAULT_EXPORT_SETTINGS,
): Projection {
  const site = primaryDispatchSite(city);
  const cityHeader = `Total ${CITY_COMMISSION_LABEL[site]}`;

  // The collaborator pinned by the scope filter, if any. A decont
  // (statement) is a per-collaborator payment file, so it applies ONLY
  // when the scope pins one partner. "all"/"direct" exports are plain
  // centralizatoare where every row shows its OWN collaborator and no
  // single partner is stamped on the whole file (mirrors ExportMenu's
  // `statementOn` gate so the file cannot disagree with it). The
  // unassigned-row fallback is the scope partner too, never a header
  // pick, so a "Toate perechile" export never attributes legacy pairs
  // to one collaborator.
  const scopeCollab: CollaboratorKey | null =
    settingsIn.scope !== "all" && settingsIn.scope !== "direct" ? settingsIn.scope : null;
  const stmtOn = settingsIn.statement && scopeCollab !== null;
  const settings = normalizeSettings(settingsIn, stmtOn);
  const anchor: CollaboratorKey | null = scopeCollab;
  const stmtCollab: CollaboratorKey | null = stmtOn ? scopeCollab : null;

  const rows: Row[] = [];
  const effSeen = new Set<CollaboratorKey>();
  let cityRunningTotal = 0;
  let collabRunningTotal = 0;
  let collabSeen = false;
  let baseRunningTotal = 0;
  let bonusRunningTotal = 0;
  let stmtPct: number | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    // Guard satisfies `noUncheckedIndexedAccess`; the loop bound makes
    // the undefined branch unreachable at runtime.
    if (!p || p.status.kind !== "ready") continue;
    if (!pairInScope(p, settings)) continue;
    const { service, edits, breakdown } = p.status;
    const { awb, invoices } = edits;
    const cityTotal = breakdown.cityCommissions[site]?.customerTotal ?? 0;
    // Decont mode prices every row against the statement collaborator;
    // otherwise the row pays its own assignment, falling back to the
    // scope/header pick (same rule as the in-app payout column).
    const eff: CollaboratorKey | null = settings.statement
      ? stmtCollab
      : (p.collaborator ?? anchor);
    const collabRow = eff !== null ? breakdown.collaboratorPrices[eff] : undefined;
    const collabTotal = collabRow ? collabRow.total : null;
    const collabBonus = collabRow ? collabRow.bonus : null;
    if (eff !== null && collabRow) effSeen.add(eff);
    // `factura` cell: join every invoice number with " · " so the
    // export shows all of them on one row, each suffixed with " (DUP)"
    // when the invoice is marked DUPLICAT. Most pairs still carry one
    // invoice; in that case the join is a no-op.
    const facturaCell = invoices
      .map((inv) => inv.invoice_number + (inv.invoice_is_duplicate ? " (DUP)" : ""))
      .join(" · ");
    rows.push({
      idx: i + 1,
      awb: awb.awb_number,
      factura: facturaCell,
      date: awb.delivery_date,
      service,
      kg: awb.weight_kg,
      km: awb.distance_extra_km,
      livrari: awb.num_deliveries,
      baza: breakdown.baseTariff,
      kmExtra: breakdown.extraKmCost,
      increment: breakdown.incrementCost,
      weekend: breakdown.weekendSurcharge,
      carrier: breakdown.carrierTotal,
      cityTotal,
      collabTotal,
      collabBonus,
    });
    cityRunningTotal += cityTotal;
    if (collabTotal !== null) {
      collabRunningTotal += collabTotal;
      collabSeen = true;
    }
    baseRunningTotal += breakdown.carrierTotal;
    if (collabBonus !== null) bonusRunningTotal += collabBonus;
    if (stmtPct === null && collabRow) stmtPct = collabRow.pct;
  }

  const effList = [...effSeen];
  const collabHeader =
    effList.length === 1
      ? `Plată ${COLLABORATOR_SHORT_LABEL[effList[0]!]}`
      : effList.length > 1
        ? "Plată colab."
        : null;

  const statement: StatementSummary | null =
    settings.statement && stmtCollab !== null
      ? {
          collaborator: stmtCollab,
          label: COLLABORATOR_SHORT_LABEL[stmtCollab],
          pct: stmtPct ?? 0,
          baseTotal: baseRunningTotal,
          commission: bonusRunningTotal,
          payTotal: baseRunningTotal + bonusRunningTotal,
        }
      : null;

  return {
    rows,
    cityTotal: cityRunningTotal,
    collabTotal: collabSeen ? collabRunningTotal : null,
    cityHeader,
    collabHeader,
    site,
    readyCount: rows.length,
    totalCount: pairs.length,
    generatedAt: new Date(),
    settings,
    statement,
  };
}

/* ── Column specs ─────────────────────────────────────────────────────
 * One description per column, rendered by all three exporters, so a
 * settings toggle changes PDF, XLSX and DOCX identically and no format
 * hand-codes column indices.
 * ────────────────────────────────────────────────────────────────────── */

type CellAlign = "left" | "right" | "center";

interface ExportCol {
  key: string;
  /** Compact header (PDF + DOCX). */
  head: string;
  /** XLSX header — carries the "(RON)" suffix on money columns. */
  headXlsx: string;
  align: CellAlign;
  pdfWidth: number;
  xlsxWidth: number;
  /** RON column: money format + a SUM/total in the totals band. */
  money: boolean;
  /** Bold coral bottom-line accent. */
  accent: boolean;
  /** Conditional surcharge: render 0 as "—" in PDF/DOCX. */
  blankZero: boolean;
  /** XLSX number format for non-money numeric columns. */
  numFmt?: string;
  /** Raw cell value; formatting happens at each exporter's edge. */
  value: (r: Row) => string | number | null;
  /** Pre-summed column total (money columns), else null. */
  total: number | null;
}

function buildColumns(proj: Projection): ExportCol[] {
  const s = proj.settings;
  const sum = (f: (r: Row) => number) => proj.rows.reduce((acc, r) => acc + f(r), 0);
  const col = (
    c: Pick<ExportCol, "key" | "head" | "pdfWidth" | "xlsxWidth" | "value"> &
      Partial<ExportCol>,
  ): ExportCol => ({
    headXlsx: c.head,
    align: "right",
    money: false,
    accent: false,
    blankZero: false,
    total: null,
    ...c,
  });

  // The identification block is always present — every file must let
  // the reader tie a line back to a physical AWB + invoice.
  const cols: ExportCol[] = [
    col({ key: "idx", head: "#", align: "center", pdfWidth: 22, xlsxWidth: 5, value: (r) => r.idx }),
    col({ key: "awb", head: "AWB", align: "left", pdfWidth: 88, xlsxWidth: 18, value: (r) => r.awb }),
    col({ key: "factura", head: "Factură", align: "left", pdfWidth: 88, xlsxWidth: 18, value: (r) => r.factura }),
    col({ key: "date", head: "Data", align: "center", pdfWidth: 52, xlsxWidth: 12, value: (r) => r.date }),
    col({ key: "service", head: "Serviciu", align: "center", pdfWidth: 60, xlsxWidth: 12, value: (r) => r.service }),
    col({ key: "kg", head: "kg", pdfWidth: 32, xlsxWidth: 9, numFmt: "0.00", value: (r) => r.kg }),
    col({ key: "km", head: "km", pdfWidth: 32, xlsxWidth: 7, numFmt: "0", value: (r) => r.km }),
    col({ key: "livrari", head: "Liv.", pdfWidth: 28, xlsxWidth: 7, numFmt: "0", value: (r) => r.livrari }),
  ];
  if (s.colDetails) {
    cols.push(
      col({ key: "baza", head: "Bază", headXlsx: "Bază (RON)", pdfWidth: 46, xlsxWidth: 13, money: true, total: sum((r) => r.baza), value: (r) => r.baza }),
      col({ key: "kmExtra", head: "Km+", headXlsx: "Km+ (RON)", pdfWidth: 42, xlsxWidth: 13, money: true, blankZero: true, total: sum((r) => r.kmExtra), value: (r) => r.kmExtra }),
      col({ key: "increment", head: "Inc.", headXlsx: "Inc. (RON)", pdfWidth: 42, xlsxWidth: 13, money: true, blankZero: true, total: sum((r) => r.increment), value: (r) => r.increment }),
      col({ key: "weekend", head: "Wkd", headXlsx: "Wkd (RON)", pdfWidth: 42, xlsxWidth: 13, money: true, blankZero: true, total: sum((r) => r.weekend), value: (r) => r.weekend }),
    );
  }
  if (s.colCarrier) {
    // In a decont the base tariff IS the per-row bottom line, so it
    // takes the accent the payout column would otherwise carry.
    cols.push(
      col({ key: "carrier", head: "Tarif transp.", headXlsx: "Tarif transp. (RON)", pdfWidth: 56, xlsxWidth: 15, money: true, accent: proj.statement !== null, total: sum((r) => r.carrier), value: (r) => r.carrier }),
    );
  }
  if (s.colCityTotal) {
    cols.push(
      col({ key: "cityTotal", head: proj.cityHeader, headXlsx: `${proj.cityHeader} (RON)`, pdfWidth: 68, xlsxWidth: 18, money: true, accent: true, total: proj.cityTotal, value: (r) => r.cityTotal }),
    );
  }
  if (s.colCollab && proj.collabHeader !== null) {
    cols.push(
      col({ key: "collab", head: proj.collabHeader, headXlsx: `${proj.collabHeader} (RON)`, pdfWidth: 64, xlsxWidth: 16, money: true, accent: true, total: proj.collabTotal, value: (r) => r.collabTotal }),
    );
  }
  return cols;
}

/** Display text for one cell. PDF + DOCX share it; XLSX keeps raw
 *  numbers so number formats and SUM() formulas do the work instead. */
function cellText(c: ExportCol, r: Row): string {
  const v = c.value(r);
  if (v === null) return "—";
  if (c.key === "date") return fmtDate(v as string);
  if (typeof v === "string") return v;
  if (c.money) return fmtCur(v, c.blankZero);
  if (c.numFmt === "0.00") return v.toFixed(2);
  if (c.numFmt === "0") return v.toFixed(0);
  return String(v);
}

/** "25%" / "30,1%" — bonus rate for the decont commission line. */
function fmtPct(pct: number): string {
  return `${(pct * 100).toLocaleString("ro-RO", { maximumFractionDigits: 2 })}%`;
}

/** Filter note for the document header, so a scoped file states what
 *  it contains ("Perechi: EMV + nealocate"). Null when unfiltered. */
function scopeNote(s: ExportSettings): string | null {
  if (s.scope === "all") return null;
  if (s.scope === "direct") return "Perechi: directe (fără colaborator)";
  return `Perechi: ${COLLABORATOR_SHORT_LABEL[s.scope]}${s.includeUnassigned ? " + nealocate" : ""}`;
}

/** The three decont bottom lines, shared by every exporter: base
 *  subtotal, the commission applied ONCE at the end, the amount owed. */
function statementLines(
  st: StatementSummary,
): Array<{ label: string; value: number; strong: boolean }> {
  return [
    { label: "Subtotal tarif transport", value: st.baseTotal, strong: false },
    { label: `Comision ${st.label} (${fmtPct(st.pct)})`, value: st.commission, strong: false },
    { label: `Total de plată ${st.label}`, value: st.payTotal, strong: true },
  ];
}

/** Document title: a decont is the partner's payout statement, not the
 *  internal centralizator. */
function docTitle(proj: Projection): string {
  return proj.statement ? `Decont colaborator · ${proj.statement.label}` : "Centralizator";
}

/* ── Filename + save helpers ──────────────────────────────────────── */

type Ext = "pdf" | "xlsx" | "docx";

/** Local-tz YYYY-MM-DD so the suggested filename matches what the
 *  user sees on their clock, not UTC. */
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Slug for any label, e.g. "Iași (Tudor)" → "iasi-tudor",
 *  "Vic Dinamic" → "vic-dinamic". */
function slugify(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Suggested filename. A decont is named after the partner it pays
 *  ("decont-emv-2026-06-12.pdf"); a centralizator after its dispatch
 *  site. When the caller knows which day is being exported, that day
 *  wins over the "right now" timestamp — the file is *about* that day
 *  even if it's generated later. */
function exportFileName(proj: Projection, ext: Ext, day?: string): string {
  const stamp = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ymd(proj.generatedAt);
  const base = proj.statement
    ? `decont-${slugify(proj.statement.label)}`
    : `centralizator-${slugify(CITY_COMMISSION_LABEL[proj.site])}`;
  return `${base}-${stamp}.${ext}`;
}

/**
 * Hand the generated bytes to Tauri's native save dialog and write
 * the user-chosen path via the fs plugin. Returns the absolute path on
 * success, or null when the user cancels the dialog.
 *
 * Both plugins are imported dynamically here too: a user who never
 * exports never pays the cost of pulling them into the bundle either.
 */
async function saveBinary(
  bytes: Uint8Array,
  ext: Ext,
  filterName: string,
  fileName: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const chosen = await save({
    defaultPath: fileName,
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!chosen) return null;
  await writeFile(chosen, bytes);
  return chosen;
}

/** "Ziua: 30.05.2026 · 12 din 20 perechi calculate · Perechi: EMV ·
 *  Total …" — the one-liner that anchors every export header to the
 *  day it represents and states which pairs it was filtered to. The
 *  tail is the client total for a centralizator and the partner's
 *  payout for a decont (a decont never shows client pricing). */
function metaLine(proj: Projection, day?: string): string {
  const dayPart = day ? `Ziua: ${fmtDate(day)} · ` : "";
  const note = scopeNote(proj.settings);
  const tail = proj.statement
    ? `Total de plată ${proj.statement.label}: ${fmtRon(proj.statement.payTotal)}`
    : `Total client ${CITY_COMMISSION_LABEL[proj.site]}: ${fmtRon(proj.cityTotal)}`;
  return (
    `${dayPart}${proj.readyCount} din ${proj.totalCount} perechi calculate · ` +
    (note ? `${note} · ` : "") +
    tail
  );
}

/** Currency for cells. Conditional surcharges render "—" at zero so
 *  the export matches what the user sees in the app's grid; the
 *  Excel writer ignores this and keeps raw 0 so SUM() still works. */
function fmtCur(n: number, blankZero = false): string {
  return blankZero && n === 0 ? "—" : fmtRon(n);
}

/* ══════════════════════════════════════════════════════════════════
 * PDF — jsPDF + jsPDF-AutoTable, A4 landscape
 * ══════════════════════════════════════════════════════════════════ */

export async function exportToPdf(
  pairs: Pair[],
  opts: ExportOptions = {},
): Promise<string | null> {
  const proj = pairsToRows(pairs, opts.city, opts.settings);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }
  const cols = buildColumns(proj);

  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  // A4 landscape: the full 15-column shape fits cleanly across ~760pt
  // of usable width; toggled-off columns simply leave breathing room.
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Title block ──────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(37, 34, 30); // ink-800
  doc.text(docTitle(proj), 40, 40);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(109, 102, 92); // ink-500
  doc.text(FIRM_NAME, 40, 56);
  doc.text(
    `Generat: ${proj.generatedAt.toLocaleString("ro-RO")}`,
    pageWidth - 40,
    56,
    { align: "right" },
  );
  doc.text(metaLine(proj, opts.day), 40, 72);

  // Head / body / foot / styles all derive from the same column specs,
  // so the settings modal's toggles reshape the table without any
  // per-column branching here.
  const head = cols.map((c) => c.head);
  const body = proj.rows.map((r) => cols.map((c) => cellText(c, r)));
  // Totals row: "Total" sits under "Serviciu"; every money column sums.
  const foot = cols.map((c, i) =>
    i === 4 ? "Total" : c.money && c.total !== null ? fmtRon(c.total) : "",
  );

  // autoTable accepts columnStyles as `{ [key: string]: Partial<Styles> }`,
  // so string keys + Partial values keep `fontStyle` narrowed to its
  // literal "bold" type instead of widening to string.
  const columnStyles: Record<string, Partial<JsPdfStyles>> = {};
  cols.forEach((c, i) => {
    columnStyles[String(i)] = {
      halign: c.align,
      cellWidth: c.pdfWidth,
      ...(c.accent
        ? { fontStyle: "bold" as const, textColor: [139, 72, 48] as [number, number, number] }
        : {}),
    };
  });

  autoTable(doc, {
    startY: 90,
    head: [head],
    body,
    foot: [foot],
    styles: { fontSize: 8, cellPadding: 4, valign: "middle" },
    // Header bar matches canvas-200; foot bar matches coral-500 — same
    // visual language as the in-app PairsTable, so a printed export
    // looks like the screen it came from.
    headStyles: {
      fillColor: [236, 229, 210],
      textColor: [58, 53, 47],
      fontStyle: "bold",
    },
    footStyles: {
      fillColor: [197, 111, 78],
      textColor: [251, 248, 241],
      fontStyle: "bold",
      halign: "right",
    },
    bodyStyles: { textColor: [37, 34, 30] },
    alternateRowStyles: { fillColor: [244, 239, 227] },
    columnStyles,
    margin: { left: 40, right: 40 },
  });

  // ── Decont bottom lines ──────────────────────────────────────────
  // Subtotal bază → comision (applied ONCE here, never per row) →
  // total de plată. Rendered under the table, right-aligned to it.
  if (proj.statement) {
    const finalY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 90;
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = finalY + 22;
    if (y + 60 > pageHeight - 40) {
      doc.addPage();
      y = 56;
    }
    for (const line of statementLines(proj.statement)) {
      doc.setFont("helvetica", line.strong ? "bold" : "normal");
      doc.setFontSize(line.strong ? 12 : 10);
      if (line.strong) doc.setTextColor(139, 72, 48); // coral-700
      else doc.setTextColor(58, 53, 47); // ink-700
      doc.text(`${line.label}:`, pageWidth - 160, y, { align: "right" });
      doc.text(fmtRon(line.value), pageWidth - 40, y, { align: "right" });
      y += line.strong ? 22 : 17;
    }
  }

  const buf = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return saveBinary(buf, "pdf", "PDF", exportFileName(proj, "pdf", opts.day));
}

/* ══════════════════════════════════════════════════════════════════
 * XLSX — ExcelJS workbook with live SUM() formulas
 * ══════════════════════════════════════════════════════════════════ */

export async function exportToXlsx(
  pairs: Pair[],
  opts: ExportOptions = {},
): Promise<string | null> {
  const proj = pairsToRows(pairs, opts.city, opts.settings);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }
  const cols = buildColumns(proj);

  // ExcelJS is published as a default export; named imports don't work.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Centralizator";
  wb.created = proj.generatedAt;

  // Worksheet name carries the day so a workbook opened from disk
  // identifies its contents at a glance from the bottom tab. Excel
  // caps sheet names at 31 chars; "Ziua DD.MM.YYYY" is 15.
  const sheetName = opts.day ? `Ziua ${fmtDate(opts.day)}` : "Centralizator";
  // Freeze the title + header band so the user can scroll the body.
  const ws = wb.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 4 }],
    properties: { defaultRowHeight: 18 },
  });

  const TOTAL_COLS = cols.length;
  // Spreadsheet column letter for col `c` (1-based). 26 columns is
  // enough for our shape; we never cross into AA territory.
  const colLetter = (c: number) => String.fromCharCode("A".charCodeAt(0) + c - 1);

  // Excel "character" widths roughly proportional to the in-app grid.
  ws.columns = cols.map((c) => ({ key: c.key, width: c.xlsxWidth }));

  // ── Title row ────────────────────────────────────────────────────
  const lastCol = colLetter(TOTAL_COLS);
  ws.mergeCells(`A1:${lastCol}1`);
  const titleCell = ws.getCell("A1");
  titleCell.value = `${docTitle(proj)} · ${FIRM_NAME}`;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF25221E" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${lastCol}2`);
  const subCell = ws.getCell("A2");
  const dayLabel = opts.day ? `Ziua: ${fmtDate(opts.day)} · ` : "";
  const note = scopeNote(proj.settings);
  subCell.value =
    `${dayLabel}Generat: ${proj.generatedAt.toLocaleString("ro-RO")} · ` +
    `${proj.readyCount} din ${proj.totalCount} perechi${note ? ` · ${note}` : ""}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF6D665C" } };
  ws.getRow(2).height = 16;

  // Row 3 is a 6-pt spacer for breathing room before the header.
  ws.getRow(3).height = 6;

  // ── Header row 4 ─────────────────────────────────────────────────
  const headerRow = ws.addRow(cols.map((c) => c.headXlsx));
  headerRow.font = { bold: true, color: { argb: "FF3A352F" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  headerRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECE5D2" } };
    c.border = { bottom: { style: "thin", color: { argb: "FFB9B0A0" } } };
  });
  headerRow.height = 26;

  // ── Data rows ────────────────────────────────────────────────────
  const RON = '#,##0.00" RON"';
  const firstDataRow = 5;

  for (const r of proj.rows) {
    const row = ws.addRow(cols.map((c) => c.value(r) ?? ""));
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.key === "date") {
        // Parse the ISO date into a real Date so Excel sorts and
        // filters by chronological order, not lexicographic string
        // order. The regex has exactly three capture groups, so when
        // it matches `m[1..3]` are always strings — the non-null
        // assertions satisfy `noUncheckedIndexedAccess`.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date);
        if (m) cell.value = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
        cell.numFmt = "dd.mm.yyyy";
      }
      if (c.money) cell.numFmt = RON;
      else if (c.numFmt) cell.numFmt = c.numFmt;
      if (c.align === "center") cell.alignment = { horizontal: "center" };
      if (c.accent) cell.font = { bold: true, color: { argb: "FF8B4830" } };
    });
  }

  const lastDataRow = firstDataRow + proj.rows.length - 1;

  // ── Totals row with live SUM() ───────────────────────────────────
  // Using formulas (not pre-computed values) so if the user
  // hand-edits a cell after opening the file, the total self-heals.
  // "Total" in col 5; every money column carries a SUM() of itself.
  const totalsRow = ws.addRow(new Array<string>(TOTAL_COLS).fill(""));
  totalsRow.height = 24;
  totalsRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC56F4E" } };
  });
  totalsRow.font = { bold: true, color: { argb: "FFFBF8F1" } };
  totalsRow.getCell(5).value = "Total";
  totalsRow.getCell(5).alignment = { horizontal: "right" };

  cols.forEach((c, i) => {
    if (!c.money) return;
    const letter = colLetter(i + 1);
    const cell = totalsRow.getCell(i + 1);
    cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` };
    cell.numFmt = RON;
    // Bottom-line accents get an extra-bold 12pt to match the in-app footer.
    if (c.accent) cell.font = { bold: true, size: 12, color: { argb: "FFFBF8F1" } };
  });

  // ── Decont bottom lines ──────────────────────────────────────────
  // Subtotal bază → comision (applied ONCE, off the SUM cell) → total
  // de plată. Formulas chain off the carrier SUM so the sheet
  // self-heals after hand edits; raw values are the safety fallback.
  if (proj.statement) {
    const st = proj.statement;
    const carrierIdx = cols.findIndex((c) => c.key === "carrier") + 1; // 1-based; 0 = absent
    const baseRef = carrierIdx > 0 ? `${colLetter(carrierIdx)}${totalsRow.number}` : null;
    const values: Array<number | { formula: string }> = baseRef
      ? [
          { formula: baseRef },
          { formula: `${baseRef}*${st.pct}` },
          { formula: `${baseRef}*(1+${st.pct})` },
        ]
      : [st.baseTotal, st.commission, st.payTotal];
    statementLines(st).forEach((line, i) => {
      const row = ws.addRow(new Array<string>(TOTAL_COLS).fill(""));
      ws.mergeCells(row.number, 1, row.number, TOTAL_COLS - 1);
      const labelCell = row.getCell(1);
      labelCell.value = line.label;
      labelCell.alignment = { horizontal: "right" };
      labelCell.font = {
        bold: line.strong,
        italic: !line.strong,
        size: line.strong ? 12 : 10,
        color: { argb: line.strong ? "FF8B4830" : "FF3A352F" },
      };
      const valCell = row.getCell(TOTAL_COLS);
      valCell.value = values[i]!;
      valCell.numFmt = RON;
      valCell.font = {
        bold: true,
        size: line.strong ? 12 : 10,
        color: { argb: line.strong ? "FF8B4830" : "FF3A352F" },
      };
      if (line.strong) row.height = 22;
    });
  }

  const arrBuf = await wb.xlsx.writeBuffer();
  return saveBinary(
    new Uint8Array(arrBuf as ArrayBuffer),
    "xlsx",
    "Excel",
    exportFileName(proj, "xlsx", opts.day),
  );
}

/* ══════════════════════════════════════════════════════════════════
 * DOCX — docx library, A4 landscape table
 * ══════════════════════════════════════════════════════════════════ */

export async function exportToDocx(
  pairs: Pair[],
  opts: ExportOptions = {},
): Promise<string | null> {
  const proj = pairsToRows(pairs, opts.city, opts.settings);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }
  const cols = buildColumns(proj);

  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, AlignmentType, WidthType, BorderStyle, PageOrientation,
  } = await import("docx");

  // Palette mirrored from the app theme so the doc reads as a
  // Centralizator export, not a generic Word table.
  const INK = "25221E";
  const INK_500 = "6D665C";
  const CANVAS_50 = "FBF8F1";
  const CANVAS_200 = "ECE5D2";
  const CORAL_500 = "C56F4E";
  const CORAL_700 = "8B4830";

  const border = { style: BorderStyle.SINGLE, size: 4, color: "B9B0A0" };
  const allBorders = {
    top: border, bottom: border, left: border, right: border,
    insideHorizontal: border, insideVertical: border,
  };

  function tcell(
    text: string,
    opts?: { bold?: boolean; bg?: string; color?: string; align?: CellAlign },
  ): DocxTableCell {
    return new TableCell({
      shading: opts?.bg ? { fill: opts.bg } : undefined,
      children: [
        new Paragraph({
          alignment:
            opts?.align === "right"
              ? AlignmentType.RIGHT
              : opts?.align === "center"
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
          children: [
            new TextRun({
              text,
              bold: opts?.bold,
              color: opts?.color ?? INK,
              size: 18, // half-points → 9pt
              font: "Calibri",
            }),
          ],
        }),
      ],
    });
  }

  // Header / data / totals all derive from the shared column specs, so
  // the settings modal's toggles reshape the table without any
  // per-column branches here.
  const headerRow = new TableRow({
    tableHeader: true,
    children: cols.map((c) =>
      tcell(c.head, { bold: true, bg: CANVAS_200, align: c.align }),
    ),
  });

  const dataRows = proj.rows.map(
    (r) =>
      new TableRow({
        children: cols.map((c) =>
          tcell(cellText(c, r), {
            align: c.align,
            ...(c.accent ? { bold: true, color: CORAL_700 } : {}),
          }),
        ),
      }),
  );

  // Totals row: coral background, cream text — same accent as the
  // in-app sticky bottom row. "Total" label sits under "Serviciu";
  // every money column shows its sum, everything else stays blank.
  const totalsCells: DocxTableCell[] = cols.map((c, i) => {
    if (i === 4) {
      return tcell("Total", {
        bg: CORAL_500, bold: true, color: CANVAS_50, align: "right",
      });
    }
    if (c.money && c.total !== null) {
      return tcell(fmtRon(c.total), {
        bg: CORAL_500, bold: true, color: CANVAS_50, align: "right",
      });
    }
    return tcell("", { bg: CORAL_500 });
  });
  const totalsRow = new TableRow({ children: totalsCells });

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders,
    rows: [headerRow, ...dataRows, totalsRow],
  });

  // ── Decont bottom lines ──────────────────────────────────────────
  // Subtotal bază → comision (applied ONCE here, never per row) →
  // total de plată. Right-aligned paragraphs under the table.
  const note = scopeNote(proj.settings);
  const summaryParas = proj.statement
    ? statementLines(proj.statement).map(
        (line, i) =>
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: i === 0 ? 240 : 60 },
            children: [
              new TextRun({
                text: `${line.label}:  `,
                bold: line.strong,
                color: line.strong ? CORAL_700 : INK_500,
                size: line.strong ? 24 : 20,
                font: "Calibri",
              }),
              new TextRun({
                text: fmtRon(line.value),
                bold: true,
                color: line.strong ? CORAL_700 : INK,
                size: line.strong ? 24 : 20,
                font: "Calibri",
              }),
            ],
          }),
      )
    : [];

  const doc = new Document({
    creator: "Centralizator",
    title: `${docTitle(proj)} export`,
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            // 0.5" margins in twentieths of a point.
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [
              new TextRun({ text: docTitle(proj), bold: true, size: 36, color: INK }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: FIRM_NAME, color: INK_500, size: 20 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text:
                  (opts.day ? `Ziua: ${fmtDate(opts.day)} · ` : "") +
                  `Generat: ${proj.generatedAt.toLocaleString("ro-RO")} · ${proj.readyCount} din ${proj.totalCount} perechi` +
                  (note ? ` · ${note}` : ""),
                color: INK_500,
                size: 18,
                italics: true,
              }),
            ],
          }),
          table,
          ...summaryParas,
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return saveBinary(buf, "docx", "Word", exportFileName(proj, "docx", opts.day));
}

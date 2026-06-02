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
  carrier: number;      // carrier subtotal (was `totalVat21`); muted in exports
  /** Customer total for the selected city's single dispatch site.
   *  Every CityKey maps 1-to-1 to a CityCommissionKey now (Iași Tudor
   *  and Iași ERA are top-level options, not stacked), so this is a
   *  scalar instead of a vector. */
  cityTotal: number;
  /** What the picked collaborator gets paid for this row, or `null`
   *  when the city has no collaborator (Constanța → direct, no
   *  partner). When null, every exporter drops the column entirely
   *  so the file isn't padded with empty "Plată …" cells. */
  collabTotal: number | null;
}

interface Projection {
  rows: Row[];
  /** Sum across all rows for the selected city's customer total. */
  cityTotal: number;
  /** Sum across all rows for the collaborator-payout column, or
   *  `null` when the city has no collaborator (Constanța). */
  collabTotal: number | null;
  /** Header label for the city-total column ("Total Ploiești" /
   *  "Total Iași (Tudor)" / "Total Iași (ERA)" / "Total Constanța"). */
  cityHeader: string;
  /** Header label for the collaborator-payout column, or `null` when
   *  the column is omitted entirely (Constanța). */
  collabHeader: string | null;
  /** The dispatch-site key the selected city maps to — used by the
   *  XLSX worksheet name and for any future per-site tooling. */
  site: CityCommissionKey;
  readyCount: number;
  totalCount: number;
  generatedAt: Date;
}

/** Optional metadata threaded through every exporter. `day` is the
 *  ISO YYYY-MM-DD the caller is exporting (the visible day-tab in the
 *  UI). It changes the suggested filename and adds a "Ziua: ..." line
 *  to the in-document header so the printed page identifies which
 *  day's batch it represents.
 *
 *  `city` + `collaborator` come from the global header dropdowns and
 *  drive which customer total(s) and which collaborator payout the
 *  exported file shows. They default to Ploiești / Stalexone so any
 *  legacy caller that doesn't pass them still gets a sensible file.
 */
export interface ExportOptions {
  day?: string;
  city?: CityKey;
  /** Selected collaborator. `null` means the city has no collaborator
   *  (Constanța is the only such city today); the export drops the
   *  collab column entirely instead of writing an empty one. */
  collaborator?: CollaboratorKey | null;
}

/** Pure: flatten the queue into a structured row list + grand totals.
 *  Used by all three exporters. Exposed for tests / debugging.
 *
 *  `city` + `collaborator` decide which columns the projection carries:
 *  one customer-total column for the selected city's single dispatch
 *  site, and always one collaborator-payout column for the picked
 *  partner (dropped entirely when `collaborator === null`). Defaults
 *  match the App.tsx initial-state defaults so direct callers still
 *  get a sane file. */
export function pairsToRows(
  pairs: Pair[],
  city: CityKey = "Ploiesti",
  collaborator: CollaboratorKey | null = "Stalexone",
): Projection {
  const site = primaryDispatchSite(city);
  const cityHeader = `Total ${CITY_COMMISSION_LABEL[site]}`;
  // Constanța has no collaborator → drop the column entirely instead
  // of emitting a "Plată —" placeholder. Every downstream exporter
  // checks `collabHeader === null` to decide whether to include the
  // column.
  const collabHeader =
    collaborator !== null ? `Plată ${COLLABORATOR_SHORT_LABEL[collaborator]}` : null;

  const rows: Row[] = [];
  let cityRunningTotal = 0;
  let collabRunningTotal = collaborator !== null ? 0 : null;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    // Guard satisfies `noUncheckedIndexedAccess`; the loop bound makes
    // the undefined branch unreachable at runtime.
    if (!p || p.status.kind !== "ready") continue;
    const { service, edits, breakdown } = p.status;
    const cityTotal = breakdown.cityCommissions[site]?.customerTotal ?? 0;
    const collabTotal =
      collaborator !== null
        ? (breakdown.collaboratorPrices[collaborator]?.total ?? 0)
        : null;
    rows.push({
      idx: i + 1,
      awb: edits.awb_number,
      factura:
        edits.invoice_number + (edits.invoice_is_duplicate ? " (DUP)" : ""),
      date: edits.delivery_date,
      service,
      kg: edits.weight_kg,
      km: edits.distance_extra_km,
      livrari: edits.num_deliveries,
      baza: breakdown.baseTariff,
      kmExtra: breakdown.extraKmCost,
      increment: breakdown.incrementCost,
      weekend: breakdown.weekendSurcharge,
      carrier: breakdown.totalVat21,
      cityTotal,
      collabTotal,
    });
    cityRunningTotal += cityTotal;
    if (collabRunningTotal !== null && collabTotal !== null) {
      collabRunningTotal += collabTotal;
    }
  }
  return {
    rows,
    cityTotal: cityRunningTotal,
    collabTotal: collabRunningTotal,
    cityHeader,
    collabHeader,
    site,
    readyCount: rows.length,
    totalCount: pairs.length,
    generatedAt: new Date(),
  };
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

/** Build a suggested filename. When the caller knows which day is
 *  being exported, that day wins over the "right now" timestamp —
 *  the file is *about* that day even if it's generated later. */
function defaultName(ext: Ext, generatedAt: Date, day?: string): string {
  const stamp = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ymd(generatedAt);
  return `centralizator-${stamp}.${ext}`;
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
  generatedAt: Date,
  filterName: string,
  day?: string,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const chosen = await save({
    defaultPath: defaultName(ext, generatedAt, day),
    filters: [{ name: filterName, extensions: [ext] }],
  });
  if (!chosen) return null;
  await writeFile(chosen, bytes);
  return chosen;
}

/** "Ziua: 30.05.2026 · 12 / 20 perechi · Total Ploiești: 1234,56 RON" —
 *  the one-liner that anchors every export header to the day it
 *  represents. Falls back to today's generated-at when the caller
 *  didn't pass a day, so older callers still get a sensible header. */
function metaLine(proj: Projection, day?: string): string {
  const dayPart = day ? `Ziua: ${fmtDate(day)} · ` : "";
  return (
    `${dayPart}${proj.readyCount} din ${proj.totalCount} perechi calculate · ` +
    `Total client ${CITY_COMMISSION_LABEL[proj.site]}: ${fmtRon(proj.cityTotal)}`
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
  const proj = pairsToRows(pairs, opts.city, opts.collaborator);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }

  const { jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  // A4 landscape: the static 13 columns plus 1 city-total column plus
  // (optionally) 1 collaborator-total column fit cleanly across ~760pt
  // of usable width — 14 or 15 columns depending on whether the city
  // has a collaborator.
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Title block ──────────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(37, 34, 30); // ink-800
  doc.text("Centralizator", 40, 40);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(109, 102, 92); // ink-500
  doc.text("Stalexone Trans", 40, 56);
  doc.text(
    `Generat: ${proj.generatedAt.toLocaleString("ro-RO")}`,
    pageWidth - 40,
    56,
    { align: "right" },
  );
  doc.text(metaLine(proj, opts.day), 40, 72);

  // Header + body assembled around the one city column and the
  // (optional) collaborator column so a single autoTable call handles
  // both with-collab and Constanța-no-collab cases without forking the
  // rendering path. The collab column is omitted entirely when
  // `collabHeader === null`.
  const head = [
    "#", "AWB", "Factură", "Data", "Serviciu",
    "kg", "km", "Liv.",
    "Bază", "Km+", "Inc.", "Wkd",
    "Tarif transp.",
    proj.cityHeader,
    ...(proj.collabHeader !== null ? [proj.collabHeader] : []),
  ];

  const body = proj.rows.map((r) => [
    r.idx,
    r.awb,
    r.factura,
    fmtDate(r.date),
    r.service,
    r.kg.toFixed(2),
    r.km.toFixed(0),
    r.livrari.toFixed(0),
    fmtCur(r.baza),
    fmtCur(r.kmExtra, true),
    fmtCur(r.increment, true),
    fmtCur(r.weekend, true),
    fmtCur(r.carrier),
    fmtCur(r.cityTotal),
    ...(r.collabTotal !== null ? [fmtCur(r.collabTotal)] : []),
  ]);

  // Footer: "Total" label in col 5, blanks through carrier, then the
  // city total + (optionally) the collab total. Length matches the
  // head row so autoTable's column count stays consistent.
  const foot = [
    "", "", "", "", "Total",
    "", "", "",
    "", "", "", "",
    "",
    fmtRon(proj.cityTotal),
    ...(proj.collabTotal !== null ? [fmtRon(proj.collabTotal)] : []),
  ];

  // Column-style map: 13 fixed leading columns, then the city total,
  // then (optionally) the collaborator total. Both bottom-line columns
  // get the bold coral accent. autoTable accepts columnStyles as
  // `{ [key: string]: Partial<Styles> }`, so string keys + Partial
  // values keep `fontStyle` narrowed to its literal "bold" type instead
  // of widening to string.
  const baseStyles: Record<string, Partial<JsPdfStyles>> = {
    "0": { halign: "center", cellWidth: 22 },
    "1": { halign: "left", cellWidth: 88 },
    "2": { halign: "left", cellWidth: 88 },
    "3": { halign: "center", cellWidth: 52 },
    "4": { halign: "center", cellWidth: 60 },
    "5": { halign: "right", cellWidth: 32 },
    "6": { halign: "right", cellWidth: 32 },
    "7": { halign: "right", cellWidth: 28 },
    "8": { halign: "right", cellWidth: 46 },
    "9": { halign: "right", cellWidth: 42 },
    "10": { halign: "right", cellWidth: 42 },
    "11": { halign: "right", cellWidth: 42 },
    "12": { halign: "right", cellWidth: 56 }, // carrier subtotal
    "13": {
      halign: "right",
      cellWidth: 68,
      fontStyle: "bold",
      textColor: [139, 72, 48],
    },
  };
  if (proj.collabHeader !== null) {
    baseStyles["14"] = {
      halign: "right",
      cellWidth: 64,
      fontStyle: "bold",
      textColor: [139, 72, 48],
    };
  }

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
    columnStyles: baseStyles,
    margin: { left: 40, right: 40 },
  });

  const buf = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return saveBinary(buf, "pdf", proj.generatedAt, "PDF", opts.day);
}

/* ══════════════════════════════════════════════════════════════════
 * XLSX — ExcelJS workbook with live SUM() formulas
 * ══════════════════════════════════════════════════════════════════ */

export async function exportToXlsx(
  pairs: Pair[],
  opts: ExportOptions = {},
): Promise<string | null> {
  const proj = pairsToRows(pairs, opts.city, opts.collaborator);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }

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

  // Column count = 13 static + 1 city total + 0-1 collab total = 14 or 15.
  const hasCollab = proj.collabHeader !== null;
  const TOTAL_COLS = 13 + 1 + (hasCollab ? 1 : 0);
  // Spreadsheet column letter for col `c` (1-based). 26 columns is
  // enough for our shape; we never cross into AA territory.
  const colLetter = (c: number) => String.fromCharCode("A".charCodeAt(0) + c - 1);

  // Excel "character" widths roughly proportional to the in-app grid.
  ws.columns = [
    { key: "idx", width: 5 },
    { key: "awb", width: 18 },
    { key: "factura", width: 18 },
    { key: "date", width: 12 },
    { key: "service", width: 12 },
    { key: "kg", width: 9 },
    { key: "km", width: 7 },
    { key: "livrari", width: 7 },
    { key: "baza", width: 13 },
    { key: "kmExtra", width: 13 },
    { key: "increment", width: 13 },
    { key: "weekend", width: 13 },
    { key: "carrier", width: 15 },
    { key: "city", width: 18 },
    ...(hasCollab ? [{ key: "collab", width: 16 }] : []),
  ];

  // ── Title row ────────────────────────────────────────────────────
  const lastCol = colLetter(TOTAL_COLS);
  ws.mergeCells(`A1:${lastCol}1`);
  const titleCell = ws.getCell("A1");
  titleCell.value = "Centralizator · Stalexone Trans";
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF25221E" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${lastCol}2`);
  const subCell = ws.getCell("A2");
  const dayLabel = opts.day ? `Ziua: ${fmtDate(opts.day)} · ` : "";
  subCell.value = `${dayLabel}Generat: ${proj.generatedAt.toLocaleString("ro-RO")} · ${proj.readyCount} din ${proj.totalCount} perechi`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF6D665C" } };
  ws.getRow(2).height = 16;

  // Row 3 is a 6-pt spacer for breathing room before the header.
  ws.getRow(3).height = 6;

  // ── Header row 4 ─────────────────────────────────────────────────
  const headerRow = ws.addRow([
    "#", "AWB", "Factură", "Data", "Serviciu",
    "kg", "km", "Liv.",
    "Bază (RON)", "Km+ (RON)", "Inc. (RON)", "Wkd (RON)",
    "Tarif transp. (RON)",
    `${proj.cityHeader} (RON)`,
    ...(hasCollab ? [`${proj.collabHeader} (RON)`] : []),
  ]);
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
  // First column index of the financial block we want to format as RON
  // and SUM later (Bază, Km+, Inc., Wkd, Tarif transp., city totals,
  // collab total).
  const firstMoneyCol = 9;
  // Column indices that hold the bottom-line accents (the city total
  // + the collab total). Computed once so cell-formatting in the loop
  // doesn't re-derive them per row. When the city has no collaborator
  // we still want the city-total column accented, so we don't add
  // TOTAL_COLS for that case.
  const accentCols = new Set<number>();
  accentCols.add(14); // city total
  if (hasCollab) accentCols.add(TOTAL_COLS);

  for (const r of proj.rows) {
    const row = ws.addRow([
      r.idx,
      r.awb,
      r.factura,
      r.date,
      r.service,
      r.kg,
      r.km,
      r.livrari,
      r.baza,
      r.kmExtra,
      r.increment,
      r.weekend,
      r.carrier,
      r.cityTotal,
      ...(r.collabTotal !== null ? [r.collabTotal] : []),
    ]);
    row.getCell(1).alignment = { horizontal: "center" };

    // Parse the ISO date into a real Date so Excel sorts and filters
    // by chronological order, not lexicographic string order.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.date);
    // The regex above has exactly three capture groups, so when it
    // matches `m[1..3]` are always strings — the non-null assertions
    // satisfy `noUncheckedIndexedAccess` without hiding any real bug.
    if (m) row.getCell(4).value = new Date(+m[1]!, +m[2]! - 1, +m[3]!);
    row.getCell(4).numFmt = "dd.mm.yyyy";
    row.getCell(4).alignment = { horizontal: "center" };

    row.getCell(5).alignment = { horizontal: "center" };
    row.getCell(6).numFmt = "0.00";
    row.getCell(7).numFmt = "0";
    row.getCell(8).numFmt = "0";
    // RON format on the whole money block (firstMoneyCol .. TOTAL_COLS).
    for (let c = firstMoneyCol; c <= TOTAL_COLS; c++) row.getCell(c).numFmt = RON;
    // City totals + collab total get the bold coral accent.
    for (const c of accentCols) {
      row.getCell(c).font = { bold: true, color: { argb: "FF8B4830" } };
    }
  }

  const lastDataRow = firstDataRow + proj.rows.length - 1;

  // ── Totals row with live SUM() ───────────────────────────────────
  // Using formulas (not pre-computed values) so if the user
  // hand-edits a cell after opening the file, the total self-heals.
  // 4 leading blanks, "Total" in col 5, then blanks until the money
  // block, where every cell carries a SUM() of its column.
  const totalsRow = ws.addRow([
    "", "", "", "", "Total", "", "", "",
    ...new Array(TOTAL_COLS - 8).fill(""),
  ]);
  totalsRow.height = 24;
  totalsRow.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC56F4E" } };
  });
  totalsRow.font = { bold: true, color: { argb: "FFFBF8F1" } };
  totalsRow.getCell(5).alignment = { horizontal: "right" };

  // SUM formulas across the money block: Bază (9) … collab total
  // (TOTAL_COLS). The city totals + collab total get an extra-bold
  // 12pt style to match the in-app footer.
  for (let c = firstMoneyCol; c <= TOTAL_COLS; c++) {
    const col = colLetter(c);
    totalsRow.getCell(c).value = {
      formula: `SUM(${col}${firstDataRow}:${col}${lastDataRow})`,
    };
    totalsRow.getCell(c).numFmt = RON;
  }
  for (const c of accentCols) {
    totalsRow.getCell(c).font = {
      bold: true,
      size: 12,
      color: { argb: "FFFBF8F1" },
    };
  }

  const arrBuf = await wb.xlsx.writeBuffer();
  return saveBinary(
    new Uint8Array(arrBuf as ArrayBuffer),
    "xlsx",
    proj.generatedAt,
    "Excel",
    opts.day,
  );
}

/* ══════════════════════════════════════════════════════════════════
 * DOCX — docx library, A4 landscape table
 * ══════════════════════════════════════════════════════════════════ */

export async function exportToDocx(
  pairs: Pair[],
  opts: ExportOptions = {},
): Promise<string | null> {
  const proj = pairsToRows(pairs, opts.city, opts.collaborator);
  if (proj.rows.length === 0) {
    throw new Error("Nu există perechi calculate pentru export.");
  }

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

  type Align = "left" | "right" | "center";
  function tcell(
    text: string,
    opts?: { bold?: boolean; bg?: string; color?: string; align?: Align },
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

  // Column layout = 13 static + 1 city total + 0–1 collab total = 14
  // or 15. Assembled as arrays so the row builders below iterate
  // uniformly — no per-column branches.
  const hasCollab = proj.collabHeader !== null;
  const headerLabels = [
    "#", "AWB", "Factură", "Data", "Serviciu",
    "kg", "km", "Liv.",
    "Bază", "Km+", "Inc.", "Wkd",
    "Tarif transp.",
    proj.cityHeader,
    ...(hasCollab ? [proj.collabHeader as string] : []),
  ];

  const headerAligns: Align[] = [
    "center", "left", "left", "center", "center",
    "right", "right", "right",
    "right", "right", "right", "right",
    "right",
    "right",
    ...(hasCollab ? [("right" as Align)] : []),
  ];

  const headerRow = new TableRow({
    tableHeader: true,
    children: headerLabels.map((h, i) =>
      tcell(h, { bold: true, bg: CANVAS_200, align: headerAligns[i] }),
    ),
  });

  const dataRows = proj.rows.map((r) =>
    new TableRow({
      children: [
        tcell(String(r.idx), { align: "center" }),
        tcell(r.awb),
        tcell(r.factura),
        tcell(fmtDate(r.date), { align: "center" }),
        tcell(r.service, { align: "center" }),
        tcell(r.kg.toFixed(2), { align: "right" }),
        tcell(r.km.toFixed(0), { align: "right" }),
        tcell(r.livrari.toFixed(0), { align: "right" }),
        tcell(fmtCur(r.baza), { align: "right" }),
        tcell(fmtCur(r.kmExtra, true), { align: "right" }),
        tcell(fmtCur(r.increment, true), { align: "right" }),
        tcell(fmtCur(r.weekend, true), { align: "right" }),
        tcell(fmtCur(r.carrier), { align: "right" }),
        tcell(fmtCur(r.cityTotal), { align: "right", bold: true, color: CORAL_700 }),
        ...(r.collabTotal !== null
          ? [
              tcell(fmtCur(r.collabTotal), {
                align: "right",
                bold: true,
                color: CORAL_700,
              }),
            ]
          : []),
      ],
    }),
  );

  // Totals row: coral background, cream text — same accent as the
  // in-app sticky bottom row. "Total" label sits in col 5; the city
  // total sits at index 13, the (optional) collab total at the last
  // index, and everything else stays blank.
  const totalsCells: DocxTableCell[] = headerLabels.map((_, i) => {
    if (i === 4) {
      return tcell("Total", {
        bg: CORAL_500, bold: true, color: CANVAS_50, align: "right",
      });
    }
    if (i === 13) {
      return tcell(fmtRon(proj.cityTotal), {
        bg: CORAL_500, bold: true, color: CANVAS_50, align: "right",
      });
    }
    if (hasCollab && proj.collabTotal !== null && i === headerLabels.length - 1) {
      return tcell(fmtRon(proj.collabTotal), {
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

  const doc = new Document({
    creator: "Centralizator",
    title: "Centralizator export",
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
              new TextRun({ text: "Centralizator", bold: true, size: 36, color: INK }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Stalexone Trans", color: INK_500, size: 20 }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text:
                  (opts.day ? `Ziua: ${fmtDate(opts.day)} · ` : "") +
                  `Generat: ${proj.generatedAt.toLocaleString("ro-RO")} · ${proj.readyCount} din ${proj.totalCount} perechi`,
                color: INK_500,
                size: 18,
                italics: true,
              }),
            ],
          }),
          table,
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return saveBinary(buf, "docx", proj.generatedAt, "Word", opts.day);
}

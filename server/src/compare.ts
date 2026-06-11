/**
 * Excel cross-check — compare the courier's master export ("Main") against
 * what this app extracted and computed.
 *
 * The courier portal exports one row per AWB with the authoritative facts:
 * recipient, weight, the extra-km it billed, and the road distance it
 * measured. Our app independently reads the same AWB by vision and routes the
 * distance through Mapbox. This module joins the two on the AWB number and
 * reports, field by field, where they agree and where they drift — so the
 * operator can see at a glance whether a discrepancy comes from the vision
 * read or the routing. Price is deliberately NOT compared here: the courier
 * export is a customer-facing sell price computed on a different commercial
 * layer, so a price column would only ever show an expected (non-actionable)
 * drift.
 *
 * The join is the AWB number. Everything else is a per-field comparison with a
 * tolerance chosen for that field's nature (exact-ish for weight, looser for
 * the road distance which is known to diverge between the courier's
 * measurement and Mapbox).
 */

import type { PairLightWire } from "./db.js";
import type { Extracted, Routing } from "./schema.js";
import { parseXlsxFirstSheet, type SheetTable } from "./xlsx.js";

/* ──────────────────────────────────────────────────────────────────────
 * Report shape (also the wire contract to the client)
 * ────────────────────────────────────────────────────────────────────── */

export type FieldStatus = "match" | "mismatch" | "missing";
export type Presence = "both" | "excelOnly" | "appOnly";

/**
 * How seriously a mismatch on this field should be taken:
 *   • "alert" — a mismatch points to an extraction error worth fixing
 *               (recipient, weight, extra-km read off the AWB). Drives the
 *               red row highlight + the headline "flagged" count.
 *   • "info"  — the two sides are computed differently and are EXPECTED to
 *               drift: road distance (courier measurement vs Mapbox) and the
 *               carrier price (their tariff vs our pricing engine). Shown and
 *               coloured per cell, but never marks the whole row as broken.
 */
export type FieldSeverity = "alert" | "info";

export interface CompareField {
  /** Stable id for the UI. */
  key: string;
  /** Romanian column label, mirrors the Excel header. */
  label: string;
  /** Value from the Excel master export (null = blank/absent there). */
  excel: string | number | null;
  /** Value from our app's ready pair (null = absent on our side). */
  app: string | number | null;
  status: FieldStatus;
  severity: FieldSeverity;
  /** Short Romanian explanation of the magnitude, shown on mismatch/missing. */
  note?: string;
  /** Deterministic CAUSE of the difference, inferred from the pair's own
   *  breakdown (macara line, weekend date, unloading, missing km on the
   *  photographed page, rate-card gap). Rendered in parentheses in the UI so
   *  the operator sees WHY a row differs without opening the documents. */
  reason?: string;
}

export interface CompareRow {
  /** Display AWB number (the courier's, padded form preserved). */
  awb: string;
  /** Recipient name for context (prefers the Excel side). */
  recipient: string | null;
  presence: Presence;
  /** Per-field comparisons. Empty unless presence === "both". */
  fields: CompareField[];
  /** True when any field is a mismatch (drives the row highlight). */
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
    /** Rows with any difference at all (alert OR info). */
    withDiscrepancies: number;
    /** Rows with an ALERT-severity problem (extraction error). The number
     *  that actually needs the operator's attention. */
    flagged: number;
  };
  rows: CompareRow[];
}

/* ──────────────────────────────────────────────────────────────────────
 * Excel header names (as exported by the courier portal)
 *
 * Kept as constants so a header rename is a one-line change here, and so the
 * field set is documented in one place.
 * ────────────────────────────────────────────────────────────────────── */
const COL = {
  awb: "Nr",
  recipient: "Destinatar",
  weight: "Kg",
  extraKm: "Extra km",
  roadKm: "Distanta pe strada",
} as const;

/** Per-field absolute tolerance for the numeric comparisons. */
const TOL = {
  weight: 0.5, // kg — OCR/rounding noise
  extraKm: 0.5, // km — printed integer vs our stored value
  roadKm: 1.0, // km — courier measurement vs Mapbox legitimately differ a bit
} as const;

/* ──────────────────────────────────────────────────────────────────────
 * Normalisers
 * ────────────────────────────────────────────────────────────────────── */

/** AWB join key: digits only, leading zeros stripped ("007211306" → "7211306"). */
function awbKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "").replace(/^0+/, "");
  return digits;
}

/** Name compare key: upper-case, de-diacritic, collapse whitespace. */
function nameKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritic marks
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct word tokens of a name (split on spaces + hyphens, deduped). */
function nameTokens(raw: string | null | undefined): Set<string> {
  return new Set(
    nameKey(raw)
      .split(/[\s-]+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Recipient names match when one side's token set is contained in the other's.
 * The courier export routinely TRUNCATES the recipient ("AVANGARDE" vs our
 * "AVANGARDE HOME"), REORDERS it ("Ionescu Cerasela" vs "Cerasela Ionescu"), or
 * our extraction DOUBLES it ("Mincu Anisoara Anisoara Mincu") — none of those
 * are real discrepancies. A genuine OCR slip ("Ciican" vs "Ciocan") changes a
 * token and still fails the subset test, so it's correctly flagged.
 */
function namesAgree(excel: string, app: string): boolean {
  const a = nameTokens(excel);
  const b = nameTokens(app);
  if (a.size === 0 || b.size === 0) return false;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

/** Parse a possibly-comma-decimal Excel number; null when blank/non-numeric. */
function num(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ──────────────────────────────────────────────────────────────────────
 * App-side projection
 * ────────────────────────────────────────────────────────────────────── */

interface AppFacts {
  awbRaw: string;
  recipient: string | null;
  weight: number | null;
  extraKm: number | null; // routing.awbKm (the courier-comparable km)
  roadKm: number | null; // routing.mapboxKm (our measured road km)
}

/** Pull the comparable scalars out of a ready pair; null for non-ready pairs. */
function appFactsOf(pair: PairLightWire): AppFacts | null {
  if (pair.status.kind !== "ready") return null;
  const edits = pair.status.edits as Extracted;
  const routing = pair.status.routing as Routing | undefined;
  const awb = edits?.awb;
  if (!awb?.awb_number) return null;
  return {
    awbRaw: awb.awb_number,
    recipient: awb.recipient_name ?? null,
    weight: num(awb.weight_kg),
    extraKm: routing ? num(routing.awbKm) : null,
    roadKm: routing ? num(routing.mapboxKm) : null,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * Reason classifier — WHY a field differs
 *
 * Deterministic, derived purely from the pair's own breakdown + the Excel
 * row. No guessing beyond what the numbers already prove. The strings are
 * short Romanian phrases shown in parentheses next to the differing value.
 * ────────────────────────────────────────────────────────────────────── */

/** True when the courier billed extra km but our side read 0 (the photographed
 *  page was a proces-verbal/factură without the "Distanță extra" field). */
function extraKmMissing(excelExtraKm: number | null, app: AppFacts): boolean {
  return (excelExtraKm ?? 0) > 0 && (app.extraKm ?? 0) === 0;
}

/** Dispatch the right cause for any differing field. */
function fieldReason(f: CompareField, excelExtraKm: number | null, app: AppFacts): string {
  const weightUnread = (app.weight ?? 0) === 0;
  if (f.status === "missing") {
    switch (f.key) {
      case "recipient":
        return f.app == null ? "destinatar necitit pe poză" : "lipsește în Excel";
      case "weight":
        return weightUnread ? "greutate necitită (poza nu e eticheta AWB)" : "lipsește o valoare";
      case "extraKm":
        return extraKmMissing(excelExtraKm, app)
          ? "poză fără câmpul 'Distanță extra' (proces-verbal/factură)"
          : "lipsește o valoare";
      case "roadKm":
        return "fără rută Mapbox (informativ)";
      default:
        return "lipsește o valoare";
    }
  }
  switch (f.key) {
    case "recipient":
      return "nume citit diferit (posibil OCR sau prescurtat în Excel)";
    case "weight":
      return weightUnread
        ? "greutate necitită (poza e proces-verbal/factură, nu eticheta AWB)"
        : "greutate citită diferit (verifică OCR)";
    case "extraKm":
      return extraKmMissing(excelExtraKm, app)
        ? "poză fără câmpul 'Distanță extra' (proces-verbal/factură)"
        : "km diferiți față de AWB";
    case "roadKm":
      return "Mapbox vs. măsurătoarea curierului (informativ, nu afectează prețul)";
    default:
      return "diferență";
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * Field comparators
 * ────────────────────────────────────────────────────────────────────── */

function numberField(
  key: string,
  label: string,
  excel: number | null,
  app: number | null,
  tol: number,
  severity: FieldSeverity,
): CompareField {
  if (excel === null || app === null) {
    return {
      key,
      label,
      excel,
      app,
      severity,
      status: "missing",
      note:
        excel === null && app === null
          ? "Lipsește din ambele surse."
          : excel === null
            ? "Lipsește în Excel."
            : "Lipsește în aplicație.",
    };
  }
  const diff = Math.abs(excel - app);
  if (diff <= tol) return { key, label, excel, app, severity, status: "match" };
  return {
    key,
    label,
    excel,
    app,
    severity,
    status: "mismatch",
    note: `Diferență ${round1(app - excel)} (aplicație − Excel).`,
  };
}

function recipientField(excel: string | null, app: string | null): CompareField {
  if (!excel || !app) {
    return {
      key: "recipient",
      label: COL.recipient,
      excel: excel ?? null,
      app: app ?? null,
      severity: "alert",
      status: "missing",
      note: !excel ? "Lipsește în Excel." : "Lipsește în aplicație.",
    };
  }
  const status: FieldStatus = namesAgree(excel, app) ? "match" : "mismatch";
  return {
    key: "recipient",
    label: COL.recipient,
    excel,
    app,
    severity: "alert",
    status,
    note: status === "mismatch" ? "Nume destinatar diferit." : undefined,
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * Main entry
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Build the comparison report from a parsed Excel sheet and the app's pairs.
 * Pure + deterministic — easy to unit-test without touching the DB or HTTP.
 */
export function buildReport(
  sheet: SheetTable,
  pairs: PairLightWire[],
  fileName: string | null,
): CompareReport {
  // Index app pairs by AWB key. A normal day has unique AWBs; if a duplicate
  // ever appears we keep the first (insertion order) and ignore the rest.
  const appByAwb = new Map<string, AppFacts>();
  let appPairs = 0;
  for (const pair of pairs) {
    const facts = appFactsOf(pair);
    if (!facts) continue;
    appPairs++;
    const key = awbKey(facts.awbRaw);
    if (key && !appByAwb.has(key)) appByAwb.set(key, facts);
  }

  // Index Excel rows by AWB key, skipping blank rows.
  const excelByAwb = new Map<string, Record<string, string>>();
  for (const row of sheet.rows) {
    const key = awbKey(row[COL.awb]);
    if (!key) continue;
    if (!excelByAwb.has(key)) excelByAwb.set(key, row);
  }

  const rows: CompareRow[] = [];
  const seenApp = new Set<string>();

  // Walk the Excel rows in file order — that's the courier's canonical order.
  for (const [key, xl] of excelByAwb) {
    const app = appByAwb.get(key);
    const excelAwb = (xl[COL.awb] ?? "").trim();
    const excelRecipient = (xl[COL.recipient] ?? "").trim() || null;

    if (!app) {
      rows.push({
        awb: excelAwb || key,
        recipient: excelRecipient,
        presence: "excelOnly",
        fields: [],
        hasDiscrepancy: false,
      });
      continue;
    }

    seenApp.add(key);
    const excelExtraKm = num(xl[COL.extraKm]);
    const fields: CompareField[] = [
      recipientField(excelRecipient, app.recipient),
      numberField("weight", COL.weight, num(xl[COL.weight]), app.weight, TOL.weight, "alert"),
      numberField("extraKm", COL.extraKm, excelExtraKm, app.extraKm, TOL.extraKm, "alert"),
      numberField("roadKm", COL.roadKm, num(xl[COL.roadKm]), app.roadKm, TOL.roadKm, "info"),
    ];
    // Attach the deterministic CAUSE to each differing field (shown in
    // parentheses by the UI). Matches get no reason.
    for (const f of fields) {
      if (f.status === "match") continue;
      f.reason = fieldReason(f, excelExtraKm, app);
    }
    // A row is "flagged" only on an ALERT-severity mismatch/missing (an
    // extraction error). Info-severity drifts (road km, price) are shown
    // per cell but don't paint the whole row as broken.
    const hasDiscrepancy = fields.some(
      (f) => f.severity === "alert" && f.status !== "match",
    );
    rows.push({
      awb: excelAwb || key,
      recipient: excelRecipient ?? app.recipient,
      presence: "both",
      fields,
      hasDiscrepancy,
    });
  }

  // Any app pair whose AWB never appeared in the Excel.
  for (const [key, app] of appByAwb) {
    if (seenApp.has(key)) continue;
    rows.push({
      awb: app.awbRaw,
      recipient: app.recipient,
      presence: "appOnly",
      fields: [],
      hasDiscrepancy: false,
    });
  }

  const matched = rows.filter((r) => r.presence === "both").length;
  const anyDiff = (r: CompareRow) => r.fields.some((f) => f.status !== "match");
  return {
    generatedAt: Date.now(),
    fileName,
    summary: {
      excelRows: excelByAwb.size,
      appPairs,
      matched,
      excelOnly: rows.filter((r) => r.presence === "excelOnly").length,
      appOnly: rows.filter((r) => r.presence === "appOnly").length,
      withDiscrepancies: rows.filter(anyDiff).length,
      flagged: rows.filter((r) => r.hasDiscrepancy).length,
    },
    rows,
  };
}

/** Convenience: parse raw .xlsx bytes and compare in one call. */
export function compareExcelBuffer(
  buf: Buffer,
  pairs: PairLightWire[],
  fileName: string | null,
): CompareReport {
  const sheet = parseXlsxFirstSheet(buf);
  return buildReport(sheet, pairs, fileName);
}

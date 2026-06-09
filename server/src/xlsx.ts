/**
 * Minimal, dependency-free .xlsx reader.
 *
 * An .xlsx file is a ZIP container of XML parts. We only need to read one
 * worksheet, so instead of pulling a heavy spreadsheet library (which would
 * also re-trip the sharp/pnpm build-approval pain), we parse the ZIP central
 * directory by hand and inflate the two parts we care about with Node's
 * built-in `zlib`:
 *
 *   • xl/sharedStrings.xml      — the de-duplicated string table (may be empty
 *                                 when the exporter writes inline strings)
 *   • xl/worksheets/sheet1.xml  — the cell grid of the first sheet
 *
 * The reader is deliberately small and tolerant: it understands STORED (0) and
 * DEFLATE (8) ZIP entries, shared strings (`t="s"`), inline strings
 * (`t="inlineStr"`), formula strings (`t="str"`), booleans (`t="b"`) and plain
 * numbers. ZIP64 is not handled — courier exports are a few tens of KB, far
 * under the 4 GB / 65 535-entry limits where ZIP64 kicks in.
 *
 * Output is a `SheetTable`: row 1 becomes the header list (in column order),
 * and every later row becomes an object keyed by header text. Callers reference
 * columns by their human header ("Nr", "Kg", "Destinatar") so the parser stays
 * robust against the courier reordering or inserting columns.
 */

import { inflateRawSync } from "node:zlib";

/* ZIP signatures (little-endian 32-bit). */
const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CDH = 0x02014b50; // Central Directory File Header
const SIG_LFH = 0x04034b50; // Local File Header

/** A parsed sheet: ordered headers + header-keyed data rows. */
export interface SheetTable {
  /** Row 1 cell texts, in column order (left to right). */
  headers: string[];
  /** Each data row as `{ headerText: cellText }`. Empty cells are "". */
  rows: Record<string, string>[];
}

/* ──────────────────────────────────────────────────────────────────────
 * ZIP container → { entryName: rawBytes }
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Read every file out of a ZIP buffer via its central directory. We walk the
 * directory rather than scanning local headers because local headers can omit
 * sizes (streaming/data-descriptor mode); the central directory always has the
 * authoritative compressed size and local-header offset.
 */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of first central-directory header

  const out = new Map<string, Buffer>();
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(p) !== SIG_CDH) {
      throw new Error(`xlsx: bad central directory header at byte ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    out.set(name, extractLocal(buf, localOffset, method, compSize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Locate the End Of Central Directory record by scanning backward from EOF. */
function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes + an optional comment (max 65 535). Scan that window.
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error("xlsx: not a ZIP (no End Of Central Directory record)");
}

/** Slice + decompress one entry given its local-header offset. */
function extractLocal(buf: Buffer, offset: number, method: number, compSize: number): Buffer {
  if (buf.readUInt32LE(offset) !== SIG_LFH) {
    throw new Error(`xlsx: bad local file header at byte ${offset}`);
  }
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) return Buffer.from(data); // STORED
  if (method === 8) return inflateRawSync(data); // DEFLATE
  throw new Error(`xlsx: unsupported ZIP compression method ${method}`);
}

/* ──────────────────────────────────────────────────────────────────────
 * XML helpers
 * ────────────────────────────────────────────────────────────────────── */

/** Decode the five predefined XML entities + numeric character references. */
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Concatenate every `<t>…</t>` inside an XML fragment (handles rich-text runs). */
function joinTextNodes(fragment: string): string {
  let out = "";
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) !== null) out += m[1] ?? "";
  return decodeXml(out);
}

/**
 * Build the shared-string table. Each `<si>` is one entry; an entry may be a
 * single `<t>` or several `<r><t>` rich-text runs that we concatenate.
 */
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(joinTextNodes(m[1] ?? ""));
  return out;
}

/** Leading letters of a cell ref ("AC12" → "AC"). */
function columnOf(ref: string): string {
  const m = /^([A-Z]+)/.exec(ref);
  return m?.[1] ?? "";
}

/** Spreadsheet column letters → 0-based index ("A"→0, "Z"→25, "AA"→26). */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ──────────────────────────────────────────────────────────────────────
 * Public entry point
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Parse the first worksheet of an .xlsx buffer into a header-keyed table.
 * Throws a descriptive Error when the buffer is not a readable .xlsx.
 */
export function parseXlsxFirstSheet(buf: Buffer): SheetTable {
  const entries = readZipEntries(buf);
  const sheetEntry = entries.get("xl/worksheets/sheet1.xml");
  if (!sheetEntry) throw new Error("xlsx: no xl/worksheets/sheet1.xml in workbook");
  const sheetXml = sheetEntry.toString("utf8");
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));

  // Each <row>…</row> holds <c>…</c> cells. Collect cells per row as a
  // column-index → text map, then flatten to ordered rows below.
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const grid: Array<Map<number, string>> = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const cells = new Map<number, string>();
    const body = rowMatch[2] ?? "";
    // Match both self-closing (<c .../>) and paired (<c ...>…</c>) cells.
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(body)) !== null) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const refMatch = /\br="([A-Z]+\d+)"/.exec(attrs);
      if (!refMatch?.[1]) continue;
      const col = columnIndex(columnOf(refMatch[1]));
      cells.set(col, cellText(attrs, inner, shared));
    }
    grid.push(cells);
  }

  if (grid.length === 0) return { headers: [], rows: [] };

  // Header row = first row. Width = the widest column index seen anywhere,
  // so a short header row still lines up with wider data rows.
  const headerMap = grid[0] ?? new Map<number, string>();
  let maxCol = 0;
  for (const row of grid) for (const c of row.keys()) if (c > maxCol) maxCol = c;

  const headers: string[] = [];
  for (let c = 0; c <= maxCol; c++) headers.push(headerMap.get(c) ?? "");

  const rows: Record<string, string>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r] ?? new Map<number, string>();
    const obj: Record<string, string> = {};
    for (let c = 0; c <= maxCol; c++) {
      const key = headers[c];
      if (!key) continue; // skip unlabeled columns
      obj[key] = cells.get(c) ?? "";
    }
    rows.push(obj);
  }
  return { headers, rows };
}

/** Resolve one cell's text from its attribute string + inner XML + string table. */
function cellText(attrs: string, inner: string, shared: string[]): string {
  const typeMatch = /\bt="([^"]+)"/.exec(attrs);
  const type = typeMatch?.[1] ?? "n";

  if (type === "s") {
    // Shared string: <v> holds the index into the string table.
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
    const idx = v?.[1] ? parseInt(v[1], 10) : NaN;
    return Number.isFinite(idx) ? shared[idx] ?? "" : "";
  }
  if (type === "inlineStr") return joinTextNodes(inner);
  if (type === "str") {
    const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
    return v?.[1] !== undefined ? decodeXml(v[1]) : "";
  }
  // Numbers, booleans, dates-as-serial: the raw <v> text is what we want.
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
  return v?.[1] !== undefined ? decodeXml(v[1]) : "";
}

import { inflateRawSync } from 'node:zlib';
import { errors } from '@flowza/shared';
import type { ParsedCsv } from './csv.js';

/*
 * Minimal reader for the FIRST worksheet of an Excel .xlsx workbook (Office Open XML), built on node:zlib only — the API has
 * no spreadsheet dependency and the import page must accept the files HR teams actually keep (AGENTS.md rule 10: no new
 * dependency). It reads cell VALUES only: shared strings, inline strings, numbers, booleans and dates (cells whose number
 * format is a date are returned as YYYY-MM-DD). Formulas give their cached value. Everything else — styles, merged cells,
 * comments, other sheets — is ignored.
 *
 * Hostile files: a ZIP64 archive, an encrypted entry or an unknown compression is refused; every entry is inflated with an
 * output cap (zip bombs) and the archive may hold at most MAX_ENTRIES entries. Errors are VALIDATION_ERRORs that never echo
 * the file's content.
 */

const MAX_ENTRIES = 5000;
/** Largest uncompressed part we inflate (a 5,000-row sheet is a few MB of XML). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

interface ZipEntry { name: string; method: number; flags: number; compressedSize: number; localOffset: number }

const invalid = (why: string) => errors.validation(`The file is not a readable Excel workbook (.xlsx): ${why}. Save it again as .xlsx or export the sheet as CSV (UTF-8).`, { issues: [{ path: 'file', message: 'Unreadable .xlsx' }] });

/** True when the bytes start like a ZIP archive (every .xlsx does). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

function readEntries(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: 22 bytes + a comment of at most 65,535 bytes, at the end of the file
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw invalid('no ZIP directory');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw invalid('ZIP64 archives are not supported');
  if (count > MAX_ENTRIES) throw invalid('too many parts');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw invalid('damaged ZIP directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.set(name, { name, method, flags, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  if (e.flags & 0x1) throw invalid('the workbook is password-protected');
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw invalid('damaged ZIP entry');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw invalid('truncated file');
  const data = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) out = data;
  else if (e.method === 8) {
    try { out = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }); } catch { throw invalid('a part could not be decompressed (or is too large)'); }
  } else throw invalid('unsupported compression');
  return out.toString('utf8');
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) { const cp = Number.parseInt(e.slice(2), 16); return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    if (e.startsWith('#')) { const cp = Number.parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return ENTITIES[e] ?? m;
  });
}

function attr(tagAttrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(tagAttrs);
  return m ? decodeXml(m[1]!) : undefined;
}

/** Text of a string item (`<si>` / `<is>`): every `<t>` run, phonetic runs (`<rPh>`) left out. */
function textOf(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1]!;
  return decodeXml(out);
}

/** Column index (0-based) from a cell reference like "AB12". */
function columnOf(ref: string | undefined): number | null {
  const m = ref ? /^([A-Z]+)\d*$/.exec(ref.toUpperCase()) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Built-in number formats that are dates (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmy]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Style index → "this cell is a date" from xl/styles.xml (cellXfs order). */
function dateStyles(stylesXml: string | null): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1]!, 'numFmtId')); const code = attr(m[1]!, 'formatCode');
    if (Number.isFinite(id) && code !== undefined) custom.set(id, code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>)/g)) {
    const id = Number(attr(m[1]!, 'numFmtId') ?? '0');
    const code = custom.get(id);
    if (BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormatCode(code))) out.add(i);
    i += 1;
  }
  return out;
}

/** An Excel serial day (1900 or 1904 date system) as YYYY-MM-DD; null when out of range. */
export function excelSerialToIsoDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  // 1900 system: day 1 = 1900-01-01 and the fictitious 1900-02-29 (serial 60) — epoch 1899-12-30 works for serials > 60
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const days = Math.floor(serial) + (!date1904 && serial < 61 ? 1 : 0);
  return new Date(epoch + days * 86_400_000).toISOString().slice(0, 10);
}

function resolveTarget(target: string): string {
  const t = target.replace(/^\/+/, '');
  return t.startsWith('xl/') ? t : `xl/${t}`;
}

/**
 * Reads the first worksheet into header + rows (same shape as the CSV parser). Leading and trailing empty rows are dropped,
 * an empty row in the middle too; at most `maxRows` data rows (VALIDATION_ERROR beyond).
 */
export function parseXlsx(buf: Buffer, opts: { maxRows?: number } = {}): ParsedCsv {
  const maxRows = opts.maxRows ?? 10_000;
  if (!looksLikeZip(buf)) throw invalid('not a ZIP archive');
  const entries = readEntries(buf);
  const workbook = readEntry(buf, entries, 'xl/workbook.xml');
  if (!workbook) throw invalid('no workbook part');
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/.test(workbook);
  const firstSheet = /<sheet\b([^>]*?)\/?>/.exec(workbook);
  const rid = firstSheet ? attr(firstSheet[1]!, 'r:id') : undefined;
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = readEntry(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (rid && rels) {
    for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      if (attr(m[1]!, 'Id') === rid) { const target = attr(m[1]!, 'Target'); if (target) sheetPath = resolveTarget(target); break; }
    }
  }
  const sheet = readEntry(buf, entries, sheetPath);
  if (!sheet) throw invalid('no worksheet');
  const sharedXml = readEntry(buf, entries, 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedXml) for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) shared.push(m[1] === undefined ? '' : textOf(m[1]));
  const dates = dateStyles(readEntry(buf, entries, 'xl/styles.xml'));

  const records: string[][] = [];
  const sheetData = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(sheet)?.[1] ?? '';
  for (const rowMatch of sheetData.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!; const inner = c[2] ?? '';
      const col = columnOf(attr(attrs, 'r')) ?? next;
      next = col + 1;
      if (col > 1000) continue; // nobody imports a thousand columns: ignore stray far-right cells
      const type = attr(attrs, 't');
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else if (type === 'b') value = raw === '1' ? 'true' : raw === '0' ? 'false' : '';
      else if (type === 'e') value = '';
      else if (raw !== undefined) {
        value = decodeXml(raw);
        const style = Number(attr(attrs, 's') ?? '0');
        if ((type === undefined || type === 'n') && dates.has(style)) value = excelSerialToIsoDate(Number(value), date1904) ?? value;
        else if (type === 'd') value = value.slice(0, 10);
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    if (cells.every((v) => v.trim() === '')) continue;
    records.push(cells);
    if (records.length > maxRows + 1) throw errors.validation(`The file has more than ${maxRows} rows.`);
  }
  const header = (records.shift() ?? []).map((h) => h.trim());
  return { header, rows: records };
}

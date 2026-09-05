import { errors } from '@flowza/shared';

export interface ParsedCsv { header: string[]; rows: string[][] }

/**
 * Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF/CR line endings, UTF-8 BOM.
 * Blank lines are skipped. Throws VALIDATION_ERROR on unterminated quotes or when `maxRows` is exceeded.
 */
export function parseCsv(text: string, opts: { delimiter?: string; maxRows?: number } = {}): ParsedCsv {
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRows = opts.maxRows ?? 10_000;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    pushField();
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
    if (records.length > maxRows + 1) throw errors.validation(`The file has more than ${maxRows} rows.`);
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { pushField(); i++; continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; pushRecord(); i++; continue; }
    if (ch === '\n') { pushRecord(); i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw errors.validation('Unterminated quoted field in CSV.');
  if (field.length > 0 || record.length > 0) pushRecord();
  const header = (records.shift() ?? []).map((h) => h.trim());
  return { header, rows: records };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: [string, number][] = [[',', 0], [';', 0], ['\t', 0]].map(([d]) => [d as string, firstLine.split(d as string).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/** Turn header + rows into objects; empty strings become undefined so optional Zod fields validate. */
export function csvToObjects(parsed: ParsedCsv): Record<string, string | undefined>[] {
  return parsed.rows.map((row) => {
    const obj: Record<string, string | undefined> = {};
    parsed.header.forEach((key, idx) => {
      if (!key) return;
      const v = (row[idx] ?? '').trim();
      obj[key] = v === '' ? undefined : v;
    });
    return obj;
  });
}

export function toCsvLine(values: readonly (string | number | null | undefined)[]): string {
  return values.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

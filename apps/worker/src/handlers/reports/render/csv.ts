import Papa from 'papaparse';
import type { ReportDocument } from '../model.js';
import { flatten, flattenSheets } from './flatten.js';

/**
 * Cells that a spreadsheet would evaluate (`=`, `+`, `-`, `@`, tab, CR) are prefixed with an apostrophe so an
 * employee named "=HYPERLINK(...)" stays text (AGENTS.md: exports escape formula-leading characters). Numbers are
 * emitted as numbers and are never affected.
 */
export function escapeSpreadsheetText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens Arabic text correctly without an import wizard. */
export function renderCsv(doc: ReportDocument): Buffer {
  const flat = flatten(doc);
  const data: Array<Array<string | number>> = [flat.header.map(escapeSpreadsheetText)];
  const cellOf = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? v : escapeSpreadsheetText(v));
  for (const r of flat.rows) data.push(r.values.map(cellOf));
  // a section kept apart (a summary per employee) follows after a blank line, under its name and its own header
  for (const sheet of flattenSheets(doc)) {
    data.push([], [escapeSpreadsheetText(sheet.name)], sheet.table.header.map(escapeSpreadsheetText));
    for (const r of sheet.table.rows) data.push(r.values.map(cellOf));
  }
  const text = Papa.unparse(data, { newline: '\r\n' });
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

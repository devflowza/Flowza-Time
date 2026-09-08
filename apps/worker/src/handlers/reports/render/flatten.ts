import { DASH } from '@flowza/domain';
import type { ReportCell, ReportColumn, ReportDocument, ReportSection } from '../model.js';

/**
 * A printed page can carry a group heading above its rows and a header block above its table; a spreadsheet cannot,
 * so both become leading columns and every row repeats them. Total rows are dropped — a sheet recomputes them.
 */
export interface FlatTable { header: string[]; rows: Array<{ values: Array<string | number | null>; cells: ReportCell[]; leading: string[] }> }

const columnLabel = (c: ReportColumn): string => (c.group ? `${c.group} ${c.label}` : c.label);

/** Spreadsheet-native emptiness: the printed dash stands for "nothing", so a sheet gets an empty cell, not text. */
export const spreadsheetValue = (c: ReportCell): string | number | null => {
  if (c.number !== undefined) return c.number;
  if (c.text === DASH || c.text === '') return null;
  return c.lines ? c.lines.join(' / ') : c.text;
};

export function flatten(doc: ReportDocument): FlatTable {
  const fieldLabels: string[] = doc.flatten.fieldColumns ? [...new Set(doc.sections.flatMap((s) => (s.fields ?? []).map((f) => f.label.replace(/:$/, ''))))] : [];
  const headingLabel = doc.flatten.headingColumnLabel;
  const superLabel = doc.flatten.superHeadingColumnLabel ?? null;
  const header = [...fieldLabels, ...(superLabel ? [superLabel] : []), ...(headingLabel ? [headingLabel] : []), ...doc.columns.map(columnLabel)];
  const rows: FlatTable['rows'] = [];
  for (const s of doc.sections) {
    const leading = [...fieldLabels.map((label) => (s.fields ?? []).find((f) => f.label.replace(/:$/, '') === label)?.value ?? ''), ...(superLabel ? [s.superHeading ?? ''] : []), ...(headingLabel ? [s.heading?.value ?? ''] : [])];
    for (const r of s.rows) {
      if ((r.kind ?? 'data') !== 'data') continue;
      rows.push({ leading, cells: r.cells, values: [...leading, ...r.cells.map(spreadsheetValue)] });
    }
  }
  return { header, rows };
}

/** Sections that carry their own columns (a document may mix) — the flattener uses the document's; renderers may need this. */
export const sectionColumns = (doc: ReportDocument, s: ReportSection): ReportColumn[] => s.columns ?? doc.columns;

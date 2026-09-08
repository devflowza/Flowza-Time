/**
 * The renderer-neutral shape of a finished report. Every definition builds one of these; CSV, XLSX and PDF are three
 * views of the same object, which is what keeps the row count, the ordering and the values identical across formats.
 */
export type CellTone = 'default' | 'present' | 'absent' | 'off' | 'leave' | 'holiday' | 'muted' | 'warning' | 'danger';
export type CellAlign = 'start' | 'center' | 'end';

export interface ReportCell {
  text: string;
  /** Stacked lines inside one cell (Weekly In/Out prints IN over OUT). `text` stays the flat form for CSV. */
  lines?: string[];
  tone?: CellTone;
  align?: CellAlign;
  mono?: boolean;
  bold?: boolean;
  /** Typed value for spreadsheets; `text` remains what a printed page shows. */
  number?: number | null;
  colSpan?: number;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: CellAlign;
  /** Relative width hint in characters. */
  width?: number;
  mono?: boolean;
  /** Second-level header: columns sharing a `group` print under one spanning header cell (Weekly: Sat → MornWT | EvenWT). */
  group?: string;
}

export interface ReportRow { kind?: 'data' | 'total'; cells: ReportCell[] }
export interface ReportField { label: string; value: string; mono?: boolean }

export interface ReportSection {
  /** Group heading such as `Dept: ADMIN` — `label` is the caption, `value` the group's name. */
  heading?: { label: string; value: string };
  /** Header block above the table (Detail report: Employee, Card No, Shift, Dept, Designation). */
  fields?: ReportField[];
  /** Column set for this section when it differs from the document's. */
  columns?: ReportColumn[];
  rows: ReportRow[];
  pageBreakBefore?: boolean;
}

export interface LegendEntry { code: string; label: string }

export interface ReportDocument {
  key: string;
  title: string;
  company: string;
  period: string | null;
  orientation: 'portrait' | 'landscape';
  columns: ReportColumn[];
  sections: ReportSection[];
  legend: LegendEntry[] | null;
  legendTitle: string;
  /** Footnotes printed under the legend (which rules produced OT1/OT2/UT, the hours notation in force). */
  notes: string[];
  endOfReport: boolean;
  endOfReportLabel: string;
  generatedAt: Date;
  generatedLabel: string;
  pageLabel: (page: string, total: string) => string;
  timezone: string;
  locale: 'en' | 'ar';
  dir: 'ltr' | 'rtl';
  /** Data rows across all sections — what `report_requests.row_count` records. */
  rowCount: number;
  /** How section headings and header fields flatten into spreadsheet columns. */
  flatten: { headingColumnLabel: string | null; fieldColumns: boolean };
  /** Sheet name / file stem (no extension). */
  fileStem: string;
}

export const EMPTY_CELL: ReportCell = { text: '' };
export const cell = (text: string, extra: Omit<ReportCell, 'text'> = {}): ReportCell => ({ text, ...extra });
export const num = (value: number | null, text: string, extra: Omit<ReportCell, 'text' | 'number'> = {}): ReportCell => ({ text, number: value, align: 'end', ...extra });

export function countRows(sections: readonly ReportSection[]): number {
  let n = 0;
  for (const s of sections) for (const r of s.rows) if ((r.kind ?? 'data') === 'data') n += 1;
  return n;
}

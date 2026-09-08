import ExcelJS from 'exceljs';
import type { CellTone, ReportDocument } from '../model.js';
import { escapeSpreadsheetText } from './csv.js';
import { flatten } from './flatten.js';

const TONE_ARGB: Partial<Record<CellTone, string>> = { off: 'FF1D4ED8', leave: 'FF15803D', absent: 'FFB91C1C', holiday: 'FF6D28D9', muted: 'FF6B7280', warning: 'FFB45309', danger: 'FFB91C1C' };

/** One sheet, bold frozen header, typed numbers, tone colours carried over, columns sized to their content. */
export async function renderXlsx(doc: ReportDocument): Promise<Buffer> {
  const flat = flatten(doc);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FlowZa Time';
  wb.created = doc.generatedAt;
  const sheet = wb.addWorksheet(doc.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report', { views: [{ state: 'frozen', ySplit: 1, rightToLeft: doc.dir === 'rtl' }] });
  const leadingCount = flat.header.length - doc.columns.length;
  sheet.addRow(flat.header.map(escapeSpreadsheetText));
  sheet.getRow(1).font = { bold: true };
  for (const r of flat.rows) {
    const row = sheet.addRow(r.values.map((v) => (typeof v === 'string' ? escapeSpreadsheetText(v) : v)));
    r.cells.forEach((c, i) => {
      const argb = c.tone ? TONE_ARGB[c.tone] : undefined;
      if (argb || c.bold) row.getCell(leadingCount + i + 1).font = { ...(argb ? { color: { argb } } : {}), ...(c.bold ? { bold: true } : {}) };
      if (c.align === 'end' || c.number !== undefined) row.getCell(leadingCount + i + 1).alignment = { horizontal: 'right' };
      else if (c.align === 'center') row.getCell(leadingCount + i + 1).alignment = { horizontal: 'center' };
    });
  }
  flat.header.forEach((h, i) => {
    let width = h.length;
    for (const r of flat.rows.slice(0, 500)) { const v = r.values[i]; const len = v === null || v === undefined ? 0 : String(v).length; if (len > width) width = len; }
    sheet.getColumn(i + 1).width = Math.min(48, Math.max(6, width + 2));
  });
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

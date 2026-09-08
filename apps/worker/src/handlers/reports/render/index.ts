import type { ReportFormat } from '@flowza/contracts';
import type { PdfRenderer } from '../../../deps.js';
import type { ReportDocument } from '../model.js';
import { renderCsv } from './csv.js';
import { renderPdf } from './html.js';
import { renderXlsx } from './xlsx.js';

export const CONTENT_TYPES: Record<ReportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export async function renderDocument(doc: ReportDocument, format: ReportFormat, pdf: PdfRenderer): Promise<{ body: Buffer; contentType: string }> {
  switch (format) {
    case 'csv': return { body: renderCsv(doc), contentType: CONTENT_TYPES.csv };
    case 'xlsx': return { body: await renderXlsx(doc), contentType: CONTENT_TYPES.xlsx };
    case 'pdf': return { body: await renderPdf(doc, pdf), contentType: CONTENT_TYPES.pdf };
    default: {
      const exhaustive: never = format;
      throw new Error(`Unknown report format ${String(exhaustive)}`);
    }
  }
}

export { renderCsv, renderXlsx, renderPdf };
export { renderHtml } from './html.js';

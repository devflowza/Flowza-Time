import type { PdfRenderer } from '../../../deps.js';
import type { CellTone, ReportCell, ReportColumn, ReportDocument, ReportSection } from '../model.js';

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const TONE_COLOUR: Record<CellTone, string> = { default: '#111', present: '#111', off: '#1d4ed8', leave: '#15803d', absent: '#b91c1c', holiday: '#6d28d9', muted: '#6b7280', warning: '#b45309', danger: '#b91c1c' };

/**
 * Print margins in millimetres. Chromium lets an @page margin override the margin passed to printToPDF, so the
 * stylesheet and the render call must name the same values; the footer template is drawn inside the bottom one.
 */
export const PAGE_MARGIN_MM = { top: 12, right: 12, bottom: 16, left: 12 };

/**
 * The print stylesheet the samples describe: company and title centred, a rule under the header, table headings that
 * repeat on every page, group headings as bars, colour-coded codes, a legend and footnotes at the end. Fonts name the
 * families the reports image installs (Noto Sans + Noto Sans Arabic) with system fallbacks.
 */
const CSS = `
  * { box-sizing: border-box; }
  html { font-family: "Noto Sans", "Noto Sans Arabic", "IBM Plex Sans Arabic", "Liberation Sans", Arial, sans-serif; font-size: 8.5pt; color: #111; }
  body { margin: 0; }
  .head { text-align: center; padding-bottom: 6px; border-bottom: 2px solid #b91c1c; margin-bottom: 8px; }
  .head .company { font-size: 15pt; font-weight: 700; letter-spacing: .01em; }
  .head .title { font-size: 12pt; font-weight: 700; margin-top: 2px; }
  .head .period { text-align: end; font-size: 8.5pt; font-weight: 700; color: #1d4ed8; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { padding: 2px 4px; text-align: start; vertical-align: top; }
  thead th { font-weight: 700; border-top: 1.5px solid #111; border-bottom: 1.5px solid #111; white-space: nowrap; }
  thead th.group { text-align: center; border-bottom: 1px solid #999; }
  th.end, td.end { text-align: end; }
  th.center, td.center { text-align: center; }
  td.mono, th.mono { font-variant-numeric: tabular-nums; }
  td .line { display: block; }
  tbody tr.total td { font-weight: 700; border-top: 1px solid #111; }
  .section { margin-top: 6px; }
  .section.break { page-break-before: always; }
  .heading { font-weight: 700; padding: 4px 4px 2px; }
  .heading .label { margin-inline-end: 6px; }
  .heading .value { color: #1d4ed8; text-decoration: underline; }
  .super { font-weight: 700; color: #1d4ed8; padding: 8px 4px 0; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 24px; padding: 4px; border-top: 2px solid #b91c1c; margin-bottom: 4px; }
  .fields .f { display: grid; grid-template-columns: 9em minmax(0, 1fr); gap: 8px; }
  .fields .k { color: #1d4ed8; font-weight: 700; }
  .fields .v { font-weight: 700; }
  .legend { margin-top: 14px; border-top: 2px solid #b91c1c; padding-top: 4px; font-size: 7.5pt; }
  .legend .lt { font-weight: 700; text-decoration: underline; }
  .legend .items { margin-top: 2px; }
  .legend .items span { white-space: nowrap; }
  .notes { font-size: 7pt; color: #444; margin-top: 4px; }
  .end { text-align: center; font-weight: 700; margin-top: 10px; border-top: 1px solid #b91c1c; border-bottom: 1px solid #b91c1c; padding: 3px; }
  .end + .end-title { text-align: center; font-weight: 700; margin-top: 4px; }
  @page { margin: ${PAGE_MARGIN_MM.top}mm ${PAGE_MARGIN_MM.right}mm ${PAGE_MARGIN_MM.bottom}mm ${PAGE_MARGIN_MM.left}mm; }
`;

const cls = (parts: Array<string | false | undefined | null>): string => { const s = parts.filter(Boolean).join(' '); return s ? ` class="${s}"` : ''; };

function renderCell(c: ReportCell, col: ReportColumn | undefined): string {
  const align = c.align ?? col?.align;
  const mono = c.mono ?? col?.mono;
  const colour = c.tone && c.tone !== 'default' ? ` style="color:${TONE_COLOUR[c.tone]}${c.bold ? ';font-weight:700' : ''}"` : c.bold ? ' style="font-weight:700"' : '';
  const span = c.colSpan && c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '';
  const body = c.lines ? c.lines.map((l) => `<span class="line">${escapeHtml(l)}</span>`).join('') : escapeHtml(c.text);
  return `<td${cls([align, mono && 'mono'])}${colour}${span}>${body}</td>`;
}

function renderHeader(columns: ReportColumn[]): string {
  const grouped = columns.some((c) => c.group);
  if (!grouped) return `<thead><tr>${columns.map((c) => `<th${cls([c.align, c.mono && 'mono'])}>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>`;
  // two-level header: consecutive columns sharing a group get one spanning cell above their own labels
  const top: string[] = [];
  for (let i = 0; i < columns.length;) {
    const c = columns[i]!;
    if (!c.group) { top.push(`<th rowspan="2"${cls([c.align, c.mono && 'mono'])}>${escapeHtml(c.label)}</th>`); i += 1; continue; }
    let j = i; while (j < columns.length && columns[j]!.group === c.group) j += 1;
    top.push(`<th class="group" colspan="${j - i}">${escapeHtml(c.group)}</th>`);
    i = j;
  }
  const bottom = columns.filter((c) => c.group).map((c) => `<th${cls([c.align, c.mono && 'mono'])}>${escapeHtml(c.label)}</th>`).join('');
  return `<thead><tr>${top.join('')}</tr><tr>${bottom}</tr></thead>`;
}

function renderSection(doc: ReportDocument, s: ReportSection, showSuper: boolean): string {
  const columns = s.columns ?? doc.columns;
  const superHeading = showSuper && s.superHeading ? `<div class="super">${escapeHtml(s.superHeading)}</div>` : '';
  const heading = s.heading ? `<div class="heading">${s.heading.label ? `<span class="label">${escapeHtml(s.heading.label)}</span>` : ''}<span class="value">${escapeHtml(s.heading.value)}</span></div>` : '';
  const fields = s.fields?.length ? `<div class="fields">${s.fields.map((f) => `<div class="f"><span class="k">${escapeHtml(f.label)}</span><span class="v${f.mono ? ' mono' : ''}">${escapeHtml(f.value)}</span></div>`).join('')}</div>` : '';
  const body = s.rows.map((r) => `<tr${r.kind === 'total' ? ' class="total"' : ''}>${r.cells.map((c, i) => renderCell(c, columns[i])).join('')}</tr>`).join('');
  return `<div class="section${s.pageBreakBefore ? ' break' : ''}">${superHeading}${heading}${fields}<table>${renderHeader(columns)}<tbody>${body}</tbody></table></div>`;
}

/** Full HTML document for one report. Header/footer are separate templates (Chromium repeats them per page). */
export function renderHtml(doc: ReportDocument): string {
  const legend = doc.legend?.length
    ? `<div class="legend"><div class="lt">${escapeHtml(doc.legendTitle)}</div><div class="items">${doc.legend.map((l) => `<span>${escapeHtml(l.code)} - ${escapeHtml(l.label)}</span>`).join(' ; ')}</div>${doc.notes.length ? `<div class="notes">${doc.notes.map(escapeHtml).join('<br>')}</div>` : ''}</div>`
    : doc.notes.length ? `<div class="legend"><div class="notes">${doc.notes.map(escapeHtml).join('<br>')}</div></div>` : '';
  const end = doc.endOfReport ? `<div class="end">${escapeHtml(doc.endOfReportLabel)}</div><div class="end-title">${escapeHtml(doc.title)}</div>` : '';
  return `<!doctype html><html lang="${doc.locale}" dir="${doc.dir}"><head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>${CSS}</style></head><body>`
    + `<div class="head"><div class="company">${escapeHtml(doc.company)}</div><div class="title">${escapeHtml(doc.title)}</div>${doc.period ? `<div class="period">${escapeHtml(doc.period)}</div>` : ''}</div>`
    + doc.sections.map((s, i) => renderSection(doc, s, i === 0 || doc.sections[i - 1]!.superHeading !== s.superHeading)).join('')
    + legend + end
    + `</body></html>`;
}

/** Chromium footer template: generation stamp on the start side, "Page X of Y" on the end side. */
export function footerTemplate(doc: ReportDocument): string {
  const page = doc.pageLabel('<span class="pageNumber"></span>', '<span class="totalPages"></span>');
  const dir = doc.dir;
  return `<div dir="${dir}" style="width:100%;font-size:7pt;font-family:'Noto Sans','Noto Sans Arabic',Arial,sans-serif;color:#333;padding:0 12mm;display:flex;justify-content:space-between;"><span>${escapeHtml(doc.generatedLabel)}</span><span>${page}</span></div>`;
}

export async function renderPdf(doc: ReportDocument, pdf: PdfRenderer): Promise<Buffer> {
  return pdf.render(renderHtml(doc), { landscape: doc.orientation === 'landscape', footerHtml: footerTemplate(doc), marginMm: PAGE_MARGIN_MM });
}

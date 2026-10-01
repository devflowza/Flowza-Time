import { lopDaysOf } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { deriveHours, eachDateInclusive, hoursColonMinutes, type DerivedHours } from '@flowza/domain';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, loadShiftAndPolicy, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type ReportCell, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import { monthPeriod } from './month-period.js';
import type { ReportDefinition } from './types.js';

interface Day { record: DailyRecord | undefined; hours: DerivedHours | null }

/** One hour row of the grid: its caption, the minutes of a day (null = nothing to print that day), how a value prints. */
interface HourRow { label: string; minutes: (d: Day) => number | null; text: (minutes: number) => string }

/**
 * An hour value inside the grid. Unlike the Daily Report's dash, a zero prints as an empty cell so the days that DO carry
 * overtime, under time or lateness stand out across the month; spreadsheets still get the 0 for a worked day.
 */
const hourCell = (minutes: number | null, text: (m: number) => string): ReportCell => (minutes === null ? EMPTY_CELL : num(minutes, minutes > 0 ? text(minutes) : '', { mono: true, align: 'center' }));

function hourRows(ctx: ReportContext): HourRow[] {
  const inNotation = (m: number) => ctx.hours(m, { zeroAsValue: true });
  // late / early only on a worked day: the engine leaves 0 on the others, and an absence is not "0 minutes late"
  const worked = (d: Day, minutes: (r: DailyRecord) => number) => (d.record && d.hours && d.hours.worked !== null ? minutes(d.record) : null);
  return [
    { label: ctx.t('col.workHrs'), minutes: (d) => d.hours?.span ?? null, text: hoursColonMinutes },
    { label: ctx.t('col.totHrs'), minutes: (d) => d.hours?.worked ?? null, text: inNotation },
    { label: ctx.t('col.baseHrs'), minutes: (d) => d.hours?.scheduled ?? null, text: inNotation },
    { label: ctx.t('col.ot1'), minutes: (d) => d.hours?.ot1 ?? null, text: inNotation },
    { label: ctx.t('col.ot2'), minutes: (d) => d.hours?.ot2 ?? null, text: inNotation },
    { label: ctx.t('col.ut'), minutes: (d) => d.hours?.ut ?? null, text: inNotation },
    { label: ctx.t('col.late'), minutes: (d) => worked(d, (r) => Math.max(0, r.lateMinutes)), text: inNotation },
    { label: ctx.t('col.early'), minutes: (d) => worked(d, (r) => Math.max(0, r.earlyDepartureMinutes)), text: inNotation },
  ];
}

/** `PR 20 · OF 8 · AB 2` — days per code as the grid prints them, in the legend's order (codes it does not list last). */
function dayCounts(ctx: ReportContext, codes: readonly string[], order: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const c of codes) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  const rank = (c: string) => { const i = order.indexOf(c); return i === -1 ? order.length : i; };
  return [...counts.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, ctx.locale)).map(([c, n]) => `${c} ${n}`).join(' · ');
}

/**
 * Monthly Detail Report — the Daily Report's detail for a whole month. One block per employee (identity block, then a grid
 * with the days of the month as columns): the attendance code, first IN, last OUT, Wrk Hrs (the IN → OUT span), Tot Hrs,
 * Base Hrs, OT1, OT2, UT, Late and Early for every day, a Total column for the hour rows, and the days per code with the
 * loss-of-pay days in the identity block. Landscape and compact so 31 days fit; a block never splits across pages.
 * Employees employed at any point in the month appear (the Monthly Attendance Report's roster); a day without a record
 * is blank, so a gap in processing is visible.
 */
export const monthlyDetail: ReportDefinition = {
  key: 'monthly_detail',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { month, from, to, whole } = monthPeriod(ctx.params);
    const days = eachDateInclusive(from, to);
    const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const shiftPolicy = await loadShiftAndPolicy(trx, ctx, roster, to);
    const byEmployee = new Map<string, Map<string, DailyRecord>>();
    for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }
    const legendOrder = (ctx.legend() ?? []).map((l) => l.code);
    const hours = hourRows(ctx);
    let anyLop = false;

    const sections: ReportSection[] = roster.map((e: RosterEmployee) => {
      const own = byEmployee.get(e.id);
      const grid: Day[] = days.map((d) => { const record = own?.get(d); return { record, hours: record ? deriveHours(record) : null }; });
      const codes = grid.map((d) => (d.record ? ctx.code(codeInputOf(d.record)) : null));
      const caption = (label: string) => cell(label, { bold: true });
      const rows: ReportRow[] = [
        { cells: [caption(ctx.t('col.attCode')), ...codes.map((c) => (c ? cell(c.code, { tone: TONE_OF_GROUP[c.group] ?? 'default', align: 'center', bold: true }) : EMPTY_CELL)), EMPTY_CELL] },
        { cells: [caption(ctx.t('col.inTime')), ...grid.map((d) => (d.record ? cell(ctx.clock(d.record.firstInAt, d.record.timezone), { align: 'center' }) : EMPTY_CELL)), EMPTY_CELL] },
        { cells: [caption(ctx.t('col.outTime')), ...grid.map((d) => (d.record ? cell(ctx.clock(d.record.lastOutAt, d.record.timezone), { align: 'center' }) : EMPTY_CELL)), EMPTY_CELL] },
        ...hours.map((h): ReportRow => {
          const values = grid.map((d) => h.minutes(d));
          const total = values.reduce<number>((sum, m) => sum + (m ?? 0), 0);
          return { cells: [caption(h.label), ...values.map((m) => hourCell(m, h.text)), num(total, h.text(total), { mono: true, bold: true })] };
        }),
      ];
      const lop = grid.reduce((sum, d) => sum + (d.record ? lopDaysOf(d.record.flags) : 0), 0);
      if (lop > 0) anyLop = true;
      const counts = dayCounts(ctx, codes.map((c) => c?.code ?? ''), legendOrder);
      const lopText = lop > 0 ? `${ctx.t('col.lop')} ${Number.isInteger(lop) ? lop : lop.toFixed(1)}` : '';
      const sp = shiftPolicy.get(e.id);
      return {
        fields: [
          { label: ctx.t('field.employee'), value: `${e.employeeNumber}  ${e.displayName}` },
          { label: ctx.t('field.dept'), value: e.departmentName ?? ctx.t('group.na') },
          { label: ctx.t('field.cardNo'), value: e.cardNumber ?? '', mono: true },
          { label: ctx.t('field.shift'), value: sp?.shift ?? '' },
          { label: ctx.t('field.designation'), value: e.designationName ?? '' },
          { label: ctx.t('field.days'), value: [counts, lopText].filter(Boolean).join(' · ') },
        ],
        rows,
        keepTogether: true,
      };
    });
    // the weekday under each day number: a short name in English, the narrow form in Arabic (its short name is the full word)
    const weekday = ctx.locale === 'ar' ? 'ccccc' : 'ccc';
    const columns: ReportColumn[] = [
      { key: 'item', label: ctx.t('col.day'), width: 9 },
      ...days.map((d): ReportColumn => ({ key: d, label: String(Number(d.slice(8, 10))), subLabel: ctx.date(d, weekday), align: 'center', width: 5 })),
      { key: 'total', label: ctx.t('col.total'), align: 'end', width: 7, mono: true },
    ];
    return {
      key: 'monthly_detail', title: ctx.t('report.monthly_detail.title'), company: ctx.company,
      period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', density: 'compact', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [...ctx.notes(), ctx.t('footer.monthlyDetail'), ...(anyLop ? [ctx.t('footer.lop')] : [])],
      endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: true }, fileStem: whole ? `monthly-detail-${month}` : `monthly-detail-${from}-${to}`,
    };
  },
};

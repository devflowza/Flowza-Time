import { lopDaysOf } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { deriveHours, eachDateInclusive } from '@flowza/domain';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, loadShiftAndPolicy, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type ReportCell, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { codeCell, hoursColumns, punchRows } from './daily.js';
import { dayCounts } from './monthly-detail.js';
import type { MonthPeriod } from './month-period.js';

/** Records the engine writes for days the employee was not on the payroll print only their date, as on the Daily Report. */
const OFF_PAYROLL = new Set(['EXITED', 'NOT_JOINED']);

/**
 * Monthly Attendance Report, `layout: detailed` — the Daily Report's rows for a whole month, one page per employee: every day
 * of the month with its attendance code and one row per IN/OUT pair (hours on the day's last row, as the Daily Report prints
 * them), then a total row; the identity block counts the days per code. Same roster as the summary grid (everyone employed
 * at some point in the month); a day without a record prints only its date, so a gap in processing is visible.
 */
export async function buildMonthlyDetailed(trx: Trx, ctx: ReportContext, period: MonthPeriod): Promise<ReportDocument> {
  const { month, from, to, whole } = period;
  const days = eachDateInclusive(from, to);
  const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
  const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
  const shiftPolicy = await loadShiftAndPolicy(trx, ctx, roster, to);
  const byEmployee = new Map<string, Map<string, DailyRecord>>();
  for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }
  const legendOrder = (ctx.legend() ?? []).map((l) => l.code);
  const blanks = (n: number): ReportCell[] => Array.from({ length: n }, () => EMPTY_CELL);
  const total = (minutes: number): ReportCell => num(minutes, ctx.hours(minutes, { zeroAsValue: true }), { mono: true, bold: true });
  let anyLop = false;

  const sections: ReportSection[] = roster.map((e: RosterEmployee, i) => {
    const own = byEmployee.get(e.id);
    const totals = { worked: 0, scheduled: 0, ot1: 0, ot2: 0, ut: 0 };
    const codes: string[] = [];
    let lop = 0;
    const rows: ReportRow[] = days.flatMap((d): ReportRow[] => {
      const dateCell = cell(ctx.date(d, 'dd-MMM-yy ccc'), { mono: true });
      const r = own?.get(d);
      if (!r || OFF_PAYROLL.has(r.status)) return [{ cells: [dateCell, ...blanks(9)] }];
      codes.push(ctx.code(codeInputOf(r)).code);
      lop += lopDaysOf(r.flags);
      const h = deriveHours(r);
      if (h.worked !== null) { totals.worked += h.worked; totals.scheduled += h.scheduled ?? 0; totals.ot1 += h.ot1 ?? 0; totals.ot2 += h.ot2 ?? 0; totals.ut += h.ut ?? 0; }
      return punchRows(ctx, r, [dateCell, codeCell(ctx, r)]);
    });
    // Wrk Hrs has no total: a day with several visits prints only its last visit's span, so the column does not add up
    rows.push({ kind: 'total', cells: [cell(ctx.t('group.total'), { bold: true }), ...blanks(4), total(totals.worked), total(totals.scheduled), total(totals.ot1), total(totals.ot2), total(totals.ut)] });
    if (lop > 0) anyLop = true;
    const lopText = lop > 0 ? `${ctx.t('col.lop')} ${Number.isInteger(lop) ? lop : lop.toFixed(1)}` : '';
    const sp = shiftPolicy.get(e.id);
    return {
      fields: [
        { label: ctx.t('field.employee'), value: `${e.employeeNumber}  ${e.displayName}` },
        { label: ctx.t('field.dept'), value: e.departmentName ?? ctx.t('group.na') },
        { label: ctx.t('field.cardNo'), value: e.cardNumber ?? '', mono: true },
        { label: ctx.t('field.shift'), value: sp?.shift ?? '' },
        { label: ctx.t('field.designation'), value: e.designationName ?? '' },
        { label: ctx.t('field.days'), value: [dayCounts(ctx, codes, legendOrder), lopText].filter(Boolean).join(' · ') },
      ],
      rows,
      pageBreakBefore: i > 0,
    };
  });
  const columns: ReportColumn[] = [
    { key: 'date', label: ctx.t('col.date'), width: 13, mono: true },
    { key: 'code', label: ctx.t('col.attCode'), align: 'center', width: 6 },
    { key: 'in', label: ctx.t('col.inTime'), width: 9 },
    { key: 'out', label: ctx.t('col.outTime'), width: 9 },
    ...hoursColumns(ctx),
  ];
  return {
    key: 'monthly_attendance', title: ctx.t('report.monthly_attendance.detailedTitle'), company: ctx.company,
    period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
    legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [...ctx.notes(), ctx.t('footer.monthlyDetailed'), ...(anyLop ? [ctx.t('footer.lop')] : [])],
    endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
    generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
    rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: true }, fileStem: whole ? `monthly-attendance-detailed-${month}` : `monthly-attendance-detailed-${from}-${to}`,
  };
}

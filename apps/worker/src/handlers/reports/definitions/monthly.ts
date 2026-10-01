import { lopDaysOf } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { eachDateInclusive } from '@flowza/domain';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import { monthPeriod } from './month-period.js';
import { buildMonthlyDetailed } from './monthly-detailed.js';
import type { ReportDefinition } from './types.js';

/**
 * Sample 4 — Monthly Attendance Report: one row per employee, one column per day of the month carrying the attendance
 * code (coloured as the samples print them), and an absence count. Landscape. Employees employed at any point in the
 * month appear; a day without a record is blank. A trailing LOP column (HR portal Prompt 3) carries the loss-of-pay days
 * of the month (0.5 steps, `lopDaysOf`), after the sample's own columns so their positions do not move.
 * `layout: detailed` prints the Daily Report's rows for every day of the month instead (`monthly-detailed.ts`).
 */
export const monthlyAttendance: ReportDefinition = {
  key: 'monthly_attendance',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    // the month, or its first days up to `to` for a month-to-date run (review minor 13: never a day after the period)
    const period = monthPeriod(ctx.params);
    if (ctx.params.layout === 'detailed') return buildMonthlyDetailed(trx, ctx, period);
    const { month, from, to, whole } = period;
    const days = eachDateInclusive(from, to);
    const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const byEmployee = new Map<string, Map<string, DailyRecord>>();
    for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }

    const rows = roster.map((e) => {
      const own = byEmployee.get(e.id);
      let absent = 0;
      let lop = 0;
      const dayCells = days.map((d) => {
        const r = own?.get(d);
        if (!r) return EMPTY_CELL;
        if (r.status === 'ABSENT') absent += 1;
        lop += lopDaysOf(r.flags);
        const code = ctx.code(codeInputOf(r));
        const tone = TONE_OF_GROUP[code.group] ?? 'default';
        return cell(code.code, { tone, align: 'center', bold: true });
      });
      return { cells: [cell(e.employeeNumber, { mono: true }), cell(e.displayName), ...dayCells, num(absent, String(absent), { bold: true }), num(lop, Number.isInteger(lop) ? String(lop) : lop.toFixed(1), { bold: lop > 0 })] };
    });
    const sections: ReportSection[] = [{ rows }];
    const columns: ReportColumn[] = [
      { key: 'empId', label: ctx.t('col.empId'), width: 7, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 22 },
      ...days.map((d) => ({ key: d, label: String(Number(d.slice(8, 10))), align: 'center' as const, width: 3 })),
      { key: 'abs', label: ctx.t('col.abs'), align: 'end', width: 4 },
      { key: 'lop', label: ctx.t('col.lop'), align: 'end', width: 4 },
    ];
    return {
      key: 'monthly_attendance', title: ctx.t('report.monthly_attendance.title'), company: ctx.company,
      period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [ctx.t('footer.lop')], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false }, fileStem: whole ? `monthly-attendance-${month}` : `monthly-attendance-${from}-${to}`,
    };
  },
};

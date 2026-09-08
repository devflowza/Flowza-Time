import { DateTime } from 'luxon';
import type { Trx } from '@flowza/database';
import { eachDateInclusive } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import type { ReportDefinition } from './types.js';

/**
 * Sample 4 — Monthly Attendance Report: one row per employee, one column per day of the month carrying the attendance
 * code (coloured as the samples print them), and an absence count. Landscape. Employees employed at any point in the
 * month appear; a day without a record is blank.
 */
export const monthlyAttendance: ReportDefinition = {
  key: 'monthly_attendance',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const month = ctx.params.month;
    if (!month) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.month', message: 'Required' }] });
    const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
    if (!start.isValid) throw errors.validation('Invalid month.', { issues: [{ path: 'parameters.month', message: 'Expected YYYY-MM' }] });
    const from = start.toISODate()!;
    const to = start.endOf('month').toISODate()!;
    const days = eachDateInclusive(from, to);
    const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const byEmployee = new Map<string, Map<string, DailyRecord>>();
    for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }

    const rows = roster.map((e) => {
      const own = byEmployee.get(e.id);
      let absent = 0;
      const dayCells = days.map((d) => {
        const r = own?.get(d);
        if (!r) return EMPTY_CELL;
        if (r.status === 'ABSENT') absent += 1;
        const code = ctx.code(codeInputOf(r));
        const tone = TONE_OF_GROUP[code.group] ?? 'default';
        return cell(code.code, { tone, align: 'center', bold: true });
      });
      return { cells: [cell(e.employeeNumber, { mono: true }), cell(e.displayName), ...dayCells, num(absent, String(absent), { bold: true })] };
    });
    const sections: ReportSection[] = [{ rows }];
    const columns: ReportColumn[] = [
      { key: 'empId', label: ctx.t('col.empId'), width: 7, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 22 },
      ...days.map((d) => ({ key: d, label: String(Number(d.slice(8, 10))), align: 'center' as const, width: 3 })),
      { key: 'abs', label: ctx.t('col.abs'), align: 'end', width: 4 },
    ];
    return {
      key: 'monthly_attendance', title: ctx.t('report.monthly_attendance.title'), company: ctx.company,
      period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false }, fileStem: `monthly-attendance-${month}`,
    };
  },
};

import type { Trx } from '@flowza/database';
import { dayList } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { groupByDepartment, loadRoster, sortByEmployeeNumber } from '../data/roster.js';
import { cell, countRows, num, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

export interface DayListSpec {
  key: ReportDefinition['key'];
  /** Which records count for this list. */
  matches: (ctx: ReportContext, r: DailyRecord) => boolean;
  title: (ctx: ReportContext) => string;
  fileStem: (ctx: ReportContext, from: string, to: string) => string;
  endOfReport: boolean;
}

/**
 * Samples 6, 7, 8, 9 share one layout: per department, a numbered list of employees with the day numbers of the month
 * on which something happened (absence, lateness, a given leave) and how many such days. Employees with nothing to
 * list are omitted; departments are alphabetical with "N/A" for the department-less.
 */
export function dayListReport(spec: DayListSpec): ReportDefinition {
  return {
    key: spec.key,
    async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
      const { from, to } = ctx.params;
      if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
      const records = await loadRecords(trx, ctx, { from, to });
      const hits = new Map<string, string[]>();
      for (const r of records) if (spec.matches(ctx, r)) hits.set(r.employeeId, [...(hits.get(r.employeeId) ?? []), r.attendanceDate]);
      const roster = await loadRoster(trx, ctx, { employeeIds: [...hits.keys()] });
      const groups = groupByDepartment(ctx, roster, (e) => e.departmentName);
      const sections: ReportSection[] = groups.map((g) => ({
        heading: { label: ctx.t('group.departmentPlain'), value: g.label },
        rows: sortByEmployeeNumber(g.items).map((e, i) => {
          const dates = hits.get(e.id) ?? [];
          return { cells: [num(i + 1, String(i + 1), { align: 'end' }), cell(e.employeeNumber, { mono: true }), cell(e.displayName), cell(dayList(dates), { mono: true, wrap: true }), num(dates.length, String(dates.length))] };
        }),
      }));
      const employeeGroup = ctx.t('col.employeeCodeName');
      const columns: ReportColumn[] = [
        { key: 'sr', label: ctx.t('col.sr'), align: 'end', width: 4 },
        { key: 'code', label: ctx.t('col.empCode'), width: 8, mono: true, group: employeeGroup },
        { key: 'name', label: ctx.t('col.empName'), width: 26, group: employeeGroup },
        { key: 'days', label: ctx.t('col.dateOfMonth'), width: 40, mono: true },
        { key: 'count', label: ctx.t('col.noOfDays'), align: 'end', width: 8 },
      ];
      return {
        key: spec.key, title: spec.title(ctx), company: ctx.company,
        period: ctx.t('period.date', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
        legend: null, legendTitle: ctx.t('legend.title'), notes: [], endOfReport: spec.endOfReport, endOfReportLabel: ctx.t('group.endOfReport'),
        generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
        rowCount: countRows(sections), flatten: { headingColumnLabel: ctx.t('col.department'), fieldColumns: false }, fileStem: spec.fileStem(ctx, from, to),
      };
    },
  };
}

/** Sample 6 — Staff Absents Monthly Report. */
export const absenceReport = dayListReport({
  key: 'absence_report',
  matches: (_ctx, r) => r.status === 'ABSENT',
  title: (ctx) => ctx.t('report.absence_report.title'),
  fileStem: (_ctx, from, to) => `absent-report-${from}-${to}`,
  endOfReport: false,
});

/** Sample 8 — Staff Late Attendance Report: days the engine flagged LATE under the tenant's grace and threshold. */
export const lateReport = dayListReport({
  key: 'late_report',
  matches: (_ctx, r) => r.flags.includes('LATE'),
  title: (ctx) => ctx.t('report.late_report.title'),
  fileStem: (_ctx, from, to) => `late-report-${from}-${to}`,
  endOfReport: false,
});

/** Samples 7 and 9 — one leave type's days (parameter `leaveTypeCode`), with the "End Of Report" trailer they print. */
export const leaveReport = dayListReport({
  key: 'leave_report',
  matches: (ctx, r) => {
    const wanted = String(ctx.params.leaveTypeCode ?? '').toUpperCase();
    return wanted !== '' && (r.status === 'LEAVE' || r.flags.includes('HALF_DAY_LEAVE')) && ctx.code(codeInputOf(r)).code.toUpperCase() === wanted;
  },
  title: (ctx) => {
    const code = String(ctx.params.leaveTypeCode ?? '').toUpperCase();
    const lt = ctx.leaveTypes.find((l) => l.code.toUpperCase() === code);
    return ctx.t('report.leave_report.title', { leaveType: (ctx.locale === 'ar' && lt?.nameAr) || lt?.name || code });
  },
  fileStem: (ctx, from, to) => `leave-${String(ctx.params.leaveTypeCode ?? 'all').toLowerCase()}-${from}-${to}`,
  endOfReport: true,
});

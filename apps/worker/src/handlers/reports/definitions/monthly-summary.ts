import { attendanceSummaryRows, attendanceSummaryTotals, type AttendanceSummaryDbFigures, type AttendanceSummaryScope, type Trx } from '@flowza/database';
import { formatDays } from '@flowza/domain';
import type { ReportContext } from '../context.js';
import { cell, countRows, EMPTY_CELL, num, type ReportCell, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { monthPeriod } from './month-period.js';
import type { ReportDefinition } from './types.js';

const uuidList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

/**
 * Monthly Attendance Summary (HR portal Prompt 6a review — defects 8, 10): one row per employee for a month — present (a half day
 * counts ½), late, half days, leave, absent, missed punch, holidays, weekly offs, days worked, worked / overtime / average hours,
 * loss of pay and unexcused days, and whether the counts are the finalised payroll period's — plus a total row (printed layouts;
 * a spreadsheet recomputes it). The figures come from `attendanceSummaryRows`, the ONE definition the summary page, the profile's
 * month strip and the print statement read, so the file always equals the screen. It is the summary page's export (queued by
 * POST /attendance/summary/export) and an ordinary report type (Reports page, Send now, schedules).
 *
 * Scope, applied here explicitly because the worker runs in the organisation's system context: the explicit / injected branches
 * select the employees (current branch, as the page filters them) and the injected `branchScope` restricts the DAYS to the
 * requester's branches (what their RLS shows); `employeeIds` is a filter or a line manager's team; `search` the page's search;
 * `finalizedFigures` whether the requester may see finalised period counts (payroll.view), as on the page.
 */
export const monthlySummary: ReportDefinition = {
  key: 'monthly_summary',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { month, from, to, whole } = monthPeriod(ctx.params);
    const scope: AttendanceSummaryScope = {
      employeeBranchIds: ctx.scope.branchIds,
      recordBranchIds: uuidList(ctx.params['branchScope']),
      departmentId: ctx.scope.departmentId,
      employeeIds: ctx.scope.employeeIds,
      search: typeof ctx.params['search'] === 'string' && ctx.params['search'].trim() ? ctx.params['search'].trim() : null,
      includeFinalized: ctx.params['finalizedFigures'] === true,
    };
    const rows = await attendanceSummaryRows(trx, ctx.organizationId, { from, to }, scope, null);
    const totals = await attendanceSummaryTotals(trx, ctx.organizationId, { from, to }, scope);
    const branchIds = [...new Set(rows.map((r) => r.branchId))];
    const branches = branchIds.length
      ? new Map((await trx.selectFrom('branches').select(['id', 'name', 'nameAr']).where('organizationId', '=', ctx.organizationId).where('id', 'in', branchIds).execute()).map((b) => [b.id, (ctx.locale === 'ar' && b.nameAr) || b.name]))
      : new Map<string, string>();

    const days = (n: number, bold = false): ReportCell => num(n, formatDays(n, { zeroAsDash: true }), { align: 'center', bold });
    const hours = (minutes: number, bold = false): ReportCell => num(Math.round((minutes / 60) * 100) / 100, ctx.hours(minutes, { zeroAsValue: true }), { mono: true, bold });
    const figures = (f: AttendanceSummaryDbFigures, bold = false): ReportCell[] => [
      days(f.presentDays, bold), days(f.lateDays, bold), days(f.halfDays, bold), days(f.leaveDays, bold), days(f.absentDays, bold), days(f.missingPunchDays, bold),
      days(f.holidayDays, bold), days(f.weeklyOffDays, bold), days(f.daysWorked, bold), hours(f.workedMinutes, bold), hours(f.overtimeMinutes, bold), hours(f.averageWorkedMinutes, bold),
      days(f.lopDays, bold || f.lopDays > 0), days(f.unexcusedDays, bold),
    ];
    const data: ReportRow[] = rows.map((r) => ({ cells: [
      cell(r.employeeNumber, { mono: true }), cell(r.employeeName), cell(branches.get(r.branchId) ?? ''), cell(r.departmentId ? ctx.departments.get(r.departmentId) ?? '' : ''),
      ...figures(r), cell(r.finalizedAt ? ctx.t('source.finalized') : ctx.t('source.live')),
    ] }));
    const total: ReportRow = { kind: 'total', cells: [EMPTY_CELL, cell(ctx.t('group.total'), { bold: true }), EMPTY_CELL, EMPTY_CELL, ...figures(totals.totals, true), EMPTY_CELL] };
    const sections: ReportSection[] = [{ rows: rows.length ? [...data, total] : [] }];
    const c = (key: string, label: string, width = 6): ReportColumn => ({ key, label, align: 'center', width });
    const h = (key: string, label: string): ReportColumn => ({ key, label, align: 'end', width: 7, mono: true });
    const columns: ReportColumn[] = [
      { key: 'empNo', label: ctx.t('col.employeeNo'), width: 8, mono: true },
      { key: 'employee', label: ctx.t('col.employee'), width: 22 },
      { key: 'branch', label: ctx.t('col.branch'), width: 12 },
      { key: 'department', label: ctx.t('col.department'), width: 12 },
      c('present', ctx.t('col.present')), c('late', ctx.t('col.late')), c('half', ctx.t('col.halfDays')), c('leave', ctx.t('col.onLeave')), c('absent', ctx.t('col.absent')),
      c('missing', ctx.t('col.missedPunch')), c('holiday', ctx.t('col.holidays')), c('weeklyOff', ctx.t('col.weeklyOffs')), c('daysWorked', ctx.t('col.daysWorked')),
      h('worked', ctx.t('col.workedHours')), h('overtime', ctx.t('col.overtimeHours')), h('average', ctx.t('col.avgHoursPerDay')),
      c('lop', ctx.t('col.lopDays')), c('unexcused', ctx.t('col.unexcusedDays')),
      { key: 'source', label: ctx.t('col.source'), width: 7 },
    ];
    return {
      key: 'monthly_summary', title: ctx.t('report.monthly_summary.title'), company: ctx.company,
      period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', columns, sections,
      legend: null, legendTitle: ctx.t('legend.title'), notes: [ctx.t('footer.summary', { notation: ctx.t(`notation.${ctx.notation}`) }), ctx.t('footer.lop')],
      endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false },
      fileStem: whole ? `attendance-summary-${month}` : `attendance-summary-${from}-${to}`,
    };
  },
};

import type { Trx } from '@flowza/database';
import type { EmploymentStatus } from '@flowza/contracts';
import type { ReportContext } from '../context.js';
import { ACTIVE_STATUSES, groupByDepartment, INACTIVE_STATUSES, loadRoster, loadShiftAndPolicy } from '../data/roster.js';
import { cell, countRows, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

/**
 * Samples 11 and 12 — Employees Report (active) and Inactive employee report: the same layout filtered by employment
 * status. Shift and Policy are the shift and attendance rule set in force for the employee today.
 */
export const employeeDirectory: ReportDefinition = {
  key: 'employee_directory',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const which = ctx.params.employmentStatus ?? 'active';
    const statuses: readonly EmploymentStatus[] | null = which === 'active' ? ACTIVE_STATUSES : which === 'inactive' ? INACTIVE_STATUSES : null;
    const roster = await loadRoster(trx, ctx, { statuses });
    const shiftPolicy = await loadShiftAndPolicy(trx, ctx, roster, ctx.today);
    const groups = groupByDepartment(ctx, roster, (e) => e.departmentName);
    const active = new Set<string>(ACTIVE_STATUSES);
    const sections: ReportSection[] = groups.map((g) => ({
      heading: { label: '', value: g.label },
      rows: g.items.map((e) => {
        const sp = shiftPolicy.get(e.id);
        return { cells: [
          cell(e.employeeNumber, { mono: true }), cell(e.cardNumber ?? '', { mono: true }), cell(e.displayName), cell(ctx.date(e.joiningDate), { mono: true }), cell(e.designationName ?? ''),
          cell(active.has(e.employmentStatus) ? ctx.t('status.active') : ctx.t('status.inactive'), { tone: active.has(e.employmentStatus) ? 'default' : 'muted' }),
          cell(sp?.shift ?? ''), cell(sp?.policy ?? ''),
        ] };
      }),
    }));
    const columns: ReportColumn[] = [
      { key: 'id', label: ctx.t('col.id'), width: 8, mono: true },
      { key: 'card', label: ctx.t('col.cardNo'), width: 9, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 28 },
      { key: 'hire', label: ctx.t('col.hireDate'), width: 11, mono: true },
      { key: 'desg', label: ctx.t('col.designationFull'), width: 22 },
      { key: 'status', label: ctx.t('col.status'), width: 8 },
      { key: 'shift', label: ctx.t('col.shift'), width: 12 },
      { key: 'policy', label: ctx.t('col.policy'), width: 12 },
    ];
    return {
      key: 'employee_directory', title: ctx.t(which === 'inactive' ? 'report.employee_directory.inactiveTitle' : 'report.employee_directory.title'), company: ctx.company, period: null, orientation: 'landscape', columns, sections,
      legend: null, legendTitle: ctx.t('legend.title'), notes: [], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: ctx.t('col.department'), fieldColumns: false }, fileStem: `employees-${which}-${ctx.today}`,
    };
  },
};

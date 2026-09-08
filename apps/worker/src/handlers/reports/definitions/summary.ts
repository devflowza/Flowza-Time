import type { Trx } from '@flowza/database';
import { formatDays, hoursColonMinutes, leaveGroupOf, summariseCodes } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster } from '../data/roster.js';
import { cell, countRows, num, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

/**
 * Sample 3 — Summary Report: one row per employee for the period, day counts per attendance code grouped into
 * T/PR · T/OL · T/AB exactly as the sample orders them (PR HL OF [present-type leave] HP T/PR | [paid leave types]
 * T/OL | AB [unpaid leave types] T/AB), then OT1, OT2 as h:mm and UT in the tenant's notation. The leave columns are
 * the tenant's own leave types, so a tenant with CL and EL gets CL and EL columns.
 */
export const attendanceSummary: ReportDefinition = {
  key: 'attendance_summary',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { from, to } = ctx.params;
    if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
    const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const byEmployee = new Map<string, DailyRecord[]>();
    for (const r of records) byEmployee.set(r.employeeId, [...(byEmployee.get(r.employeeId) ?? []), r]);

    const presentTypes = ctx.leaveTypes.filter((l) => leaveGroupOf(l.code, ctx.leaveTypes) === 'present');
    const paidTypes = ctx.leaveTypes.filter((l) => leaveGroupOf(l.code, ctx.leaveTypes) === 'leave');
    const unpaidTypes = ctx.leaveTypes.filter((l) => leaveGroupOf(l.code, ctx.leaveTypes) === 'absent');
    const codeOf = (status: string) => ctx.code({ status, flags: [] }).code;
    const count = (n: number) => num(n, formatDays(n, { zeroAsDash: true }), { align: 'center' });
    const total = (n: number) => num(n, formatDays(n, { alwaysDecimal: true }), { align: 'center', bold: true });

    const rows = roster.map((e) => {
      const s = summariseCodes((byEmployee.get(e.id) ?? []).map((r) => ({ status: r.status, flags: r.flags, leaveTypeCode: r.leave?.code ?? null, firstInAt: r.firstInAt, lastOutAt: r.lastOutAt, workedMinutes: r.workedMinutes, scheduledMinutes: r.scheduledMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: r.overtimeCategory })), ctx.leaveTypes);
      const leaveDays = (code: string) => Object.entries(s.leave).filter(([k]) => k.toUpperCase() === code.toUpperCase()).reduce((a, [, v]) => a + v, 0);
      return { cells: [
        cell(e.employeeNumber, { mono: true }), cell(e.displayName),
        count(s.present), count(s.holiday), count(s.weeklyOff), ...presentTypes.map((l) => count(leaveDays(l.code))), count(s.halfDayPresent), total(s.totalPresent),
        ...paidTypes.map((l) => count(leaveDays(l.code))), total(s.totalLeave),
        count(s.absent), ...unpaidTypes.map((l) => count(leaveDays(l.code))), total(s.totalAbsent),
        num(s.ot1Minutes, hoursColonMinutes(s.ot1Minutes), { mono: true }), num(s.ot2Minutes, hoursColonMinutes(s.ot2Minutes), { mono: true }), num(s.utMinutes, ctx.hours(s.utMinutes, { zeroAsValue: true }), { mono: true }),
      ] };
    });
    const sections: ReportSection[] = [{ rows }];
    const c = (key: string, label: string, width = 4): ReportColumn => ({ key, label, align: 'center', width });
    const columns: ReportColumn[] = [
      { key: 'id', label: ctx.t('col.id'), width: 7, mono: true },
      { key: 'name', label: ctx.t('col.employeeName'), width: 24 },
      c('pr', codeOf('PRESENT')), c('hl', codeOf('HOLIDAY')), c('of', codeOf('WEEKLY_OFF')), ...presentTypes.map((l) => c(`lt-${l.code}`, l.code)), c('hp', ctx.t('col.halfPresent')), c('tpr', ctx.t('col.totalPresent'), 5),
      ...paidTypes.map((l) => c(`lt-${l.code}`, l.code)), c('tol', ctx.t('col.totalLeave'), 5),
      c('ab', codeOf('ABSENT')), ...unpaidTypes.map((l) => c(`lt-${l.code}`, l.code)), c('tab', ctx.t('col.totalAbsent'), 5),
      { key: 'ot1', label: ctx.t('col.ot1'), align: 'end', width: 6, mono: true }, { key: 'ot2', label: ctx.t('col.ot2'), align: 'end', width: 6, mono: true }, { key: 'ut', label: ctx.t('col.ut'), align: 'end', width: 6, mono: true },
    ];
    return {
      key: 'attendance_summary', title: ctx.t('report.attendance_summary.title'), company: ctx.company,
      period: ctx.t('period.forPeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: ctx.notes(), endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false }, fileStem: `summary-report-${from}-${to}`,
    };
  },
};

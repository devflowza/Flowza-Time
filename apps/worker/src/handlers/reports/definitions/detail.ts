import type { Trx } from '@flowza/database';
import { DASH, deriveHours, eachDateInclusive, hoursColonMinutes } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { asDate, chunk, isoDate } from '../../attendance/common.js';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, loadShiftAndPolicy, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import type { ReportDefinition } from './types.js';

/** Reasons of corrections applied to (employee, date) — the closest thing to the sample's free-text Remarks (decision #5). */
async function loadRemarks(trx: Trx, ctx: ReportContext, employeeIds: readonly string[], from: string, to: string): Promise<Map<string, string>> {
  const out = new Map<string, string[]>();
  for (const batch of chunk(employeeIds, 1000)) {
    if (!batch.length) continue;
    const rows = await trx.selectFrom('attendanceCorrections').select(['employeeId', 'attendanceDate', 'reason'])
      .where('organizationId', '=', ctx.organizationId).where('employeeId', 'in', batch).where('status', '=', 'APPLIED')
      .where('attendanceDate', '>=', asDate(from)).where('attendanceDate', '<=', asDate(to)).orderBy('appliedAt', 'asc').execute();
    for (const r of rows) { const k = `${r.employeeId}|${isoDate(r.attendanceDate)}`; out.set(k, [...(out.get(k) ?? []), r.reason]); }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.join('; ')]));
}

function detailRow(ctx: ReportContext, date: string, r: DailyRecord | undefined, remark: string | undefined): ReportRow {
  const dateCell = cell(ctx.date(date, 'dd-MMM-yy ccc'), { mono: true });
  if (!r) return { cells: [dateCell, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, cell(remark ?? '')] };
  const code = ctx.code(codeInputOf(r));
  const tone = TONE_OF_GROUP[code.group] ?? 'default';
  const h = deriveHours(r);
  const hours = h.worked === null
    ? [EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL]
    : [
      num(h.scheduled, ctx.hours(h.scheduled, { zeroAsValue: true }), { mono: true }),
      num(h.span, h.span === null ? DASH : hoursColonMinutes(h.span), { mono: true }),
      num(h.worked, ctx.hours(h.worked), { mono: true }),
      num(h.ot1, ctx.hours(h.ot1), { mono: true }),
      num(h.ot2, ctx.hours(h.ot2), { mono: true }),
      num(h.ut, ctx.hours(h.ut), { mono: true }),
    ];
  return { cells: [dateCell, cell(code.code, { tone, align: 'center', bold: tone !== 'default' }), cell(ctx.clock(r.firstInAt, r.timezone)), cell(ctx.clock(r.lastOutAt, r.timezone)), ...hours, cell(remark ?? '')] };
}

/**
 * Sample 2 — Detail Report: one employee per page with an identity block (Employee, Card No, Shift, Dept, Designation),
 * one row per calendar day of the period, and a totals row for Tot Hrs / OT1 / OT2 / UT. Days without a record print
 * only the date, so a gap in processing is visible rather than silently skipped.
 */
export const employeeAttendance: ReportDefinition = {
  key: 'employee_attendance',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { from, to } = ctx.params;
    if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
    if (!ctx.scope.employeeIds?.length) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.employeeIds', message: 'Required' }] });
    const days = eachDateInclusive(from, to);
    if (days.length > 366) throw errors.validation('The period may not exceed one year.');
    const roster = await loadRoster(trx, ctx, { employeeIds: ctx.scope.employeeIds });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const shiftPolicy = await loadShiftAndPolicy(trx, ctx, roster, to);
    const remarks = await loadRemarks(trx, ctx, roster.map((e) => e.id), from, to);
    const byEmployee = new Map<string, Map<string, DailyRecord>>();
    for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }

    const sections: ReportSection[] = roster.map((e: RosterEmployee, i) => {
      const own = byEmployee.get(e.id) ?? new Map<string, DailyRecord>();
      const rows = days.map((d) => detailRow(ctx, d, own.get(d), remarks.get(`${e.id}|${d}`)));
      const totals = { worked: 0, ot1: 0, ot2: 0, ut: 0 };
      for (const r of own.values()) { const h = deriveHours(r); if (h.worked !== null) { totals.worked += h.worked; totals.ot1 += h.ot1 ?? 0; totals.ot2 += h.ot2 ?? 0; totals.ut += h.ut ?? 0; } }
      rows.push({ kind: 'total', cells: [EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, num(totals.worked, ctx.hours(totals.worked, { zeroAsValue: true }), { mono: true, bold: true }), num(totals.ot1, ctx.hours(totals.ot1, { zeroAsValue: true }), { mono: true, bold: true }), num(totals.ot2, ctx.hours(totals.ot2, { zeroAsValue: true }), { mono: true, bold: true }), num(totals.ut, ctx.hours(totals.ut, { zeroAsValue: true }), { mono: true, bold: true }), EMPTY_CELL] });
      const sp = shiftPolicy.get(e.id);
      return {
        fields: [
          { label: ctx.t('field.employee'), value: `${e.employeeNumber}  ${e.displayName}` },
          { label: ctx.t('field.dept'), value: e.departmentName ?? ctx.t('group.na') },
          { label: ctx.t('field.cardNo'), value: e.cardNumber ?? '', mono: true },
          { label: ctx.t('field.shift'), value: sp?.shift ?? '' },
          { label: ctx.t('field.designation'), value: e.designationName ?? '' },
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
      { key: 'base', label: ctx.t('col.baseHrs'), align: 'end', width: 7, mono: true },
      { key: 'work', label: ctx.t('col.workHrsFull'), align: 'end', width: 7, mono: true },
      { key: 'tot', label: ctx.t('col.totHrs'), align: 'end', width: 7, mono: true },
      { key: 'ot1', label: ctx.t('col.ot1'), align: 'end', width: 6, mono: true },
      { key: 'ot2', label: ctx.t('col.ot2'), align: 'end', width: 6, mono: true },
      { key: 'ut', label: ctx.t('col.ut'), align: 'end', width: 6, mono: true },
      { key: 'remarks', label: ctx.t('col.remarks'), width: 20 },
    ];
    return {
      key: 'employee_attendance', title: ctx.t('report.employee_attendance.title'), company: ctx.company,
      period: ctx.t('period.fromTo', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: ctx.notes(), endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: true }, fileStem: `detail-report-${from}-${to}`,
    };
  },
};

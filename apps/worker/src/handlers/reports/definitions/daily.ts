import type { Trx } from '@flowza/database';
import { DASH, deriveHours, minutesBetweenInstants, pairPunches, type DerivedHours } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { groupByDepartment, loadRoster, sortByEmployeeNumber, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type CellTone, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

export const TONE_OF_GROUP: Record<string, CellTone> = { present: 'default', off: 'off', holiday: 'holiday', leave: 'leave', absent: 'absent', none: 'muted' };

function hourCells(ctx: ReportContext, h: DerivedHours | null) {
  if (!h) return [cell(DASH, { align: 'end' }), cell(DASH, { align: 'end' }), cell(DASH, { align: 'end' }), cell(DASH, { align: 'end' }), cell(DASH, { align: 'end' }), cell(DASH, { align: 'end' })];
  const spanText = h.span === null ? DASH : ctx.hours(h.span, { zeroAsValue: true }) === DASH ? DASH : `${Math.floor(h.span / 60)}:${String(h.span % 60).padStart(2, '0')}`;
  return [
    num(h.span, spanText, { mono: true }),
    num(h.worked, ctx.hours(h.worked), { mono: true }),
    num(h.scheduled, ctx.hours(h.scheduled, { zeroAsValue: false }), { mono: true }),
    num(h.ot1, ctx.hours(h.ot1), { mono: true }),
    num(h.ot2, ctx.hours(h.ot2), { mono: true }),
    num(h.ut, ctx.hours(h.ut), { mono: true }),
  ];
}

/** Rows for one employee on one day: one per IN/OUT pair, hours on the last row only (as the sample prints them). */
export function dailyRowsFor(ctx: ReportContext, e: RosterEmployee, r: DailyRecord): ReportRow[] {
  const code = ctx.code(codeInputOf(r));
  const tone = TONE_OF_GROUP[code.group] ?? 'default';
  const lead = [cell(e.employeeNumber, { mono: true }), cell(e.displayName), cell(e.designationName ?? ''), cell(code.code, { tone, align: 'center', bold: tone !== 'default' })];
  const pairs = pairPunches(r.punches);
  if (pairs.length === 0) {
    const worked = r.firstInAt || r.lastOutAt;
    const hours = worked ? hourCells(ctx, deriveHours(r)) : [EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL, EMPTY_CELL];
    return [{ cells: [...lead, cell(ctx.clock(r.firstInAt, r.timezone)), cell(ctx.clock(r.lastOutAt, r.timezone)), ...hours] }];
  }
  return pairs.map((p, i) => {
    const last = i === pairs.length - 1;
    // Wrk Hrs is the span of THIS visit; the record's first_in/last_out would span every visit of the day.
    const hours = last ? hourCells(ctx, { ...deriveHours(r), span: minutesBetweenInstants(p.inAt, p.outAt) }) : hourCells(ctx, null);
    return { cells: [...lead, cell(ctx.clock(p.inAt, r.timezone)), cell(ctx.clock(p.outAt, r.timezone)), ...hours] };
  });
}

export function hoursColumns(ctx: ReportContext): ReportColumn[] {
  return [
    { key: 'work', label: ctx.t('col.workHrs'), align: 'end', width: 7, mono: true },
    { key: 'tot', label: ctx.t('col.totHrs'), align: 'end', width: 7, mono: true },
    { key: 'base', label: ctx.t('col.baseHrs'), align: 'end', width: 7, mono: true },
    { key: 'ot1', label: ctx.t('col.ot1'), align: 'end', width: 6, mono: true },
    { key: 'ot2', label: ctx.t('col.ot2'), align: 'end', width: 6, mono: true },
    { key: 'ut', label: ctx.t('col.ut'), align: 'end', width: 6, mono: true },
  ];
}

/**
 * Sample 1 — Daily Report: every employee with a record on one day, grouped by department, one row per IN/OUT pair,
 * hours in the tenant's notation, the attendance-code legend underneath.
 */
export const dailyAttendance: ReportDefinition = {
  key: 'daily_attendance',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const date = ctx.params.from;
    if (!date) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }] });
    // A record whose status is NOT_JOINED or EXITED belongs to someone who was not on the payroll that day (the engine
    // writes one for every employee a range recalculation touches); the daily sheet lists only the day's staff.
    const records = (await loadRecords(trx, ctx, { from: date, to: date })).filter((r) => r.status !== 'EXITED' && r.status !== 'NOT_JOINED');
    const roster = await loadRoster(trx, ctx, { employeeIds: [...new Set(records.map((r) => r.employeeId))] });
    const byEmployee = new Map(roster.map((e) => [e.id, e]));
    type Item = { e: RosterEmployee; r: DailyRecord };
    const items: Item[] = [];
    for (const r of records) { const e = byEmployee.get(r.employeeId); if (e) items.push({ e, r }); }
    const groups = groupByDepartment(ctx, items, (i) => (i.r.departmentId ? ctx.departments.get(i.r.departmentId) ?? null : null));
    const sections: ReportSection[] = groups.map((g) => ({
      heading: { label: ctx.t('group.department'), value: g.label },
      rows: sortByEmployeeNumber(g.items.map((i) => ({ ...i, employeeNumber: i.e.employeeNumber }))).flatMap((i) => dailyRowsFor(ctx, i.e, i.r)),
    }));
    const columns: ReportColumn[] = [
      { key: 'empId', label: ctx.t('col.empId'), width: 8, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 26 },
      { key: 'desg', label: ctx.t('col.designation'), width: 18 },
      { key: 'code', label: ctx.t('col.attCode'), align: 'center', width: 6 },
      { key: 'in', label: ctx.t('col.inTime'), width: 9 },
      { key: 'out', label: ctx.t('col.outTime'), width: 9 },
      ...hoursColumns(ctx),
    ];
    return {
      key: 'daily_attendance', title: ctx.t('report.daily_attendance.title'), company: ctx.company,
      period: ctx.date(date, 'cccc, d MMMM, yyyy'), orientation: 'portrait', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: ctx.notes(), endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: ctx.t('col.department'), fieldColumns: false }, fileStem: `daily-report-${date}`,
    };
  },
};

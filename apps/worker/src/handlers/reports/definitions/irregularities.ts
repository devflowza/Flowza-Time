import type { Trx } from '@flowza/database';
import { eachDateInclusive, irregularitiesOf, naturalCompare, shortfallMinutes, type IrregularityKind } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { asDate, chunk, isoDate, toDate } from '../../attendance/common.js';
import type { ReportContext } from '../context.js';
import { loadRecords, matchesStatusFilter, type DailyRecord } from '../data/records.js';
import { groupByDepartment, loadRoster, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, num, type ReportCell, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { codeCell } from './daily.js';
import type { ReportDefinition } from './types.js';

/** The longest period one irregular cases report covers (a year of a department; narrow by branch beyond). */
export const IRREGULARITIES_MAX_DAYS = 366;

interface DayNote { category: string; status: string }

/**
 * The reason an employee gave for each (employee, day) — the latest attendance note of the day — so the report says whether the
 * irregularity is explained and where its review stands. Category and review status only: the free text stays in the app.
 */
async function loadDayNotes(trx: Trx, ctx: ReportContext, employeeIds: readonly string[], from: string, to: string): Promise<Map<string, DayNote>> {
  const out = new Map<string, DayNote & { at: number }>();
  for (const batch of chunk(employeeIds, 1000)) {
    if (!batch.length) continue;
    const rows = await trx.selectFrom('attendanceNotes').select(['employeeId', 'attendanceDate', 'category', 'status', 'submittedAt'])
      .where('organizationId', '=', ctx.organizationId).where('employeeId', 'in', batch)
      .where('attendanceDate', '>=', asDate(from)).where('attendanceDate', '<=', asDate(to)).execute();
    for (const r of rows) {
      const key = `${r.employeeId}|${isoDate(r.attendanceDate)}`;
      const at = toDate(r.submittedAt).getTime();
      const seen = out.get(key);
      if (!seen || at > seen.at) out.set(key, { category: String(r.category), status: String(r.status), at });
    }
  }
  return new Map([...out.entries()].map(([k, v]) => [k, { category: v.category, status: v.status }]));
}

interface Case { e: RosterEmployee; r: DailyRecord; kinds: IrregularityKind[]; late: number; early: number; short: number; note: DayNote | null }

interface Tally { late: number; lateMin: number; early: number; earlyMin: number; absent: number; missing: number; short: number; shortMin: number; unexcused: number; cases: number }

const minutesCell = (v: number): ReportCell => num(v > 0 ? v : null, v > 0 ? String(v) : '', { mono: true });

/**
 * "Irregular cases" (customer requirement 2026-10-19: a morning report to each direct manager, a monthly one to the Director
 * General): one row per employee-day with an irregularity — late arrival, early departure, absence, a missing check-in or
 * check-out, short hours, an unexcused day (`irregularitiesOf`, @flowza/domain) — with the late / early / short minutes and the
 * employee's reason and its review status; grouped by department, employees in natural order, then by date. A summary per
 * employee follows (its own sheet in XLSX, below the list in CSV). Scope as every attendance report: branch, department, employees
 * and the requester's injected scope (a line manager's copy carries their team in `employeeIds`); `status` narrows the days.
 */
export const irregularitiesReport: ReportDefinition = {
  key: 'irregularities_report',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { from, to } = ctx.params;
    if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
    if (eachDateInclusive(from, to).length > IRREGULARITIES_MAX_DAYS) throw errors.validation('The period may not exceed one year.');
    const records = (await loadRecords(trx, ctx, { from, to })).filter((r) => matchesStatusFilter(r, ctx.params.status));
    const flagged = records.map((r) => ({ r, kinds: irregularitiesOf(r) })).filter((x) => x.kinds.length > 0);
    const roster = await loadRoster(trx, ctx, { employeeIds: [...new Set(flagged.map((x) => x.r.employeeId))] });
    const byEmployee = new Map(roster.map((e) => [e.id, e]));
    const notes = await loadDayNotes(trx, ctx, roster.map((e) => e.id), from, to);
    const cases: Case[] = [];
    for (const { r, kinds } of flagged) {
      const e = byEmployee.get(r.employeeId);
      if (!e) continue;
      cases.push({
        e, r, kinds,
        late: kinds.includes('LATE') ? Math.max(0, r.lateMinutes) : 0,
        early: kinds.includes('EARLY_DEPARTURE') ? Math.max(0, r.earlyDepartureMinutes) : 0,
        short: kinds.includes('UNDER_HOURS') ? shortfallMinutes(r) : 0,
        note: notes.get(`${r.employeeId}|${r.attendanceDate}`) ?? null,
      });
    }

    const reasonCells = (note: DayNote | null): ReportCell[] => note
      ? [cell(ctx.t(`reason.${note.category}`)), cell(ctx.t(`reasonStatus.${note.status}`), { tone: note.status === 'rejected' ? 'danger' : note.status === 'pending' || note.status === 'info_requested' ? 'warning' : 'success' })]
      : [cell(ctx.t('reason.none'), { tone: 'muted' }), cell('')];
    const groups = groupByDepartment(ctx, cases, (c) => (c.r.departmentId ? ctx.departments.get(c.r.departmentId) ?? null : null));
    const sections: ReportSection[] = groups.map((g) => ({
      heading: { label: ctx.t('group.department'), value: g.label },
      rows: [...g.items].sort((a, b) => naturalCompare(a.e.employeeNumber, b.e.employeeNumber) || a.r.attendanceDate.localeCompare(b.r.attendanceDate)).map((c): ReportRow => ({
        cells: [
          cell(ctx.date(c.r.attendanceDate), { mono: true }),
          cell(c.e.employeeNumber, { mono: true }),
          cell(c.e.displayName),
          codeCell(ctx, c.r),
          cell(ctx.clock(c.r.firstInAt, c.r.timezone)),
          cell(ctx.clock(c.r.lastOutAt, c.r.timezone)),
          cell(c.kinds.map((k) => ctx.t(`irregularity.${k}`)).join(', '), { tone: c.kinds.includes('ABSENT') || c.kinds.includes('UNEXCUSED') ? 'danger' : 'warning' }),
          minutesCell(c.late),
          minutesCell(c.early),
          minutesCell(c.short),
          ...reasonCells(c.note),
        ],
      })),
    }));

    // summary per employee: the counts a manager reads first
    const tallies = new Map<string, Tally>();
    for (const c of cases) {
      const t = tallies.get(c.e.id) ?? { late: 0, lateMin: 0, early: 0, earlyMin: 0, absent: 0, missing: 0, short: 0, shortMin: 0, unexcused: 0, cases: 0 };
      t.cases += 1;
      if (c.kinds.includes('LATE')) { t.late += 1; t.lateMin += c.late; }
      if (c.kinds.includes('EARLY_DEPARTURE')) { t.early += 1; t.earlyMin += c.early; }
      if (c.kinds.includes('ABSENT')) t.absent += 1;
      if (c.kinds.includes('MISSING_IN') || c.kinds.includes('MISSING_OUT')) t.missing += 1;
      if (c.kinds.includes('UNDER_HOURS')) { t.short += 1; t.shortMin += c.short; }
      if (c.kinds.includes('UNEXCUSED')) t.unexcused += 1;
      tallies.set(c.e.id, t);
    }
    const summaryTitle = ctx.t('report.irregularities_report.summaryTitle');
    const na = ctx.t('group.na');
    const summaryColumns: ReportColumn[] = [
      { key: 'empId', label: ctx.t('col.empId'), width: 8, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 24 },
      { key: 'dept', label: ctx.t('col.department'), width: 16 },
      { key: 'lateDays', label: ctx.t('col.lateDays'), align: 'end', width: 6 },
      { key: 'lateMin', label: ctx.t('col.lateMin'), align: 'end', width: 7, mono: true },
      { key: 'earlyDays', label: ctx.t('col.earlyDays'), align: 'end', width: 6 },
      { key: 'earlyMin', label: ctx.t('col.earlyMin'), align: 'end', width: 7, mono: true },
      { key: 'absent', label: ctx.t('col.absentDays'), align: 'end', width: 6 },
      { key: 'missing', label: ctx.t('col.missingPunchDays'), align: 'end', width: 6 },
      { key: 'shortDays', label: ctx.t('col.shortDays'), align: 'end', width: 6 },
      { key: 'shortMin', label: ctx.t('col.shortMin'), align: 'end', width: 7, mono: true },
      { key: 'unexcused', label: ctx.t('col.unexcusedDays'), align: 'end', width: 6 },
      { key: 'cases', label: ctx.t('col.cases'), align: 'end', width: 6 },
    ];
    const count = (v: number) => num(v, String(v));
    const summaryRows: ReportRow[] = [...tallies.entries()]
      .map(([id, t]) => ({ e: byEmployee.get(id)!, t }))
      // the list's order: departments by name ("N/A" sorts as its label), then employee numbers in natural order
      .sort((a, b) => (a.e.departmentName ?? na).localeCompare(b.e.departmentName ?? na, ctx.locale, { sensitivity: 'base' }) || naturalCompare(a.e.employeeNumber, b.e.employeeNumber))
      .map(({ e, t }) => ({ cells: [cell(e.employeeNumber, { mono: true }), cell(e.displayName), cell(e.departmentName ?? na), count(t.late), count(t.lateMin), count(t.early), count(t.earlyMin), count(t.absent), count(t.missing), count(t.short), count(t.shortMin), count(t.unexcused), count(t.cases)] }));
    if (summaryRows.length) sections.push({ superHeading: summaryTitle, columns: summaryColumns, rows: summaryRows, sheet: summaryTitle, pageBreakBefore: sections.length > 0 });

    const columns: ReportColumn[] = [
      { key: 'date', label: ctx.t('col.date'), width: 10, mono: true },
      { key: 'empId', label: ctx.t('col.empId'), width: 8, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 22 },
      { key: 'code', label: ctx.t('col.attCode'), align: 'center', width: 6 },
      { key: 'in', label: ctx.t('col.inTime'), width: 8 },
      { key: 'out', label: ctx.t('col.outTime'), width: 8 },
      { key: 'irregularity', label: ctx.t('col.irregularity'), width: 22 },
      { key: 'late', label: ctx.t('col.lateMin'), align: 'end', width: 7, mono: true },
      { key: 'early', label: ctx.t('col.earlyMin'), align: 'end', width: 7, mono: true },
      { key: 'short', label: ctx.t('col.shortMin'), align: 'end', width: 7, mono: true },
      { key: 'reason', label: ctx.t('col.reason'), width: 14 },
      { key: 'reasonStatus', label: ctx.t('col.reasonStatus'), width: 12 },
    ];
    return {
      key: 'irregularities_report', title: ctx.t('report.irregularities_report.title'), company: ctx.company,
      period: from === to ? ctx.date(from, 'cccc, d MMMM, yyyy') : ctx.t('period.fromTo', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'landscape', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [ctx.t('footer.irregularities')], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: ctx.t('col.department'), fieldColumns: false }, fileStem: from === to ? `irregular-cases-${from}` : `irregular-cases-${from}-${to}`,
    };
  },
};

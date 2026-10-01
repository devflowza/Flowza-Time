import type { Trx } from '@flowza/database';
import { deriveHours, eachDateInclusive, shiftHoursVerdict, type DerivedHours, type ShiftHoursVerdict } from '@flowza/domain';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, loadShiftNames, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, num, type CellTone, type ReportCell, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import { monthPeriod } from './month-period.js';
import type { ReportDefinition } from './types.js';

const VERDICT_TONE: Record<ShiftHoursVerdict, CellTone> = { MET: 'success', SHORT: 'danger', MISSED_PUNCH: 'warning' };

/** The hour figures of one worked day; null on a day not worked (absence, leave, a plain day off) or without a record. */
interface WorkedDay { hours: DerivedHours & { worked: number; scheduled: number }; overtime: number; late: number; early: number; verdict: ShiftHoursVerdict | null }

function workedDay(r: DailyRecord | undefined): WorkedDay | null {
  if (!r) return null;
  const h = deriveHours(r);
  if (h.worked === null || h.scheduled === null) return null;
  return {
    hours: { ...h, worked: h.worked, scheduled: h.scheduled },
    overtime: (h.ot1 ?? 0) + (h.ot2 ?? 0),
    // late / early only on a worked day: the engine leaves 0 on the others, and an absence is not "0 minutes late"
    late: Math.max(0, r.lateMinutes),
    early: Math.max(0, r.earlyDepartureMinutes),
    verdict: shiftHoursVerdict(r),
  };
}

/**
 * Monthly Timesheet Report — each employee's month as a timesheet, one page per employee: a row per day with the day's
 * shift, attendance code, check-in (first IN) and check-out (last OUT), the hours the shift requires (Base Hrs) against the
 * hours worked (Tot Hrs), whether the shift's hours were met, overtime (OT1 + OT2), under time, late and early, and a total
 * row; the identity block counts the days the shift's hours were met (no Shift field: the shift is printed per day, so a
 * rotation shows). Answers "did everyone do their 8 hours, and by how much over or under" without the engine's columns.
 * Employees employed at any point in the month appear (the Monthly Attendance Report's roster); a day without a record
 * prints only its date, so a gap in processing is visible.
 */
export const monthlyTimesheet: ReportDefinition = {
  key: 'monthly_timesheet',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { month, from, to, whole } = monthPeriod(ctx.params);
    const days = eachDateInclusive(from, to);
    const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
    const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
    const shiftNames = await loadShiftNames(trx, ctx);
    const byEmployee = new Map<string, Map<string, DailyRecord>>();
    for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }
    const hrs = (minutes: number, opts: { zeroAsValue?: boolean; bold?: boolean } = {}): ReportCell => num(minutes, ctx.hours(minutes, { zeroAsValue: opts.zeroAsValue ?? false }), { mono: true, ...(opts.bold ? { bold: true } : {}) });
    const blanks = (n: number): ReportCell[] => Array.from({ length: n }, () => EMPTY_CELL);

    const sections: ReportSection[] = roster.map((e: RosterEmployee, i) => {
      const own = byEmployee.get(e.id);
      const totals = { required: 0, worked: 0, overtime: 0, underTime: 0, late: 0, early: 0, met: 0, judged: 0 };
      const rows: ReportRow[] = days.map((d): ReportRow => {
        const dateCell = cell(ctx.date(d, 'dd-MMM-yy ccc'), { mono: true });
        const r = own?.get(d);
        if (!r) return { cells: [dateCell, ...blanks(11)] };
        const code = ctx.code(codeInputOf(r));
        const tone = TONE_OF_GROUP[code.group] ?? 'default';
        const lead = [dateCell, cell(r.shiftId ? shiftNames.get(r.shiftId) ?? '' : ''), cell(code.code, { tone, align: 'center', bold: tone !== 'default' }), cell(ctx.clock(r.firstInAt, r.timezone)), cell(ctx.clock(r.lastOutAt, r.timezone))];
        const w = workedDay(r);
        if (!w) return { cells: [...lead, ...blanks(7)] };
        const ut = w.hours.ut ?? 0;
        totals.required += w.hours.scheduled; totals.worked += w.hours.worked; totals.overtime += w.overtime; totals.underTime += ut; totals.late += w.late; totals.early += w.early;
        if (w.verdict) { totals.judged += 1; if (w.verdict === 'MET') totals.met += 1; }
        const verdict = w.verdict ? cell(ctx.t(`hoursMet.${w.verdict}`), { tone: VERDICT_TONE[w.verdict], align: 'center', bold: true }) : EMPTY_CELL;
        return { cells: [...lead, hrs(w.hours.scheduled, { zeroAsValue: true }), hrs(w.hours.worked, { zeroAsValue: true }), verdict, hrs(w.overtime), hrs(ut), hrs(w.late), hrs(w.early)] };
      });
      rows.push({
        kind: 'total',
        cells: [
          cell(ctx.t('group.total'), { bold: true }), ...blanks(4),
          hrs(totals.required, { zeroAsValue: true, bold: true }), hrs(totals.worked, { zeroAsValue: true, bold: true }),
          totals.judged > 0 ? cell(`${totals.met}/${totals.judged}`, { align: 'center', mono: true, bold: true }) : EMPTY_CELL,
          hrs(totals.overtime, { zeroAsValue: true, bold: true }), hrs(totals.underTime, { zeroAsValue: true, bold: true }), hrs(totals.late, { zeroAsValue: true, bold: true }), hrs(totals.early, { zeroAsValue: true, bold: true }),
        ],
      });
      return {
        fields: [
          { label: ctx.t('field.employee'), value: `${e.employeeNumber}  ${e.displayName}` },
          { label: ctx.t('field.dept'), value: e.departmentName ?? ctx.t('group.na') },
          { label: ctx.t('field.cardNo'), value: e.cardNumber ?? '', mono: true },
          { label: ctx.t('field.designation'), value: e.designationName ?? '' },
          { label: ctx.t('field.hoursMet'), value: totals.judged > 0 ? ctx.t('hoursMet.summary', { met: totals.met, days: totals.judged }) : '' },
        ],
        rows,
        pageBreakBefore: i > 0,
      };
    });
    const columns: ReportColumn[] = [
      { key: 'date', label: ctx.t('col.date'), width: 13, mono: true },
      { key: 'shift', label: ctx.t('col.shift'), width: 12 },
      { key: 'code', label: ctx.t('col.attCode'), align: 'center', width: 6 },
      { key: 'in', label: ctx.t('col.checkIn'), width: 9 },
      { key: 'out', label: ctx.t('col.checkOut'), width: 9 },
      { key: 'shiftHrs', label: ctx.t('col.shiftHrs'), align: 'end', width: 7, mono: true },
      { key: 'worked', label: ctx.t('col.workedHrs'), align: 'end', width: 7, mono: true },
      { key: 'hoursMet', label: ctx.t('col.hoursMet'), align: 'center', width: 8 },
      { key: 'overtime', label: ctx.t('col.overtime'), align: 'end', width: 7, mono: true },
      { key: 'underTime', label: ctx.t('col.underTime'), align: 'end', width: 7, mono: true },
      { key: 'late', label: ctx.t('col.late'), align: 'end', width: 6, mono: true },
      { key: 'early', label: ctx.t('col.early'), align: 'end', width: 6, mono: true },
    ];
    return {
      key: 'monthly_timesheet', title: ctx.t('report.monthly_timesheet.title'), company: ctx.company,
      period: ctx.t('period.forThePeriod', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
      legend: ctx.legend(), legendTitle: ctx.t('legend.title'), notes: [ctx.t('footer.timesheet', { notation: ctx.t(`notation.${ctx.notation}`) })],
      endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: true }, fileStem: whole ? `monthly-timesheet-${month}` : `monthly-timesheet-${from}-${to}`,
    };
  },
};

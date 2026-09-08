import type { Trx } from '@flowza/database';
import { weekRange } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { codeInputOf, loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, EMPTY_CELL, type ReportColumn, type ReportDocument, type ReportSection } from '../model.js';
import { TONE_OF_GROUP } from './daily.js';
import type { ReportDefinition } from './types.js';

interface WeekData { days: string[]; from: string; to: string; roster: RosterEmployee[]; byEmployee: Map<string, Map<string, DailyRecord>> }

/** The week containing `parameters.from`, starting on the tenant's first day of the week, with everyone employed in it. */
async function loadWeek(trx: Trx, ctx: ReportContext): Promise<WeekData> {
  const anchor = ctx.params.from;
  if (!anchor) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }] });
  const { from, to, days } = weekRange(anchor, ctx.firstDayOfWeek);
  const roster = await loadRoster(trx, ctx, { employedBetween: { from, to } });
  const records = await loadRecords(trx, ctx, { from, to, employeeIds: roster.map((e) => e.id) });
  const byEmployee = new Map<string, Map<string, DailyRecord>>();
  for (const r of records) { const m = byEmployee.get(r.employeeId) ?? new Map<string, DailyRecord>(); m.set(r.attendanceDate, r); byEmployee.set(r.employeeId, m); }
  return { days, from, to, roster, byEmployee };
}

const common = (ctx: ReportContext, w: WeekData, sections: ReportSection[], columns: ReportColumn[]) => ({
  company: ctx.company, columns, sections, legendTitle: ctx.t('legend.title'), endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
  generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
  rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false } as ReportDocument['flatten'], fileStem: `week-${w.from}`,
});

/**
 * Sample 5 — Weekly Report: one row per employee, two sub-columns per day (MornWT = first IN, EvenWT = last OUT) under a
 * two-level header carrying the weekday and date; `_` where nothing was recorded. Landscape.
 */
export const weeklyAttendance: ReportDefinition = {
  key: 'weekly_attendance',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const w = await loadWeek(trx, ctx);
    const mark = (v: string) => (v === '' ? '_' : v);
    const rows = w.roster.map((e) => {
      const own = w.byEmployee.get(e.id);
      return { cells: [cell(e.employeeNumber, { mono: true, align: 'center' }), cell(e.displayName), ...w.days.flatMap((d) => { const r = own?.get(d); return [cell(mark(ctx.clock(r?.firstInAt ?? null, r?.timezone)), { align: 'center', mono: true }), cell(mark(ctx.clock(r?.lastOutAt ?? null, r?.timezone)), { align: 'center', mono: true })]; })] };
    });
    const sections: ReportSection[] = [{ rows }];
    const columns: ReportColumn[] = [
      { key: 'id', label: ctx.t('col.id'), width: 8, mono: true, align: 'center' },
      { key: 'name', label: ctx.t('col.name'), width: 22 },
      ...w.days.flatMap((d) => { const group = `${ctx.date(d, 'ccc')} ${ctx.date(d, 'dd/MMM/yyyy')}`; return [{ key: `${d}-in`, label: ctx.t('col.mornWt'), group, align: 'center' as const, width: 6, mono: true }, { key: `${d}-out`, label: ctx.t('col.evenWt'), group, align: 'center' as const, width: 6, mono: true }]; }),
    ];
    return { key: 'weekly_attendance', title: ctx.t('report.weekly_attendance.title'), period: ctx.t('period.week', { from: ctx.date(w.from), to: ctx.date(w.to) }), orientation: 'landscape', legend: null, notes: [], ...common(ctx, w, sections, columns), fileStem: `weekly-report-${w.from}` };
  },
};

/**
 * Sample 14 — Weekly In/Out Report: one column per day; a worked day stacks IN over OUT (`00:00` standing for the
 * missing side), a day without punches shows its attendance code (SD, AL, AB, OF …). Portrait, with the code legend.
 */
export const weeklyInOut: ReportDefinition = {
  key: 'weekly_in_out',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const w = await loadWeek(trx, ctx);
    const clock = (v: string | null, zone: string) => (v ? ctx.clock(v, zone) : '00:00');
    const rows = w.roster.map((e) => {
      const own = w.byEmployee.get(e.id);
      return { cells: [cell(e.employeeNumber, { mono: true }), cell(e.displayName), ...w.days.map((d) => {
        const r = own?.get(d);
        if (!r) return EMPTY_CELL;
        if (r.firstInAt || r.lastOutAt) { const lines = [clock(r.firstInAt, r.timezone), clock(r.lastOutAt, r.timezone)]; return cell(lines.join(' / '), { lines, align: 'center', mono: true }); }
        const code = ctx.code(codeInputOf(r));
        const tone = TONE_OF_GROUP[code.group] ?? 'default';
        return cell(code.code, { tone, align: 'center', bold: tone !== 'default' });
      })] };
    });
    const sections: ReportSection[] = [{ rows }];
    const columns: ReportColumn[] = [
      { key: 'code', label: ctx.t('col.empCode'), width: 9, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 26 },
      ...w.days.map((d) => ({ key: d, label: `${ctx.date(d, 'ccc')} ${d.slice(8, 10)}`, align: 'center' as const, width: 7 })),
    ];
    return { key: 'weekly_in_out', title: ctx.t('report.weekly_in_out.title'), period: ctx.t('period.fromTo', { from: ctx.headerDate(w.from), to: ctx.headerDate(w.to) }), orientation: 'portrait', legend: ctx.legend(), notes: [], ...common(ctx, w, sections, columns), fileStem: `weekly-in-out-${w.from}` };
  },
};

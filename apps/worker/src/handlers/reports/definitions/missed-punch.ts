import type { Trx } from '@flowza/database';
import { naturalCompare, pairPunches } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ReportContext } from '../context.js';
import { loadRecords, type DailyRecord } from '../data/records.js';
import { loadRoster, type RosterEmployee } from '../data/roster.js';
import { cell, countRows, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

/**
 * Sample 10 — Missed Punch Report: every unpaired punch of the period, grouped by date and then department, showing the
 * time that was recorded in the IN or OUT column and leaving the missing side blank. Pairs come from the record's
 * trace, so PAIRED tenants see each visit; FIRST_LAST tenants see the day's single missing side.
 */
export const missingPunchReport: ReportDefinition = {
  key: 'missing_punch_report',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { from, to } = ctx.params;
    if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
    const records = await loadRecords(trx, ctx, { from, to });
    type Hit = { r: DailyRecord; inAt: string | null; outAt: string | null };
    const hits: Hit[] = [];
    for (const r of records) {
      const pairs = pairPunches(r.punches);
      if (pairs.length) { for (const p of pairs) if (!p.inAt !== !p.outAt) hits.push({ r, inAt: p.inAt, outAt: p.outAt }); }
      else if ((r.flags.includes('MISSING_IN') || r.flags.includes('MISSING_OUT')) && (r.firstInAt || r.lastOutAt) && !(r.firstInAt && r.lastOutAt)) hits.push({ r, inAt: r.firstInAt, outAt: r.lastOutAt });
    }
    const roster = await loadRoster(trx, ctx, { employeeIds: [...new Set(hits.map((h) => h.r.employeeId))] });
    const byEmployee = new Map(roster.map((e) => [e.id, e]));
    const na = ctx.t('group.na');
    // date → department → rows
    const byDate = new Map<string, Map<string, Array<Hit & { e: RosterEmployee }>>>();
    for (const h of hits) {
      const e = byEmployee.get(h.r.employeeId); if (!e) continue;
      const dept = (h.r.departmentId ? ctx.departments.get(h.r.departmentId) : null) ?? na;
      const depts = byDate.get(h.r.attendanceDate) ?? new Map<string, Array<Hit & { e: RosterEmployee }>>();
      depts.set(dept, [...(depts.get(dept) ?? []), { ...h, e }]);
      byDate.set(h.r.attendanceDate, depts);
    }
    const sections: ReportSection[] = [];
    for (const date of [...byDate.keys()].sort()) {
      const depts = byDate.get(date)!;
      const dateLabel = ctx.date(date, 'dd/MMM/yyyy');
      for (const dept of [...depts.keys()].sort((a, b) => a.localeCompare(b, ctx.locale, { sensitivity: 'base' }))) {
        const items = depts.get(dept)!.sort((a, b) => naturalCompare(a.e.employeeNumber, b.e.employeeNumber) || (a.inAt ?? a.outAt ?? '').localeCompare(b.inAt ?? b.outAt ?? ''));
        const rows: ReportRow[] = items.map((h) => ({ cells: [cell(h.e.employeeNumber, { mono: true }), cell(h.e.displayName), cell(ctx.clock(h.inAt, h.r.timezone)), cell(ctx.clock(h.outAt, h.r.timezone))] }));
        sections.push({ superHeading: dateLabel, heading: { label: '', value: dept }, rows });
      }
    }
    const columns: ReportColumn[] = [
      { key: 'code', label: ctx.t('col.empCode'), width: 9, mono: true },
      { key: 'name', label: ctx.t('col.empName'), width: 30 },
      { key: 'in', label: `${ctx.t('col.inTime')}`, width: 10 },
      { key: 'out', label: `${ctx.t('col.outTime')}`, width: 10 },
    ];
    return {
      key: 'missing_punch_report', title: ctx.t('report.missing_punch_report.title'), company: ctx.company,
      period: ctx.t('period.fromTo', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
      legend: null, legendTitle: ctx.t('legend.title'), notes: [], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: ctx.t('col.department'), superHeadingColumnLabel: ctx.t('col.date'), fieldColumns: false }, fileStem: `missed-punch-${from}-${to}`,
    };
  },
};

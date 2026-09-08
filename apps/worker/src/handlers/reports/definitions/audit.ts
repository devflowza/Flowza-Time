import { DateTime } from 'luxon';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import { asArray, asObject, chunk, isoDate, toDate } from '../../attendance/common.js';
import type { ReportContext } from '../context.js';
import { loadRoster } from '../data/roster.js';
import { cell, countRows, type ReportColumn, type ReportDocument, type ReportRow, type ReportSection } from '../model.js';
import type { ReportDefinition } from './types.js';

/** Period bounds as instants in the organisation zone: [from 00:00, to + 1 day 00:00). */
function periodBounds(ctx: ReportContext, from: string, to: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(from, { zone: ctx.timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: ctx.timezone }).plus({ days: 1 }).startOf('day');
  if (!start.isValid || !end.isValid) throw errors.validation('Invalid period.');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

interface RecordState { firstInAt: string | null; lastOutAt: string | null; status: string; flags: string[]; timezone: string }

function stateOf(snapshot: unknown, fallbackZone: string): RecordState {
  const o = asObject(snapshot);
  const iso = (v: unknown): string | null => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : null);
  return { firstInAt: iso(o['firstInAt'] ?? o['first_in_at']), lastOutAt: iso(o['lastOutAt'] ?? o['last_out_at']), status: String(o['status'] ?? ''), flags: asArray(o['flags']).map(String), timezone: typeof o['timezone'] === 'string' ? o['timezone'] : fallbackZone };
}

const EDITED_FIELDS = [
  { key: 'firstInAt', labelKey: 'field.inTime' },
  { key: 'lastOutAt', labelKey: 'field.outTime' },
  { key: 'status', labelKey: 'field.attendanceCode' },
] as const;

/**
 * Sample 13 — Audit Trail Report. `scope=attendance` (default) lists attendance edits the way the sample does — one row per
 * changed field (In Time, Out Time, Attendance Code) with the value before and after, who made the change and when —
 * derived from `attendance_daily_record_history`: every recompute caused by a correction or manual override snapshots the
 * previous row, so pairing each snapshot with the next version (or the current record) gives old → new without a schema
 * change. `scope=all` exports the organisation's whole audit log for the period in the same columns.
 */
export const auditReport: ReportDefinition = {
  key: 'audit_report',
  async build(trx: Trx, ctx: ReportContext): Promise<ReportDocument> {
    const { from, to } = ctx.params;
    if (!from || !to) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.from', message: 'Required' }, { path: 'parameters.to', message: 'Required' }] });
    const scope = ctx.params.scope ?? 'attendance';
    const { start, end } = periodBounds(ctx, from, to);
    const rows = scope === 'all' ? await auditLogRows(trx, ctx, start, end) : await attendanceEditRows(trx, ctx, start, end);
    const sections: ReportSection[] = [{ rows }];
    const columns: ReportColumn[] = [
      { key: 'keys', label: ctx.t('col.keys'), width: 16, mono: true },
      { key: 'field', label: ctx.t('col.editedField'), width: 16 },
      { key: 'old', label: ctx.t('col.oldValue'), width: 18, mono: true },
      { key: 'new', label: ctx.t('col.newValue'), width: 18, mono: true },
      { key: 'by', label: ctx.t('col.editedBy'), width: 14 },
      { key: 'on', label: ctx.t('col.editedOn'), width: 12, mono: true },
    ];
    return {
      key: 'audit_report', title: ctx.t('report.audit_report.title'), company: ctx.company,
      period: ctx.t('period.period', { from: ctx.headerDate(from), to: ctx.headerDate(to) }), orientation: 'portrait', columns, sections,
      legend: null, legendTitle: ctx.t('legend.title'), notes: [], endOfReport: false, endOfReportLabel: ctx.t('group.endOfReport'),
      generatedAt: ctx.now, generatedLabel: ctx.generatedLabel(), pageLabel: ctx.pageLabel, timezone: ctx.timezone, locale: ctx.locale, dir: ctx.dir,
      rowCount: countRows(sections), flatten: { headingColumnLabel: null, fieldColumns: false }, fileStem: `audit-trail-${scope}-${from}-${to}`,
    };
  },
};

async function userNames(trx: Trx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const batch of chunk([...new Set(ids)], 1000)) {
    if (!batch.length) continue;
    for (const u of await trx.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', batch).execute()) out.set(u.id, u.fullName || String(u.email));
  }
  return out;
}

async function attendanceEditRows(trx: Trx, ctx: ReportContext, start: Date, end: Date): Promise<ReportRow[]> {
  let q = trx.selectFrom('attendanceDailyRecordHistory as h')
    .select(['h.id', 'h.recordId', 'h.employeeId', 'h.branchId', 'h.attendanceDate', 'h.calculationVersion', 'h.snapshot', 'h.triggeredBy', 'h.createdAt'])
    .where('h.organizationId', '=', ctx.organizationId).where('h.reason', 'in', ['CORRECTION', 'MANUAL_OVERRIDE']).where('h.createdAt', '>=', start).where('h.createdAt', '<', end);
  if (ctx.scope.branchIds) q = q.where('h.branchId', 'in', ctx.scope.branchIds.length ? ctx.scope.branchIds : ['00000000-0000-0000-0000-000000000000']);
  if (ctx.scope.employeeIds) q = q.where('h.employeeId', 'in', ctx.scope.employeeIds.length ? ctx.scope.employeeIds : ['00000000-0000-0000-0000-000000000000']);
  const edits = await q.orderBy('h.createdAt', 'asc').orderBy('h.id', 'asc').execute();
  if (edits.length === 0) return [];

  // the state after each edit: the next snapshot of the same record, else the record as it stands now
  const recordIds = [...new Set(edits.map((e) => e.recordId))];
  const later = new Map<string, Map<number, RecordState>>();
  const current = new Map<string, RecordState>();
  for (const batch of chunk(recordIds, 1000)) {
    for (const h of await trx.selectFrom('attendanceDailyRecordHistory').select(['recordId', 'calculationVersion', 'snapshot']).where('organizationId', '=', ctx.organizationId).where('recordId', 'in', batch).execute()) {
      const m = later.get(h.recordId) ?? new Map<number, RecordState>();
      m.set(h.calculationVersion, stateOf(h.snapshot, ctx.timezone));
      later.set(h.recordId, m);
    }
    for (const r of await trx.selectFrom('attendanceDailyRecords').select(['id', 'firstInAt', 'lastOutAt', 'status', 'flags', 'timezone']).where('organizationId', '=', ctx.organizationId).where('id', 'in', batch).execute()) {
      current.set(r.id, { firstInAt: r.firstInAt ? toDate(r.firstInAt).toISOString() : null, lastOutAt: r.lastOutAt ? toDate(r.lastOutAt).toISOString() : null, status: r.status, flags: asArray(r.flags).map(String), timezone: r.timezone });
    }
  }
  const roster = await loadRoster(trx, ctx, { employeeIds: [...new Set(edits.map((e) => e.employeeId))] });
  const byEmployee = new Map(roster.map((e) => [e.id, e]));
  const names = await userNames(trx, edits.map((e) => e.triggeredBy).filter((v): v is string => !!v));

  const show = (field: (typeof EDITED_FIELDS)[number]['key'], s: RecordState): string => {
    if (field === 'status') return s.status ? ctx.code({ status: s.status, flags: s.flags }).code : '';
    return ctx.clock(s[field], s.timezone);
  };
  const rows: ReportRow[] = [];
  for (const e of edits) {
    const before = stateOf(e.snapshot, ctx.timezone);
    const after = later.get(e.recordId)?.get(e.calculationVersion + 1) ?? current.get(e.recordId);
    if (!after) continue;
    const emp = byEmployee.get(e.employeeId);
    const key = `${emp?.employeeNumber ?? ''} ${ctx.date(isoDate(e.attendanceDate), 'dd/MMM/yyyy')}`.trim();
    const by = (e.triggeredBy && names.get(e.triggeredBy)) || ctx.t('actor.system');
    const on = ctx.headerDate(DateTime.fromJSDate(toDate(e.createdAt)).setZone(ctx.timezone).toISODate() ?? isoDate(toDate(e.createdAt)));
    for (const f of EDITED_FIELDS) {
      const oldText = show(f.key, before);
      const newText = show(f.key, after);
      if (oldText === newText) continue;
      rows.push({ cells: [cell(key, { mono: true }), cell(ctx.t(f.labelKey)), cell(oldText, { mono: true }), cell(newText, { mono: true }), cell(by), cell(on, { mono: true })] });
    }
  }
  return rows;
}

const compact = (v: unknown): string => { if (v === null || v === undefined) return ''; const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 160 ? `${s.slice(0, 157)}…` : s; };

async function auditLogRows(trx: Trx, ctx: ReportContext, start: Date, end: Date): Promise<ReportRow[]> {
  let q = trx.selectFrom('audit.logs as a').leftJoin('userProfiles as u', 'u.id', 'a.actorUserId')
    .select(['a.id', 'a.action', 'a.entityType', 'a.entityId', 'a.oldValue', 'a.newValue', 'a.actorType', 'a.actorLabel', 'a.createdAt', 'u.fullName'])
    .where('a.organizationId', '=', ctx.organizationId).where('a.createdAt', '>=', start).where('a.createdAt', '<', end);
  if (ctx.scope.branchIds) { const ids = ctx.scope.branchIds.length ? ctx.scope.branchIds : ['00000000-0000-0000-0000-000000000000']; q = q.where((eb) => eb.or([eb('a.branchId', 'is', null), eb('a.branchId', 'in', ids)])); }
  const rows = await q.orderBy('a.createdAt', 'asc').orderBy('a.id', 'asc').execute();
  return rows.map((a) => ({ cells: [
    cell(`${a.entityType} ${a.entityId ?? ''}`.trim(), { mono: true }), cell(a.action, { mono: true }), cell(compact(a.oldValue), { mono: true }), cell(compact(a.newValue), { mono: true }),
    cell(a.fullName ?? a.actorLabel ?? String(a.actorType).toLowerCase()), cell(DateTime.fromJSDate(toDate(a.createdAt)).setZone(ctx.timezone).setLocale(ctx.locale).toFormat('dd-MMM-yyyy HH:mm'), { mono: true }),
  ] }));
}

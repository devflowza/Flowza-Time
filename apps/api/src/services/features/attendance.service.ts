import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { DateTime } from 'luxon';
import { SELF_CORRECTION_TYPES, approvalInboxQuerySchema, type ActivityRange, type AttendanceActivityDayDto, type AttendanceActivityDto, type AttendanceActivityMonthDto, type AttendanceActivityQuery, type AttendanceDailyRecordDto, type AttendanceStatus, type CreateCorrectionInput, type DailyAttendanceListQuery, type MonthlyAttendanceListQuery, type PeriodLockInput, type RawTransactionsQuery, type RecalculateInput, type approvalDecisionSchema, type attendanceEventsQuerySchema } from '@flowza/contracts';
import { emitDomainEvent, toDayMarkRow, type Trx } from '@flowza/database';
import { activitySegments, summarisePeriod, weekRange, type MembershipGrant, type PeriodRecordLike } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { z } from 'zod';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, isTeamMember, requireBranchAccess, requireMembership, requirePermission, requireTeamOrPermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { likeContains, pageOf, prefixTsQuery, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../../lib/mappers.js';
import { systemStep } from './context.js';
import { enqueueRecalculation } from './recalc.js';
import { DAILY_RECORD_COLUMNS, toDailyRecordDto, toDayMarkDto, type DailyRecordRow } from './mappers.js';
import { dv } from './sql-helpers.js';
import { canCancel, cancelForEntity, decideWithin, submit } from '../approvals/engine.js';
import { listInbox, requestDtoWithin } from '../approvals/queries.js';
import * as approvalWorkflows from '../approvals/workflows.js';
import { preValidateCorrection } from '../attendance/correction-guards.js';

type EventsQuery = z.infer<typeof attendanceEventsQuerySchema>;
type Decision = z.infer<typeof approvalDecisionSchema>;

/** attendance.view, or attendance.view_own restricted to the caller's own employee record. */
function viewGrant(actor: Actor, orgId: string): { grant: MembershipGrant; ownOnly: string | null } {
  const grant = requireMembership(actor.principal, orgId);
  if (hasPermission(grant, 'attendance.view')) return { grant, ownOnly: null };
  if (hasPermission(grant, 'attendance.view_own') && grant.employeeId) return { grant, ownOnly: grant.employeeId };
  throw errors.forbidden('Missing permission: attendance.view.');
}

/**
 * The branch's IANA zone for day windows. Read in the organisation's system scope: an employee viewing their own
 * attendance (attendance.view_own) holds no branch.view, and under their RLS the branch row — and so its zone — is hidden.
 */
async function branchTimezone(trx: Trx, orgId: string, branchId: string): Promise<string> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select('timezone').where('organizationId', '=', orgId).where('id', '=', branchId).executeTakeFirst());
  return row?.timezone ?? 'UTC';
}

function recordQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('attendanceDailyRecords as r').innerJoin('employees as e', 'e.id', 'r.employeeId').leftJoin('branches as b', 'b.id', 'r.branchId').leftJoin('departments as dp', 'dp.id', 'r.departmentId').leftJoin('shifts as s', 's.id', 'r.shiftId').where('r.organizationId', '=', orgId);
}

// ----- reads -----------------------------------------------------------------------------------------------------------

/** Records with a missing punch: the MISSING_IN / MISSING_OUT flags (and a legacy MISSING_PUNCH status, should one exist). */
const MISSING_PUNCH_PREDICATE = sql<boolean>`(r.status = 'MISSING_PUNCH' or r.flags && array['MISSING_IN', 'MISSING_OUT']::text[])`;

export async function listDaily(deps: ApiDeps, actor: Actor, orgId: string, q: DailyAttendanceListQuery) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = recordQuery(trx, orgId).where('r.attendanceDate', '=', dv(q.date));
    if (ownOnly) base = base.where('r.employeeId', '=', ownOnly);
    if (scope) base = base.where('r.branchId', 'in', scope);
    if (q.departmentId) base = base.where('r.departmentId', '=', q.departmentId);
    if (q.shiftId) base = base.where('r.shiftId', '=', q.shiftId);
    // MISSING_PUNCH is a flag-derived bucket: the engine records a missing punch as the MISSING_IN / MISSING_OUT flag and
    // sets the status by the rule set's missingPunchBehavior (HR portal Prompt 3 defect fix — the status alone matched nothing)
    if (q.status === 'MISSING_PUNCH') base = base.where(MISSING_PUNCH_PREDICATE);
    else if (q.status) base = base.where('r.status', '=', q.status);
    if (q.flag) base = base.where(sql<boolean>`${sql.val(q.flag)} = any (r.flags)`);
    if (q.search) { const like = likeContains(q.search); const tsq = prefixTsQuery(q.search); base = base.where((eb) => eb.or([...(tsq ? [sql<boolean>`e.search @@ to_tsquery('simple', ${tsq})`] : []), eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
    const page = pageOf(q);
    const sortCol = q.sort === 'status' ? 'r.status' : q.sort === 'firstInAt' ? 'r.first_in_at' : q.sort === 'lateMinutes' ? 'r.late_minutes' : q.sort === 'workedMinutes' ? 'r.worked_minutes' : 'e.display_name';
    // One statement: the page, the total (a window over the filtered set) and the per-status totals (a subquery over
    // the same set, evaluated once). Each separate query is a round trip between the API's region and the database's.
    // Records without a punch (null first_in_at) sort after those with one, whichever direction is asked for.
    const byStatusQuery = base.select(['r.status', (eb) => eb.fn.countAll().as('n')]).groupBy('r.status');
    const missingPunchQuery = base.where(MISSING_PUNCH_PREDICATE).select((eb) => eb.fn.countAll().as('n'));
    const rows = await base
      .select([...DAILY_RECORD_COLUMNS, sql<string>`count(*) over ()`.as('total'), jsonArrayFrom(byStatusQuery).as('byStatus'), missingPunchQuery.as('missingPunch')])
      .orderBy(sql.raw(`${sortCol} ${q.order} nulls last`)).orderBy('r.id').limit(page.pageSize).offset(page.offset).execute();
    const first = rows[0];
    let total = first ? toCount(first.total) : 0;
    let byStatus: Record<string, number> = first ? Object.fromEntries(first.byStatus.map((t) => [t.status, toCount(t.n)])) : {};
    let missingPunch = first ? toCount(first.missingPunch) : 0;
    if (!first && page.offset > 0) {
      // a page past the end: the totals still describe the whole set
      const totals = await byStatusQuery.execute();
      byStatus = Object.fromEntries(totals.map((t) => [t.status, toCount(t.n)]));
      total = Object.values(byStatus).reduce((a, n) => a + n, 0);
      missingPunch = toCount((await missingPunchQuery.executeTakeFirst())?.n);
    }
    return { data: rows.map(({ total: _t, byStatus: _s, missingPunch: _m, ...r }) => toDailyRecordDto(r as DailyRecordRow)), total, meta: { byStatus, missingPunch } };
  });
}

export interface MonthlyRow { employeeId: string; employeeNumber: string; employeeName: string; branchId: string; days: Record<string, { status: string; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; flags: string[]; recordId: string } | null>; totals: { present: number; absent: number; leave: number; holiday: number; weeklyOff: number; halfDay: number; late: number; missingPunch: number; workedMinutes: number; overtimeMinutes: number; lateMinutes: number } }

export async function listMonthly(deps: ApiDeps, actor: Actor, orgId: string, q: MonthlyAttendanceListQuery) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  const scope = branchFilter(grant, q.branchId);
  const start = DateTime.fromISO(`${q.month}-01`, { zone: 'utc' });
  if (!start.isValid) throw errors.validation('Invalid month.');
  const end = start.endOf('month');
  const from = start.toISODate()!; const to = end.toISODate()!;
  return runUser(deps.db, actor, async (trx) => {
    let eq = trx.selectFrom('employees as e').select(['e.id', 'e.employeeNumber', 'e.displayName', 'e.branchId']).where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null)
      .where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', dv(from))])).where('e.joiningDate', '<=', dv(to));
    if (ownOnly) eq = eq.where('e.id', '=', ownOnly); else if (q.employeeId) eq = eq.where('e.id', '=', q.employeeId);
    if (scope) eq = eq.where('e.branchId', 'in', scope);
    if (q.departmentId) eq = eq.where('e.departmentId', '=', q.departmentId);
    if (q.search) { const like = likeContains(q.search); eq = eq.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
    const total = toCount((await eq.clearSelect().select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const employees = await eq.orderBy('e.displayName').orderBy('e.id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    const ids = employees.map((e) => e.id);
    const records = ids.length ? await trx.selectFrom('attendanceDailyRecords').select(['id', 'employeeId', 'attendanceDate', 'status', 'workedMinutes', 'lateMinutes', 'overtimeMinutes', 'flags']).where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to)).execute() : [];
    const days: string[] = []; for (let d = start; d <= end; d = d.plus({ days: 1 })) days.push(d.toISODate()!);
    const data: MonthlyRow[] = employees.map((e) => {
      const row: MonthlyRow = { employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, days: Object.fromEntries(days.map((d) => [d, null])), totals: { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 } };
      for (const r of records.filter((x) => x.employeeId === e.id)) {
        const flags = jsonArray<string>(r.flags);
        row.days[isoDate(r.attendanceDate)] = { status: r.status, workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes, overtimeMinutes: r.overtimeMinutes, flags, recordId: r.id };
        const t = row.totals;
        if (r.status === 'PRESENT') t.present += 1; else if (r.status === 'ABSENT') t.absent += 1; else if (r.status === 'LEAVE') t.leave += 1; else if (r.status === 'HOLIDAY') t.holiday += 1; else if (r.status === 'WEEKLY_OFF') t.weeklyOff += 1; else if (r.status === 'HALF_DAY') { t.halfDay += 1; t.present += 0.5; }
        if (flags.includes('LATE')) t.late += 1;
        if (flags.includes('MISSING_IN') || flags.includes('MISSING_OUT') || r.status === 'MISSING_PUNCH') t.missingPunch += 1;
        t.workedMinutes += r.workedMinutes; t.overtimeMinutes += r.overtimeMinutes; t.lateMinutes += r.lateMinutes;
      }
      return row;
    });
    return { data, total, meta: { month: q.month, days } };
  });
}

export async function getRecord(deps: ApiDeps, actor: Actor, orgId: string, id: string) {
  // a line manager (attendance.view_team) opens a direct report's record from the team workspace (HR portal Prompt 5): the
  // team predicate decides (RLS applies it again), not a branch grant; everyone else keeps the organisation-wide / own rule
  const grant = requireMembership(actor.principal, orgId);
  const orgWide = hasPermission(grant, 'attendance.view');
  const own = hasPermission(grant, 'attendance.view_own') ? grant.employeeId : null;
  const team = hasPermission(grant, 'attendance.view_team');
  if (!orgWide && !own && !team) throw errors.forbidden('Missing permission: attendance.view.');
  return runUser(deps.db, actor, async (trx) => {
    const row = (await recordQuery(trx, orgId).select([...DAILY_RECORD_COLUMNS, 'r.trace', 'r.ruleSetId', 'r.shiftAssignmentId', 'r.engineVersion']).where('r.id', '=', id).executeTakeFirst()) as (DailyRecordRow & { trace: unknown; ruleSetId: string | null; shiftAssignmentId: string | null; engineVersion: string }) | undefined;
    const viaTeam = !!row && team && isTeamMember(grant, row.employeeId) && row.employeeId !== grant.employeeId;
    if (!row || (!orgWide && !viaTeam && row.employeeId !== own)) throw errors.notFound('Attendance record', id);
    if (!viaTeam) requireBranchAccess(grant, row.branchId);
    const date = isoDate(row.attendanceDate);
    const dayStart = DateTime.fromISO(date, { zone: row.timezone }).minus({ days: 1 }).toJSDate();
    const dayEnd = DateTime.fromISO(date, { zone: row.timezone }).plus({ days: 2 }).toJSDate();
    const trace = jsonObject(row.trace);
    const traceEventIds = jsonArray<{ eventId?: string }>(trace.punches).map((p) => p.eventId).filter((x): x is string => typeof x === 'string');
    let evq = trx.selectFrom('attendanceEvents as ev').leftJoin('devices as d', 'd.id', 'ev.deviceId').select(['ev.id', 'ev.punchedAt', 'ev.eventType', 'ev.source', 'ev.verificationMethod', 'ev.deviceId', 'd.name as deviceName', 'ev.voidedAt', 'ev.voidedByCorrectionId', 'ev.correctionId', 'ev.note', 'ev.rawTransactionId']).where('ev.organizationId', '=', orgId).where('ev.employeeId', '=', row.employeeId);
    evq = traceEventIds.length ? evq.where((eb) => eb.or([eb('ev.id', 'in', traceEventIds), eb.and([eb('ev.punchedAt', '>=', dayStart), eb('ev.punchedAt', '<', dayEnd)])])) : evq.where('ev.punchedAt', '>=', dayStart).where('ev.punchedAt', '<', dayEnd);
    const events = await evq.orderBy('ev.punchedAt').execute();
    const history = await trx.selectFrom('attendanceDailyRecordHistory').select(['id', 'calculationVersion', 'reason', 'triggeredBy', 'jobId', 'snapshot', 'createdAt']).where('recordId', '=', id).orderBy('calculationVersion', 'desc').limit(50).execute();
    const corrections = await trx.selectFrom('attendanceCorrections').selectAll().where('organizationId', '=', orgId).where('employeeId', '=', row.employeeId).where('attendanceDate', '=', dv(date)).orderBy('createdAt', 'desc').execute();
    // day marks (HR portal Prompt 3): every mark of the day, revoked ones included — the trail, not just the verdict in force
    const marks = await trx.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', orgId).where('employeeId', '=', row.employeeId).where('attendanceDate', '=', dv(date)).orderBy('createdAt', 'asc').orderBy('id', 'asc').execute();
    return {
      ...toDailyRecordDto(row), ruleSetId: row.ruleSetId, shiftAssignmentId: row.shiftAssignmentId, engineVersion: row.engineVersion, trace,
      marks: marks.map((m) => toDayMarkDto(toDayMarkRow(m))),
      events: events.map((e) => ({ id: e.id, punchedAt: isoDateTime(e.punchedAt), localTime: DateTime.fromJSDate(e.punchedAt).setZone(row.timezone).toISO(), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, deviceName: e.deviceName, voidedAt: isoDateTimeOrNull(e.voidedAt), voidedByCorrectionId: e.voidedByCorrectionId, correctionId: e.correctionId, note: e.note, rawTransactionId: e.rawTransactionId === null ? null : String(e.rawTransactionId), attributed: traceEventIds.length ? traceEventIds.includes(e.id) : null })),
      history: history.map((h) => ({ id: String(h.id), calculationVersion: h.calculationVersion, reason: h.reason, triggeredBy: h.triggeredBy, jobId: h.jobId === null ? null : String(h.jobId), snapshot: jsonObject(h.snapshot), createdAt: isoDateTime(h.createdAt) })),
      corrections: corrections.map(toCorrectionDto),
    };
  });
}

export async function listEvents(deps: ApiDeps, actor: Actor, orgId: string, q: EventsQuery) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  if (ownOnly && q.employeeId !== ownOnly) throw errors.forbidden('You may only view your own attendance.');
  const from = DateTime.fromISO(q.from, { zone: 'utc' }); const to = DateTime.fromISO(q.to, { zone: 'utc' });
  if (!from.isValid || !to.isValid || to < from) throw errors.validation('Invalid date range.');
  if (to.diff(from, 'days').days > 62) throw errors.validation('The range may span at most 62 days.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', q.employeeId).executeTakeFirst();
    if (!emp) throw errors.notFound('Employee', q.employeeId);
    requireBranchAccess(grant, emp.branchId);
    const tz = await branchTimezone(trx, orgId, emp.branchId);
    const start = DateTime.fromISO(q.from, { zone: tz }).startOf('day').toJSDate(); const end = DateTime.fromISO(q.to, { zone: tz }).endOf('day').toJSDate();
    const rows = await trx.selectFrom('attendanceEvents as ev').leftJoin('devices as d', 'd.id', 'ev.deviceId').select(['ev.id', 'ev.punchedAt', 'ev.eventType', 'ev.source', 'ev.verificationMethod', 'ev.deviceId', 'd.name as deviceName', 'ev.voidedAt', 'ev.correctionId', 'ev.note'])
      .where('ev.organizationId', '=', orgId).where('ev.employeeId', '=', q.employeeId).where('ev.punchedAt', '>=', start).where('ev.punchedAt', '<=', end).orderBy('ev.punchedAt').limit(5000).execute();
    return rows.map((e) => ({ id: e.id, punchedAt: isoDateTime(e.punchedAt), localDate: DateTime.fromJSDate(e.punchedAt).setZone(tz).toISODate(), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, deviceName: e.deviceName, voidedAt: isoDateTimeOrNull(e.voidedAt), correctionId: e.correctionId, note: e.note }));
  });
}

// ---- activity ----------------------------------------------------------------------------------------------------------

/** Whole calendar period around `anchor`. The week honours the tenant's first day of the week (§ report samples). */
function activityPeriod(range: ActivityRange, anchor: string, firstDayOfWeek: number): { from: string; to: string } {
  const d = DateTime.fromISO(anchor, { zone: 'utc' });
  if (!d.isValid) throw errors.validation('Invalid anchor date.');
  switch (range) {
    case 'day': return { from: anchor, to: anchor };
    case 'week': { const w = weekRange(anchor, firstDayOfWeek); return { from: w.from, to: w.to }; }
    case 'month': return { from: d.startOf('month').toISODate()!, to: d.endOf('month').toISODate()! };
    case 'year': return { from: d.startOf('year').toISODate()!, to: d.endOf('year').toISODate()! };
    default: { const exhaustive: never = range; return exhaustive; }
  }
}

interface ActivityRow {
  id: string; attendanceDate: Date | string; status: AttendanceStatus; shiftName: string | null; flags: string[]; expectedStartAt: Date | null; expectedEndAt: Date | null; scheduledMinutes: number;
  firstInAt: Date | null; lastOutAt: Date | null; workedMinutes: number; breakMinutes: number; lateMinutes: number; earlyDepartureMinutes: number; overtimeMinutes: number; overtimeCategory: string | null; punchCount: number; tracePunches: unknown;
}

/** `summarisePeriod` switches exhaustively on the category, so an unexpected value from the column has to become null. */
function overtimeCategoryOf(value: string | null): AttendanceActivityDayDto['overtimeCategory'] {
  return value === 'REGULAR' || value === 'WEEKLY_OFF' || value === 'HOLIDAY' ? value : null;
}

function toActivityDay(r: ActivityRow, withDetail: boolean): AttendanceActivityDayDto {
  const firstInAt = isoDateTimeOrNull(r.firstInAt);
  const lastOutAt = isoDateTimeOrNull(r.lastOutAt);
  // The span between the first and the last punch splits into the engine's worked minutes and the rest: the time the
  // employee spent away from the office in the middle of the day (field work, a client visit or an unpaid break).
  const spanMinutes = firstInAt && lastOutAt ? Math.max(0, Math.round((Date.parse(lastOutAt) - Date.parse(firstInAt)) / 60_000)) : 0;
  const officeMinutes = Math.max(0, r.workedMinutes);
  const punches = withDetail ? jsonArray<{ punchedAt?: string; role?: string; eventId?: string }>(r.tracePunches) : [];
  return {
    date: isoDate(r.attendanceDate), recordId: r.id, status: r.status, shiftName: r.shiftName,
    expectedStartAt: isoDateTimeOrNull(r.expectedStartAt), expectedEndAt: isoDateTimeOrNull(r.expectedEndAt), scheduledMinutes: r.scheduledMinutes,
    firstInAt, lastOutAt, spanMinutes, officeMinutes, fieldMinutes: Math.max(0, spanMinutes - officeMinutes),
    breakMinutes: r.breakMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: overtimeCategoryOf(r.overtimeCategory), lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes,
    punchCount: r.punchCount, flags: jsonArray<string>(r.flags),
    segments: withDetail ? activitySegments(punches, { firstInAt, lastOutAt }) : [],
    punches: punches.filter((p) => typeof p.punchedAt === 'string').map((p) => ({ at: p.punchedAt!, role: typeof p.role === 'string' ? p.role : 'PUNCH', eventId: typeof p.eventId === 'string' ? p.eventId : null })),
  };
}

function monthBuckets(days: readonly AttendanceActivityDayDto[]): AttendanceActivityMonthDto[] {
  const by = new Map<string, AttendanceActivityMonthDto>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    const b = by.get(month) ?? { month, recordedDays: 0, presentDays: 0, absentDays: 0, leaveDays: 0, lateDays: 0, scheduledMinutes: 0, officeMinutes: 0, fieldMinutes: 0, overtimeMinutes: 0 };
    b.recordedDays += 1;
    if (d.status === 'PRESENT' || d.status === 'MISSING_PUNCH') b.presentDays += 1;
    else if (d.status === 'HALF_DAY') { b.presentDays += 0.5; b.absentDays += 0.5; }
    else if (d.status === 'ABSENT') b.absentDays += 1;
    else if (d.status === 'LEAVE') b.leaveDays += 1;
    if (d.flags.includes('LATE')) b.lateDays += 1;
    b.scheduledMinutes += d.scheduledMinutes; b.officeMinutes += d.officeMinutes; b.fieldMinutes += d.fieldMinutes; b.overtimeMinutes += d.overtimeMinutes;
    by.set(month, b);
  }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * One employee's day shape over a calendar period: when they were inside, when they were out between the first and the
 * last punch, and the productive totals. Segments and punches come from the engine's own trace, so the picture and the
 * numbers are the same interpretation; the year range answers with month buckets instead (365 timelines chart nothing).
 */
export async function listActivity(deps: ApiDeps, actor: Actor, orgId: string, q: AttendanceActivityQuery): Promise<AttendanceActivityDto> {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  if (ownOnly && q.employeeId !== ownOnly) throw errors.forbidden('You may only view your own attendance.');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'employeeNumber', 'displayName', 'branchId']).where('organizationId', '=', orgId).where('id', '=', q.employeeId).executeTakeFirst();
    if (!emp) throw errors.notFound('Employee', q.employeeId);
    requireBranchAccess(grant, emp.branchId);
    const [timezone, settings] = await Promise.all([
      branchTimezone(trx, orgId, emp.branchId),
      trx.selectFrom('organizationSettings').select('general').where('organizationId', '=', orgId).executeTakeFirst(),
    ]);
    const general = jsonObject(settings?.general);
    const firstDayOfWeek = typeof general.firstDayOfWeek === 'number' ? general.firstDayOfWeek : 0;
    const anchor = q.anchor ?? DateTime.now().setZone(timezone).toISODate()!;
    const { from, to } = activityPeriod(q.range, anchor, firstDayOfWeek);
    const withDetail = q.range !== 'year';

    // `trace -> 'punches'` rather than the whole trace: the calculation steps are the bulk of the column and the
    // activity view never shows them, which keeps a year of records to a few hundred KB.
    const rows = (await trx.selectFrom('attendanceDailyRecords as r').leftJoin('shifts as s', 's.id', 'r.shiftId')
      .select(['r.id', 'r.attendanceDate', 'r.status', 's.name as shiftName', 'r.flags', 'r.expectedStartAt', 'r.expectedEndAt', 'r.scheduledMinutes', 'r.firstInAt', 'r.lastOutAt', 'r.workedMinutes', 'r.breakMinutes', 'r.lateMinutes', 'r.earlyDepartureMinutes', 'r.overtimeMinutes', 'r.overtimeCategory', 'r.punchCount', sql<unknown>`r.trace -> 'punches'`.as('tracePunches')])
      .where('r.organizationId', '=', orgId).where('r.employeeId', '=', q.employeeId).where('r.attendanceDate', '>=', dv(from)).where('r.attendanceDate', '<=', dv(to))
      .orderBy('r.attendanceDate').execute()) as ActivityRow[];

    const days = rows.map((r) => toActivityDay(r, withDetail));
    const period = summarisePeriod(days.map((d): PeriodRecordLike => ({ attendanceDate: d.date, status: d.status, flags: d.flags as PeriodRecordLike['flags'], workedMinutes: d.officeMinutes, overtimeMinutes: d.overtimeMinutes, overtimeCategory: d.overtimeCategory, lateMinutes: d.lateMinutes, earlyDepartureMinutes: d.earlyDepartureMinutes })), { periodStart: from, periodEnd: to });
    const sum = (pick: (d: AttendanceActivityDayDto) => number): number => days.reduce((n, d) => n + pick(d), 0);
    const officeMinutes = sum((d) => d.officeMinutes);
    const workedDays = days.filter((d) => d.officeMinutes > 0).length;
    return {
      employeeId: emp.id, employeeNumber: emp.employeeNumber, employeeName: emp.displayName, range: q.range, from, to, timezone,
      days: withDetail ? days : [],
      months: withDetail ? [] : monthBuckets(days),
      totals: {
        recordedDays: days.length, workingDays: period.workingDays, presentDays: period.presentDays, absentDays: period.absentDays, leaveDays: period.leaveDays, holidayDays: period.holidayDays,
        weeklyOffDays: period.weeklyOffDays, halfDays: period.halfDays, lateDays: period.lateDays, missingPunchDays: period.missingPunchDays,
        scheduledMinutes: sum((d) => d.scheduledMinutes), spanMinutes: sum((d) => d.spanMinutes), officeMinutes, fieldMinutes: sum((d) => d.fieldMinutes),
        overtimeMinutes: period.totalOvertimeMinutes, regularMinutes: period.regularMinutes, lateMinutes: period.lateMinutes, earlyDepartureMinutes: period.earlyDepartureMinutes,
        averageOfficeMinutes: workedDays === 0 ? 0 : Math.round(officeMinutes / workedDays),
      },
    };
  });
}

function encodeCursor(id: string): string { return Buffer.from(id, 'utf8').toString('base64url'); }
function decodeCursor(c: string | undefined): string | null { if (!c) return null; const v = Buffer.from(c, 'base64url').toString('utf8'); if (!/^\d{1,19}$/.test(v)) throw errors.validation('Invalid cursor.'); return v; }

export async function listRaw(deps: ApiDeps, actor: Actor, orgId: string, q: RawTransactionsQuery) {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view_raw');
  const scope = branchFilter(grant, q.branchId);
  const after = decodeCursor(q.cursor);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceRawTransactions as t').leftJoin('devices as d', 'd.id', 't.deviceId').leftJoin('employees as e', 'e.id', 't.employeeId').where('t.organizationId', '=', orgId);
    if (scope) base = base.where((eb) => eb.or([eb('t.branchId', 'in', scope), eb.and([eb('t.branchId', 'is', null), eb('d.branchId', 'in', scope)])]));
    if (q.deviceId) base = base.where('t.deviceId', '=', q.deviceId);
    if (q.from) base = base.where('t.punchedAt', '>=', new Date(q.from));
    if (q.to) base = base.where('t.punchedAt', '<=', new Date(q.to));
    if (q.processingStatus) base = base.where('t.processingStatus', '=', q.processingStatus);
    if (q.deviceEmployeeId) base = base.where('t.deviceEmployeeId', '=', q.deviceEmployeeId);
    if (after) base = base.where('t.id', '<', after);
    const rows = await base.select(['t.id', 't.deviceId', 'd.name as deviceName', 't.providerKey', 't.providerTransactionId', 't.deviceEmployeeId', 't.employeeId', 'e.displayName as employeeName', 't.punchedAt', 't.deviceLocalTime', 't.assumedTimezone', 't.clockSkewSeconds', 't.verificationMethod', 't.direction', 't.source', 't.processingStatus', 't.processingError', 't.processedAt', 't.receivedAt', 't.syncJobId', 't.deviceGeneration', 't.rawPayload'])
      .orderBy('t.id', 'desc').limit(q.limit + 1).execute();
    const hasMore = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    return {
      data: page.map((r) => ({ id: String(r.id), deviceId: r.deviceId, deviceName: r.deviceName, providerKey: r.providerKey, providerTransactionId: r.providerTransactionId, deviceEmployeeId: r.deviceEmployeeId, employeeId: r.employeeId, employeeName: r.employeeName, punchedAt: isoDateTime(r.punchedAt), deviceLocalTime: r.deviceLocalTime, assumedTimezone: r.assumedTimezone, clockSkewSeconds: r.clockSkewSeconds, verificationMethod: r.verificationMethod, direction: r.direction, source: r.source, processingStatus: r.processingStatus, processingError: r.processingError, processedAt: isoDateTimeOrNull(r.processedAt), receivedAt: isoDateTime(r.receivedAt), syncJobId: r.syncJobId, deviceGeneration: r.deviceGeneration, rawPayload: jsonObject(r.rawPayload) })),
      nextCursor: hasMore && page.length ? encodeCursor(String(page[page.length - 1]!.id)) : null,
    };
  });
}

export async function requeueRaw(deps: ApiDeps, actor: Actor, orgId: string, id: string) {
  const grant = requirePermission(actor.principal, orgId, 'attendance.correct', 'attendance.view_raw');
  if (!/^\d{1,19}$/.test(id)) throw errors.notFound('Raw transaction', id);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('attendanceRawTransactions as t').innerJoin('devices as d', 'd.id', 't.deviceId').select(['t.id', 't.processingStatus', 't.deviceId', 'd.branchId', 't.branchId as rawBranchId']).where('t.organizationId', '=', orgId).where('t.id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Raw transaction', id);
    requireBranchAccess(grant, row.rawBranchId ?? row.branchId);
    if (!['unmatched', 'quarantined', 'held', 'error'].includes(row.processingStatus)) throw errors.invalidState(`Only unmatched, quarantined, held or errored transactions can be re-queued (current: ${row.processingStatus}).`);
    await systemStep(trx, orgId, async (t) => {
      await t.updateTable('attendanceRawTransactions').set({ processingStatus: 'pending', processingError: null, processedAt: null }).where('organizationId', '=', orgId).where('id', '=', id).execute();
      await enqueueJob(deps.queue, t, { queue: 'processing', jobType: 'NORMALIZE_RAW', organizationId: orgId, payload: { organizationId: orgId, deviceId: row.deviceId, rawTransactionIds: [String(row.id)] }, dedupeKey: `normalize:${orgId}`, correlationId: actor.requestId, priority: 6 });
    });
    await audit(trx, actor, orgId, 'attendance.raw_requeued', 'attendance_raw_transaction', { entityId: String(row.id), branchId: row.rawBranchId ?? row.branchId, oldValue: { processingStatus: row.processingStatus }, newValue: { processingStatus: 'pending' } });
    return { id: String(row.id), processingStatus: 'pending' as const };
  });
}

// ----- corrections & approvals ------------------------------------------------------------------------------------------

export interface CorrectionDto {
  id: string; employeeId: string; branchId: string; attendanceDate: string; type: string; originalEventId: string | null; originalPunchedAt: string | null; proposedPunchedAt: string | null; proposedEventType: string | null; proposedStatus: string | null; reason: string; status: string;
  requestedBy: string | null; approvalRequestId: string | null; appliedEventId: string | null; appliedAt: string | null; rejectionReason: string | null; createdAt: string; updatedAt: string; employeeNumber?: string; employeeName?: string;
}
type CorrectionRow = { id: string; employeeId: string; branchId: string; attendanceDate: Date | string; type: string; originalEventId: string | null; originalPunchedAt: Date | null; proposedPunchedAt: Date | null; proposedEventType: string | null; proposedStatus: string | null; reason: string; status: string; requestedBy: string | null; approvalRequestId: string | null; appliedEventId: string | null; appliedAt: Date | null; rejectionReason: string | null; createdAt: Date; updatedAt: Date; employeeNumber?: string; employeeName?: string };
function toCorrectionDto(r: CorrectionRow): CorrectionDto {
  return { id: r.id, employeeId: r.employeeId, branchId: r.branchId, attendanceDate: isoDate(r.attendanceDate), type: r.type, originalEventId: r.originalEventId, originalPunchedAt: isoDateTimeOrNull(r.originalPunchedAt), proposedPunchedAt: isoDateTimeOrNull(r.proposedPunchedAt), proposedEventType: r.proposedEventType, proposedStatus: r.proposedStatus, reason: r.reason, status: r.status, requestedBy: r.requestedBy, approvalRequestId: r.approvalRequestId, appliedEventId: r.appliedEventId, appliedAt: isoDateTimeOrNull(r.appliedAt), rejectionReason: r.rejectionReason, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt), ...(r.employeeNumber ? { employeeNumber: r.employeeNumber } : {}), ...(r.employeeName ? { employeeName: r.employeeName } : {}) };
}

export async function isPeriodLocked(trx: Trx, orgId: string, branchId: string | null, date: string): Promise<boolean> {
  const res = await sql<{ locked: boolean }>`select app.is_period_locked(${orgId}::uuid, ${branchId}::uuid, ${date}::date) as locked`.execute(trx);
  return res.rows[0]?.locked ?? false;
}

// ----- corrections (filed here; routed and decided by the approval engine — services/approvals) ------------------------------

/** Which door a correction comes through; decides the self-service rules and whether a missing workflow may auto-approve. */
type CorrectionMode = 'self' | 'team' | 'org';

/**
 * Who may file a correction, and through which door (HR portal Prompt 1 review, P1/P2):
 *  - the caller's OWN record always goes through the self-service door — attendance.request_correction semantics (punch
 *    changes only, always routed, never auto-approved) whatever other keys the caller holds. attendance.correct opens the
 *    same door, and the organisation's "self-service corrections" switch only gates callers without attendance.correct;
 *  - a direct report (primary or secondary manager on the employee record) is the team door: attendance.correct, and the
 *    request is always routed — a line manager's correction is never applied without somebody else deciding;
 *  - anybody else needs attendance.correct AND organisation-wide attendance.view (branch scope applies): the org door, the
 *    only one where a missing workflow lets an attendance.approve holder's correction apply at once (HR).
 */
function correctionAccess(actor: Actor, orgId: string, input: CreateCorrectionInput): { grant: MembershipGrant; mode: CorrectionMode } {
  const grant = requireMembership(actor.principal, orgId);
  if (grant.employeeId && grant.employeeId === input.employeeId) {
    if (!hasPermission(grant, 'attendance.request_correction') && !hasPermission(grant, 'attendance.correct')) throw errors.forbidden('Missing permission: attendance.request_correction.');
    if (!(SELF_CORRECTION_TYPES as readonly string[]).includes(input.type)) throw errors.forbidden('Only HR can change the status of a day; request a punch correction instead.');
    return { grant, mode: 'self' };
  }
  if (!hasPermission(grant, 'attendance.correct')) throw errors.forbidden('Missing permission: attendance.correct.');
  requireTeamOrPermission(actor.principal, orgId, input.employeeId, 'attendance.view');
  return { grant, mode: hasPermission(grant, 'attendance.view') ? 'org' : 'team' };
}

export async function createCorrection(deps: ApiDeps, actor: Actor, orgId: string, input: CreateCorrectionInput): Promise<CorrectionDto & { approval: 'AUTO_APPROVED' | 'PENDING'; approvalRequestId: string | null }> {
  // HR portal Prompt 6a review: the branch that OWNED the day (D2) and the date inside today / employment (D6), for every door
  await preValidateCorrection(deps, actor, orgId, input);
  const { grant, mode } = correctionAccess(actor, orgId, input);
  return runUser(deps.db, actor, async (trx) => {
    if (mode === 'self' && !hasPermission(grant, 'attendance.correct')) {
      // Settings → Attendance → "Self-service corrections" (off by default) decides whether employees may ask at all.
      const settings = await trx.selectFrom('organizationSettings').select('attendance').where('organizationId', '=', orgId).executeTakeFirst();
      if (jsonObject(settings?.attendance).allowSelfServiceCorrections !== true) throw errors.forbidden('Self-service corrections are turned off for this organisation.');
    }
    const emp = await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId', 'joiningDate', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).executeTakeFirst();
    if (!emp || emp.deletedAt) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    if (mode !== 'self') requireBranchAccess(grant, emp.branchId);
    if (await isPeriodLocked(trx, orgId, emp.branchId, input.attendanceDate)) throw errors.periodLocked('The attendance period for this date is locked; unlock it before submitting corrections.');
    let originalPunchedAt: Date | null = null;
    if (input.originalEventId) {
      const ev = await trx.selectFrom('attendanceEvents').select(['id', 'punchedAt', 'voidedAt']).where('organizationId', '=', orgId).where('employeeId', '=', input.employeeId).where('id', '=', input.originalEventId).executeTakeFirst();
      if (!ev) throw errors.validation('Original event not found for this employee.', { issues: [{ path: 'originalEventId', message: 'Unknown event' }] });
      if (ev.voidedAt) throw errors.invalidState('The original event has already been voided.');
      originalPunchedAt = ev.punchedAt;
    }
    const dup = await trx.selectFrom('attendanceCorrections').select('id').where('organizationId', '=', orgId).where('employeeId', '=', input.employeeId).where('attendanceDate', '=', dv(input.attendanceDate)).where('status', 'in', ['PENDING', 'APPROVED']).where('type', '=', input.type)
      .where((eb) => input.originalEventId ? eb('originalEventId', '=', input.originalEventId) : eb.and([eb('originalEventId', 'is', null), ...(input.proposedPunchedAt ? [eb('proposedPunchedAt', '=', new Date(input.proposedPunchedAt))] : [])])).executeTakeFirst();
    if (dup) throw errors.conflict('An equivalent correction is already pending or approved.', { correctionId: dup.id });
    const row = await trx.insertInto('attendanceCorrections').values({
      organizationId: orgId, employeeId: input.employeeId, branchId: emp.branchId, attendanceDate: input.attendanceDate, type: input.type, originalEventId: input.originalEventId ?? null, originalPunchedAt,
      proposedPunchedAt: input.proposedPunchedAt ? new Date(input.proposedPunchedAt) : null, proposedEventType: input.proposedEventType ?? (input.type === 'ADD_PUNCH' || input.type === 'EDIT_PUNCH' ? 'PUNCH' : null), proposedStatus: input.proposedStatus ?? null,
      reason: input.reason, requestedBy: actor.userId, status: 'PENDING',
    }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'attendance.correction_submitted', 'attendance_correction', { entityId: row.id, branchId: emp.branchId, newValue: { ...input, mode } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'attendance.correction_submitted', aggregateType: 'attendance_correction', aggregateId: row.id, payload: { employeeId: input.employeeId, attendanceDate: input.attendanceDate, type: input.type }, actorUserId: actor.userId, requestId: actor.requestId });

    // Routing (engine v2). The configured workflow always wins. Without one, only HR (organisation-wide attendance.view +
    // attendance.approve) filing for somebody else is applied at once; a line manager's correction for a report and anybody's
    // own correction go to the attendance.approve holders in reach of the employee, the requester excluded.
    const autoApprove = mode === 'org' && hasPermission(grant, 'attendance.approve');
    const submitted = await submit(deps, trx, actor, orgId, {
      entityType: 'ATTENDANCE_CORRECTION', entityId: row.id, employeeId: input.employeeId, branchId: emp.branchId, departmentId: emp.departmentId, units: null, requestedBy: actor.userId,
      noWorkflow: autoApprove ? { kind: 'AUTO_APPROVE' } : { kind: 'PERMISSION', permission: 'attendance.approve' },
    });
    await systemStep(trx, orgId, (t) => t.updateTable('attendanceCorrections').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute());
    if (submitted.autoApproved) await audit(trx, actor, orgId, 'attendance.correction_auto_approved', 'attendance_correction', { entityId: row.id, branchId: emp.branchId });
    const saved = await trx.selectFrom('attendanceCorrections').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
    return { ...toCorrectionDto(saved), approval: submitted.autoApproved ? 'AUTO_APPROVED' : 'PENDING', approvalRequestId: submitted.requestId };
  });
}

export async function listCorrections(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: string; employeeId?: string; branchId?: string; from?: string; to?: string }) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceCorrections as c').where('c.organizationId', '=', orgId);
    if (ownOnly) base = base.where('c.employeeId', '=', ownOnly); else if (q.employeeId) base = base.where('c.employeeId', '=', q.employeeId);
    if (scope) base = base.where('c.branchId', 'in', scope);
    if (q.status) base = base.where('c.status', '=', q.status as never);
    if (q.from) base = base.where('c.attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('c.attendanceDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('c').orderBy('c.createdAt', 'desc').orderBy('c.id').limit(page.pageSize).offset(page.offset).execute();
    // names in the organisation's system scope, for the rows RLS already let the caller read (a line manager's role may not
    // read the employee directory)
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const names = employeeIds.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select(['id', 'employeeNumber', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute()) : [];
    const byId = new Map(names.map((n) => [n.id, n]));
    return { data: rows.map((r) => toCorrectionDto({ ...(r as CorrectionRow), employeeNumber: byId.get(r.employeeId)?.employeeNumber, employeeName: byId.get(r.employeeId)?.displayName })), total };
  });
}

/**
 * Withdraw a pending correction: the engine's withdrawal rule (Finance B-98, review P2-4) — the requester, approval.manage
 * or the owner, or an attendance.correct holder with the organisation-wide attendance.view (branch scope applies); an
 * approver who is only seated on it cannot. The correction and its approval request close together, in system context
 * (clients cannot write corrections' status under RLS since the engine v2 migration).
 */
export async function cancelCorrection(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string | undefined): Promise<CorrectionDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const c = await trx.selectFrom('attendanceCorrections').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!c) throw errors.notFound('Correction', id);
    if (!canCancel(grant, actor.userId, { entityType: 'ATTENDANCE_CORRECTION', requestedBy: c.requestedBy, subjectUserId: null, employeeId: c.employeeId, branchId: c.branchId })) throw errors.forbidden('Only the requester, approval.manage or an attendance.correct holder (organisation-wide) can cancel a correction.');
    if (c.status !== 'PENDING') throw errors.invalidState(`Only pending corrections can be cancelled (current: ${c.status}).`);
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('attendanceCorrections').set({ status: 'CANCELLED', rejectionReason: reason ?? null }).where('id', '=', id).where('status', '=', 'PENDING').executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The correction changed meanwhile. Please refresh.');
      await cancelForEntity(deps, t, actor, orgId, 'ATTENDANCE_CORRECTION', id, reason ?? null, { source: 'correction_cancel' });
    });
    await audit(trx, actor, orgId, 'attendance.correction_cancelled', 'attendance_correction', { entityId: id, branchId: c.branchId, reason: reason ?? null });
    return toCorrectionDto(await trx.selectFrom('attendanceCorrections').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  });
}

// ----- approvals: thin delegates to services/approvals (engine v2) — kept for existing importers -------------------------------

/** @deprecated use services/approvals `listInbox` (GET /orgs/:orgId/approvals). */
export async function approvalsInbox(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number }) {
  return listInbox(deps, actor, orgId, approvalInboxQuerySchema.parse({ page: q.page, pageSize: q.pageSize, scope: 'mine', view: 'pending' }));
}

/** @deprecated use services/approvals `decideWithin` (POST /orgs/:orgId/approvals/:id/decide). */
export async function decide(deps: ApiDeps, actor: Actor, orgId: string, requestId: string, decision: 'approve' | 'reject', input: Decision) {
  return runUser(deps.db, actor, async (trx) => {
    const outcome = await decideWithin(deps, trx, actor, orgId, requestId, { decision: decision === 'approve' ? 'APPROVE' : 'REJECT', comment: input.comment });
    return { ...(await requestDtoWithin(trx, actor, orgId, requestId, { withEvents: true })), noop: outcome.noop, terminal: outcome.terminal };
  });
}

export const listWorkflows = approvalWorkflows.listWorkflows;
export const createWorkflow = approvalWorkflows.createWorkflow;
export const updateWorkflow = approvalWorkflows.updateWorkflow;
export const deleteWorkflow = approvalWorkflows.deleteWorkflow;

// ----- recalculation & period locks ------------------------------------------------------------------------------------------

export async function requestRecalculation(deps: ApiDeps, actor: Actor, orgId: string, input: RecalculateInput) {
  const grant = requirePermission(actor.principal, orgId, 'attendance.recalculate');
  requireBranchAccess(grant, input.branchId);
  if (input.toDate < input.fromDate) throw errors.validation('toDate must be on/after fromDate.', { issues: [{ path: 'toDate', message: 'Before fromDate' }] });
  if (DateTime.fromISO(input.toDate).diff(DateTime.fromISO(input.fromDate), 'days').days > 366) throw errors.validation('A recalculation may span at most 366 days.');
  return runUser(deps.db, actor, async (trx) => {
    if (!grant.allBranches && !input.branchId && !input.employeeIds?.length) throw errors.forbidden('Branch-scoped users must specify a branch or employees.');
    if (input.employeeIds?.length) {
      const emps = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(input.employeeIds)]).execute();
      if (emps.length !== new Set(input.employeeIds).size) throw errors.validation('One or more employees were not found.');
      for (const e of emps) requireBranchAccess(grant, e.branchId);
    }
    const res = await enqueueRecalculation(deps, trx, actor, orgId, { fromDate: input.fromDate, toDate: input.toDate, branchId: input.branchId ?? null, departmentId: input.departmentId ?? null, employeeIds: input.employeeIds ?? null, reason: input.reason });
    await audit(trx, actor, orgId, 'attendance.recalculation_requested', 'attendance_recalculation_request', { entityId: res!.requestId, branchId: input.branchId ?? null, newValue: input });
    return { jobId: res!.jobId, requestId: res!.requestId, status: 'QUEUED' as const, message: 'Recalculation queued.' };
  });
}

export async function listRecalculations(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const scope = branchFilter(grant);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceRecalculationRequests as r').leftJoin('userProfiles as u', 'u.id', 'r.requestedBy').where('r.organizationId', '=', orgId);
    if (scope) base = base.where((eb) => eb.or([eb('r.branchId', 'is', null), eb('r.branchId', 'in', scope)]));
    if (q.status) base = base.where('r.status', '=', q.status as never);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('r').select('u.fullName as requestedByName').orderBy('r.createdAt', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => ({ id: r.id, fromDate: isoDate(r.fromDate), toDate: isoDate(r.toDate), branchId: r.branchId, departmentId: r.departmentId, employeeIds: r.employeeIds, reason: r.reason, status: r.status, summary: r.summary === null ? null : jsonObject(r.summary), requestedBy: r.requestedBy, requestedByName: r.requestedByName ?? null, jobId: r.queueJobId === null ? null : String(r.queueJobId), createdAt: isoDateTime(r.createdAt), startedAt: isoDateTimeOrNull(r.startedAt), finishedAt: isoDateTimeOrNull(r.finishedAt) })), total };
  });
}

export interface PeriodLockDto { id: string; branchId: string | null; periodStart: string; periodEnd: string; lockedBy: string | null; lockedAt: string; reason: string | null; unlockedBy: string | null; unlockedAt: string | null; unlockReason: string | null; active: boolean }
const toLockDto = (l: { id: string; branchId: string | null; periodStart: Date | string; periodEnd: Date | string; lockedBy: string | null; lockedAt: Date; reason: string | null; unlockedBy: string | null; unlockedAt: Date | null; unlockReason: string | null }): PeriodLockDto => ({ id: l.id, branchId: l.branchId, periodStart: isoDate(l.periodStart), periodEnd: isoDate(l.periodEnd), lockedBy: l.lockedBy, lockedAt: isoDateTime(l.lockedAt), reason: l.reason, unlockedBy: l.unlockedBy, unlockedAt: isoDateTimeOrNull(l.unlockedAt), unlockReason: l.unlockReason, active: l.unlockedAt === null });

export async function lockPeriod(deps: ApiDeps, actor: Actor, orgId: string, input: PeriodLockInput): Promise<PeriodLockDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.lock_period');
  requireBranchAccess(grant, input.branchId);
  if (!grant.allBranches && !input.branchId) throw errors.forbidden('Branch-scoped users can only lock their own branches.');
  if (input.periodEnd < input.periodStart) throw errors.validation('periodEnd must be on/after periodStart.', { issues: [{ path: 'periodEnd', message: 'Before periodStart' }] });
  return runUser(deps.db, actor, async (trx) => {
    const pendingCorrections = toCount((await trx.selectFrom('attendanceCorrections').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('status', 'in', ['PENDING', 'APPROVED']).where('attendanceDate', '>=', dv(input.periodStart)).where('attendanceDate', '<=', dv(input.periodEnd)).$if(!!input.branchId, (qb) => qb.where('branchId', '=', input.branchId!)).executeTakeFirst())?.n);
    if (pendingCorrections > 0) throw errors.invalidState(`${pendingCorrections} correction(s) are still pending or awaiting application in this period.`, { pendingCorrections });
    const row = await trx.insertInto('attendancePeriodLocks').values({ organizationId: orgId, branchId: input.branchId ?? null, periodStart: input.periodStart, periodEnd: input.periodEnd, lockedBy: actor.userId, reason: input.reason ?? null }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'attendance.period_locked', 'attendance_period_lock', { entityId: row.id, branchId: input.branchId ?? null, newValue: input, reason: input.reason ?? null });
    return toLockDto(row);
  });
}

export async function unlockPeriod(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string): Promise<PeriodLockDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.lock_period');
  return runUser(deps.db, actor, async (trx) => {
    const lock = await trx.selectFrom('attendancePeriodLocks').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!lock) throw errors.notFound('Period lock', id);
    requireBranchAccess(grant, lock.branchId);
    // symmetric with lockPeriod: an organisation-wide lock (branch_id null) is never a branch-scoped user's to release
    if (!grant.allBranches && !lock.branchId) throw errors.forbidden('Branch-scoped users cannot unlock organisation-wide periods.');
    if (lock.unlockedAt) throw errors.invalidState('The period is already unlocked.');
    await trx.updateTable('attendancePeriodLocks').set({ unlockedAt: new Date(), unlockedBy: actor.userId, unlockReason: reason }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'attendance.period_unlocked', 'attendance_period_lock', { entityId: id, branchId: lock.branchId, oldValue: { periodStart: isoDate(lock.periodStart), periodEnd: isoDate(lock.periodEnd) }, reason });
    return toLockDto(await trx.selectFrom('attendancePeriodLocks').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  });
}

export async function listPeriods(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId?: string; includeUnlocked: boolean; year?: number }): Promise<PeriodLockDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendancePeriodLocks').selectAll().where('organizationId', '=', orgId);
    if (scope) base = base.where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', 'in', scope)]));
    if (!q.includeUnlocked) base = base.where('unlockedAt', 'is', null);
    if (q.year) base = base.where('periodEnd', '>=', dv(`${q.year}-01-01`)).where('periodStart', '<=', dv(`${q.year}-12-31`));
    return (await base.orderBy('periodStart', 'desc').execute()).map(toLockDto);
  });
}

export type { AttendanceDailyRecordDto };

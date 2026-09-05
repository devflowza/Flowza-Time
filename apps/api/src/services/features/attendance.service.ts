import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { SYSTEM_ROLE_IDS, type AttendanceDailyRecordDto, type CreateCorrectionInput, type PeriodLockInput, type RecalculateInput } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { z } from 'zod';
import type { approvalDecisionSchema, attendanceEventsQuerySchema } from '@flowza/contracts';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { enqueueJob } from '../../lib/jobs.js';
import { likeContains, pageOf, prefixTsQuery, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime, isoDateTimeOrNull, jsonArray, jsonObject } from '../../lib/mappers.js';
import type { ApprovalRequestDto, ApprovalStepDto, ApprovalWorkflowInput, DailyAttendanceListQuery, MonthlyAttendanceListQuery, RawTransactionsQuery } from '../../routes/v1/features/dto.js';
import { systemStep } from './context.js';
import { enqueueRecalculation } from './recalc.js';
import { DAILY_RECORD_COLUMNS, toDailyRecordDto, type DailyRecordRow } from './mappers.js';
import { dv } from './sql-helpers.js';

type EventsQuery = z.infer<typeof attendanceEventsQuerySchema>;
type Decision = z.infer<typeof approvalDecisionSchema>;

/** attendance.view, or attendance.view_own restricted to the caller's own employee record. */
function viewGrant(actor: Actor, orgId: string): { grant: MembershipGrant; ownOnly: string | null } {
  const grant = requireMembership(actor.principal, orgId);
  if (hasPermission(grant, 'attendance.view')) return { grant, ownOnly: null };
  if (hasPermission(grant, 'attendance.view_own') && grant.employeeId) return { grant, ownOnly: grant.employeeId };
  throw errors.forbidden('Missing permission: attendance.view.');
}

function recordQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('attendanceDailyRecords as r').innerJoin('employees as e', 'e.id', 'r.employeeId').leftJoin('branches as b', 'b.id', 'r.branchId').leftJoin('departments as dp', 'dp.id', 'r.departmentId').leftJoin('shifts as s', 's.id', 'r.shiftId').where('r.organizationId', '=', orgId);
}

// ----- reads -----------------------------------------------------------------------------------------------------------

export async function listDaily(deps: ApiDeps, actor: Actor, orgId: string, q: DailyAttendanceListQuery) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = recordQuery(trx, orgId).where('r.attendanceDate', '=', dv(q.date));
    if (ownOnly) base = base.where('r.employeeId', '=', ownOnly);
    if (scope) base = base.where('r.branchId', 'in', scope);
    if (q.departmentId) base = base.where('r.departmentId', '=', q.departmentId);
    if (q.shiftId) base = base.where('r.shiftId', '=', q.shiftId);
    if (q.status) base = base.where('r.status', '=', q.status);
    if (q.flag) base = base.where(sql<boolean>`${sql.val(q.flag)} = any (r.flags)`);
    if (q.search) { const like = likeContains(q.search); const tsq = prefixTsQuery(q.search); base = base.where((eb) => eb.or([...(tsq ? [sql<boolean>`e.search @@ to_tsquery('simple', ${tsq})`] : []), eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const sortCol = q.sort === 'status' ? 'r.status' : q.sort === 'firstInAt' ? 'r.first_in_at' : q.sort === 'lateMinutes' ? 'r.late_minutes' : q.sort === 'workedMinutes' ? 'r.worked_minutes' : 'e.display_name';
    const rows = (await base.select(DAILY_RECORD_COLUMNS).orderBy(sql.raw(sortCol), q.order).orderBy('r.id').limit(page.pageSize).offset(page.offset).execute()) as DailyRecordRow[];
    const totals = await base.select([(eb) => eb.fn.countAll().as('n'), 'r.status']).groupBy('r.status').execute();
    return { data: rows.map(toDailyRecordDto), total, meta: { byStatus: Object.fromEntries(totals.map((t) => [t.status, toCount(t.n)])) } };
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
  const { grant, ownOnly } = viewGrant(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const row = (await recordQuery(trx, orgId).select([...DAILY_RECORD_COLUMNS, 'r.trace', 'r.ruleSetId', 'r.shiftAssignmentId', 'r.engineVersion']).where('r.id', '=', id).executeTakeFirst()) as (DailyRecordRow & { trace: unknown; ruleSetId: string | null; shiftAssignmentId: string | null; engineVersion: string }) | undefined;
    if (!row || (ownOnly && row.employeeId !== ownOnly)) throw errors.notFound('Attendance record', id);
    requireBranchAccess(grant, row.branchId);
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
    return {
      ...toDailyRecordDto(row), ruleSetId: row.ruleSetId, shiftAssignmentId: row.shiftAssignmentId, engineVersion: row.engineVersion, trace,
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
    const branch = await trx.selectFrom('branches').select('timezone').where('id', '=', emp.branchId).executeTakeFirst();
    const tz = branch?.timezone ?? 'UTC';
    const start = DateTime.fromISO(q.from, { zone: tz }).startOf('day').toJSDate(); const end = DateTime.fromISO(q.to, { zone: tz }).endOf('day').toJSDate();
    const rows = await trx.selectFrom('attendanceEvents as ev').leftJoin('devices as d', 'd.id', 'ev.deviceId').select(['ev.id', 'ev.punchedAt', 'ev.eventType', 'ev.source', 'ev.verificationMethod', 'ev.deviceId', 'd.name as deviceName', 'ev.voidedAt', 'ev.correctionId', 'ev.note'])
      .where('ev.organizationId', '=', orgId).where('ev.employeeId', '=', q.employeeId).where('ev.punchedAt', '>=', start).where('ev.punchedAt', '<=', end).orderBy('ev.punchedAt').limit(5000).execute();
    return rows.map((e) => ({ id: e.id, punchedAt: isoDateTime(e.punchedAt), localDate: DateTime.fromJSDate(e.punchedAt).setZone(tz).toISODate(), eventType: e.eventType, source: e.source, verificationMethod: e.verificationMethod, deviceId: e.deviceId, deviceName: e.deviceName, voidedAt: isoDateTimeOrNull(e.voidedAt), correctionId: e.correctionId, note: e.note }));
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

interface WorkflowStep { order: number; approverType: 'MANAGER' | 'ROLE' | 'USER'; roleId?: string; userId?: string }
function parseWorkflowSteps(raw: unknown): WorkflowStep[] {
  return jsonArray<Record<string, unknown>>(raw).map((s, i) => ({
    order: typeof s.order === 'number' ? s.order : i + 1,
    approverType: String(s.approverType ?? s.approver_type ?? 'ROLE') as WorkflowStep['approverType'],
    roleId: typeof (s.roleId ?? s.role_id) === 'string' ? String(s.roleId ?? s.role_id) : undefined,
    userId: typeof (s.userId ?? s.user_id) === 'string' ? String(s.userId ?? s.user_id) : undefined,
  })).sort((a, b) => a.order - b.order);
}

/** Resolve a workflow step to a concrete approver (user or role) for one employee; MANAGER falls back to hr_admin when unresolvable. */
async function resolveStep(trx: Trx, orgId: string, step: WorkflowStep, employeeId: string): Promise<{ approverType: WorkflowStep['approverType']; approverUserId: string | null; approverRoleId: string | null }> {
  if (step.approverType === 'USER' && step.userId) return { approverType: 'USER', approverUserId: step.userId, approverRoleId: null };
  if (step.approverType === 'ROLE' && step.roleId) return { approverType: 'ROLE', approverUserId: null, approverRoleId: step.roleId };
  if (step.approverType === 'MANAGER') {
    const emp = await trx.selectFrom('employees').select('managerEmployeeId').where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
    if (emp?.managerEmployeeId) {
      const m = await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', emp.managerEmployeeId).where('status', '=', 'active').executeTakeFirst();
      if (m) return { approverType: 'MANAGER', approverUserId: m.userId, approverRoleId: null };
    }
  }
  return { approverType: 'ROLE', approverUserId: null, approverRoleId: SYSTEM_ROLE_IDS.hr_admin };
}

async function approveCorrectionFinal(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, correctionId: string, comment: string | null): Promise<void> {
  await trx.updateTable('attendanceCorrections').set({ status: 'APPROVED' }).where('organizationId', '=', orgId).where('id', '=', correctionId).execute();
  await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'APPLY_CORRECTION', organizationId: orgId, payload: { organizationId: orgId, correctionId }, correlationId: actor.requestId, priority: 7 });
  await emitDomainEvent(trx, { organizationId: orgId, eventType: 'attendance.correction_approved', aggregateType: 'attendance_correction', aggregateId: correctionId, payload: { approvedBy: actor.userId, comment }, actorUserId: actor.userId, requestId: actor.requestId });
}

export async function createCorrection(deps: ApiDeps, actor: Actor, orgId: string, input: CreateCorrectionInput): Promise<CorrectionDto & { approval: 'AUTO_APPROVED' | 'PENDING'; approvalRequestId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.correct');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await trx.selectFrom('employees').select(['id', 'branchId', 'joiningDate', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).executeTakeFirst();
    if (!emp || emp.deletedAt) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
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
    await audit(trx, actor, orgId, 'attendance.correction_submitted', 'attendance_correction', { entityId: row.id, branchId: emp.branchId, newValue: { ...input } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'attendance.correction_submitted', aggregateType: 'attendance_correction', aggregateId: row.id, payload: { employeeId: input.employeeId, attendanceDate: input.attendanceDate, type: input.type }, actorUserId: actor.userId, requestId: actor.requestId });

    // Approval routing (system step: the requester may not hold attendance.approve, which the approval tables require).
    const outcome = await systemStep(trx, orgId, async (t) => {
      const workflows = await t.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('entityType', '=', 'ATTENDANCE_CORRECTION').where('status', '=', 'active').where('isDefault', '=', true)
        .where((eb) => eb.or([eb('branchId', '=', emp.branchId), eb('branchId', 'is', null)])).execute();
      const workflow = workflows.find((w) => w.branchId === emp.branchId) ?? workflows.find((w) => w.branchId === null) ?? null;
      let steps: WorkflowStep[];
      if (workflow) steps = parseWorkflowSteps(workflow.steps);
      else if (hasPermission(grant, 'attendance.approve')) return { kind: 'auto' as const };
      else steps = [{ order: 1, approverType: 'ROLE', roleId: SYSTEM_ROLE_IDS.hr_admin }];
      const request = await t.insertInto('approvalRequests').values({ organizationId: orgId, workflowId: workflow?.id ?? null, entityType: 'ATTENDANCE_CORRECTION', entityId: row.id, branchId: emp.branchId, employeeId: input.employeeId, currentStep: 1, status: 'PENDING', requestedBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
      let stepNo = 0;
      for (const s of steps) {
        const resolved = await resolveStep(t, orgId, s, input.employeeId);
        stepNo += 1;
        await t.insertInto('approvalSteps').values({ organizationId: orgId, requestId: request.id, stepNo, approverType: resolved.approverType, approverRoleId: resolved.approverRoleId, approverUserId: resolved.approverUserId, status: 'PENDING' }).execute();
      }
      await t.updateTable('attendanceCorrections').set({ approvalRequestId: request.id }).where('id', '=', row.id).execute();
      return { kind: 'pending' as const, requestId: request.id, steps: stepNo };
    });
    if (outcome.kind === 'auto') {
      await approveCorrectionFinal(deps, trx, actor, orgId, row.id, 'auto-approved: requester holds attendance.approve and no workflow is configured');
      await audit(trx, actor, orgId, 'attendance.correction_auto_approved', 'attendance_correction', { entityId: row.id, branchId: emp.branchId });
    } else {
      await emitDomainEvent(trx, { organizationId: orgId, eventType: 'approval.pending', aggregateType: 'approval_request', aggregateId: outcome.requestId, payload: { entityType: 'ATTENDANCE_CORRECTION', entityId: row.id, employeeId: input.employeeId, steps: outcome.steps }, actorUserId: actor.userId, requestId: actor.requestId });
    }
    const saved = await trx.selectFrom('attendanceCorrections').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
    return { ...toCorrectionDto(saved), approval: outcome.kind === 'auto' ? 'AUTO_APPROVED' : 'PENDING', approvalRequestId: outcome.kind === 'auto' ? null : outcome.requestId };
  });
}

export async function listCorrections(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; status?: string; employeeId?: string; branchId?: string; from?: string; to?: string }) {
  const { grant, ownOnly } = viewGrant(actor, orgId);
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('attendanceCorrections as c').innerJoin('employees as e', 'e.id', 'c.employeeId').where('c.organizationId', '=', orgId);
    if (ownOnly) base = base.where('c.employeeId', '=', ownOnly); else if (q.employeeId) base = base.where('c.employeeId', '=', q.employeeId);
    if (scope) base = base.where('c.branchId', 'in', scope);
    if (q.status) base = base.where('c.status', '=', q.status as never);
    if (q.from) base = base.where('c.attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('c.attendanceDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('c').select(['e.employeeNumber', 'e.displayName as employeeName']).orderBy('c.createdAt', 'desc').orderBy('c.id').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map((r) => toCorrectionDto(r as CorrectionRow)), total };
  });
}

export async function cancelCorrection(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string | undefined): Promise<CorrectionDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const c = await trx.selectFrom('attendanceCorrections').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!c) throw errors.notFound('Correction', id);
    if (c.requestedBy !== actor.userId && !hasPermission(grant, 'attendance.approve')) throw errors.forbidden('Only the requester or an approver can cancel a correction.');
    if (c.status !== 'PENDING') throw errors.invalidState(`Only pending corrections can be cancelled (current: ${c.status}).`);
    await systemStep(trx, orgId, async (t) => {
      await t.updateTable('attendanceCorrections').set({ status: 'CANCELLED', rejectionReason: reason ?? null }).where('id', '=', id).execute();
      if (c.approvalRequestId) {
        await t.updateTable('approvalRequests').set({ status: 'CANCELLED', completedAt: new Date() }).where('id', '=', c.approvalRequestId).execute();
        await t.updateTable('approvalSteps').set({ status: 'CANCELLED' }).where('requestId', '=', c.approvalRequestId).where('status', '=', 'PENDING').execute();
      }
    });
    await audit(trx, actor, orgId, 'attendance.correction_cancelled', 'attendance_correction', { entityId: id, branchId: c.branchId, reason: reason ?? null });
    return toCorrectionDto(await trx.selectFrom('attendanceCorrections').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
  });
}

function toStepDto(s: { id: string; requestId: string; stepNo: number; approverType: ApprovalStepDto['approverType']; approverRoleId: string | null; approverUserId: string | null; status: ApprovalStepDto['status']; actedBy: string | null; actedAt: Date | null; comment: string | null }): ApprovalStepDto {
  return { id: s.id, requestId: s.requestId, stepNo: s.stepNo, approverType: s.approverType, approverRoleId: s.approverRoleId, approverUserId: s.approverUserId, status: s.status, actedBy: s.actedBy, actedAt: isoDateTimeOrNull(s.actedAt), comment: s.comment };
}

export async function approvalsInbox(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number }) {
  const grant = requireMembership(actor.principal, orgId);
  const roleIds = [grant.roleId].filter((r) => /^[0-9a-f-]{36}$/i.test(r));
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('approvalSteps as s').innerJoin('approvalRequests as r', 'r.id', 's.requestId').where('s.organizationId', '=', orgId).where('s.status', '=', 'PENDING').where('r.status', '=', 'PENDING').whereRef('r.currentStep', '=', 's.stepNo')
      .where((eb) => eb.or([eb('s.approverUserId', '=', actor.userId), ...(roleIds.length ? [eb('s.approverRoleId', 'in', roleIds)] : []), ...(grant.roleKey === 'owner' ? [eb('s.approverType', '=', 'ROLE')] : [])]));
    if (!grant.allBranches) base = base.where((eb) => eb.or([eb('r.branchId', 'is', null), eb('r.branchId', 'in', grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000'])]));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.select(['s.id as stepId', 's.stepNo', 's.approverType', 's.approverRoleId', 's.approverUserId', 'r.id as requestId', 'r.entityType', 'r.entityId', 'r.branchId', 'r.employeeId', 'r.currentStep', 'r.requestedBy', 'r.createdAt', 'r.workflowId']).orderBy('r.createdAt').limit(page.pageSize).offset(page.offset).execute();
    const correctionIds = rows.filter((r) => r.entityType === 'ATTENDANCE_CORRECTION').map((r) => r.entityId);
    const corrections = correctionIds.length ? await trx.selectFrom('attendanceCorrections as c').innerJoin('employees as e', 'e.id', 'c.employeeId').selectAll('c').select(['e.employeeNumber', 'e.displayName as employeeName']).where('c.id', 'in', correctionIds).execute() : [];
    const requesters = rows.map((r) => r.requestedBy).filter((x): x is string => !!x);
    const names = requesters.length ? await trx.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', [...new Set(requesters)]).execute() : [];
    const byId = new Map(corrections.map((c) => [c.id, c]));
    const nameById = new Map(names.map((n) => [n.id, n.fullName || n.email]));
    return {
      data: rows.map((r) => ({ stepId: r.stepId, stepNo: r.stepNo, approverType: r.approverType, requestId: r.requestId, entityType: r.entityType, entityId: r.entityId, branchId: r.branchId, employeeId: r.employeeId, currentStep: r.currentStep, requestedBy: r.requestedBy, requestedByName: r.requestedBy ? nameById.get(r.requestedBy) ?? null : null, createdAt: isoDateTime(r.createdAt), correction: byId.has(r.entityId) ? toCorrectionDto(byId.get(r.entityId) as CorrectionRow) : null })),
      total,
    };
  });
}

async function loadRequest(trx: Trx, orgId: string, id: string, opts: { lock?: boolean } = {}) {
  // `lock` serialises concurrent decisions on one request (FOR UPDATE): the second approver re-reads the committed status.
  let q = trx.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', id);
  if (opts.lock) q = q.forUpdate();
  const r = await q.executeTakeFirst();
  if (!r) throw errors.notFound('Approval request', id);
  const steps = await trx.selectFrom('approvalSteps').selectAll().where('requestId', '=', id).orderBy('stepNo').execute();
  return { request: r, steps };
}
export function toRequestDto(r: { id: string; organizationId: string; workflowId: string | null; entityType: ApprovalRequestDto['entityType']; entityId: string; branchId: string | null; employeeId: string | null; currentStep: number; status: ApprovalRequestDto['status']; requestedBy: string | null; completedAt: Date | null; createdAt: Date }, steps: Parameters<typeof toStepDto>[0][]): ApprovalRequestDto {
  return { id: r.id, organizationId: r.organizationId, workflowId: r.workflowId, entityType: r.entityType, entityId: r.entityId, branchId: r.branchId, employeeId: r.employeeId, currentStep: r.currentStep, status: r.status, requestedBy: r.requestedBy, completedAt: isoDateTimeOrNull(r.completedAt), createdAt: isoDateTime(r.createdAt), steps: steps.map(toStepDto) };
}

function canAct(grant: MembershipGrant, actorUserId: string, step: { approverType: string; approverUserId: string | null; approverRoleId: string | null }): boolean {
  if (step.approverUserId) return step.approverUserId === actorUserId;
  if (step.approverRoleId) return step.approverRoleId === grant.roleId || (grant.roleKey === 'owner' && hasPermission(grant, 'attendance.approve'));
  return false;
}

export async function decide(deps: ApiDeps, actor: Actor, orgId: string, requestId: string, decision: 'approve' | 'reject', input: Decision): Promise<ApprovalRequestDto & { correction: CorrectionDto | null }> {
  const grant = requireMembership(actor.principal, orgId);
  if (decision === 'reject' && !input.comment) throw errors.validation('A comment is required when rejecting.', { issues: [{ path: 'comment', message: 'Required' }] });
  return runUser(deps.db, actor, async (trx) => {
    // System step: approvers assigned by user id (managers) do not necessarily hold attendance.approve.
    const result = await systemStep(trx, orgId, async (t) => {
      const { request, steps } = await loadRequest(t, orgId, requestId, { lock: true });
      if (request.status !== 'PENDING') throw errors.invalidState(`The request is already ${request.status}.`);
      if (!grant.allBranches && request.branchId && !grant.branchIds.includes(request.branchId)) throw errors.forbidden('This request is outside your branch scope.');
      const step = steps.find((s) => s.stepNo === request.currentStep && s.status === 'PENDING');
      if (!step) throw errors.invalidState('The request has no pending step.');
      if (!canAct(grant, actor.userId, step)) throw errors.forbidden('You are not the approver of the current step.');
      // separation of duties: a workflow exists, so the requester never decides on their own request (they can cancel it instead)
      if (request.requestedBy === actor.userId) throw errors.forbidden('You cannot approve or reject your own request; cancel it instead.');
      const now = new Date();
      const acted = await t.updateTable('approvalSteps').set({ status: decision === 'approve' ? 'APPROVED' : 'REJECTED', actedBy: actor.userId, actedAt: now, comment: input.comment ?? null }).where('id', '=', step.id).where('status', '=', 'PENDING').executeTakeFirst();
      if (Number(acted.numUpdatedRows) !== 1) throw errors.conflict('The step was decided concurrently. Please refresh.');
      const correction = request.entityType === 'ATTENDANCE_CORRECTION' ? await t.selectFrom('attendanceCorrections').selectAll().where('id', '=', request.entityId).executeTakeFirst() : undefined;
      if (decision === 'reject') {
        await t.updateTable('approvalSteps').set({ status: 'CANCELLED' }).where('requestId', '=', requestId).where('status', '=', 'PENDING').execute();
        await t.updateTable('approvalRequests').set({ status: 'REJECTED', completedAt: now }).where('id', '=', requestId).execute();
        if (correction) await t.updateTable('attendanceCorrections').set({ status: 'REJECTED', rejectionReason: input.comment ?? null }).where('id', '=', correction.id).execute();
        return { final: true as const, rejected: true as const, correction, branchId: request.branchId };
      }
      const next = steps.find((s) => s.stepNo > request.currentStep && s.status === 'PENDING');
      if (next) { await t.updateTable('approvalRequests').set({ currentStep: next.stepNo }).where('id', '=', requestId).execute(); return { final: false as const, rejected: false as const, correction, branchId: request.branchId }; }
      await t.updateTable('approvalRequests').set({ status: 'APPROVED', completedAt: now }).where('id', '=', requestId).execute();
      return { final: true as const, rejected: false as const, correction, branchId: request.branchId };
    });
    if (result.correction) {
      if (result.rejected) {
        await emitDomainEvent(trx, { organizationId: orgId, eventType: 'attendance.correction_rejected', aggregateType: 'attendance_correction', aggregateId: result.correction.id, payload: { rejectedBy: actor.userId, reason: input.comment ?? null }, actorUserId: actor.userId, requestId: actor.requestId });
      } else if (result.final) {
        await systemStep(trx, orgId, (t) => approveCorrectionFinal(deps, t, actor, orgId, result.correction!.id, input.comment ?? null));
      }
    }
    await audit(trx, actor, orgId, decision === 'approve' ? (result.final ? 'approval.approved' : 'approval.step_approved') : 'approval.rejected', 'approval_request', { entityId: requestId, branchId: result.branchId, newValue: { comment: input.comment ?? null, entityId: result.correction?.id ?? null } });
    const { request, steps } = await systemStep(trx, orgId, (t) => loadRequest(t, orgId, requestId));
    const correction = result.correction ? await systemStep(trx, orgId, (t) => t.selectFrom('attendanceCorrections').selectAll().where('id', '=', result.correction!.id).executeTakeFirstOrThrow()) : null;
    return { ...toRequestDto(request, steps), correction: correction ? toCorrectionDto(correction) : null };
  });
}

// ----- workflows -------------------------------------------------------------------------------------------------------------

export interface WorkflowDto { id: string; organizationId: string; entityType: string; name: string; branchId: string | null; steps: WorkflowStep[]; isDefault: boolean; status: string; createdAt: string; updatedAt: string }
const toWorkflowDto = (w: { id: string; organizationId: string; entityType: string; name: string; branchId: string | null; steps: unknown; isDefault: boolean; status: string; createdAt: Date; updatedAt: Date }): WorkflowDto => ({ id: w.id, organizationId: w.organizationId, entityType: w.entityType, name: w.name, branchId: w.branchId, steps: parseWorkflowSteps(w.steps), isDefault: w.isDefault, status: w.status, createdAt: isoDateTime(w.createdAt), updatedAt: isoDateTime(w.updatedAt) });

export async function listWorkflows(deps: ApiDeps, actor: Actor, orgId: string): Promise<WorkflowDto[]> {
  requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => (await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).orderBy('entityType').orderBy('name').execute()).map(toWorkflowDto));
}
async function validateWorkflowSteps(trx: Trx, orgId: string, steps: ApprovalWorkflowInput['steps']): Promise<void> {
  for (const s of steps) {
    if (s.roleId) { const r = await trx.selectFrom('roles').select('id').where('id', '=', s.roleId).where((eb) => eb.or([eb('isSystem', '=', true), eb('organizationId', '=', orgId)])).executeTakeFirst(); if (!r) throw errors.validation('Unknown role in workflow step.', { roleId: s.roleId }); }
    if (s.userId) { const m = await trx.selectFrom('orgMemberships').select('id').where('organizationId', '=', orgId).where('userId', '=', s.userId).where('status', '=', 'active').executeTakeFirst(); if (!m) throw errors.validation('Workflow step user is not an active member.', { userId: s.userId }); }
  }
}
export async function createWorkflow(deps: ApiDeps, actor: Actor, orgId: string, input: ApprovalWorkflowInput): Promise<WorkflowDto> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  return runUser(deps.db, actor, async (trx) => {
    await validateWorkflowSteps(trx, orgId, input.steps);
    const row = await trx.insertInto('approvalWorkflows').values({ organizationId: orgId, entityType: input.entityType, name: input.name, branchId: input.branchId ?? null, steps: JSON.stringify(input.steps), isDefault: input.isDefault, status: input.status }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'approval_workflow.created', 'approval_workflow', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    return toWorkflowDto(row);
  });
}
export async function updateWorkflow(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<ApprovalWorkflowInput>): Promise<WorkflowDto> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!before) throw errors.notFound('Approval workflow', id);
    if (input.steps) await validateWorkflowSteps(trx, orgId, input.steps);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = k === 'steps' ? JSON.stringify(v) : v;
    if (Object.keys(patch).length) await trx.updateTable('approvalWorkflows').set(patch as never).where('id', '=', id).execute();
    const after = await trx.selectFrom('approvalWorkflows').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'approval_workflow.updated', 'approval_workflow', { entityId: id, branchId: after.branchId, oldValue: toWorkflowDto(before), newValue: toWorkflowDto(after) });
    return toWorkflowDto(after);
  });
}
export async function deleteWorkflow(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'organization.manage');
  return runUser(deps.db, actor, async (trx) => {
    const w = await trx.selectFrom('approvalWorkflows').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!w) throw errors.notFound('Approval workflow', id);
    await trx.deleteFrom('approvalWorkflows').where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'approval_workflow.deleted', 'approval_workflow', { entityId: id, branchId: w.branchId, oldValue: toWorkflowDto(w) });
  });
}

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

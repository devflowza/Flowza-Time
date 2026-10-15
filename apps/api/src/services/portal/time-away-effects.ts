import { DateTime } from 'luxon';
import type { ApprovalContextDto, ApprovalRequestStatus, AttendancePolicySections, PunchInterpretation, TimeAwayKind, TimeAwayRequestDto, TimeAwaySource, TimeAwayStatus } from '@flowza/contracts';
import { additionalShiftOn, enqueueRecompute, loadAdditionalShiftAssignments, resolvePolicyFor, type Trx } from '@flowza/database';
import { timeAwayInactiveReason } from '@flowza/domain';
import { addDays } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { withSystemScope } from '../../lib/service.js';
import type { HookContext } from '../approvals/hooks/index.js';
import { dv } from '../features/sql-helpers.js';
import { isPeriodLocked, loadEmployeeCtx, type EmployeeCtx } from './common.js';
import { resolveDays } from './shift-resolve.js';

/**
 * What a time-away decision DOES (docs/time-away.md): an approved window is read by the engine (load-inputs: approved windows
 * only) when it classifies the day's measured away time, so approving or withdrawing an APPROVED window recomputes the day; a
 * rejection changes nothing on the record (a pending window never counted). The window itself is never edited after it is
 * filed — a different window is a new request. System scope; never imports the engine's calculation.
 */

export type TimeAwayRow = {
  id: string; organizationId: string; employeeId: string; branchId: string | null; attendanceDate: Date | string; kind: TimeAwayKind; source: TimeAwaySource;
  startsAt: Date; endsAt: Date; returnedAt: Date | null; reason: string; destination: string | null; status: TimeAwayStatus; approvalRequestId: string | null;
  stepOutRawId: string | null; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
};
export const TIME_AWAY_COLUMNS = ['id', 'organizationId', 'employeeId', 'branchId', 'attendanceDate', 'kind', 'source', 'startsAt', 'endsAt', 'returnedAt', 'reason', 'destination', 'status', 'approvalRequestId', 'stepOutRawId', 'decidedBy', 'decidedAt', 'decisionNote', 'createdBy', 'createdAt', 'updatedAt'] as const;

export const KIND_LABEL: Record<TimeAwayKind, string> = { OFFICIAL: 'official duty', PERSONAL: 'personal permission' };
export const windowMinutes = (r: Pick<TimeAwayRow, 'startsAt' | 'endsAt'>): number => Math.max(0, Math.round((r.endsAt.getTime() - r.startsAt.getTime()) / 60_000));

export async function loadTimeAway(t: Trx, orgId: string, id: string): Promise<TimeAwayRow | undefined> {
  return (await t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as TimeAwayRow | undefined;
}

/** Rows → DTOs with the approval status and the decider's name (system scope for the lookups; ids the caller could already see). */
export async function timeAwayDtos(trx: Trx, orgId: string, rows: readonly TimeAwayRow[], opts: { withEmployee?: boolean } = {}): Promise<TimeAwayRequestDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const reqs = requestIds.length ? await t.selectFrom('approvalRequests').select(['id', 'status']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : [];
    const userIds = [...new Set(rows.map((r) => r.decidedBy).filter((x): x is string => !!x))];
    const users = userIds.length ? await t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute() : [];
    const employeeIds = opts.withEmployee ? [...new Set(rows.map((r) => r.employeeId))] : [];
    const employees = employeeIds.length ? await t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute() : [];
    const reqOf = new Map(reqs.map((r) => [r.id, r.status as ApprovalRequestStatus]));
    const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email]));
    const empOf = new Map(employees.map((e) => [e.id, e]));
    return rows.map((r): TimeAwayRequestDto => ({
      id: r.id, employeeId: r.employeeId,
      ...(opts.withEmployee ? { employeeName: empOf.get(r.employeeId)?.displayName ?? null, employeeNumber: empOf.get(r.employeeId)?.employeeNumber ?? null } : {}),
      branchId: r.branchId, attendanceDate: isoDate(r.attendanceDate), kind: r.kind, source: r.source, startsAt: isoDateTime(r.startsAt), endsAt: isoDateTime(r.endsAt),
      returnedAt: isoDateTimeOrNull(r.returnedAt), minutes: windowMinutes(r), reason: r.reason, destination: r.destination, status: r.status, approvalRequestId: r.approvalRequestId,
      approvalStatus: r.approvalRequestId ? reqOf.get(r.approvalRequestId) ?? null : null, decidedByName: r.decidedBy ? nameOf.get(r.decidedBy) ?? null : null,
      decidedAt: isoDateTimeOrNull(r.decidedAt), decisionNote: r.decisionNote, createdAt: isoDateTime(r.createdAt),
    }));
  });
}

/**
 * The time-away section of the attendance POLICY that applies to the employee on `date`, resolved exactly as the engine resolves
 * it (branch and department effective on the day, the day's primary shift, else its additional shift), with the punch
 * interpretation that decides whether it can measure anything. System scope.
 */
export async function timeAwayPolicyFor(trx: Trx, orgId: string, emp: EmployeeCtx, date: string, branchId: string): Promise<{ policy: AttendancePolicySections['timeAway']; mode: PunchInterpretation; inactive: 'DISABLED' | 'FIRST_LAST_INTERPRETATION' | null }> {
  const [day] = await resolveDays(trx, orgId, emp, date, date);
  return withSystemScope(trx, orgId, async (t) => {
    const hist = await t.selectFrom('employmentHistory').select('departmentId').where('organizationId', '=', orgId).where('employeeId', '=', emp.id)
      .where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))])).orderBy('effectiveFrom', 'desc').executeTakeFirst();
    const shiftId = day?.shiftId ?? additionalShiftOn(await loadAdditionalShiftAssignments(t, orgId, [emp.id], date, date), date)?.shiftId ?? null;
    const resolved = await resolvePolicyFor(t, orgId, emp.id, date, { branchId, departmentId: hist ? hist.departmentId : emp.departmentId, shiftId });
    const policy = resolved.rules.policy.timeAway;
    const mode = resolved.rules.punchInterpretation;
    return { policy, mode, inactive: timeAwayInactiveReason(policy, mode) };
  });
}

/** Minutes of PERSONAL permission the employee has pending or approved in the calendar month of `date` (the quota's basis). System scope. */
export async function personalMinutesInMonth(trx: Trx, orgId: string, employeeId: string, date: string, excludeId?: string): Promise<number> {
  const monthStart = `${date.slice(0, 7)}-01`;
  const nextMonth = DateTime.fromISO(monthStart, { zone: 'utc' }).plus({ months: 1 }).toISODate()!;
  return withSystemScope(trx, orgId, async (t) => {
    let q = t.selectFrom('timeAwayRequests').select(['startsAt', 'endsAt']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('kind', '=', 'PERSONAL')
      .where('status', 'in', ['pending', 'approved']).where('attendanceDate', '>=', dv(monthStart)).where('attendanceDate', '<', dv(nextMonth));
    if (excludeId) q = q.where('id', '!=', excludeId);
    return (await q.execute()).reduce((sum, r) => sum + windowMinutes(r), 0);
  });
}

/** The (employee, date) records an approved / withdrawn window touches: its attendance date, and the next one when it crosses midnight. */
async function recomputeDays(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'actor'>, row: TimeAwayRow, tz: string): Promise<void> {
  const date = isoDate(row.attendanceDate);
  const endDate = DateTime.fromJSDate(row.endsAt).setZone(tz).toISODate() ?? date;
  for (const d of endDate > date ? [date, addDays(date, 1)] : [date]) {
    await enqueueRecompute(deps.queue, { organizationId: ctx.orgId, employeeId: row.employeeId, date: d, reason: 'TIME_AWAY', triggeredBy: ctx.actor.userId, correlationId: ctx.actor.requestId }, t);
  }
}

/** A window can no longer be approved once its day is in a locked period (HR unlocks first). */
export async function timeAwayApprovalBlocker(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId'>): Promise<string | null> {
  const row = await loadTimeAway(t, ctx.orgId, ctx.entityId);
  if (!row || row.status !== 'pending') return null;
  if (await isPeriodLocked(t, ctx.orgId, row.branchId, isoDate(row.attendanceDate))) return 'The attendance period of this day is locked.';
  return null;
}

export async function applyTimeAwayApproval(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>): Promise<void> {
  const row = await loadTimeAway(t, ctx.orgId, ctx.entityId);
  if (!row || row.status !== 'pending') return;
  await t.updateTable('timeAwayRequests').set({ status: 'approved', decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment }).where('id', '=', row.id).where('status', '=', 'pending').execute();
  const emp = await loadEmployeeCtx(t, ctx.orgId, row.employeeId);
  await recomputeDays(deps, t, ctx, row, emp.timezone);
}

export async function applyTimeAwayClosed(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>, outcome: 'rejected' | 'cancelled'): Promise<void> {
  const row = await loadTimeAway(t, ctx.orgId, ctx.entityId);
  if (!row || (row.status !== 'pending' && !(outcome === 'cancelled' && row.status === 'approved'))) return;
  await t.updateTable('timeAwayRequests').set({ status: outcome, decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment }).where('id', '=', row.id).where('status', '=', row.status).execute();
  // only an APPROVED window ever reached the record: withdrawing one recomputes its day
  if (row.status === 'approved') await recomputeDays(deps, t, ctx, row, (await loadEmployeeCtx(t, ctx.orgId, row.employeeId)).timezone);
}

export async function timeAwayContexts(t: Trx, orgId: string, ids: string[]): Promise<Map<string, ApprovalContextDto>> {
  const out = new Map<string, ApprovalContextDto>();
  if (ids.length === 0) return out;
  const rows = (await t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as TimeAwayRow[];
  for (const r of rows) {
    const emp = await loadEmployeeCtx(t, orgId, r.employeeId).catch(() => null);
    const tz = emp?.timezone ?? null;
    const date = isoDate(r.attendanceDate);
    const fmt = (d: Date) => (tz ? DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm') : d.toISOString().slice(11, 16));
    let used: number | null = null; let quota: number | null = null;
    if (r.kind === 'PERSONAL' && emp) {
      used = await personalMinutesInMonth(t, orgId, r.employeeId, date);
      quota = (await timeAwayPolicyFor(t, orgId, emp, date, r.branchId ?? emp.branchId).catch(() => null))?.policy.personalMonthlyQuotaMinutes ?? null;
    }
    out.set(r.id, {
      kind: 'TIME_AWAY', summary: `${KIND_LABEL[r.kind]} · ${date} ${fmt(r.startsAt)}–${fmt(r.endsAt)}`,
      timeAway: { id: r.id, attendanceDate: date, kind: r.kind, source: r.source, startsAt: isoDateTime(r.startsAt), endsAt: isoDateTime(r.endsAt), returnedAt: isoDateTimeOrNull(r.returnedAt), minutes: windowMinutes(r), reason: r.reason, destination: r.destination, status: r.status, timezone: tz, personalUsedMinutes: used, personalMonthlyQuotaMinutes: quota },
    });
  }
  return out;
}

import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { isoDateSchema, uuidSchema, type AttendanceFlag, type AttendanceSettings, type AttendanceStatus } from '@flowza/contracts';
import { addDays, event } from '@flowza/shared';
import { activeMarksBetween, chargeUnexcusedDay, emitDomainEvent, markDay, withContext, writeAudit, type Trx } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';
import { asDate, isoDate, loadAttendanceSettings, parsePayload } from './common.js';
import { isPeriodLocked } from './recompute.js';

/**
 * Day-close sweep (HR portal Prompt 3; Finance parity `_sweep_unexcused_attendance`, ATT-87/88, B-25).
 *
 * Once a working day is older than the grace period — `max(missedPunch.dayCloseGraceDays, unexcused.graceDays)` days in
 * the organisation's timezone — a day that is ABSENT, carries the LATE flag, or carries MISSING_IN / MISSING_OUT and has
 * no open explanation is marked UNEXCUSED (source SWEEP). "Open explanation" today = an active EXCUSED / PAY_EFFECT / LOP
 * mark or approved leave covering the day; the attendance notes of Prompt 4 join that list by writing marks through the
 * same table. When `unexcused.autoDeductEnabled` is on, the pay effect (`payEffectAbsent` / `payEffectLate` /
 * `payEffectMissingPunch`, the largest applicable weight) is charged through the one pay-effect charger — paid leave first,
 * LOP otherwise — the same function a manager's rejection uses.
 *
 * Bounded (DAY_CLOSE_MAX_DAYS records per organisation per run, a DAY_CLOSE_LOOKBACK_DAYS window before the cut-off so
 * history that pre-dates the policy is not judged retroactively), idempotent (a marked day is never marked twice), skips
 * locked periods, isolates per-day failures with savepoints, and emits ONE `attendance.unexcused_marked` event per
 * (employee, run) targeted at the employee's login and the managers holding `attendance.approve`.
 */
export const DAY_CLOSE_JOB_TYPE = 'ATTENDANCE_DAY_CLOSE';
export const DAY_CLOSE_MAX_DAYS = 5_000;
export const DAY_CLOSE_LOOKBACK_DAYS = 31;

export const dayClosePayloadSchema = z.object({
  organizationId: uuidSchema,
  /** "Today" in the organisation's timezone; defaults to the current local date. */
  asOf: isoDateSchema.optional(),
  /** Oldest date considered (default: cut-off − DAY_CLOSE_LOOKBACK_DAYS). */
  fromDate: isoDateSchema.optional(),
});
export type DayClosePayload = z.infer<typeof dayClosePayloadSchema>;

export interface DayCloseSummary {
  asOf: string;
  cutoff: string;
  fromDate: string;
  candidates: number;
  marked: number;
  chargedLeave: number;
  lop: number;
  alreadyMarked: number;
  skippedLocked: number;
  skippedLeave: number;
  skippedDisabled: number;
  errors: number;
  employees: number;
  capped: boolean;
}

export const dayCloseDedupeKey = (organizationId: string, localDate: string): string => `day-close:${organizationId}:${localDate}`;

type Candidate = { id: string; employeeId: string; attendanceDate: string; branchId: string; status: AttendanceStatus; flags: AttendanceFlag[] };
type Cause = 'ABSENT' | 'LATE' | 'MISSING_PUNCH';

/** Why the day needs an explanation and what it weighs under the policy (the largest applicable weight wins). */
export function assessDay(status: AttendanceStatus, flags: readonly string[], settings: AttendanceSettings): { cause: Cause; payEffectDays: number } | null {
  const options: Array<{ cause: Cause; payEffectDays: number }> = [];
  if (status === 'ABSENT') options.push({ cause: 'ABSENT', payEffectDays: settings.unexcused.payEffectAbsent });
  if (flags.includes('LATE')) options.push({ cause: 'LATE', payEffectDays: settings.unexcused.payEffectLate });
  if (settings.missedPunch.detectionEnabled && (flags.includes('MISSING_IN') || flags.includes('MISSING_OUT'))) options.push({ cause: 'MISSING_PUNCH', payEffectDays: settings.unexcused.payEffectMissingPunch });
  if (options.length === 0) return null;
  return options.sort((a, b) => b.payEffectDays - a.payEffectDays)[0]!;
}

/** Today's date in the organisation's timezone. */
export async function orgLocalDate(trx: Trx, organizationId: string, now: Date): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', organizationId).executeTakeFirst();
  const zone = org?.timezone ?? 'UTC';
  return DateTime.fromJSDate(now).setZone(zone).toISODate() ?? now.toISOString().slice(0, 10);
}

/**
 * Who hears about an employee's unexcused days: the employee's own login(s) plus the line managers (primary / secondary
 * manager on the employee record) whose role holds `attendance.approve`. When no line manager qualifies, the approvers
 * who can actually open the employee's records — `attendance.approve` AND `attendance.view`, all branches or the
 * employee's branch — so a line manager of another team is never told about somebody outside their team.
 */
export async function dayCloseRecipients(trx: Trx, organizationId: string, employeeId: string): Promise<string[]> {
  const rows = await sql<{ userId: string }>`
    with emp as (select id, branch_id, manager_employee_id, secondary_manager_employee_id from public.employees where organization_id = ${organizationId}::uuid and id = ${employeeId}::uuid),
    own as (select m.user_id from public.org_memberships m where m.organization_id = ${organizationId}::uuid and m.status = 'active' and m.employee_id = ${employeeId}::uuid),
    managers as (
      select distinct m.user_id from public.org_memberships m
      join public.role_permissions rp on rp.role_id = m.role_id and rp.permission_key = 'attendance.approve'
      join emp on m.employee_id in (emp.manager_employee_id, emp.secondary_manager_employee_id)
      where m.organization_id = ${organizationId}::uuid and m.status = 'active' and m.employee_id is not null
    ),
    approvers as (
      select distinct m.user_id from public.org_memberships m cross join emp
      where m.organization_id = ${organizationId}::uuid and m.status = 'active'
        and exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'attendance.approve')
        and exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'attendance.view')
        and (m.all_branches or exists (select 1 from public.membership_branches mb where mb.membership_id = m.id and mb.branch_id = emp.branch_id))
    )
    select user_id as "userId" from own
    union select user_id from managers
    union select user_id from approvers where not exists (select 1 from managers)`.execute(trx);
  return [...new Set(rows.rows.map((r) => r.userId))].sort();
}

export async function runDayClose(trx: Trx, p: DayClosePayload, now: Date, jobId: string | null, log?: JobContext['log'], queue?: JobContext['deps']['queue']): Promise<DayCloseSummary> {
  const { organizationId } = p;
  const settings = await loadAttendanceSettings(trx, organizationId);
  const asOf = p.asOf ?? await orgLocalDate(trx, organizationId, now);
  const grace = Math.max(settings.missedPunch.dayCloseGraceDays, settings.unexcused.graceDays);
  const cutoff = addDays(asOf, -grace);
  const fromDate = p.fromDate ?? addDays(cutoff, -DAY_CLOSE_LOOKBACK_DAYS);
  const summary: DayCloseSummary = { asOf, cutoff, fromDate, candidates: 0, marked: 0, chargedLeave: 0, lop: 0, alreadyMarked: 0, skippedLocked: 0, skippedLeave: 0, skippedDisabled: 0, errors: 0, employees: 0, capped: false };
  if (fromDate > cutoff) return summary;

  // Working days that still need an explanation: judged (not PENDING), absent / late / missing a punch, not yet marked.
  // The flags reflect the last recompute; the marks table is checked again below so a mark whose recompute is still queued
  // cannot be duplicated.
  const rows = await trx.selectFrom('attendanceDailyRecords')
    .select(['id', 'employeeId', 'attendanceDate', 'branchId', 'status', 'flags'])
    .where('organizationId', '=', organizationId).where('attendanceDate', '>=', asDate(fromDate)).where('attendanceDate', '<=', asDate(cutoff))
    .where('status', 'in', ['ABSENT', 'PRESENT', 'HALF_DAY', 'MISSING_PUNCH'])
    .where((eb) => eb.or([eb('status', '=', 'ABSENT'), sql<boolean>`'LATE' = any(flags)`, sql<boolean>`'MISSING_IN' = any(flags)`, sql<boolean>`'MISSING_OUT' = any(flags)`]))
    .where(sql<boolean>`not (flags && array['UNEXCUSED', 'EXCUSED', 'LOP', 'PAY_EFFECT_HALF', 'PAY_EFFECT_FULL']::text[])`)
    .orderBy('attendanceDate', 'asc').orderBy('employeeId', 'asc').limit(DAY_CLOSE_MAX_DAYS + 1).execute();
  summary.capped = rows.length > DAY_CLOSE_MAX_DAYS;
  const candidates: Candidate[] = rows.slice(0, DAY_CLOSE_MAX_DAYS).map((r) => ({ id: r.id, employeeId: r.employeeId, attendanceDate: isoDate(r.attendanceDate), branchId: r.branchId, status: r.status as AttendanceStatus, flags: (Array.isArray(r.flags) ? r.flags : []) as AttendanceFlag[] }));
  summary.candidates = candidates.length;
  if (candidates.length === 0) return summary;

  const employeeIds = [...new Set(candidates.map((c) => c.employeeId))];
  const [marks, leaves, locks] = await Promise.all([
    activeMarksBetween(trx, organizationId, employeeIds, fromDate, cutoff),
    trx.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', organizationId).where('status', '=', 'APPROVED').where('employeeId', 'in', employeeIds)
      .where('startDate', '<=', asDate(cutoff)).where('endDate', '>=', asDate(fromDate)).execute(),
    trx.selectFrom('attendancePeriodLocks').select(['branchId', 'periodStart', 'periodEnd']).where('organizationId', '=', organizationId).where('unlockedAt', 'is', null)
      .where('periodStart', '<=', asDate(cutoff)).where('periodEnd', '>=', asDate(fromDate)).execute(),
  ]);
  const markedKeys = new Set(marks.map((m) => `${m.employeeId}|${m.attendanceDate}`));
  const onLeave = (employeeId: string, date: string) => leaves.some((l) => l.employeeId === employeeId && isoDate(l.startDate) <= date && isoDate(l.endDate) >= date);
  const lockedByCache = (branchId: string, date: string) => locks.some((l) => (l.branchId === null || l.branchId === branchId) && isoDate(l.periodStart) <= date && isoDate(l.periodEnd) >= date);

  const markedByEmployee = new Map<string, string[]>();
  for (const c of candidates) {
    const key = `${c.employeeId}|${c.attendanceDate}`;
    if (markedKeys.has(key)) { summary.alreadyMarked++; continue; }
    if (onLeave(c.employeeId, c.attendanceDate)) { summary.skippedLeave++; continue; }
    const assessed = assessDay(c.status, c.flags, settings);
    if (!assessed) { summary.skippedDisabled++; continue; }
    if (lockedByCache(c.branchId, c.attendanceDate) || await isPeriodLocked(trx, organizationId, c.branchId, c.attendanceDate)) { summary.skippedLocked++; continue; }
    if (!queue) throw new Error('day close needs the job queue to enqueue recomputes');
    await sql`savepoint day_close_row`.execute(trx);
    try {
      const reason = `Day close: ${assessed.cause.toLowerCase().replace('_', ' ')} on ${c.attendanceDate} left unexplained after ${grace} day(s)`;
      const { created } = await markDay(trx, queue, { organizationId, employeeId: c.employeeId, attendanceDate: c.attendanceDate, branchId: c.branchId, kind: 'UNEXCUSED', payEffectDays: assessed.payEffectDays, source: 'SWEEP', sourceId: null, reason, createdBy: null }, { now, recomputeReason: 'RECALCULATION' });
      if (!created) { summary.alreadyMarked++; await sql`release savepoint day_close_row`.execute(trx); continue; }
      summary.marked++;
      markedKeys.add(key);
      markedByEmployee.set(c.employeeId, [...(markedByEmployee.get(c.employeeId) ?? []), c.attendanceDate]);
      if (settings.unexcused.autoDeductEnabled && assessed.payEffectDays > 0) {
        const charge = await chargeUnexcusedDay(trx, queue, { organizationId, employeeId: c.employeeId, date: c.attendanceDate, payEffectDays: assessed.payEffectDays, sourceKind: 'SWEEP', sourceId: null, createdBy: null, halfDayPart: assessed.cause === 'LATE' ? 'FIRST_HALF' : 'SECOND_HALF' }, settings.unexcused, { now });
        if (charge.outcome === 'charged_leave') summary.chargedLeave++;
        else if (charge.outcome === 'lop') summary.lop++;
      }
      await sql`release savepoint day_close_row`.execute(trx);
    } catch (err) {
      await sql`rollback to savepoint day_close_row`.execute(trx);
      summary.errors++;
      log?.warn(event('day_close_row_failed', { organizationId, employeeId: c.employeeId, date: c.attendanceDate, err: (err as Error).message }));
    }
  }

  summary.employees = markedByEmployee.size;
  for (const [employeeId, dates] of markedByEmployee) {
    const userIds = await dayCloseRecipients(trx, organizationId, employeeId);
    await emitDomainEvent(trx, {
      organizationId, eventType: 'attendance.unexcused_marked', aggregateType: 'employee', aggregateId: employeeId,
      payload: { employeeId, dates: dates.sort(), count: dates.length, autoDeduct: settings.unexcused.autoDeductEnabled, userIds },
      actorUserId: null,
    });
  }
  if (summary.marked > 0 || summary.errors > 0) {
    await writeAudit(trx, { organizationId, actorUserId: null, actorType: 'SYSTEM', action: 'attendance.day_close_swept', entityType: 'attendance_day_mark', entityId: null, newValue: summary, jobId });
  }
  return summary;
}

/**
 * ATTENDANCE_DAY_CLOSE handler: payload `{ organizationId, asOf?, fromDate? }`, one organisation per job, one transaction in
 * the organisation's system context with a savepoint per day (a failing day is counted and skipped, the rest commits).
 */
export async function dayCloseHandler({ job, deps, log }: JobContext) {
  const p = parsePayload(dayClosePayloadSchema, job.payload);
  const ctx = { kind: 'system' as const, organizationId: p.organizationId, jobId: job.id };
  const res = await withContext(deps.db, ctx, (trx) => runDayClose(trx, p, deps.now(), job.id, log, deps.queue));
  log.info(event('attendance_day_close', { organizationId: p.organizationId, ...res }));
  return res;
}

export function registerDayCloseHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: DAY_CLOSE_JOB_TYPE, handler: dayCloseHandler, timeoutMs: 1_800_000 });
}

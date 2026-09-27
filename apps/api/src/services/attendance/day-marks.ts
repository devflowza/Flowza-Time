import { sql } from 'kysely';
import type { CreateDayMarkInput, DayMarkDto, DayMarksQuery } from '@flowza/contracts';
import { effectiveBranchOn, markDay as writeMark, revokeMark as writeRevocation, toDayMarkRow, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { eachDate, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, isTeamMember, requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { isPeriodLocked } from '../features/attendance.service.js';
import { systemStep } from '../features/context.js';
import { toDayMarkDto } from '../features/mappers.js';
import { chargeDayAsSystem, reverseChargeAsSystem, type ChargeOutcome } from './pay-effect.js';

/**
 * HR / manager surface of the attendance day marks (HR portal Prompt 3). Authorization twice: the service checks the
 * permission, the team scope and the branch scope; RLS enforces read scope (attendance.view / own rows / attendance.view_team)
 * and write scope (attendance.approve + branch) again. Every write queues the day's recompute in the same transaction
 * through the shared primitives of `@flowza/database` — the daily record is never patched directly.
 *
 *   EXCUSED     waives the consequences: any PAY_EFFECT / LOP charge on the day is reversed (leave restored) first;
 *   UNEXCUSED   marks the day; with a pay effect > 0 it is also charged through the pay-effect charger;
 *   PAY_EFFECT  charges 0.5 / 1 day through the charger (paid leave first, else LOP) — the mark written is what the
 *               charger decided (PAY_EFFECT when leave covered it, LOP otherwise), never a bare PAY_EFFECT row.
 * A user never marks their own days (segregation of duties), and a locked period is refused rather than left with a
 * mark its record cannot pick up. A contradictory verdict is refused too (409): UNEXCUSED / PAY_EFFECT on a day that is
 * excused or covered by approved leave — revoke the excuse / cancel the leave first.
 */
const MAX_RANGE_DAYS = 366;
const dv = (date: string) => sql<Date>`${date}::date`;

/** Who may see marks: org-wide readers, line managers (team key) for their reports, employees for themselves. */
function readScope(grant: MembershipGrant, employeeId: string | undefined): { employeeIds: string[] | null; scopeBranches: string[] | null } {
  if (hasPermission(grant, 'attendance.view')) return { employeeIds: employeeId ? [employeeId] : null, scopeBranches: branchFilter(grant) };
  const team = hasPermission(grant, 'attendance.view_team') ? grant.teamEmployeeIds : [];
  const own = hasPermission(grant, 'attendance.view_own') && grant.employeeId ? [grant.employeeId] : [];
  const visible = [...new Set([...team, ...own])];
  if (visible.length === 0) throw errors.forbidden('Missing permission: attendance.view.');
  if (employeeId) {
    if (!visible.includes(employeeId)) throw errors.forbidden('You may only view marks of your own days or of your direct reports.');
    return { employeeIds: [employeeId], scopeBranches: null };
  }
  return { employeeIds: visible, scopeBranches: null };
}

export async function listDayMarks(deps: ApiDeps, actor: Actor, orgId: string, q: DayMarksQuery): Promise<DayMarkDto[]> {
  const grant = requireMembership(actor.principal, orgId);
  if (eachDate(q.from, q.to).length > MAX_RANGE_DAYS) throw errors.validation(`The range may span at most ${MAX_RANGE_DAYS} days.`);
  const scope = readScope(grant, q.employeeId);
  const includeRevoked = q.includeRevoked === 'true' || q.includeRevoked === '1';
  return runUser(deps.db, actor, async (trx) => {
    let query = trx.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', orgId).where('attendanceDate', '>=', dv(q.from)).where('attendanceDate', '<=', dv(q.to));
    if (scope.employeeIds) query = query.where('employeeId', 'in', scope.employeeIds);
    if (scope.scopeBranches) query = query.where('branchId', 'in', scope.scopeBranches);
    if (q.kind) query = query.where('kind', '=', q.kind);
    if (!includeRevoked) query = query.where('revokedAt', 'is', null);
    const rows = await query.orderBy('attendanceDate', 'desc').orderBy('createdAt', 'desc').limit(5000).execute();
    return rows.map((r) => toDayMarkDto(toDayMarkRow(r)));
  });
}

/** attendance.approve, plus the team rule for callers without organisation-wide attendance.view, plus never one's own day. */
function writeGrant(actor: Actor, orgId: string, employeeId: string): MembershipGrant {
  const grant = requirePermission(actor.principal, orgId, 'attendance.approve');
  if (grant.employeeId === employeeId) throw errors.forbidden('You cannot mark your own attendance days.');
  if (!hasPermission(grant, 'attendance.view') && !isTeamMember(grant, employeeId)) throw errors.forbidden('Line managers may mark the days of their direct reports only.');
  return grant;
}

async function assertMarkable(trx: Trx, grant: MembershipGrant, orgId: string, employeeId: string, date: string): Promise<{ branchId: string | null }> {
  const emp = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!emp) throw errors.notFound('Employee', employeeId);
  const branchId = (await effectiveBranchOn(trx, orgId, employeeId, date)) ?? emp.branchId;
  requireBranchAccess(grant, branchId);
  if (await isPeriodLocked(trx, orgId, branchId, date)) throw errors.periodLocked('The attendance period is locked; unlock it before marking days in it.');
  return { branchId };
}

/**
 * What already stands on the day, read in a system step: a custom role may hold attendance.approve without the leave /
 * attendance read keys, and a check that silently saw nothing would let a contradictory mark through.
 */
async function dayState(trx: Trx, orgId: string, employeeId: string, date: string): Promise<{ excused: boolean; coveredByLeave: boolean }> {
  return systemStep(trx, orgId, async (t) => {
    const [excused, leave] = await Promise.all([
      t.selectFrom('attendanceDayMarks').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('attendanceDate', '=', dv(date)).where('kind', '=', 'EXCUSED').where('revokedAt', 'is', null).executeTakeFirst(),
      t.selectFrom('leaveRecords').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('status', '=', 'APPROVED').where('startDate', '<=', dv(date)).where('endDate', '>=', dv(date)).executeTakeFirst(),
    ]);
    return { excused: excused !== undefined, coveredByLeave: leave !== undefined };
  });
}

const REFUSALS: Partial<Record<ChargeOutcome, string>> = {
  covered_by_leave: 'The day is already covered by approved leave.',
  excused: 'The day is excused; revoke the EXCUSED mark first.',
  no_effect: 'Nothing to charge for this day.',
};

export async function createDayMark(deps: ApiDeps, actor: Actor, orgId: string, input: CreateDayMarkInput): Promise<DayMarkDto & { charge: { outcome: ChargeOutcome; leaveTypeCode: string | null } | null; reversed: number }> {
  const grant = writeGrant(actor, orgId, input.employeeId);
  return runUser(deps.db, actor, async (trx) => {
    const { branchId } = await assertMarkable(trx, grant, orgId, input.employeeId, input.attendanceDate);
    const common = { organizationId: orgId, employeeId: input.employeeId, attendanceDate: input.attendanceDate, branchId, reason: input.reason, createdBy: actor.userId, source: 'HR' as const };
    let mark: DayMarkDto;
    let charge: { outcome: ChargeOutcome; leaveTypeCode: string | null } | null = null;
    let reversed = 0;
    if (input.kind === 'PAY_EFFECT') {
      const result = await chargeDayAsSystem(deps, trx, actor, orgId, { employeeId: input.employeeId, date: input.attendanceDate, payEffectDays: input.payEffectDays ?? 0, sourceKind: 'HR', reason: input.reason });
      // charged now, or already charged (idempotent: the existing charge is returned); anything else charged nothing
      const refusal = REFUSALS[result.outcome];
      if (refusal || !result.mark) throw errors.invalidState(refusal ?? 'Nothing to charge for this day.', { outcome: result.outcome });
      mark = toDayMarkDto(result.mark);
      charge = { outcome: result.outcome, leaveTypeCode: result.leaveTypeCode };
    } else {
      if (input.kind === 'UNEXCUSED') {
        // an unexcused verdict on an excused or leave-covered day contradicts what stands: undo that first
        const state = await dayState(trx, orgId, input.employeeId, input.attendanceDate);
        if (state.excused) throw errors.invalidState(REFUSALS.excused!, { outcome: 'excused' });
        if (state.coveredByLeave) throw errors.invalidState(REFUSALS.covered_by_leave!, { outcome: 'covered_by_leave' });
      }
      if (input.kind === 'EXCUSED') {
        const undone = await reverseChargeAsSystem(deps, trx, actor, orgId, { employeeId: input.employeeId, date: input.attendanceDate, reason: `Excused: ${input.reason}` });
        reversed = undone.reversedMarks.length;
      }
      const written = await writeMark(trx, deps.queue, { ...common, kind: input.kind, payEffectDays: input.kind === 'UNEXCUSED' ? input.payEffectDays ?? 0 : 0 }, { correlationId: actor.requestId });
      mark = toDayMarkDto(written.mark);
      if (input.kind === 'UNEXCUSED' && (input.payEffectDays ?? 0) > 0) {
        const result = await chargeDayAsSystem(deps, trx, actor, orgId, { employeeId: input.employeeId, date: input.attendanceDate, payEffectDays: input.payEffectDays ?? 0, sourceKind: 'HR', reason: input.reason });
        charge = { outcome: result.outcome, leaveTypeCode: result.leaveTypeCode };
      }
    }
    await audit(trx, actor, orgId, 'attendance.day_mark_created', 'attendance_day_mark', { entityId: mark.id, branchId, newValue: { employeeId: input.employeeId, attendanceDate: input.attendanceDate, kind: mark.kind, payEffectDays: mark.payEffectDays, charge, reversed }, reason: input.reason });
    return { ...mark, charge, reversed };
  });
}

export async function revokeDayMark(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason: string): Promise<DayMarkDto> {
  requirePermission(actor.principal, orgId, 'attendance.approve'); // before any read: a caller without the key learns nothing about the mark
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Attendance day mark', id);
    const existing = toDayMarkRow(row);
    const grant = writeGrant(actor, orgId, existing.employeeId);
    await assertMarkable(trx, grant, orgId, existing.employeeId, existing.attendanceDate);
    if (existing.revokedAt) return toDayMarkDto(existing);
    // a charged day: the internal leave row goes with the mark (system step: an APPROVED row is cancelled)
    if (existing.kind === 'PAY_EFFECT') {
      await systemStep(trx, orgId, (t) => t.updateTable('leaveRecords').set({ status: 'CANCELLED', decisionNote: `Charge reversed: ${reason}`.slice(0, 1000) })
        .where('organizationId', '=', orgId).where('employeeId', '=', existing.employeeId).where('externalRef', '=', `mark:${existing.id}`).where('status', '=', 'APPROVED').execute());
    }
    const revoked = await writeRevocation(trx, deps.queue, { organizationId: orgId, markId: existing.id, revokedBy: actor.userId, reason }, { recomputeReason: existing.kind === 'PAY_EFFECT' ? 'LEAVE_CHANGE' : 'MANUAL_OVERRIDE', correlationId: actor.requestId });
    if (!revoked) throw errors.notFound('Attendance day mark', id);
    await audit(trx, actor, orgId, 'attendance.day_mark_revoked', 'attendance_day_mark', { entityId: existing.id, branchId: existing.branchId, oldValue: { kind: existing.kind, payEffectDays: existing.payEffectDays }, reason });
    return toDayMarkDto(revoked);
  });
}

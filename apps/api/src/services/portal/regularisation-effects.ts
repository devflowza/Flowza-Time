import { sql } from 'kysely';
import type { ApprovalContextDto, AttendanceEventType, RegularisationStatus, RegularisationType } from '@flowza/contracts';
import { ensureSelfServiceDevice, writeAudit, type Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { enqueueJob } from '../../lib/jobs.js';
import { isoDate, isoDateTimeOrNull } from '../../lib/mappers.js';
import type { HookContext } from '../approvals/hooks/index.js';
import { emitToUsers, isPeriodLocked, loadEmployeeCtx, localDate, userIdsOfEmployees } from './common.js';

/**
 * What an approved regularisation DOES (HR portal Prompt 4): it is applied THROUGH attendance corrections — never by editing
 * events — so the raw ledger, the void/add audit trail and the recompute stay the ones every other correction uses:
 *
 *   missed_punch     ADD_PUNCH for the proposed check-in and / or check-out;
 *   wrong_punch      EDIT_PUNCH of the day's check-in (first PUNCH_IN) / check-out (last PUNCH_OUT) to the proposed time —
 *                    only a punch of the SAME direction (review P1-6: a punch's direction is never flipped, and a
 *                    direction-less device punch is never guessed at); ADD_PUNCH of that direction when the day has none;
 *   wfh_unmarked,    ADD_PUNCH for whatever times were given, plus SET_STATUS PRESENT (the employee worked, the terminal
 *   system_downtime  simply never saw it).
 *
 * The corrections are created APPROVED (the regularisation's own request was the approval) ON BEHALF OF that approval — the
 * approver is recorded as who applied them, and `attendance.regularisation_applied` names them in the audit (review P2-9:
 * status changes stay HR's for DIRECT corrections; a regularisation's are decided through its approval). They are stamped
 * with the organisation's self-service device (their CORRECTION events carry it) and the reason "Regularisation (…): …", and
 * APPLY_CORRECTION jobs are queued in the same transaction; the worker voids / adds events and recomputes.
 *
 * Applying is IDEMPOTENT (review P2-10): a punch the day already has (same instant and direction), or a correction that
 * already does the same (approved or applied — a self-correction, another regularisation), is not added again; the skipped
 * ones are listed in the audit. System scope; never imports the engine.
 */

export type RegularisationRow = {
  id: string; organizationId: string; employeeId: string; branchId: string | null; attendanceDate: Date | string; type: RegularisationType; proposedInAt: Date | null; proposedOutAt: Date | null; reason: string;
  status: RegularisationStatus; approvalRequestId: string | null; appliedCorrectionId: string | null; appliedAt: Date | null; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
};
export const REGULARISATION_COLUMNS = ['id', 'organizationId', 'employeeId', 'branchId', 'attendanceDate', 'type', 'proposedInAt', 'proposedOutAt', 'reason', 'status', 'approvalRequestId', 'appliedCorrectionId', 'appliedAt', 'decidedBy', 'decidedAt', 'decisionNote', 'createdBy', 'createdAt', 'updatedAt'] as const;

const TYPE_LABEL: Record<RegularisationType, string> = { missed_punch: 'missed punch', wrong_punch: 'wrong punch', wfh_unmarked: 'work from home not marked', system_downtime: 'system downtime' };

export async function loadRegularisation(t: Trx, orgId: string, id: string): Promise<RegularisationRow | undefined> {
  return (await t.selectFrom('attendanceRegularisationRequests').select(REGULARISATION_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as RegularisationRow | undefined;
}

type EventLite = { id: string; punchedAt: Date; eventType: AttendanceEventType };

/** The employee's live events whose local date (branch timezone) is the regularised date. */
async function eventsOfDay(t: Trx, orgId: string, employeeId: string, date: string, tz: string): Promise<EventLite[]> {
  const rows = await t.selectFrom('attendanceEvents').select(['id', 'punchedAt', 'eventType'])
    .where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('voidedAt', 'is', null)
    .where('punchedAt', '>=', sql<Date>`(${date}::date - interval '1 day')::timestamptz`).where('punchedAt', '<', sql<Date>`(${date}::date + interval '2 day')::timestamptz`)
    .orderBy('punchedAt', 'asc').orderBy('id', 'asc').execute();
  return rows.filter((r) => localDate(r.punchedAt, tz) === date);
}

/** What one correction would do, and the identical punch / correction that makes it unnecessary (P2-10). */
type CorrectionSpec = { type: 'ADD_PUNCH' | 'EDIT_PUNCH' | 'SET_STATUS'; originalEventId?: string; originalPunchedAt?: Date; proposedPunchedAt?: Date; proposedEventType?: AttendanceEventType; proposedStatus?: 'PRESENT' };

async function alreadyDone(t: Trx, orgId: string, employeeId: string, date: string, events: readonly EventLite[], spec: CorrectionSpec): Promise<string | null> {
  if (spec.proposedPunchedAt && spec.proposedEventType) {
    const at = spec.proposedPunchedAt.getTime();
    const same = events.find((e) => e.punchedAt.getTime() === at && e.eventType === spec.proposedEventType);
    if (same) return `the day already has this ${spec.proposedEventType === 'PUNCH_IN' ? 'check-in' : 'check-out'}`;
  }
  let q = t.selectFrom('attendanceCorrections').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`)
    .where('status', 'in', ['APPROVED', 'APPLIED']).where('type', '=', spec.type);
  if (spec.type === 'SET_STATUS') q = q.where('proposedStatus', '=', spec.proposedStatus ?? 'PRESENT');
  else if (spec.type === 'EDIT_PUNCH') q = q.where('originalEventId', '=', spec.originalEventId ?? null);
  else q = q.where('proposedPunchedAt', '=', spec.proposedPunchedAt ?? null).where('proposedEventType', '=', spec.proposedEventType ?? null);
  const dup = await q.executeTakeFirst();
  return dup ? `an equivalent correction is already approved (${dup.id})` : null;
}

export async function applyRegularisationApproval(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'requestId' | 'actor' | 'comment'>): Promise<string[]> {
  const reg = await loadRegularisation(t, ctx.orgId, ctx.entityId);
  if (!reg || reg.status !== 'pending') return [];
  const emp = await loadEmployeeCtx(t, ctx.orgId, reg.employeeId);
  const date = isoDate(reg.attendanceDate);
  // the branch that owned the day (captured when it was filed — employment history), not the current one
  const branchId = reg.branchId ?? emp.branchId;
  if (await isPeriodLocked(t, ctx.orgId, branchId, date)) throw errors.periodLocked('The attendance period of this day is locked; unlock it before approving the regularisation.');
  const device = await ensureSelfServiceDevice(t, ctx.orgId);
  const reason = `Regularisation (${TYPE_LABEL[reg.type]}): ${reg.reason}`.slice(0, 1000);
  const common = { organizationId: ctx.orgId, employeeId: reg.employeeId, branchId, attendanceDate: date, reason, requestedBy: reg.createdBy, status: 'APPROVED' as const, approvalRequestId: ctx.requestId || null, deviceId: device.id };
  const events = await eventsOfDay(t, ctx.orgId, reg.employeeId, date, emp.timezone);
  const ids: string[] = [];
  const skipped: Array<{ type: string; proposedPunchedAt: string | null; why: string }> = [];
  const add = async (spec: CorrectionSpec) => {
    const why = await alreadyDone(t, ctx.orgId, reg.employeeId, date, events, spec);
    if (why) { skipped.push({ type: spec.type, proposedPunchedAt: spec.proposedPunchedAt?.toISOString() ?? null, why }); return; }
    const row = await t.insertInto('attendanceCorrections').values({ ...common, type: spec.type, originalEventId: spec.originalEventId ?? null, originalPunchedAt: spec.originalPunchedAt ?? null, proposedPunchedAt: spec.proposedPunchedAt ?? null, proposedEventType: spec.proposedEventType ?? null, proposedStatus: spec.proposedStatus ?? null })
      .returning('id').executeTakeFirstOrThrow();
    ids.push(row.id);
  };
  if (reg.type === 'wrong_punch') {
    // only a punch of the SAME direction is edited (review P1-6): the check-in's time never moves the check-out, or vice versa
    const inTarget = reg.proposedInAt ? events.find((e) => e.eventType === 'PUNCH_IN') : undefined;
    const outTarget = reg.proposedOutAt ? [...events].reverse().find((e) => e.eventType === 'PUNCH_OUT') : undefined;
    if (reg.proposedInAt) {
      if (inTarget) await add({ type: 'EDIT_PUNCH', originalEventId: inTarget.id, originalPunchedAt: inTarget.punchedAt, proposedPunchedAt: reg.proposedInAt, proposedEventType: 'PUNCH_IN' });
      else await add({ type: 'ADD_PUNCH', proposedPunchedAt: reg.proposedInAt, proposedEventType: 'PUNCH_IN' });
    }
    if (reg.proposedOutAt) {
      if (outTarget) await add({ type: 'EDIT_PUNCH', originalEventId: outTarget.id, originalPunchedAt: outTarget.punchedAt, proposedPunchedAt: reg.proposedOutAt, proposedEventType: 'PUNCH_OUT' });
      else await add({ type: 'ADD_PUNCH', proposedPunchedAt: reg.proposedOutAt, proposedEventType: 'PUNCH_OUT' });
    }
  } else {
    if (reg.proposedInAt) await add({ type: 'ADD_PUNCH', proposedPunchedAt: reg.proposedInAt, proposedEventType: 'PUNCH_IN' });
    if (reg.proposedOutAt) await add({ type: 'ADD_PUNCH', proposedPunchedAt: reg.proposedOutAt, proposedEventType: 'PUNCH_OUT' });
    if (reg.type === 'wfh_unmarked' || reg.type === 'system_downtime') await add({ type: 'SET_STATUS', proposedStatus: 'PRESENT' });
  }
  for (const correctionId of ids) {
    await enqueueJob(deps.queue, t, { queue: 'processing', jobType: 'APPLY_CORRECTION', organizationId: ctx.orgId, payload: { organizationId: ctx.orgId, correctionId, appliedBy: ctx.actor.userId }, correlationId: ctx.actor.requestId, priority: 7 });
  }
  const now = new Date();
  await t.updateTable('attendanceRegularisationRequests').set({ status: 'approved', decidedBy: ctx.actor.userId, decidedAt: now, decisionNote: ctx.comment, appliedCorrectionId: ids[0] ?? null, appliedAt: now })
    .where('id', '=', reg.id).where('status', '=', 'pending').execute();
  // applied on behalf of the approval: the approver is the actor of record (review P2-9)
  await writeAudit(t, { organizationId: ctx.orgId, actorUserId: ctx.actor.userId, action: 'attendance.regularisation_applied', entityType: 'attendance_regularisation', entityId: reg.id, branchId, newValue: { onBehalfOfApproval: ctx.requestId || null, approvedBy: ctx.actor.userId, correctionIds: ids, skipped, type: reg.type, attendanceDate: date }, requestId: ctx.actor.requestId });
  await emitToUsers(t, ctx.actor, ctx.orgId, 'attendance.regularisation_decided', { type: 'attendance_regularisation', id: reg.id }, await userIdsOfEmployees(t, ctx.orgId, [reg.employeeId]),
    { regularisationId: reg.id, employeeId: reg.employeeId, attendanceDate: date, type: reg.type, decision: 'approved', comment: ctx.comment, correctionIds: ids });
  return ids;
}

export async function applyRegularisationRejection(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>): Promise<void> {
  const reg = await loadRegularisation(t, ctx.orgId, ctx.entityId);
  if (!reg || reg.status !== 'pending') return;
  await t.updateTable('attendanceRegularisationRequests').set({ status: 'rejected', decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment }).where('id', '=', reg.id).where('status', '=', 'pending').execute();
  await emitToUsers(t, ctx.actor, ctx.orgId, 'attendance.regularisation_decided', { type: 'attendance_regularisation', id: reg.id }, await userIdsOfEmployees(t, ctx.orgId, [reg.employeeId]),
    { regularisationId: reg.id, employeeId: reg.employeeId, attendanceDate: isoDate(reg.attendanceDate), type: reg.type, decision: 'rejected', comment: ctx.comment });
}

export async function applyRegularisationCancelled(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment'>): Promise<void> {
  await t.updateTable('attendanceRegularisationRequests').set({ status: 'cancelled', decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'pending').execute();
}

export async function regularisationContexts(t: Trx, orgId: string, ids: string[]): Promise<Map<string, ApprovalContextDto>> {
  const out = new Map<string, ApprovalContextDto>();
  if (ids.length === 0) return out;
  const rows = (await t.selectFrom('attendanceRegularisationRequests').select(REGULARISATION_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as RegularisationRow[];
  const tz = new Map<string, string | null>();
  for (const r of rows) {
    if (!tz.has(r.employeeId)) tz.set(r.employeeId, (await loadEmployeeCtx(t, orgId, r.employeeId).catch(() => null))?.timezone ?? null);
    const date = isoDate(r.attendanceDate);
    out.set(r.id, { kind: 'REGULARISATION', summary: `${TYPE_LABEL[r.type]} · ${date}`, regularisation: { id: r.id, attendanceDate: date, type: r.type, proposedInAt: isoDateTimeOrNull(r.proposedInAt), proposedOutAt: isoDateTimeOrNull(r.proposedOutAt), reason: r.reason, status: r.status, timezone: tz.get(r.employeeId) ?? null } });
  }
  return out;
}

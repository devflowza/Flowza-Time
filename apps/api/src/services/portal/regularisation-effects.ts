import { sql } from 'kysely';
import type { ApprovalContextDto, AttendanceEventType, RegularisationStatus, RegularisationType } from '@flowza/contracts';
import { ensureSelfServiceDevice, type Trx } from '@flowza/database';
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
 *   wrong_punch      EDIT_PUNCH of the day's first check-in / last check-out to the proposed time (ADD_PUNCH when the day
 *                    has no such punch);
 *   wfh_unmarked,    ADD_PUNCH for whatever times were given, plus SET_STATUS PRESENT (the employee worked, the terminal
 *   system_downtime  simply never saw it).
 *
 * The corrections are created APPROVED (the regularisation's own request was the approval), stamped with the organisation's
 * self-service device (their CORRECTION events carry it) and the reason "Regularisation (…): …", and APPLY_CORRECTION jobs
 * are queued in the same transaction; the worker voids / adds events and recomputes. System scope; never imports the engine.
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

export async function applyRegularisationApproval(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'requestId' | 'actor' | 'comment'>): Promise<string[]> {
  const reg = await loadRegularisation(t, ctx.orgId, ctx.entityId);
  if (!reg || reg.status !== 'pending') return [];
  const emp = await loadEmployeeCtx(t, ctx.orgId, reg.employeeId);
  const date = isoDate(reg.attendanceDate);
  if (await isPeriodLocked(t, ctx.orgId, emp.branchId, date)) throw errors.periodLocked('The attendance period of this day is locked; unlock it before approving the regularisation.');
  const device = await ensureSelfServiceDevice(t, ctx.orgId);
  const reason = `Regularisation (${TYPE_LABEL[reg.type]}): ${reg.reason}`.slice(0, 1000);
  const common = { organizationId: ctx.orgId, employeeId: reg.employeeId, branchId: emp.branchId, attendanceDate: date, reason, requestedBy: reg.createdBy, status: 'APPROVED' as const, approvalRequestId: ctx.requestId || null, deviceId: device.id };
  const ids: string[] = [];
  const add = async (values: { type: 'ADD_PUNCH' | 'EDIT_PUNCH' | 'SET_STATUS'; originalEventId?: string; originalPunchedAt?: Date; proposedPunchedAt?: Date; proposedEventType?: AttendanceEventType; proposedStatus?: 'PRESENT' }) => {
    const row = await t.insertInto('attendanceCorrections').values({ ...common, type: values.type, originalEventId: values.originalEventId ?? null, originalPunchedAt: values.originalPunchedAt ?? null, proposedPunchedAt: values.proposedPunchedAt ?? null, proposedEventType: values.proposedEventType ?? null, proposedStatus: values.proposedStatus ?? null })
      .returning('id').executeTakeFirstOrThrow();
    ids.push(row.id);
  };
  if (reg.type === 'wrong_punch') {
    const events = await eventsOfDay(t, ctx.orgId, reg.employeeId, date, emp.timezone);
    const inTarget = reg.proposedInAt ? (events.find((e) => e.eventType === 'PUNCH_IN') ?? events[0]) : undefined;
    const outTarget = reg.proposedOutAt ? ([...events].reverse().find((e) => e.eventType === 'PUNCH_OUT' && e.id !== inTarget?.id) ?? [...events].reverse().find((e) => e.id !== inTarget?.id)) : undefined;
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

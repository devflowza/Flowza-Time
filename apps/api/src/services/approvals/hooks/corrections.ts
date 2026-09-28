import type { ApprovalContextDto } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { ApiDeps } from '../../../deps.js';
import { enqueueJob } from '../../../lib/jobs.js';
import { isoDate, isoDateTimeOrNull } from '../../../lib/mappers.js';
import type { EntityHook, HookContext } from './index.js';

/**
 * Attendance corrections: approval marks the correction APPROVED and queues APPLY_CORRECTION (the worker voids/adds
 * events and recomputes the day — raw immutability); rejection records the reason; a cancelled request withdraws a
 * still-pending correction. Notifications reach the requester through payload.userId (unchanged from v1).
 */
export const correctionHook: EntityHook = {
  entityType: 'ATTENDANCE_CORRECTION',
  approvePermission: 'attendance.approve',
  viewPermission: 'attendance.view',
  async onApproved(deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const c = await trx.updateTable('attendanceCorrections').set({ status: 'APPROVED' }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING')
      .returning(['employeeId', 'attendanceDate', 'requestedBy']).executeTakeFirst();
    if (!c) return; // already applied / cancelled meanwhile: nothing to queue
    await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: 'APPLY_CORRECTION', organizationId: ctx.orgId, payload: { organizationId: ctx.orgId, correctionId: ctx.entityId }, correlationId: ctx.actor.requestId, priority: 7 });
    await emitDomainEvent(trx, { organizationId: ctx.orgId, eventType: 'attendance.correction_approved', aggregateType: 'attendance_correction', aggregateId: ctx.entityId, payload: { approvedBy: ctx.actor.userId, comment: ctx.comment, employeeId: c.employeeId, attendanceDate: isoDate(c.attendanceDate), ...(c.requestedBy && c.requestedBy !== ctx.actor.userId ? { userId: c.requestedBy } : {}) }, actorUserId: ctx.actor.userId, requestId: ctx.actor.requestId });
  },
  async onRejected(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    const c = await trx.updateTable('attendanceCorrections').set({ status: 'REJECTED', rejectionReason: ctx.comment }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING')
      .returning(['employeeId', 'attendanceDate', 'requestedBy']).executeTakeFirst();
    if (!c) return;
    await emitDomainEvent(trx, { organizationId: ctx.orgId, eventType: 'attendance.correction_rejected', aggregateType: 'attendance_correction', aggregateId: ctx.entityId, payload: { rejectedBy: ctx.actor.userId, reason: ctx.comment, employeeId: c.employeeId, attendanceDate: isoDate(c.attendanceDate), ...(c.requestedBy ? { userId: c.requestedBy } : {}) }, actorUserId: ctx.actor.userId, requestId: ctx.actor.requestId });
  },
  async onCancelled(_deps: ApiDeps, trx: Trx, ctx: HookContext) {
    await trx.updateTable('attendanceCorrections').set({ status: 'CANCELLED', rejectionReason: ctx.comment }).where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'PENDING').execute();
  },
  async loadContexts(trx: Trx, orgId: string, entityIds: string[]) {
    const out = new Map<string, ApprovalContextDto>();
    if (!entityIds.length) return out;
    const rows = await trx.selectFrom('attendanceCorrections').select(['id', 'attendanceDate', 'type', 'originalPunchedAt', 'proposedPunchedAt', 'proposedEventType', 'proposedStatus', 'reason', 'status', 'requestedBy', 'rejectionReason']).where('organizationId', '=', orgId).where('id', 'in', entityIds).execute();
    for (const r of rows) out.set(r.id, { kind: 'ATTENDANCE_CORRECTION', correction: { id: r.id, attendanceDate: isoDate(r.attendanceDate), type: r.type, originalPunchedAt: isoDateTimeOrNull(r.originalPunchedAt), proposedPunchedAt: isoDateTimeOrNull(r.proposedPunchedAt), proposedEventType: r.proposedEventType, proposedStatus: r.proposedStatus, reason: r.reason, status: r.status, requestedBy: r.requestedBy, rejectionReason: r.rejectionReason } });
    return out;
  },
  summary(context) {
    return context.kind === 'ATTENDANCE_CORRECTION' ? `${context.correction.type.replace('_', ' ').toLowerCase()} · ${context.correction.attendanceDate}` : null;
  },
};

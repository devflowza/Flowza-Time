import type { LeaveCommentDto, LeaveCommentKind } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateTime } from '../../lib/mappers.js';

/**
 * The comment thread of a leave request (leave v2, Finance parity): append-only, readable by whoever may read the leave or
 * its approval request (the employee, their managers, the request's approvers and delegates, HR) — the table's RLS is that
 * rule, so this service only adds the 404. Approver questions (`info_request`), the employee's answers (`reply`) and system
 * notes are written by the engine's leave hook; people add plain `comment`s here. A new comment tells the other participants
 * (`leave.comment_added`, targeted).
 */

async function assertThreadVisible(trx: Trx, orgId: string, leaveId: string): Promise<void> {
  const leave = await trx.selectFrom('leaveRecords').select('id').where('organizationId', '=', orgId).where('id', '=', leaveId).executeTakeFirst();
  if (leave) return;
  const viaRequest = await trx.selectFrom('approvalRequests').select('id').where('organizationId', '=', orgId).where('entityType', '=', 'LEAVE').where('entityId', '=', leaveId).executeTakeFirst();
  if (!viaRequest) throw errors.notFound('Leave record', leaveId);
}

async function toCommentDtos(trx: Trx, orgId: string, actor: Actor, rows: Array<{ id: string; leaveRecordId: string; authorUserId: string | null; kind: string; body: string; createdAt: Date }>): Promise<LeaveCommentDto[]> {
  const userIds = [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))];
  const users = userIds.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', userIds).execute()) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.fullName || u.email || null]));
  return rows.map((r) => ({ id: r.id, leaveRecordId: r.leaveRecordId, authorUserId: r.authorUserId, authorName: r.authorUserId ? nameOf.get(r.authorUserId) ?? null : null, kind: r.kind as LeaveCommentKind, body: r.body, createdAt: isoDateTime(r.createdAt), mine: !!r.authorUserId && r.authorUserId === actor.userId }));
}

/** GET /leave-records/:id/comments — the thread, oldest first. */
export async function listLeaveComments(deps: ApiDeps, actor: Actor, orgId: string, leaveId: string): Promise<LeaveCommentDto[]> {
  requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    await assertThreadVisible(trx, orgId, leaveId);
    const rows = await trx.selectFrom('leaveRequestComments').select(['id', 'leaveRecordId', 'authorUserId', 'kind', 'body', 'createdAt']).where('organizationId', '=', orgId).where('leaveRecordId', '=', leaveId).orderBy('createdAt').orderBy('id').limit(500).execute();
    return toCommentDtos(trx, orgId, actor, rows);
  });
}

/**
 * Who hears about a new comment: the employee (their own login — the portal link), and the requester, the approvers still
 * to act on the current level and everyone who already wrote in the thread (the approval request link). System scope (ids
 * only; the outbox keeps active members). The author is removed by the caller.
 */
async function threadParticipants(t: Trx, orgId: string, leaveId: string): Promise<{ employee: string[]; others: string[]; requestId: string | null }> {
  const leave = await t.selectFrom('leaveRecords').select(['employeeId', 'createdBy']).where('organizationId', '=', orgId).where('id', '=', leaveId).executeTakeFirst();
  if (!leave) return { employee: [], others: [], requestId: null };
  const [subject, request, writers] = await Promise.all([
    t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', leave.employeeId).where('status', '=', 'active').execute(),
    t.selectFrom('approvalRequests').select(['id', 'requestedBy', 'currentStep', 'status']).where('organizationId', '=', orgId).where('entityType', '=', 'LEAVE').where('entityId', '=', leaveId).orderBy('createdAt', 'desc').executeTakeFirst(),
    t.selectFrom('leaveRequestComments').select('authorUserId').where('organizationId', '=', orgId).where('leaveRecordId', '=', leaveId).execute(),
  ]);
  const approvers = request && request.status === 'PENDING'
    ? await t.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select('a.userId').where('s.requestId', '=', request.id).where('s.stepNo', '=', request.currentStep).where('a.decision', '=', 'PENDING').execute()
    : [];
  const employee = [...new Set(subject.map((m) => m.userId))].sort();
  const others = [...new Set([request?.requestedBy ?? leave.createdBy, ...approvers.map((a) => a.userId), ...writers.map((w) => w.authorUserId)].filter((u): u is string => !!u && !employee.includes(u)))].sort();
  return { employee, others, requestId: request?.id ?? null };
}

/** POST /leave-records/:id/comments { body } — a plain comment by anybody who can read the leave (RLS decides). */
export async function addLeaveComment(deps: ApiDeps, actor: Actor, orgId: string, leaveId: string, body: string): Promise<LeaveCommentDto> {
  requireMembership(actor.principal, orgId);
  const text = body.trim();
  if (!text) throw errors.validation('The comment is empty.', { issues: [{ path: 'body', message: 'Required' }] });
  return runUser(deps.db, actor, async (trx) => {
    await assertThreadVisible(trx, orgId, leaveId);
    const row = await trx.insertInto('leaveRequestComments').values({ organizationId: orgId, leaveRecordId: leaveId, authorUserId: actor.userId, body: text.slice(0, 2000), kind: 'comment' })
      .returning(['id', 'leaveRecordId', 'authorUserId', 'kind', 'body', 'createdAt']).executeTakeFirstOrThrow();
    const who = await withSystemScope(trx, orgId, (t) => threadParticipants(t, orgId, leaveId));
    const leave = await withSystemScope(trx, orgId, (t) => t.selectFrom('leaveRecords as l').innerJoin('employees as e', 'e.id', 'l.employeeId').innerJoin('leaveTypes as lt', 'lt.id', 'l.leaveTypeId').select(['l.employeeId', 'l.branchId', 'e.displayName', 'lt.name']).where('l.id', '=', leaveId).executeTakeFirst());
    const payload = { leaveRecordId: leaveId, approvalRequestId: who.requestId, commentId: row.id, employeeId: leave?.employeeId ?? null, employeeName: leave?.displayName ?? null, leaveTypeName: leave?.name ?? null, excerpt: text.slice(0, 140) };
    // one notice per audience: the employee opens their portal, everybody else the approval request
    for (const [audience, ids] of [['employee', who.employee], ['approvers', who.others]] as const) {
      const userIds = ids.filter((u) => u !== actor.userId);
      if (userIds.length) await emitDomainEvent(trx, { organizationId: orgId, eventType: 'leave.comment_added', aggregateType: 'leave_record', aggregateId: leaveId, payload: { ...payload, audience, userIds }, actorUserId: actor.userId, requestId: actor.requestId });
    }
    await audit(trx, actor, orgId, 'leave.comment_added', 'leave_record', { entityId: leaveId, branchId: leave?.branchId ?? null, newValue: { commentId: row.id, length: text.length } });
    const [dto] = await toCommentDtos(trx, orgId, actor, [row]);
    return dto!;
  });
}

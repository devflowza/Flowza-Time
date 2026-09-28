import { sql } from 'kysely';
import { notificationReaders, type ApprovalEntity } from '@flowza/contracts';
import { applyContext, type Trx } from '@flowza/database';
import { approvalEntityFacts, leaveTypeNamesOf } from '../approvals/facts.js';
import { asObject } from '../attendance/common.js';

const R = notificationReaders;
type Payload = Record<string, unknown>;

/** The outbox row as the relay reads it (the fields this module needs). */
export interface SourceEventRow { id: string; organizationId: string; eventType: string; aggregateType: string; aggregateId: string | null; payload: Payload }

/**
 * Approval notices are derived from the REQUEST, never from the event's payload (HR portal Prompt 8 review, 8-P0-1). An
 * `approval.*` event is honoured only when the request exists in the event's organisation AND the request's own timeline holds,
 * written by the SAME transaction as the event (same `now()`: `approval_request_events.at` = `domain_events.occurred_at`), the
 * entry that justifies it. The notice then says what the request says: its entity, the person, the day / the leave's dates and
 * type (both languages), the level, and — from that timeline entry — the decision, the comment / reason, the question or the
 * answer. Recipients stay the ones the engine named, kept to the parties of the request (its requester, the people it is
 * about, and everyone ever seated on one of its levels). An event that cannot be tied to its request notifies nobody.
 */
export const REQUEST_NOTICE_KINDS: Readonly<Record<string, readonly string[]>> = {
  // in priority order: the first kind found in the event's transaction explains it
  'approval.pending': ['reassigned', 'advanced', 'secondary_seated', 'submitted'],
  'approval.reminder': ['reminded'],
  'approval.escalated': ['escalated'],
  'approval.decided': ['approved', 'rejected', 'system_rejected', 'cancelled', 'invalidated', 'bypassed'],
  'approval.info_requested': ['info_requested'],
  'approval.info_answered': ['info_answered'],
  'approval.reassigned': ['reassigned'],
  'approval.bypassed': ['bypassed'],
};

/** The daily digest is the one approval notice about no single request (the worker's per-approver counts). */
export const isDigestEvent = (row: Pick<SourceEventRow, 'eventType' | 'aggregateType'>) => row.eventType === 'approval.reminder' && row.aggregateType === 'approval_digest';
/** Every other approval notice must be derived from its request. */
export const isRequestNotice = (row: Pick<SourceEventRow, 'eventType' | 'aggregateType'>) => Object.hasOwn(REQUEST_NOTICE_KINDS, row.eventType) && !isDigestEvent(row);

/**
 * The digest carries counts only: whatever else a row says (a request id, an entity, a person) is dropped, and it is always the
 * digest variant — the one that mints no one-click links.
 */
export function digestPayload(payload: Payload): Payload {
  return { kind: 'digest', digestDate: payload['digestDate'], total: payload['total'], counts: payload['counts'], userIds: payload['userIds'] };
}

export interface RequestNotice { payload: Payload; parties: ReadonlySet<string> }

const DECISION_OF_KIND: Readonly<Record<string, 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'INVALIDATED'>> = {
  approved: 'APPROVED', rejected: 'REJECTED', system_rejected: 'REJECTED', cancelled: 'CANCELLED', invalidated: 'INVALIDATED', bypassed: 'APPROVED',
};
const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Run `fn` in the organisation's system context and return to the relay's platform context. Under a savepoint: a failure
 * inside is rolled back (which also restores the platform context) and surfaces as ITSELF, not as the "transaction is aborted"
 * of a context switch attempted after it.
 */
async function inOrgContext<T>(trx: Trx, organizationId: string, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint relay_org_context`.execute(trx);
  try {
    await applyContext(trx, { kind: 'system', organizationId });
    const out = await fn();
    await applyContext(trx, { kind: 'platform' });
    await sql`release savepoint relay_org_context`.execute(trx);
    return out;
  } catch (err) {
    await sql`rollback to savepoint relay_org_context`.execute(trx);
    throw err;
  }
}

/** The approval notice of one outbox row, derived from its request (null: the event cannot be tied to its request). */
export async function requestNotice(trx: Trx, row: SourceEventRow): Promise<RequestNotice | null> {
  const requestId = row.aggregateType === 'approval_request' ? R.id(row.aggregateId) : null;
  const kinds = REQUEST_NOTICE_KINDS[row.eventType];
  if (!requestId || !kinds) return null;
  return inOrgContext(trx, row.organizationId, async () => {
    const req = await trx.selectFrom('approvalRequests').select(['id', 'entityType', 'entityId', 'employeeId', 'requestedBy', 'subjectUserId', 'coSubjectUserIds', 'currentStep'])
      .where('organizationId', '=', row.organizationId).where('id', '=', requestId).executeTakeFirst();
    if (!req) return null;
    // the timeline entries written by the event's own transaction (same now()), of the kinds that justify this notice
    const { rows: entries } = await sql<{ kind: string; detail: unknown }>`
      select e.kind, e.detail from public.approval_request_events e
      where e.organization_id = ${row.organizationId}::uuid and e.request_id = ${requestId}::uuid and e.kind = any(${[...kinds]}::text[])
        and e.at = (select d.occurred_at from public.domain_events d where d.id = ${row.id}::bigint)
      order by e.id`.execute(trx);
    const entry = kinds.map((k) => entries.find((e) => e.kind === k)).find((e) => e !== undefined);
    if (!entry) return null;
    const detail = asObject(entry.detail);
    const steps = await trx.selectFrom('approvalSteps').select(['id', 'stepNo', 'activatedAt', 'dueAt']).where('requestId', '=', requestId).execute();
    const actors = steps.length ? await trx.selectFrom('approvalStepActors').select('userId').where('stepId', 'in', steps.map((s) => s.id)).execute() : [];
    const parties = new Set<string>([...actors.map((a) => a.userId), ...(req.coSubjectUserIds ?? []), ...(req.requestedBy ? [req.requestedBy] : []), ...(req.subjectUserId ? [req.subjectUserId] : [])].map((u) => u.toLowerCase()));
    const employee = req.employeeId ? await trx.selectFrom('employees').select('displayName').where('organizationId', '=', row.organizationId).where('id', '=', req.employeeId).executeTakeFirst() : undefined;
    const facts = await approvalEntityFacts(trx, row.organizationId, req.entityType as ApprovalEntity, req.entityId);
    const stepNo = numOf(detail['stepNo']) ?? (entry.kind === 'submitted' ? 1 : req.currentStep);
    const step = steps.find((s) => s.stepNo === stepNo);
    const payload: Payload = {
      requestId, entityType: req.entityType, entityId: req.entityId, employeeId: req.employeeId, employeeName: employee?.displayName ?? null, stepNo,
      date: facts.date, endDate: facts.endDate, leaveTypeName: facts.leaveTypeName, leaveTypeNameAr: facts.leaveTypeNameAr ?? null,
      // who hears it is the engine's choice (kept to the request's parties by the relay)
      userIds: row.payload['userIds'],
    };
    switch (row.eventType) {
      case 'approval.pending':
        if (entry.kind === 'reassigned') payload['reassigned'] = true;
        break;
      case 'approval.reminder':
        payload['kind'] = 'reminder';
        payload['waitingSince'] = R.instant(detail['waitingSince']) ?? R.instant(step?.activatedAt ?? null);
        break;
      case 'approval.escalated':
        payload['dueAt'] = R.instant(detail['dueAt']) ?? R.instant(step?.dueAt ?? null);
        break;
      case 'approval.decided':
        payload['decision'] = DECISION_OF_KIND[entry.kind];
        payload['comment'] = entry.kind === 'approved' || entry.kind === 'rejected' ? textOf(detail['comment']) : textOf(detail['reason']);
        if (entry.kind === 'bypassed') payload['exception'] = true;
        break;
      case 'approval.info_requested':
      case 'approval.info_answered':
        payload['comment'] = textOf(detail['comment']);
        break;
      case 'approval.reassigned':
      case 'approval.bypassed':
        payload['reason'] = textOf(detail['reason']);
        break;
    }
    return { payload, parties };
  });
}

/** Leave-family notices whose leave type the relay names in both languages (review 8-P2-2). */
const LEAVE_RECORD_TYPES = new Set(['leave.requested', 'leave.approved', 'leave.rejected', 'leave.info_requested', 'leave.comment_added']);

/**
 * Both names of the leave type a notice mentions, read from the leave record (or, for a reason rejected against a leave
 * balance, from the type's code) in the organisation's system context — the recipient's language picks one when the notice is
 * rendered (review 8-P2-2). The payload is returned unchanged when the notice names no leave type or the leave is not found.
 */
export async function withLeaveTypeNames(trx: Trx, row: SourceEventRow, payload: Payload): Promise<Payload> {
  const leaveRecordId = LEAVE_RECORD_TYPES.has(row.eventType) ? R.id(payload['leaveRecordId']) ?? (row.aggregateType === 'leave_record' ? R.id(row.aggregateId) : null) : null;
  const code = row.eventType === 'attendance.note_decided' ? R.code(payload['leaveTypeCode']) : null;
  if (!leaveRecordId && !code) return payload;
  const names = await inOrgContext(trx, row.organizationId, () => leaveTypeNamesOf(trx, row.organizationId, { leaveRecordId, code }));
  if (!names) return payload;
  return { ...payload, leaveTypeName: names.leaveTypeName ?? payload['leaveTypeName'] ?? null, leaveTypeNameAr: names.leaveTypeNameAr };
}

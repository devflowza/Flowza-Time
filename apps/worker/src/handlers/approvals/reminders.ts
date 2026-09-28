import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { ApprovalEntity, ApprovalEscalationTarget } from '@flowza/contracts';
import { emitDomainEvent, withContext, type Trx } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { HandlerRegistry, JobContext } from '../types.js';

/** A current level still waiting this long after it became current gets one reminder to its pending approvers (B-102). */
export const APPROVAL_REMINDER_AFTER_HOURS = 24;
/** The daily digest goes out on the first run at or after this local hour (organisation timezone). */
export const APPROVAL_DIGEST_LOCAL_HOUR = 8;

interface CurrentStep {
  stepId: string; requestId: string; stepNo: number; entityType: ApprovalEntity; entityId: string; employeeId: string | null; branchId: string | null;
  requestedBy: string | null; subjectUserId: string | null; workflowId: string | null; activatedAt: Date | null; dueAt: Date | null; escalatedAt: Date | null; remindedAt: Date | null; escalateTo: string | null;
  /** Other people the request is about (HR portal Prompt 4 review, P0-2 — a swap's colleague) and their logins at submit. */
  coSubjectEmployeeIds: string[] | null; coSubjectUserIds: string[] | null;
}

export interface ApprovalRemindersResult { escalated: number; reminded: number; digests: number }

async function currentSteps(trx: Trx, orgId: string): Promise<CurrentStep[]> {
  return trx.selectFrom('approvalSteps as s').innerJoin('approvalRequests as r', 'r.id', 's.requestId')
    .select(['s.id as stepId', 's.requestId', 's.stepNo', 'r.entityType', 'r.entityId', 'r.employeeId', 'r.branchId', 'r.requestedBy', 'r.subjectUserId', 'r.workflowId', 's.activatedAt', 's.dueAt', 's.escalatedAt', 's.remindedAt', 's.escalateTo', 'r.coSubjectEmployeeIds', 'r.coSubjectUserIds'])
    .where('r.organizationId', '=', orgId).where('r.status', '=', 'PENDING').where('s.status', '=', 'PENDING').whereRef('s.stepNo', '=', 'r.currentStep')
    .orderBy('r.createdAt').orderBy('r.id').execute() as Promise<CurrentStep[]>;
}

async function pendingActorIds(trx: Trx, stepId: string): Promise<string[]> {
  return (await trx.selectFrom('approvalStepActors').select('userId').where('stepId', '=', stepId).where('decision', '=', 'PENDING').execute()).map((a) => a.userId);
}

async function requestPayload(trx: Trx, orgId: string, s: CurrentStep): Promise<Record<string, unknown>> {
  const emp = s.employeeId ? await trx.selectFrom('employees').select(['displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', s.employeeId).executeTakeFirst() : undefined;
  return { requestId: s.requestId, entityType: s.entityType, entityId: s.entityId, employeeId: s.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, requestedBy: s.requestedBy, stepId: s.stepId, stepNo: s.stepNo };
}

async function recordEvent(trx: Trx, orgId: string, requestId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await trx.insertInto('approvalRequestEvents').values({ organizationId: orgId, requestId, kind, actorUserId: null, detail: JSON.stringify(detail) }).execute();
}

async function emitTargeted(trx: Trx, orgId: string, eventType: 'approval.reminder' | 'approval.escalated', aggregateId: string, userIds: readonly string[], payload: Record<string, unknown>): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await emitDomainEvent(trx, { organizationId: orgId, eventType, aggregateType: 'approval_request', aggregateId, payload: { ...payload, userIds: ids }, actorUserId: null, requestId: null });
}

/** Active members who can act for the request's branch, by role key (hr_admin / owner). */
async function membersByRole(trx: Trx, orgId: string, roleKey: 'hr_admin' | 'owner', branchId: string | null): Promise<string[]> {
  const rows = await trx.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId')
    .select(['m.id', 'm.userId', 'm.allBranches']).where('m.organizationId', '=', orgId).where('m.status', '=', 'active').where('r.key', '=', roleKey).execute();
  if (!branchId || roleKey === 'owner') return rows.map((r) => r.userId);
  const restricted = rows.filter((r) => !r.allBranches).map((r) => r.id);
  const scoped = restricted.length ? await trx.selectFrom('membershipBranches').select(['membershipId', 'branchId']).where('membershipId', 'in', restricted).execute() : [];
  return rows.filter((r) => r.allBranches || scoped.some((b) => b.membershipId === r.id && b.branchId === branchId)).map((r) => r.userId);
}

/**
 * Escalate an overdue level (B-103): its `escalateTo` target — the next level's approvers, the HR admins or the owners —
 * joins the level as ESCALATED actors (the original approvers keep their seats). An escalated actor is an extra pair of
 * hands, not an extra seat: their decision fills ONE pending seat of the level (Finance B-91 "one row per call", review
 * P2-13) — an ANY level settles, an ALL / QUORUM level counts one approval — so escalation never makes a level harder to
 * close and never lets one person close a level that needs several. The person the request is about (the submit-time
 * snapshot or the CURRENT membership link, review P0-4), its other parties (co-subjects — HR portal Prompt 4 review, P0-2)
 * and the requester are never added: self-approval is not configurable (review P0-3).
 */
async function escalate(trx: Trx, orgId: string, s: CurrentStep, now: Date): Promise<string[]> {
  const current = new Set((await trx.selectFrom('approvalStepActors').select('userId').where('stepId', '=', s.stepId).execute()).map((a) => a.userId));
  const linkedToSubject = new Set(s.employeeId ? (await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', s.employeeId).execute()).map((m) => m.userId) : []);
  // the request's other parties (a swap's colleague — review P0-2): the logins snapshotted at submit and every CURRENT link
  const coSubjects = s.coSubjectEmployeeIds ?? [];
  const linkedToCoSubjects = new Set([...(s.coSubjectUserIds ?? []), ...(coSubjects.length ? (await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', 'in', coSubjects).execute()).map((m) => m.userId) : [])]);
  const eligible = (ids: string[]) => ids.filter((u) => !current.has(u) && u !== s.subjectUserId && u !== s.requestedBy && !linkedToSubject.has(u) && !linkedToCoSubjects.has(u));
  const ladder: ApprovalEscalationTarget[] = s.escalateTo === 'NEXT_STEP' ? ['NEXT_STEP', 'HR_ADMIN', 'OWNER'] : s.escalateTo === 'HR_ADMIN' ? ['HR_ADMIN', 'OWNER'] : ['OWNER'];
  let target: ApprovalEscalationTarget | null = null;
  let added: string[] = [];
  for (const t of ladder) {
    let candidates: string[] = [];
    if (t === 'NEXT_STEP') {
      const next = await trx.selectFrom('approvalSteps').select('id').where('requestId', '=', s.requestId).where('stepNo', '=', s.stepNo + 1).executeTakeFirst();
      candidates = next ? (await trx.selectFrom('approvalStepActors').select('userId').where('stepId', '=', next.id).execute()).map((a) => a.userId) : [];
    } else candidates = await membersByRole(trx, orgId, t === 'HR_ADMIN' ? 'hr_admin' : 'owner', s.branchId);
    // sorted: the escalation's timeline entry and notices never depend on the order rows were read in
    added = [...new Set(eligible(candidates))].sort();
    if (added.length) { target = t; break; }
  }
  if (added.length) await trx.insertInto('approvalStepActors').values(added.map((userId) => ({ organizationId: orgId, stepId: s.stepId, userId, viaDelegationOf: null, resolutionPath: 'escalated' }))).onConflict((oc) => oc.columns(['stepId', 'userId']).doNothing()).execute();
  await trx.updateTable('approvalSteps').set({ escalatedAt: now }).where('id', '=', s.stepId).execute();
  await recordEvent(trx, orgId, s.requestId, 'escalated', { stepNo: s.stepNo, target: target ?? s.escalateTo, added, ...(added.length ? {} : { reason: 'nobody else to escalate to' }) });
  if (added.length) await emitTargeted(trx, orgId, 'approval.escalated', s.requestId, added, { ...(await requestPayload(trx, orgId, s)), target, dueAt: s.dueAt?.toISOString() ?? null });
  return added;
}

/**
 * The hourly approvals sweep for one organisation (system context, injected clock): escalate overdue levels, remind the
 * approvers of levels waiting longer than a day (once per level), and once a day — the first run at or after 08:00 in the
 * organisation's timezone — send every approver ONE digest notification with their pending counts (idempotent through
 * `approval_digest_runs`).
 */
export async function runApprovalReminders(deps: WorkerDeps, orgId: string, opts: { jobId?: string } = {}): Promise<ApprovalRemindersResult> {
  const now = deps.now();
  return withContext(deps.db, { kind: 'system', organizationId: orgId, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, async (trx) => {
    const steps = await currentSteps(trx, orgId);
    let escalated = 0; let reminded = 0; let digests = 0;
    for (const s of steps) {
      if (s.dueAt && s.dueAt.getTime() <= now.getTime() && !s.escalatedAt && s.escalateTo) { await escalate(trx, orgId, s, now); escalated += 1; }
    }
    const remindBefore = now.getTime() - APPROVAL_REMINDER_AFTER_HOURS * 3_600_000;
    for (const s of steps) {
      if (s.remindedAt || !s.activatedAt || s.activatedAt.getTime() > remindBefore) continue;
      const userIds = await pendingActorIds(trx, s.stepId);
      await trx.updateTable('approvalSteps').set({ remindedAt: now }).where('id', '=', s.stepId).execute();
      await recordEvent(trx, orgId, s.requestId, 'reminded', { stepNo: s.stepNo, recipients: userIds.length });
      await emitTargeted(trx, orgId, 'approval.reminder', s.requestId, userIds, { ...(await requestPayload(trx, orgId, s)), kind: 'reminder', waitingSince: s.activatedAt.toISOString() });
      reminded += 1;
    }
    // daily digest
    const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
    const local = DateTime.fromJSDate(now, { zone: org?.timezone ?? 'UTC' });
    const localDate = local.toISODate();
    if (localDate && local.hour >= APPROVAL_DIGEST_LOCAL_HOUR && steps.length) {
      const claimed = await sql<{ organizationId: string }>`insert into public.approval_digest_runs (organization_id, digest_date, sent_at, recipients) values (${orgId}::uuid, ${localDate}::date, ${now}, 0)
        on conflict (organization_id, digest_date) do nothing returning organization_id as "organizationId"`.execute(trx);
      if (claimed.rows.length) {
        const byUser = new Map<string, Map<string, number>>();
        const actors = await trx.selectFrom('approvalStepActors').select(['stepId', 'userId']).where('stepId', 'in', steps.map((s) => s.stepId)).where('decision', '=', 'PENDING').execute();
        const typeOf = new Map(steps.map((s) => [s.stepId, s.entityType]));
        for (const a of actors) {
          const counts = byUser.get(a.userId) ?? new Map<string, number>();
          const type = typeOf.get(a.stepId) ?? 'OTHER';
          counts.set(type, (counts.get(type) ?? 0) + 1);
          byUser.set(a.userId, counts);
        }
        for (const [userId, counts] of byUser) {
          const total = [...counts.values()].reduce((a, b) => a + b, 0);
          // counts as a list, not an object keyed by entity type: the CamelCasePlugin rewrites nested jsonb keys on read
          // (ATTENDANCE_CORRECTION would come back as ATTENDANCECORRECTION)
          const byType = [...counts.entries()].map(([entityType, count]) => ({ entityType, count })).sort((x, y) => x.entityType.localeCompare(y.entityType));
          await emitDomainEvent(trx, { organizationId: orgId, eventType: 'approval.reminder', aggregateType: 'approval_digest', aggregateId: orgId, payload: { kind: 'digest', digestDate: localDate, total, counts: byType, userIds: [userId] }, actorUserId: null, requestId: null });
          digests += 1;
        }
        await trx.updateTable('approvalDigestRuns').set({ recipients: digests }).where('organizationId', '=', orgId).where('digestDate', '=', localDate as never).execute();
      }
    }
    return { escalated, reminded, digests };
  });
}

export async function approvalRemindersHandler({ deps, log, job }: JobContext): Promise<ApprovalRemindersResult> {
  const orgId = String(job.payload['organizationId'] ?? job.organizationId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('APPROVAL_REMINDERS needs an organizationId');
  const res = await runApprovalReminders(deps, orgId, { jobId: job.id });
  if (res.escalated || res.reminded || res.digests) log.info(event('approval_reminders', { organizationId: orgId, jobId: job.id, ...res }));
  return res;
}

export function registerApprovalHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'APPROVAL_REMINDERS', handler: approvalRemindersHandler, timeoutMs: 120_000 });
}

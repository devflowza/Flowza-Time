import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { resolveApprovalSettings, type ApprovalEntity, type ApprovalEscalationTarget, type ApprovalSettings } from '@flowza/contracts';
import { emitDomainEvent, withContext, type Trx } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { HandlerRegistry, JobContext } from '../types.js';
import { approvalEntityFacts } from './facts.js';

/**
 * A current level still waiting this long after it became current — or after the requester answered the last question on
 * it — gets one reminder to its pending approvers (B-102).
 */
export const APPROVAL_REMINDER_AFTER_HOURS = 24;
/** The daily digest goes out on the first run at or after this local hour (organisation timezone). */
export const APPROVAL_DIGEST_LOCAL_HOUR = 8;

interface CurrentStep {
  stepId: string; requestId: string; stepNo: number; approverType: string; entityType: ApprovalEntity; entityId: string; employeeId: string | null; branchId: string | null;
  requestedBy: string | null; subjectUserId: string | null; workflowId: string | null; activatedAt: Date | null; dueAt: Date | null; escalatedAt: Date | null; remindedAt: Date | null; escalateTo: string | null;
  /** Other people the request is about (HR portal Prompt 4 review, P0-2 — a swap's colleague) and their logins at submit. */
  coSubjectEmployeeIds: string[] | null; coSubjectUserIds: string[] | null;
  /** Set while an approver's question waits for the requester's answer (review 8-P2-1: the level's clocks are paused). */
  infoRequestedAt: Date | null;
  /** When the requester last answered a question on the request: the reminder clock restarts there (review 8-P2-1). */
  lastAnsweredAt: Date | null;
}

export interface ApprovalRemindersResult { escalated: number; reminded: number; digests: number; handedOver: number }

async function currentSteps(trx: Trx, orgId: string): Promise<CurrentStep[]> {
  return trx.selectFrom('approvalSteps as s').innerJoin('approvalRequests as r', 'r.id', 's.requestId')
    .select(['s.id as stepId', 's.requestId', 's.stepNo', 's.approverType', 'r.entityType', 'r.entityId', 'r.employeeId', 'r.branchId', 'r.requestedBy', 'r.subjectUserId', 'r.workflowId', 's.activatedAt', 's.dueAt', 's.escalatedAt', 's.remindedAt', 's.escalateTo', 'r.coSubjectEmployeeIds', 'r.coSubjectUserIds', 'r.infoRequestedAt'])
    .select((eb) => eb.selectFrom('approvalRequestEvents as e').select((e) => e.fn.max('e.at').as('at')).whereRef('e.requestId', '=', 'r.id').where('e.kind', '=', 'info_answered').as('lastAnsweredAt'))
    .where('r.organizationId', '=', orgId).where('r.status', '=', 'PENDING').where('s.status', '=', 'PENDING').whereRef('s.stepNo', '=', 'r.currentStep')
    .orderBy('r.createdAt').orderBy('r.id').execute() as Promise<CurrentStep[]>;
}

/**
 * Since when the current level has been waiting for its approvers: its activation, or the requester's last answer when that is
 * later (review 8-P2-1 — a question hands the request back to the requester; the answer starts the level's clock again).
 */
export function waitingSinceOf(s: Pick<CurrentStep, 'activatedAt' | 'lastAnsweredAt'>): Date | null {
  const answered = s.lastAnsweredAt ? new Date(s.lastAnsweredAt) : null;
  if (!s.activatedAt) return null;
  return answered && answered.getTime() > s.activatedAt.getTime() ? answered : s.activatedAt;
}

async function pendingActorIds(trx: Trx, stepId: string): Promise<string[]> {
  return (await trx.selectFrom('approvalStepActors').select('userId').where('stepId', '=', stepId).where('decision', '=', 'PENDING').execute()).map((a) => a.userId);
}

/**
 * The notification payload of a request: who it is about and — for every entity type with a document (B-102) — the day or
 * the leave's dates and type (approvalEntityFacts), so the reminder / escalation texts say which request they mean.
 */
async function requestPayload(trx: Trx, orgId: string, s: CurrentStep): Promise<Record<string, unknown>> {
  const emp = s.employeeId ? await trx.selectFrom('employees').select(['displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', '=', s.employeeId).executeTakeFirst() : undefined;
  const facts = await approvalEntityFacts(trx, orgId, s.entityType, s.entityId);
  return { requestId: s.requestId, entityType: s.entityType, entityId: s.entityId, employeeId: s.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, requestedBy: s.requestedBy, stepId: s.stepId, stepNo: s.stepNo, ...facts };
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
  // four-eyes (HR portal Prompt 5 review, O3): whoever approved an earlier level of the request is never added to a later one
  const priorApprovers = new Set((await trx.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as st', 'st.id', 'a.stepId').select('a.userId')
    .where('st.organizationId', '=', orgId).where('st.requestId', '=', s.requestId).where('st.stepNo', '<', s.stepNo).where('a.decision', '=', 'APPROVED').execute()).map((a) => a.userId));
  const eligible = (ids: string[]) => ids.filter((u) => !current.has(u) && u !== s.subjectUserId && u !== s.requestedBy && !linkedToSubject.has(u) && !linkedToCoSubjects.has(u) && !priorApprovers.has(u));
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
  await recordEvent(trx, orgId, s.requestId, 'escalated', { stepNo: s.stepNo, target: target ?? s.escalateTo, added, dueAt: s.dueAt?.toISOString() ?? null, ...(added.length ? {} : { reason: 'nobody else to escalate to' }) });
  if (added.length) await emitTargeted(trx, orgId, 'approval.escalated', s.requestId, added, { ...(await requestPayload(trx, orgId, s)), target, dueAt: s.dueAt?.toISOString() ?? null });
  return added;
}

/** The people a request is about, its requester and its earlier approvers: never added to a level (self-approval and four-eyes). */
async function excludedFrom(trx: Trx, orgId: string, s: CurrentStep): Promise<Set<string>> {
  const linkedToSubject = s.employeeId ? (await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', '=', s.employeeId).execute()).map((m) => m.userId) : [];
  const coSubjects = s.coSubjectEmployeeIds ?? [];
  const linkedToCoSubjects = coSubjects.length ? (await trx.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('employeeId', 'in', coSubjects).execute()).map((m) => m.userId) : [];
  const priorApprovers = (await trx.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as st', 'st.id', 'a.stepId').select('a.userId')
    .where('st.organizationId', '=', orgId).where('st.requestId', '=', s.requestId).where('st.stepNo', '<', s.stepNo).where('a.decision', '=', 'APPROVED').execute()).map((a) => a.userId);
  return new Set([...linkedToSubject, ...linkedToCoSubjects, ...(s.coSubjectUserIds ?? []), ...priorApprovers, ...[s.subjectUserId, s.requestedBy].filter((u): u is string => !!u)]);
}

/**
 * Absence hand-over (customer review: the secondary manager hears of a request only when the immediate manager is on leave).
 * A MANAGER level resolved at submit keeps its manager; when every seat still pending on it belongs to somebody on approved
 * leave TODAY (organisation date) whom no delegation in force covers, the backup joins the level ONCE as an escalated actor
 * — an extra pair of hands that fills one pending seat, exactly like an escalation: the subject's secondary manager, else
 * (`managerUnavailable = next_level_manager`) the next manager up from the absent one, else the HR admins, then the owners.
 * Nobody the request is about, its requester or an earlier approver is ever added. Off with `approvals.handOverWhenAway`.
 */
async function handOverAbsent(trx: Trx, orgId: string, s: CurrentStep, today: string, policy: ApprovalSettings): Promise<string[]> {
  if (s.approverType !== 'MANAGER') return [];
  const done = await trx.selectFrom('approvalRequestEvents').select('id').where('requestId', '=', s.requestId).where('kind', '=', 'absence_handover').where(sql<boolean>`(detail->>'stepNo')::int = ${s.stepNo}`).executeTakeFirst();
  if (done) return [];
  const rows = await trx.selectFrom('approvalStepActors').select(['userId', 'viaDelegationOf', 'resolutionPath', 'decision']).where('stepId', '=', s.stepId).execute();
  const seats = [...new Set(rows.filter((r) => r.decision === 'PENDING' && r.resolutionPath !== 'escalated').map((r) => r.viaDelegationOf ?? r.userId))];
  if (!seats.length || rows.some((r) => r.resolutionPath === 'escalated' && r.decision === 'PENDING')) return [];
  const employeeOf = new Map((await trx.selectFrom('orgMemberships').select(['userId', 'employeeId']).where('organizationId', '=', orgId).where('status', '=', 'active').where('userId', 'in', seats).execute()).map((m) => [m.userId, m.employeeId]));
  const seatEmployees = seats.map((u) => employeeOf.get(u) ?? null);
  if (seatEmployees.some((e) => !e)) return []; // a seat without an employee record cannot be on leave: nothing to hand over
  const onLeave = async (employeeIds: string[]) => new Set(employeeIds.length ? (await trx.selectFrom('leaveRecords').select('employeeId').where('organizationId', '=', orgId).where('employeeId', 'in', employeeIds).where('status', '=', 'APPROVED')
    .where('startDate', '<=', sql<Date>`${today}::date`).where('endDate', '>=', sql<Date>`${today}::date`).execute()).map((r) => r.employeeId) : []);
  const away = await onLeave(seatEmployees as string[]);
  if (seatEmployees.some((e) => !away.has(e!))) return [];
  // a delegation in force today covers the absent approver: their delegate already decides in their seat
  for (const u of seats) {
    const { rows: d } = await sql<{ delegate: string | null }>`select app.approval_delegate_of(${orgId}::uuid, ${u}::uuid, ${s.entityType}::public.approval_entity) as delegate`.execute(trx);
    if (d[0]?.delegate) return [];
  }
  const excluded = await excludedFrom(trx, orgId, s);
  for (const r of rows) excluded.add(r.userId);
  const loginOf = async (employeeIds: string[]) => new Map(employeeIds.length ? (await trx.selectFrom('orgMemberships').select(['employeeId', 'userId']).where('organizationId', '=', orgId).where('status', '=', 'active').where('employeeId', 'in', employeeIds).orderBy('createdAt').execute()).reverse().map((m) => [m.employeeId!, m.userId]) : []);
  /** The first of these employees with an active login, at work today and allowed on the request. */
  const firstAvailable = async (employeeIds: Array<string | null>): Promise<string | null> => {
    const ids = employeeIds.filter((e): e is string => !!e);
    const logins = await loginOf(ids); const awayToday = await onLeave(ids);
    for (const e of ids) { const u = logins.get(e); if (u && !awayToday.has(e) && !excluded.has(u)) return u; }
    return null;
  };
  let target: 'secondary' | 'next_level' | 'HR_ADMIN' | 'OWNER' | null = null;
  let added: string[] = [];
  const subject = s.employeeId ? await trx.selectFrom('employees').select(['secondaryManagerEmployeeId']).where('organizationId', '=', orgId).where('id', '=', s.employeeId).executeTakeFirst() : undefined;
  const secondary = await firstAvailable([subject?.secondaryManagerEmployeeId ?? null]);
  if (secondary) { target = 'secondary'; added = [secondary]; }
  if (!added.length && policy.managerUnavailable === 'next_level_manager') {
    // up the reporting line from the absent manager (primary links, at most five levels)
    const up: string[] = [];
    let cursor: string | null = seatEmployees[0] ?? null;
    for (let i = 0; i < 5 && cursor; i += 1) {
      const e: { managerEmployeeId: string | null } | undefined = await trx.selectFrom('employees').select('managerEmployeeId').where('organizationId', '=', orgId).where('id', '=', cursor).where('deletedAt', 'is', null).executeTakeFirst();
      cursor = e?.managerEmployeeId ?? null;
      if (cursor && !up.includes(cursor)) up.push(cursor);
    }
    const next = await firstAvailable(up);
    if (next) { target = 'next_level'; added = [next]; }
  }
  for (const t of ['HR_ADMIN', 'OWNER'] as const) {
    if (added.length) break;
    added = [...new Set((await membersByRole(trx, orgId, t === 'HR_ADMIN' ? 'hr_admin' : 'owner', s.branchId)).filter((u) => !excluded.has(u)))].sort();
    if (added.length) target = t;
  }
  await recordEvent(trx, orgId, s.requestId, 'absence_handover', { stepNo: s.stepNo, absent: seats.slice().sort(), target, added, today, ...(added.length ? {} : { reason: 'nobody available to hand over to' }) });
  if (!added.length) return [];
  await trx.insertInto('approvalStepActors').values(added.map((userId) => ({ organizationId: orgId, stepId: s.stepId, userId, viaDelegationOf: null, resolutionPath: 'escalated' }))).onConflict((oc) => oc.columns(['stepId', 'userId']).doNothing()).execute();
  await emitTargeted(trx, orgId, 'approval.escalated', s.requestId, added, { ...(await requestPayload(trx, orgId, s)), kind: 'absence', target });
  return added;
}

/**
 * The hourly approvals sweep for one organisation (system context, injected clock): escalate overdue levels, remind the
 * approvers of levels waiting longer than a day (once per level), hand a level whose manager went on leave to their backup
 * (`handOverAbsent`, once per level), and once a day — the first run at or after 08:00 in the
 * organisation's timezone — send every approver ONE digest notification with their pending counts (idempotent through
 * `approval_digest_runs`).
 *
 * A request whose approver asked a question (INFO_REQUESTED — `info_requested_at` set) waits for the REQUESTER, not for its
 * approvers (review 8-P2-1): it is neither escalated, nor reminded, nor counted in the digest until it is answered. The answer
 * restarts the level's clocks: the reminder is due a day after the answer, and the escalation deadline is re-armed from the
 * answer by the engine (apps/api `answerInfo`).
 */
export async function runApprovalReminders(deps: WorkerDeps, orgId: string, opts: { jobId?: string } = {}): Promise<ApprovalRemindersResult> {
  const now = deps.now();
  return withContext(deps.db, { kind: 'system', organizationId: orgId, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, async (trx) => {
    const steps = await currentSteps(trx, orgId);
    let escalated = 0; let reminded = 0; let digests = 0; let handedOver = 0;
    // the requests waiting for their approvers (not for the requester's answer to a question)
    const waiting = steps.filter((s) => !s.infoRequestedAt);
    for (const s of waiting) {
      if (s.dueAt && s.dueAt.getTime() <= now.getTime() && !s.escalatedAt && s.escalateTo) { await escalate(trx, orgId, s, now); escalated += 1; }
    }
    const policy = resolveApprovalSettings((await trx.selectFrom('organizationSettings').select('approvals').where('organizationId', '=', orgId).executeTakeFirst())?.approvals);
    if (policy.handOverWhenAway && waiting.length) {
      const { rows } = await sql<{ d: string }>`select app.org_today(${orgId}::uuid)::text as d`.execute(trx);
      const today = rows[0]?.d;
      if (today) for (const s of waiting) if ((await handOverAbsent(trx, orgId, s, today, policy)).length) handedOver += 1;
    }
    const remindBefore = now.getTime() - APPROVAL_REMINDER_AFTER_HOURS * 3_600_000;
    for (const s of waiting) {
      const since = waitingSinceOf(s);
      if (s.remindedAt || !since || since.getTime() > remindBefore) continue;
      const userIds = await pendingActorIds(trx, s.stepId);
      await trx.updateTable('approvalSteps').set({ remindedAt: now }).where('id', '=', s.stepId).execute();
      await recordEvent(trx, orgId, s.requestId, 'reminded', { stepNo: s.stepNo, recipients: userIds.length, waitingSince: since.toISOString() });
      await emitTargeted(trx, orgId, 'approval.reminder', s.requestId, userIds, { ...(await requestPayload(trx, orgId, s)), kind: 'reminder', waitingSince: since.toISOString() });
      reminded += 1;
    }
    // daily digest
    const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
    const local = DateTime.fromJSDate(now, { zone: org?.timezone ?? 'UTC' });
    const localDate = local.toISODate();
    if (localDate && local.hour >= APPROVAL_DIGEST_LOCAL_HOUR && waiting.length) {
      const claimed = await sql<{ organizationId: string }>`insert into public.approval_digest_runs (organization_id, digest_date, sent_at, recipients) values (${orgId}::uuid, ${localDate}::date, ${now}, 0)
        on conflict (organization_id, digest_date) do nothing returning organization_id as "organizationId"`.execute(trx);
      if (claimed.rows.length) {
        const byUser = new Map<string, Map<string, number>>();
        const actors = await trx.selectFrom('approvalStepActors').select(['stepId', 'userId']).where('stepId', 'in', waiting.map((s) => s.stepId)).where('decision', '=', 'PENDING').execute();
        const typeOf = new Map(waiting.map((s) => [s.stepId, s.entityType]));
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
    return { escalated, reminded, digests, handedOver };
  });
}

export async function approvalRemindersHandler({ deps, log, job }: JobContext): Promise<ApprovalRemindersResult> {
  const orgId = String(job.payload['organizationId'] ?? job.organizationId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('APPROVAL_REMINDERS needs an organizationId');
  const res = await runApprovalReminders(deps, orgId, { jobId: job.id });
  if (res.escalated || res.reminded || res.digests || res.handedOver) log.info(event('approval_reminders', { organizationId: orgId, jobId: job.id, ...res }));
  return res;
}

export function registerApprovalHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'APPROVAL_REMINDERS', handler: approvalRemindersHandler, timeoutMs: 120_000 });
}

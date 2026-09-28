/**
 * Notifications review fixes (HR portal Prompt 8 review — docs/hr-portal/reviews/08-notifications-review.md), API side:
 *  - 8-P0-1: a client session (PostgREST: `authenticator` → `authenticated`) cannot write the outbox, while every emitter of
 *    the services still can; the e-mail landing page previews a link from the REQUEST (read-only, bound to the link,
 *    rate-limited) before the decision;
 *  - 8-P0-4: a correction's decision reaches the requester and the person concerned once — never the decider, never a
 *    manager of another branch;
 *  - 8-P1-3: withdrawing somebody else's pending request tells its requester and the person it is about;
 *  - 8-P2-1: answering a question restarts the level's clocks (the escalation deadline and the reminder);
 *  - 8-P2-8: a reason answered by editing it tells the approvers "answer received", not "changed" + "waiting".
 * End to end through the worker's real relay where the notices matter.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { DOMAIN_EVENT_TYPES } from '@flowza/contracts';
import { createLogger } from '@flowza/shared';
import { emitDomainEvent, issueApprovalEmailTokens, PgJobQueue, withContext } from '@flowza/database';
import { relayOutbox } from '../../../../../worker/src/handlers/notifications/outbox.js';
import { APPROVAL_EMAIL_ACTION_LIMIT } from './approvals.js';
import { auditRows, createApiHarness, domainEvents, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const lineMgr = uuid('c'); const staff = uuid('c');
let e4: string; let e5: string; let leaveTypeId: string;
const base = () => `/api/v1/orgs/${f.orgId}`;

/** The worker's relay over the worker's own database role (the real handler, deps reduced to what it touches). */
async function relay() {
  const deps = { db: h.tdb.workerDb, now: () => new Date(), log: createLogger({ name: 'relay-test', level: 'silent' }), realtime: { async publish() {} }, queue: new PgJobQueue(h.tdb.workerDb), config: { WEB_PUBLIC_URL: 'http://web.test' } };
  return relayOutbox({ job: { id: '1', queueName: 'notifications', jobType: 'RELAY_OUTBOX', organizationId: null, payload: {}, priority: 5, attempts: 1, maxAttempts: 1, correlationId: null, lockedBy: 'test', runAt: new Date() }, log: deps.log, deps: deps as never, signal: new AbortController().signal });
}
/** The notices written for one aggregate (a request, a record), as (recipient, type). */
async function noticesOf(aggregateId: string) {
  return (await h.admin.selectFrom('notifications').select(['userId', 'type', 'title', 'body']).where(sql<boolean>`data->>'aggregateId' = ${aggregateId}`).orderBy('createdAt').execute());
}
async function workflow(entityType: string, steps: unknown[]) {
  await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', f.orgId).where('entityType', '=', entityType as never).execute();
  const r = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: `${entityType} ${Math.random().toString(36).slice(2, 7)}`, entityType, steps } });
  expect(r.status).toBe(201);
}
let weekOffset = 6;
function nextDay(): string {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay()); // a Sunday, weeks ahead
  return d.toISOString().slice(0, 10);
}
const oneDay = () => { const d = nextDay(); return { startDate: d, endDate: d }; };

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_notif_review_${process.pid}`);
  f = await seedOrg(h.admin, 'ntr');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  await seedUser(h.admin, lineMgr, 'line-mgr-ntr@test.local', 'Line Manager');
  await seedUser(h.admin, staff, 'staff-ntr@test.local', 'Staff Five');
  await seedMembership(h.admin, f.orgId, lineMgr, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, staff, ROLE.employee, { employeeId: e5 });
  const type = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'CL', name: 'Casual Leave', nameAr: 'إجازة عارضة', annualAllowanceDays: 30 } });
  expect(type.status).toBe(201);
  leaveTypeId = type.body.data.id;
});
afterAll(async () => { await h?.close(); });

describe('8-P0-1 the outbox is written by the services only', () => {
  it('8-P0-1 an authenticated client cannot insert a domain event (PostgREST: authenticator → authenticated, the member\'s own JWT)', async () => {
    const url = new URL(h.tdb.connectionString); url.username = 'authenticator'; url.password = '';
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query('begin');
      await client.query('select set_config(\'request.jwt.claims\', $1, true)', [JSON.stringify({ sub: f.owner, role: 'authenticated' })]);
      await client.query('set local role authenticated');
      expect((await client.query('select session_user::text as s, current_user::text as c')).rows[0]).toEqual({ s: 'authenticator', c: 'authenticated' });
      // the owner holds every key and is a member: the refusal is about WHO writes, not what they may do in the app
      await expect(client.query('insert into public.domain_events (organization_id, event_type, aggregate_type, aggregate_id, payload) values ($1, \'approval.pending\', \'approval_request\', $2, $3)',
        [f.orgId, uuid('9'), JSON.stringify({ userIds: [f.hrAdmin], employeeName: 'Somebody' })])).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('8-P0-1 emitDomainEvent still works for every emitter: every event type, from the API (user context, system step) and the worker (system, platform)', async () => {
    const contexts = [
      { name: 'api-user', db: h.tdb.db, ctx: { kind: 'user' as const, userId: f.owner } },
      { name: 'api-system', db: h.tdb.db, ctx: { kind: 'system' as const, organizationId: f.orgId } },
      { name: 'worker-system', db: h.tdb.workerDb, ctx: { kind: 'system' as const, organizationId: f.orgId } },
      { name: 'worker-platform', db: h.tdb.workerDb, ctx: { kind: 'platform' as const } },
    ];
    for (const c of contexts) {
      await withContext(c.db, c.ctx, async (trx) => {
        for (const eventType of DOMAIN_EVENT_TYPES) await emitDomainEvent(trx, { organizationId: f.orgId, eventType, aggregateType: 'p8f_probe', aggregateId: null, payload: { probe: c.name } });
      });
    }
    const rows = await h.admin.selectFrom('domainEvents').select(['eventType', 'payload']).where('aggregateType', '=', 'p8f_probe').execute();
    for (const c of contexts) expect(rows.filter((r) => (r.payload as Record<string, unknown>)['probe'] === c.name).map((r) => r.eventType).sort(), c.name).toEqual([...DOMAIN_EVENT_TYPES].sort());
    // probes, not notices
    await h.admin.updateTable('domainEvents').set({ publishedAt: new Date() }).where('aggregateType', '=', 'p8f_probe').execute();
    // and a real route in a user context writes its events through the API login
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const apply = await h.request('POST', `${base()}/me/leave`, { token: staff, body: { leaveTypeId, ...oneDay(), reason: 'Probe' } });
    expect(apply.status, JSON.stringify(apply.body)).toBe(201);
    expect((await domainEvents(h.admin, 'approval.pending')).some((e) => e.aggregateId === apply.body.data.approvalRequestId)).toBe(true);
    await h.request('POST', `${base()}/approvals/${apply.body.data.approvalRequestId}/cancel`, { token: staff, body: { reason: 'Probe done' } });
  });
});

describe('8-P0-1 the e-mail landing page previews the request before the decision', () => {
  it('8-P0-1 the preview reads the REQUEST (entity, person, dates, type, level) — read-only and bound to the link; the decision then goes through', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const day = nextDay();
    const apply = await h.request('POST', `${base()}/me/leave`, { token: staff, body: { leaveTypeId, startDate: day, endDate: day, reason: 'Family' } });
    expect(apply.status).toBe(201);
    const requestId = apply.body.data.approvalRequestId as string;
    const step = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', requestId).executeTakeFirstOrThrow();
    const pair = await h.admin.transaction().execute((trx) => issueApprovalEmailTokens(trx, { organizationId: f.orgId, requestId, stepId: step.id, userId: lineMgr }));
    const preview = (token: string, action: 'APPROVE' | 'REJECT', user = lineMgr) => h.request('POST', `${base()}/approvals/email-action/preview`, { token: user, body: { token, action } });
    const p = await preview(pair.approve, 'APPROVE');
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ requestId, action: 'APPROVE', entityType: 'LEAVE', employeeName: 'Employee 5', date: day, endDate: day, leaveTypeName: 'Casual Leave', leaveTypeNameAr: 'إجازة عارضة', stepNo: 1, stepCount: 1, currentStep: 1, status: 'PENDING', actionable: true });
    expect(Date.parse(p.body.data.expiresAt)).toBeGreaterThan(Date.now());
    // read-only: nothing spent, nothing decided
    expect((await h.admin.selectFrom('approvalEmailTokens').select('usedAt').where('requestId', '=', requestId).execute()).every((t) => t.usedAt === null)).toBe(true);
    expect((await h.admin.selectFrom('approvalRequests').select('status').where('id', '=', requestId).executeTakeFirstOrThrow()).status).toBe('PENDING');
    // bound like the action: somebody else's link is worthless, the action must match
    expect((await preview(pair.approve, 'APPROVE', f.owner)).status).toBe(404);
    expect((await preview(pair.approve, 'REJECT')).status).toBe(400);
    expect((await preview('x'.repeat(40), 'APPROVE')).status).toBe(404);
    // the confirmation decides with the same link; afterwards the link previews as spent
    const ok = await h.request('POST', `${base()}/approvals/email-action`, { token: lineMgr, body: { token: pair.approve, action: 'APPROVE' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect((await preview(pair.approve, 'APPROVE')).status).toBe(409);
    // a failed preview is audited without the token
    const failed = (await auditRows(h.admin, 'approval.email_token_preview_failed')).filter((a) => a.organizationId === f.orgId);
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(failed)).not.toContain(pair.approve);
  });

  it('8-P0-1 the preview has its own limiter: 20 a minute per IP and per user', async () => {
    const guess = (i: number) => `guess-${i}-${'0'.repeat(20)}`;
    const attempt = (i: number, ip: string, user: string) => h.request('POST', `${base()}/approvals/email-action/preview`, { token: user, headers: { 'x-forwarded-for': ip }, body: { token: guess(i), action: 'APPROVE' } });
    for (let i = 0; i < APPROVAL_EMAIL_ACTION_LIMIT.max; i += 1) expect((await attempt(i, '198.51.100.21', f.hrUser)).status).toBe(404);
    expect((await attempt(99, '198.51.100.21', f.hrUser)).status).toBe(429);
    expect((await attempt(100, '198.51.100.22', f.hrUser)).status).toBe(429); // the user's bucket
    // the one-click action itself is not charged for previews
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrUser, headers: { 'x-forwarded-for': '198.51.100.23' }, body: { token: guess(101), action: 'APPROVE' } })).status).toBe(404);
  });
});

describe('8-P0-4 a correction\'s decision reaches the requester and the person concerned once', () => {
  it('8-P0-4 approvers within branch scope through approval.pending; the decision once each to the requester and the subject; never the decider nor a branch-B manager', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', permission: 'attendance.approve' }]);
    const day = '2026-07-06';
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: { employeeId: f.e1, attendanceDate: day, type: 'ADD_PUNCH', proposedPunchedAt: `${day}T13:05:00Z`, reason: 'Forgot to punch out' } });
    expect(r.status).toBe(201);
    const requestId = r.body.data.approvalRequestId as string;
    const seated = (await h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select('a.userId').where('s.requestId', '=', requestId).execute()).map((x) => x.userId);
    expect(seated).not.toContain(f.branchManagerB); // branch scope: e1 works in branch A
    expect(seated).not.toContain(f.hrUser); // the requester
    expect(seated).toContain(f.hrAdmin);
    const decided = await h.request('POST', `${base()}/approvals/${requestId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1, comment: 'Checked the CCTV' } });
    expect(decided.status).toBe(200);
    expect((await domainEvents(h.admin, 'attendance.correction_approved')).some((e) => e.aggregateId === r.body.data.id)).toBe(true);
    await relay();
    const onRequest = await noticesOf(requestId);
    const onCorrection = await noticesOf(r.body.data.id);
    expect(onCorrection).toEqual([]); // attendance.correction_approved: published for realtime only
    const decisions = onRequest.filter((n) => n.type === 'approval.decided');
    expect(decisions.map((n) => n.userId).sort()).toEqual([f.hrUser, f.employeeUser].sort()); // once each
    expect(decisions[0]!.title).toBe('Attendance correction — Employee 1 was approved');
    const all = [...onRequest, ...onCorrection];
    expect(all.filter((n) => n.userId === f.branchManagerB)).toEqual([]);
    expect(all.filter((n) => n.userId === f.hrAdmin && n.type !== 'approval.pending')).toEqual([]); // the decider hears nothing of their decision
    expect(all.filter((n) => n.userId === f.hrUser)).toHaveLength(1);
  });
});

describe('8-P1-3 a withdrawal by somebody else tells the requester and the person concerned', () => {
  it('8-P1-3 HR withdrawing an employee\'s pending leave: the employee hears it (and the waiting approver); HR does not', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const day = nextDay();
    const apply = await h.request('POST', `${base()}/me/leave`, { token: staff, body: { leaveTypeId, startDate: day, endDate: day, reason: 'Wedding' } });
    const requestId = apply.body.data.approvalRequestId as string;
    const w = await h.request('POST', `${base()}/approvals/${requestId}/cancel`, { token: f.hrUser, body: { reason: 'Duplicate of an HR record' } });
    expect(w.status).toBe(200);
    const ev = (await domainEvents(h.admin, 'approval.decided')).filter((e) => e.aggregateId === requestId);
    expect(ev).toHaveLength(1);
    expect(((ev[0]!.payload as Record<string, unknown>)['userIds'] as string[]).sort()).toEqual([lineMgr, staff].sort());
    await relay();
    const n = (await noticesOf(requestId)).filter((x) => x.type === 'approval.decided');
    expect(n.map((x) => x.userId).sort()).toEqual([lineMgr, staff].sort());
    const toStaff = n.find((x) => x.userId === staff)!;
    expect(toStaff.title).toBe('Leave request — Employee 5 was withdrawn');
    expect(toStaff.body).toContain('Duplicate of an HR record');
    // the requester withdrawing their own: the waiting approver only (the requester did it themselves)
    const again = await h.request('POST', `${base()}/me/leave`, { token: staff, body: { leaveTypeId, ...oneDay(), reason: 'Trip' } });
    const own = again.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${own}/cancel`, { token: staff, body: { reason: 'Plans changed' } })).status).toBe(200);
    const ownEv = (await domainEvents(h.admin, 'approval.decided')).filter((e) => e.aggregateId === own);
    expect((ownEv[0]!.payload as Record<string, unknown>)['userIds']).toEqual([lineMgr]);
  });
});

describe('8-P2-1 answering a question restarts the level\'s clocks', () => {
  it('8-P2-1 the answer re-arms the escalation deadline from the answer and clears the reminder, both on the timeline', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER', escalateAfterHours: 24, escalateTo: 'HR_ADMIN' }]);
    const apply = await h.request('POST', `${base()}/me/leave`, { token: staff, body: { leaveTypeId, ...oneDay(), reason: 'Clocks' } });
    const requestId = apply.body.data.approvalRequestId as string;
    const step = () => h.admin.selectFrom('approvalSteps').select(['id', 'dueAt', 'remindedAt', 'activatedAt']).where('requestId', '=', requestId).executeTakeFirstOrThrow();
    const first = await step();
    // the level waited, was reminded, then a question paused it for a while
    await h.admin.updateTable('approvalSteps').set({ activatedAt: new Date(Date.now() - 30 * 3_600_000), dueAt: new Date(Date.now() - 6 * 3_600_000), remindedAt: new Date(Date.now() - 6 * 3_600_000) }).where('id', '=', first.id).execute();
    expect((await h.request('POST', `${base()}/approvals/${requestId}/request-info`, { token: lineMgr, body: { comment: 'Who covers you?' } })).status).toBe(200);
    const before = Date.now();
    expect((await h.request('POST', `${base()}/approvals/${requestId}/answer-info`, { token: staff, body: { comment: 'Sara covers me' } })).status).toBe(200);
    const after = await step();
    expect(after.remindedAt).toBeNull();
    expect(after.dueAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1_000);
    expect(after.dueAt!.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000 + 1_000);
    const answered = await h.admin.selectFrom('approvalRequestEvents').select('detail').where('requestId', '=', requestId).where('kind', '=', 'info_answered').executeTakeFirstOrThrow();
    expect(answered.detail).toMatchObject({ comment: 'Sara covers me', dueAt: after.dueAt!.toISOString() });
    await h.request('POST', `${base()}/approvals/${requestId}/cancel`, { token: staff, body: { reason: 'Done' } });
  });
});

describe('8-P2-8 a reason answered by editing it reads as an answer', () => {
  it('8-P2-8 the approvers hear approval.info_answered with the new reason — not "changed while pending" + "waiting"; the invalidation stays on the timeline', async () => {
    const date = isoToday(-5);
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e1, attendanceDate: date, branchId: f.branchA, departmentId: f.departmentA, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'ABSENT' as never, flags: [], workedMinutes: 0, lateMinutes: 0, trace: JSON.stringify({ punches: [] }) }).execute();
    const n = await h.request('POST', `${base()}/me/attendance/notes`, { token: f.employeeUser, body: { date, category: 'absence_reason', note: 'I was at the clinic' } });
    expect(n.status).toBe(201);
    const noteId = n.body.data.id as string;
    const oldRequest = n.body.data.approvalRequestId as string;
    const q = await h.request('POST', `${base()}/attendance/notes/${noteId}/review`, { token: f.managerUser, body: { decision: 'request_info', reason: 'Do you have the clinic slip?' } });
    expect(q.status).toBe(200);
    await relay();
    const patched = await h.request('PATCH', `${base()}/me/attendance/notes/${noteId}`, { token: f.employeeUser, body: { note: 'Clinic slip attached in the HR portal' } });
    expect(patched.status).toBe(200);
    const newRequest = patched.body.data.approvalRequestId as string;
    expect(newRequest).not.toBe(oldRequest);
    // the events of the edit: one answer to the approvers of the new request; no "invalidated", no fresh "waiting for your approval"
    const decidedOld = (await domainEvents(h.admin, 'approval.decided')).filter((e) => e.aggregateId === oldRequest);
    expect(decidedOld).toEqual([]);
    expect((await domainEvents(h.admin, 'approval.pending')).filter((e) => e.aggregateId === newRequest)).toEqual([]);
    const answer = (await domainEvents(h.admin, 'approval.info_answered')).filter((e) => e.aggregateId === newRequest);
    expect(answer).toHaveLength(1);
    expect((answer[0]!.payload as Record<string, unknown>)['userIds']).toEqual([f.managerUser]);
    // the timelines: the old request invalidated (quietly), the new one carrying the answer
    const kinds = async (id: string) => (await h.admin.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', id).orderBy('id').execute());
    const oldTimeline = await kinds(oldRequest);
    expect(oldTimeline.map((e) => e.kind)).toContain('invalidated');
    expect(oldTimeline.find((e) => e.kind === 'invalidated')!.detail).toMatchObject({ reason: 'The employee answered the question and updated the reason.', notified: false });
    expect((await kinds(newRequest)).map((e) => e.kind)).toEqual(['submitted', 'info_answered']);
    expect((await h.admin.selectFrom('approvalRequests').select('status').where('id', '=', oldRequest).executeTakeFirstOrThrow()).status).toBe('INVALIDATED');
    await relay();
    const toManager = (await noticesOf(newRequest)).filter((x) => x.userId === f.managerUser);
    expect(toManager.map((x) => x.type)).toEqual(['approval.info_answered']);
    expect(toManager[0]!.title).toBe('Answer received: Attendance reason — Employee 1');
    expect(toManager[0]!.body).toContain('Clinic slip attached in the HR portal');
    expect((await noticesOf(oldRequest)).filter((x) => x.userId === f.managerUser && x.type === 'approval.decided')).toEqual([]);
    // a plain edit of a pending reason (not an answer) still reads as a change: invalidated + a new request waiting
    const edit = await h.request('PATCH', `${base()}/me/attendance/notes/${noteId}`, { token: f.employeeUser, body: { note: 'Clinic slip attached, see HR portal' } });
    expect(edit.status).toBe(200);
    expect((await domainEvents(h.admin, 'approval.decided')).filter((e) => e.aggregateId === newRequest).map((e) => (e.payload as Record<string, unknown>)['decision'])).toEqual(['INVALIDATED']);
    expect((await domainEvents(h.admin, 'approval.pending')).filter((e) => e.aggregateId === edit.body.data.approvalRequestId)).toHaveLength(1);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { relayOutbox, deliverNotifications } from '../notifications/outbox.js';
import { runApprovalReminders, approvalTasks } from './index.js';

/**
 * approvals.reminders with an injected clock: a 24-hour reminder once per level, escalation of an overdue level (HR admins,
 * or the next level's approvers), one digest per approver per local day at 08:00, targeted notifications, and one-click
 * token pairs minted for the approver's e-mail only.
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const BRANCH = '0e000000-0000-0000-0000-00000000000b';
const EMP = '0e000000-0000-0000-0000-0000000000e1';
const U = { owner: 'e0000000-0000-0000-0000-000000000001', hr: 'e0000000-0000-0000-0000-000000000002', a: 'e0000000-0000-0000-0000-000000000003', b: 'e0000000-0000-0000-0000-000000000004', subject: 'e0000000-0000-0000-0000-000000000005' };
const T0 = new Date('2026-09-01T02:00:00Z'); // 06:00 in Muscat
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);
let clock = T0;
let h: TestHarness;
let req1: string; let req2: string; let step1: string; let step2a: string;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_appr_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } }, () => clock);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values ${sql.join(Object.values(U).map((id) => sql`(${id}::uuid, ${`${id}@t.local`})`))}`.execute(a);
  await a.insertInto('userProfiles').values(Object.entries(U).map(([k, id]) => ({ id, email: `${id}@t.local`, fullName: k }))).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'APR', legalName: 'A', displayName: 'A', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }).execute();
  await a.insertInto('employees').values({ id: EMP, organizationId: ORG, branchId: BRANCH, employeeNumber: 'E1', firstName: 'Sub', lastName: 'Ject', displayName: 'Subject One', joiningDate: '2024-01-01', deviceUserId: '1' }).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: U.owner, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.hr, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.a, roleId: '10000000-0000-0000-0000-000000000009', status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.b, roleId: '10000000-0000-0000-0000-000000000009', status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.subject, roleId: '10000000-0000-0000-0000-000000000008', status: 'active', allBranches: true, employeeId: EMP },
  ]).execute();
  // request 1: level 1 (approver A, escalates to HR after 48 h), level 2 (approver B)
  req1 = (await a.insertInto('approvalRequests').values({ organizationId: ORG, entityType: 'LEAVE', entityId: '0e000000-0000-0000-0000-0000000001a1', branchId: BRANCH, employeeId: EMP, subjectUserId: U.subject, requestedBy: U.subject, currentStep: 1, status: 'PENDING', createdAt: T0 }).returning('id').executeTakeFirstOrThrow()).id;
  step1 = (await a.insertInto('approvalSteps').values({ organizationId: ORG, requestId: req1, stepNo: 1, approverType: 'MANAGER', approverUserId: U.a, mode: 'ANY', requiredCount: 1, status: 'PENDING', activatedAt: T0, dueAt: at(48), escalateTo: 'HR_ADMIN', escalateAfterHours: 48 }).returning('id').executeTakeFirstOrThrow()).id;
  const s12 = (await a.insertInto('approvalSteps').values({ organizationId: ORG, requestId: req1, stepNo: 2, approverType: 'USER', approverUserId: U.b, mode: 'ANY', requiredCount: 1, status: 'PENDING' }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('approvalStepActors').values([{ organizationId: ORG, stepId: step1, userId: U.a, resolutionPath: 'primary' }, { organizationId: ORG, stepId: s12, userId: U.b, resolutionPath: 'user' }]).execute();
  // request 2: level 1 (approver A) escalates to the NEXT level's approver (B) after 1 hour
  req2 = (await a.insertInto('approvalRequests').values({ organizationId: ORG, entityType: 'ATTENDANCE_CORRECTION', entityId: '0e000000-0000-0000-0000-0000000001a2', branchId: BRANCH, employeeId: EMP, subjectUserId: U.subject, requestedBy: U.hr, currentStep: 1, status: 'PENDING', createdAt: T0 }).returning('id').executeTakeFirstOrThrow()).id;
  step2a = (await a.insertInto('approvalSteps').values({ organizationId: ORG, requestId: req2, stepNo: 1, approverType: 'USER', approverUserId: U.a, mode: 'ALL', status: 'PENDING', activatedAt: at(20), dueAt: at(21), escalateTo: 'NEXT_STEP', escalateAfterHours: 1 }).returning('id').executeTakeFirstOrThrow()).id;
  const s22 = (await a.insertInto('approvalSteps').values({ organizationId: ORG, requestId: req2, stepNo: 2, approverType: 'USER', approverUserId: U.b, mode: 'ANY', requiredCount: 1, status: 'PENDING' }).returning('id').executeTakeFirstOrThrow()).id;
  await a.insertInto('approvalStepActors').values([{ organizationId: ORG, stepId: step2a, userId: U.a, resolutionPath: 'user' }, { organizationId: ORG, stepId: s22, userId: U.b, resolutionPath: 'user' }]).execute();
});
afterAll(async () => { await h?.close(); });

const events = (type: string) => h.tdb.adminDb.selectFrom('domainEvents').select(['aggregateId', 'payload']).where('eventType', '=', type).orderBy('id').execute();
const userIdsOf = (p: unknown) => ((p as Record<string, unknown>)['userIds'] as string[]).slice().sort();

describe('approvals.reminders', () => {
  it('the scheduler task enqueues one deduped job per organisation with pending requests', async () => {
    await approvalTasks[0]!.run(h.deps);
    await approvalTasks[0]!.run(h.deps);
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['jobType', 'organizationId', 'dedupeKey']).where('jobType', '=', 'APPROVAL_REMINDERS').execute();
    expect(jobs).toEqual([{ jobType: 'APPROVAL_REMINDERS', organizationId: ORG, dedupeKey: `approval-reminders:${ORG}` }]);
  });

  it('reminds once, 24 hours after a level became current; no digest before 08:00 local; escalates NEXT_STEP when due', async () => {
    clock = at(25); // 07:00 Muscat on 2 Sept
    const r = await runApprovalReminders(h.deps, ORG);
    expect(r).toEqual({ escalated: 1, reminded: 1, digests: 0 });
    const reminders = await events('approval.reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.aggregateId).toBe(req1);
    expect(userIdsOf(reminders[0]!.payload)).toEqual([U.a]);
    expect(reminders[0]!.payload).toMatchObject({ kind: 'reminder', employeeName: 'Subject One', stepNo: 1 });
    // request 2 was due at T0+21h: the next level's approver (B) joins level 1 as an escalated actor
    const actors2 = await h.tdb.adminDb.selectFrom('approvalStepActors').select(['userId', 'resolutionPath']).where('stepId', '=', step2a).orderBy('userId').execute();
    expect(actors2).toEqual([{ userId: U.a, resolutionPath: 'user' }, { userId: U.b, resolutionPath: 'escalated' }]);
    const escalated = await events('approval.escalated');
    expect(escalated.map((e) => e.aggregateId)).toEqual([req2]);
    expect(userIdsOf(escalated[0]!.payload)).toEqual([U.b]);
    expect(escalated[0]!.payload).toMatchObject({ target: 'NEXT_STEP' });
    // a second run in the same hour changes nothing
    expect(await runApprovalReminders(h.deps, ORG)).toEqual({ escalated: 0, reminded: 0, digests: 0 });
  });

  it('sends one digest per approver at 08:00 local, once per day', async () => {
    clock = at(26.5); // 08:30 Muscat
    const r = await runApprovalReminders(h.deps, ORG);
    expect(r.digests).toBe(2); // A (two requests) and B (escalated on request 2)
    const digests = (await events('approval.reminder')).filter((e) => (e.payload as Record<string, unknown>)['kind'] === 'digest');
    const forA = digests.find((d) => userIdsOf(d.payload)[0] === U.a);
    expect(forA?.payload).toMatchObject({ total: 2, counts: [{ entityType: 'ATTENDANCE_CORRECTION', count: 1 }, { entityType: 'LEAVE', count: 1 }], digestDate: '2026-09-02' });
    clock = at(27.5);
    expect((await runApprovalReminders(h.deps, ORG)).digests).toBe(0);
    const run = await h.tdb.adminDb.selectFrom('approvalDigestRuns').select(['digestDate', 'recipients']).where('organizationId', '=', ORG).execute();
    expect(run).toHaveLength(1);
    expect(run[0]!.recipients).toBe(2);
  });

  it('escalates an overdue level to the HR admins (never the subject or the requester) and records it on the timeline', async () => {
    clock = at(49); // 07:00 Muscat on 3 Sept: past due, before the digest hour
    const r = await runApprovalReminders(h.deps, ORG);
    expect(r).toMatchObject({ escalated: 1, digests: 0 });
    const actors = await h.tdb.adminDb.selectFrom('approvalStepActors').select(['userId', 'resolutionPath']).where('stepId', '=', step1).orderBy('userId').execute();
    expect(actors).toEqual([{ userId: U.hr, resolutionPath: 'escalated' }, { userId: U.a, resolutionPath: 'primary' }].sort((x, y) => x.userId.localeCompare(y.userId)));
    const step = await h.tdb.adminDb.selectFrom('approvalSteps').select(['escalatedAt']).where('id', '=', step1).executeTakeFirstOrThrow();
    expect(step.escalatedAt?.toISOString()).toBe(at(49).toISOString());
    const timeline = await h.tdb.adminDb.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', req1).orderBy('id').execute();
    expect(timeline.map((t) => t.kind)).toEqual(['reminded', 'escalated']);
    expect(timeline[1]!.detail).toMatchObject({ target: 'HR_ADMIN', added: [U.hr] });
  });

  it('the relay notifies exactly the targeted users; the approver\'s e-mail gets a one-click token pair', async () => {
    const res = await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    expect(res.relayed).toBeGreaterThanOrEqual(5);
    const notifs = await h.tdb.adminDb.selectFrom('notifications').select(['userId', 'type', 'title', 'link']).where('organizationId', '=', ORG).execute();
    expect(notifs.filter((n) => n.userId === U.subject)).toHaveLength(0); // nobody routes approvals to the person concerned
    expect(notifs.filter((n) => n.userId === U.owner)).toHaveLength(0); // nor to everybody holding a permission
    const hrEscalation = notifs.find((n) => n.userId === U.hr && n.type === 'approval.escalated');
    expect(hrEscalation).toMatchObject({ title: 'Escalated to you: Leave request — Subject One', link: `/approvals?request=${req1}` });
    const digestA = notifs.find((n) => n.userId === U.a && n.type === 'approval.reminder' && n.title.includes('waiting for you') && !n.title.startsWith('Reminder'));
    expect(digestA).toMatchObject({ title: '2 approvals waiting for you', link: '/approvals' });
    expect((await h.tdb.adminDb.selectFrom('notifications').select('body').where('userId', '=', U.a).where('title', '=', '2 approvals waiting for you').executeTakeFirstOrThrow()).body).toBe('Attendance correction: 1 · Leave request: 1');
    await deliverNotifications({ job: fakeJob('DELIVER_NOTIFICATIONS'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    // tokens only for levels still waiting for that recipient: HR (escalated on request 1), A (reminder on request 1), B (escalated on request 2)
    const tokens = await h.tdb.adminDb.selectFrom('approvalEmailTokens').select(['userId', 'requestId', 'action']).execute();
    expect(tokens.filter((t) => t.userId === U.hr && t.requestId === req1).map((t) => t.action).sort()).toEqual(['APPROVE', 'REJECT']);
    expect(tokens.some((t) => t.userId === U.subject)).toBe(false);
    expect(h.emails.some((e) => e.to === `${U.hr}@t.local` && e.subject.includes('Escalated to you'))).toBe(true);
  });

  it('an exception approval (B-99) tells the approvers who were waiting, with no one-click token', async () => {
    await h.tdb.adminDb.insertInto('domainEvents').values({ organizationId: ORG, eventType: 'approval.bypassed', aggregateType: 'approval_request', aggregateId: req2, payload: JSON.stringify({ userIds: [U.b], requestId: req2, entityType: 'ATTENDANCE_CORRECTION', employeeName: 'Subject One', reason: 'Payroll cut-off today' }), actorUserId: U.hr }).execute();
    const tokensBefore = (await h.tdb.adminDb.selectFrom('approvalEmailTokens').select('id').where('userId', '=', U.b).execute()).length;
    await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const notice = await h.tdb.adminDb.selectFrom('notifications').select(['title', 'body', 'link']).where('userId', '=', U.b).where('type', '=', 'approval.bypassed').executeTakeFirstOrThrow();
    expect(notice).toEqual({ title: 'Attendance correction — Subject One was approved as an exception', body: 'No action is needed from you · Reason: Payroll cut-off today', link: `/approvals?request=${req2}` });
    await deliverNotifications({ job: fakeJob('DELIVER_NOTIFICATIONS'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    expect((await h.tdb.adminDb.selectFrom('approvalEmailTokens').select('id').where('userId', '=', U.b).execute()).length).toBe(tokensBefore);
    expect(h.emails.some((e) => e.to === `${U.b}@t.local` && /approved as an exception/i.test(e.subject))).toBe(true);
  });

  it('P0-3 P0-4 escalation never seats the person a request is about — by the submit snapshot or by the CURRENT membership link — whatever the workflow', async () => {
    const a = h.tdb.adminDb;
    const ORG2 = '0f000000-0000-0000-0000-000000000000'; const BRANCH2 = '0f000000-0000-0000-0000-00000000000b'; const EMP2 = '0f000000-0000-0000-0000-0000000000e2';
    const V = { owner: 'f0000000-0000-0000-0000-000000000001', approver: 'f0000000-0000-0000-0000-000000000002', hrLinked: 'f0000000-0000-0000-0000-000000000003', hrOther: 'f0000000-0000-0000-0000-000000000004' };
    await sql`insert into auth.users (id, email) values ${sql.join(Object.values(V).map((id) => sql`(${id}::uuid, ${`${id}@t.local`})`))}`.execute(a);
    await a.insertInto('userProfiles').values(Object.entries(V).map(([k, id]) => ({ id, email: `${id}@t.local`, fullName: k }))).execute();
    await a.insertInto('organizations').values({ id: ORG2, companyCode: 'APR2', legalName: 'B', displayName: 'B', timezone: 'Asia/Muscat' }).execute();
    await a.insertInto('branches').values({ id: BRANCH2, organizationId: ORG2, code: 'HQ', name: 'HQ' }).execute();
    await a.insertInto('employees').values({ id: EMP2, organizationId: ORG2, branchId: BRANCH2, employeeNumber: 'E2', firstName: 'Later', lastName: 'Linked', displayName: 'Later Linked', joiningDate: '2024-01-01', deviceUserId: '2' }).execute();
    await a.insertInto('orgMemberships').values([
      { organizationId: ORG2, userId: V.owner, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true },
      { organizationId: ORG2, userId: V.approver, roleId: '10000000-0000-0000-0000-000000000009', status: 'active', allBranches: true },
      // an HR admin whose login was linked to the subject AFTER the request was filed (subject_user_id is null)
      { organizationId: ORG2, userId: V.hrLinked, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true, employeeId: EMP2 },
      { organizationId: ORG2, userId: V.hrOther, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true },
    ]).execute();
    const req = (await a.insertInto('approvalRequests').values({ organizationId: ORG2, entityType: 'LEAVE', entityId: '0f000000-0000-0000-0000-0000000001a1', branchId: BRANCH2, employeeId: EMP2, subjectUserId: null, requestedBy: V.owner, currentStep: 1, status: 'PENDING', createdAt: at(60) }).returning('id').executeTakeFirstOrThrow()).id;
    const step = (await a.insertInto('approvalSteps').values({ organizationId: ORG2, requestId: req, stepNo: 1, approverType: 'MANAGER', approverUserId: V.approver, mode: 'ANY', requiredCount: 1, status: 'PENDING', activatedAt: at(60), dueAt: at(61), escalateTo: 'HR_ADMIN', escalateAfterHours: 1 }).returning('id').executeTakeFirstOrThrow()).id;
    await a.insertInto('approvalStepActors').values({ organizationId: ORG2, stepId: step, userId: V.approver, resolutionPath: 'primary' }).execute();
    clock = at(62);
    expect(await runApprovalReminders(h.deps, ORG2)).toMatchObject({ escalated: 1 });
    const actors = await a.selectFrom('approvalStepActors').select(['userId', 'resolutionPath']).where('stepId', '=', step).orderBy('userId').execute();
    expect(actors).toEqual([{ userId: V.approver, resolutionPath: 'primary' }, { userId: V.hrOther, resolutionPath: 'escalated' }]);
    const timeline = await a.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', req).orderBy('id').execute();
    expect(timeline.find((t) => t.kind === 'escalated')?.detail).toMatchObject({ target: 'HR_ADMIN', added: [V.hrOther] });
  });
});

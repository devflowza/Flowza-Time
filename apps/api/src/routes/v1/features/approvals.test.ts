/**
 * Approval engine v2 (HR portal Prompt 2): workflows v2, multilevel modes, segregation of duties by the subject, the
 * permission override (Finance B-91), delegations, reassignment, ask-for-info, invalidation / cancellation driven by the
 * leave document, one-click e-mail tokens and the unified inbox (mine / team / all, pending / history).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueApprovalEmailTokens } from '@flowza/database';
import { createApiHarness, domainEvents, isoToday, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 is the line manager's employee record; e5 reports to e4; e6 is an HR admin's own record; e7 a second owner's record
let e4: string; let e5: string; let e6: string; let e7: string;
const lineManager = uuid('c'); const staff5 = uuid('c'); const delegateUser = uuid('c'); const hrLinked = uuid('c'); const ownerLinked = uuid('c');
let leaveTypeId: string;
const HR_ADMIN_ROLE = ROLE.hr_admin;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_approvals_${process.pid}`);
  f = await seedOrg(h.admin, 'appr');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4, { departmentId: f.departmentA });
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4, departmentId: f.departmentA });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  await seedUser(h.admin, lineManager, 'line-manager-appr@test.local', 'Line Manager');
  await seedUser(h.admin, staff5, 'staff5-appr@test.local', 'Staff Five');
  await seedUser(h.admin, delegateUser, 'delegate-appr@test.local', 'Deputy');
  await seedUser(h.admin, hrLinked, 'hr-linked-appr@test.local', 'HR Linked');
  await seedUser(h.admin, ownerLinked, 'owner-linked-appr@test.local', 'Owner Linked');
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, staff5, ROLE.employee, { employeeId: e5 });
  await seedMembership(h.admin, f.orgId, delegateUser, ROLE.employee);
  await seedMembership(h.admin, f.orgId, hrLinked, ROLE.hr_admin, { employeeId: e6 });
  await seedMembership(h.admin, f.orgId, ownerLinked, ROLE.owner, { employeeId: e7 });
  const lt = await h.request('POST', `/api/v1/orgs/${f.orgId}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
  leaveTypeId = lt.body.data.id;
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;

/** Remove every workflow (each scenario configures its own). */
async function clearWorkflows() { await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', f.orgId).execute(); }
async function workflow(entityType: string, steps: unknown[], extra: Record<string, unknown> = {}) {
  const r = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: `${entityType} ${Math.random().toString(36).slice(2, 7)}`, entityType, steps, ...extra } });
  expect(r.status).toBe(201);
  return r.body.data as { id: string };
}
async function actorsOf(requestId: string, stepNo = 1) {
  const step = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', requestId).where('stepNo', '=', stepNo).executeTakeFirstOrThrow();
  return h.admin.selectFrom('approvalStepActors').select(['userId', 'viaDelegationOf', 'decision', 'resolutionPath']).where('stepId', '=', step.id).execute();
}
async function eventsOf(requestId: string) {
  return (await h.admin.selectFrom('approvalRequestEvents').select(['kind', 'actorUserId', 'detail']).where('requestId', '=', requestId).orderBy('id').execute()).map((e) => e.kind);
}
let weekOffset = 3;
/**
 * A fresh future range per leave request so nothing overlaps: starts on a Sunday (the fixture's week is Sun–Thu, weekly
 * off Friday + Saturday), `days` working days long (at most 5).
 */
function nextRange(days = 1) {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay()); // a Sunday, weeks ahead
  const start = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + days - 1);
  return { startDate: start, endDate: d.toISOString().slice(0, 10) };
}
let correctionDay = 1;
function correction(employeeId: string, reason = 'Forgot to punch out') {
  correctionDay += 1;
  const day = `2026-07-${String(correctionDay).padStart(2, '0')}`;
  return { employeeId, attendanceDate: day, type: 'ADD_PUNCH', proposedPunchedAt: `${day}T13:05:00Z`, reason };
}

beforeEach(async () => { await clearWorkflows(); });

describe('workflows v2', () => {
  it('requires approval.manage (or organization.manage), validates the step shape and PATCHes one field without resetting the rest', async () => {
    expect((await h.request('POST', `${base()}/approval-workflows`, { token: f.hrUser, body: { name: 'x', steps: [{ order: 1, approverType: 'MANAGER' }] } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approval-workflows`, { token: lineManager, body: { name: 'x', steps: [{ order: 1, approverType: 'MANAGER' }] } })).status).toBe(403);
    // QUORUM without a count, ROLE without a role or a permission, escalation without a target: 400
    for (const steps of [[{ order: 1, approverType: 'HR_ADMIN', mode: 'QUORUM' }], [{ order: 1, approverType: 'ROLE' }], [{ order: 1, approverType: 'MANAGER', escalateAfterHours: 24 }]]) {
      expect((await h.request('POST', `${base()}/approval-workflows`, { token: f.hrAdmin, body: { name: 'bad', steps } })).status).toBe(400);
    }
    expect((await h.request('POST', `${base()}/approval-workflows`, { token: f.hrAdmin, body: { name: 'bad', steps: [{ order: 1, approverType: 'MANAGER' }], appliesTo: { branchIds: [uuid('b')] } } })).status).toBe(400);
    const created = await h.request('POST', `${base()}/approval-workflows`, { token: f.hrAdmin, body: {
      name: 'Leave tiers', entityType: 'LEAVE', minUnits: 3, appliesTo: { departmentIds: [f.departmentA] },
      steps: [{ order: 1, approverType: 'MANAGER_CHAIN', chainLevel: 2, escalateAfterHours: 48, escalateTo: 'HR_ADMIN' }, { order: 2, approverType: 'ROLE', permission: 'leave.approve', mode: 'QUORUM', requiredCount: 2 }],
    } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ entityType: 'LEAVE', minUnits: 3, allowSelfApproval: false, appliesTo: { departmentIds: [f.departmentA] } });
    expect(created.body.data.steps).toEqual([
      { order: 1, approverType: 'MANAGER_CHAIN', chainLevel: 2, mode: 'ANY', escalateAfterHours: 48, escalateTo: 'HR_ADMIN' },
      { order: 2, approverType: 'ROLE', permission: 'leave.approve', mode: 'QUORUM', requiredCount: 2 },
    ]);
    const patched = await h.request('PATCH', `${base()}/approval-workflows/${created.body.data.id}`, { token: f.hrAdmin, body: { name: 'Leave tiers v2' } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ name: 'Leave tiers v2', minUnits: 3, isDefault: true, status: 'active', appliesTo: { departmentIds: [f.departmentA] } });
    expect(patched.body.data.steps).toHaveLength(2);
    expect((await h.request('GET', `${base()}/approval-workflows`, { token: lineManager })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/approval-workflows/${created.body.data.id}`, { token: f.hrAdmin })).status).toBe(204);
  });
});

describe('submit', () => {
  it('self-service leave with no workflow is PENDING, routed to the leave.approve holders in reach — never the employee, never a stranger manager', async () => {
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(2), reason: 'Trip' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', approvalStatus: 'PENDING', approvalCurrentStep: 1, approvalStepCount: 1 });
    const requestId = r.body.data.approvalRequestId as string;
    const req = await h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ entityType: 'LEAVE', status: 'PENDING', employeeId: e5, subjectUserId: staff5, requestedBy: staff5 });
    expect(Number(req.units)).toBe(2);
    const actors = (await actorsOf(requestId)).map((a) => a.userId);
    // leave.view holders across the organisation + e5's own manager (the line manager has leave.approve but no leave.view)
    expect(actors).toEqual(expect.arrayContaining([f.owner, f.hrAdmin, f.hrUser, f.managerUser, lineManager, hrLinked, ownerLinked]));
    expect(actors).not.toContain(staff5); // the subject
    expect(actors).not.toContain(f.branchManagerB); // branch B does not cover e5 (branch A)
    expect(actors).not.toContain(f.payrollUser); // reads leave organisation-wide but holds no leave.approve
    const pending = (await domainEvents(h.admin, 'approval.pending')).find((e) => e.aggregateId === requestId);
    expect(((pending?.payload as Record<string, unknown>)['userIds'] as string[]).sort()).toEqual([...actors].sort());
  });

  it('HR-recorded leave with no workflow is approved at once (an APPROVED request exists); HR recording their own leave is routed instead', async () => {
    const r = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e5, leaveTypeId, ...nextRange(1) } });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('APPROVED');
    const leave = await h.admin.selectFrom('leaveRecords').select(['approvalRequestId', 'approvedBy']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(leave.approvedBy).toBe(f.hrAdmin);
    const req = await h.admin.selectFrom('approvalRequests').select(['status', 'decidedBy']).where('id', '=', leave.approvalRequestId!).executeTakeFirstOrThrow();
    expect(req).toEqual({ status: 'APPROVED', decidedBy: f.hrAdmin });
    expect(await eventsOf(leave.approvalRequestId!)).toEqual(['auto_approved']);
    // hrLinked is HR AND the employee: their own leave is never self-approved
    const own = await h.request('POST', `${base()}/leave-records`, { token: hrLinked, body: { employeeId: e6, leaveTypeId, ...nextRange(1) } });
    expect(own.status).toBe(201);
    expect(own.body.data.status).toBe('PENDING');
  });

  it('picks the most specific workflow: branch-specific over organisation-wide, the highest tier the units reach', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }], { minUnits: 3 });
    const short = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Short' } });
    const long = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(4), reason: 'Long' } });
    expect(short.body.data.approvalStepCount).toBe(1);
    expect(long.body.data.approvalStepCount).toBe(2);
    expect((await actorsOf(short.body.data.approvalRequestId)).map((a) => a.userId)).toEqual([lineManager]);
    const hr = (await actorsOf(long.body.data.approvalRequestId, 2)).map((a) => a.userId).sort();
    expect(hr).toEqual([f.hrAdmin, hrLinked].sort());
  });
});

describe('decisions', () => {
  it('ALL needs every approver; ANY keeps a rejection non-terminal while somebody can still approve; QUORUM counts approvals', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    const all = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const allId = all.body.data.approvalRequestId as string;
    const first = await h.request('POST', `${base()}/approvals/${allId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE' } });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'PENDING', terminal: false, noop: false });
    // the same actor again: a harmless no-op
    const again = await h.request('POST', `${base()}/approvals/${allId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE' } });
    expect(again.body.data).toMatchObject({ status: 'PENDING', noop: true });
    const second = await h.request('POST', `${base()}/approvals/${allId}/decide`, { token: hrLinked, body: { decision: 'APPROVE' } });
    expect(second.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect(second.body.data.context.correction.status).toBe('APPROVED');

    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ANY' }]);
    const any = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const anyId = any.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${anyId}/decide`, { token: f.hrAdmin, body: { decision: 'REJECT' } })).status).toBe(400); // comment required
    const rejected = await h.request('POST', `${base()}/approvals/${anyId}/decide`, { token: f.hrAdmin, body: { decision: 'REJECT', comment: 'Not convinced' } });
    expect(rejected.body.data).toMatchObject({ status: 'PENDING', terminal: false });
    expect(rejected.body.data.steps[0].actors.find((a: { userId: string }) => a.userId === f.hrAdmin).decision).toBe('REJECTED');
    const approved = await h.request('POST', `${base()}/approvals/${anyId}/decide`, { token: hrLinked, body: { decision: 'APPROVE', comment: 'Checked the camera' } });
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', terminal: true });

    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', permission: 'attendance.approve', mode: 'QUORUM', requiredCount: 2 }]);
    const q = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const qId = q.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${qId}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE' } })).body.data.status).toBe('PENDING');
    expect((await h.request('POST', `${base()}/approvals/${qId}/decide`, { token: hrLinked, body: { decision: 'REJECT', comment: 'No' } })).body.data).toMatchObject({ status: 'PENDING', terminal: false });
    expect((await h.request('POST', `${base()}/approvals/${qId}/decide`, { token: f.owner, body: { decision: 'APPROVE' } })).body.data.status).toBe('APPROVED');
    // a closed request is a conflict, and so is a step that is not the current one
    expect((await h.request('POST', `${base()}/approvals/${qId}/decide`, { token: ownerLinked, body: { decision: 'APPROVE' } })).status).toBe(409);
  });

  it('a manager-only role reads and decides the step routed to them; a stranger can neither read nor decide', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Doctor' } });
    const id = r.body.data.approvalRequestId as string;
    const got = await h.request('GET', `${base()}/approvals/${id}`, { token: lineManager });
    expect(got.status).toBe(200);
    // names come from the organisation's system scope, not from the manager's RLS read of employees / profiles
    expect(got.body.data).toMatchObject({ employeeName: 'Employee 5', requestedByName: 'Staff Five', context: { kind: 'LEAVE', leave: { leaveTypeName: 'Annual Leave', allowanceDays: 30 } }, abilities: { canDecide: true } });
    expect(got.body.data.events.map((e: { kind: string }) => e.kind)).toEqual(['submitted']);
    // the employee who is neither actor, subject, team nor org-wide reader sees nothing
    expect((await h.request('GET', `${base()}/approvals/${id}`, { token: f.employeeUser })).status).toBe(404);
    expect((await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.employeeUser, body: { decision: 'APPROVE' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.payrollUser, body: { decision: 'APPROVE' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.outsider, body: { decision: 'APPROVE' } })).status).toBe(403);
    const step1 = await h.request('POST', `${base()}/approvals/${id}/decide`, { token: lineManager, body: { decision: 'APPROVE', comment: 'Fine by me', stepNo: 1 } });
    expect(step1.body.data).toMatchObject({ status: 'PENDING', currentStep: 2 });
    // an explicit stepNo that is not the current step is refused
    expect((await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', stepNo: 1 } })).status).toBe(409);
    const done = await h.request('POST', `${base()}/approvals/${id}/approve`, { token: f.hrAdmin, body: { comment: 'Approved' } });
    expect(done.body.data.status).toBe('APPROVED');
    const leave = await h.admin.selectFrom('leaveRecords').select(['status', 'approvedBy', 'decisionNote']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(leave).toEqual({ status: 'APPROVED', approvedBy: f.hrAdmin, decisionNote: 'Approved' });
    const decided = (await domainEvents(h.admin, 'approval.decided')).find((e) => e.aggregateId === id);
    expect((decided?.payload as Record<string, unknown>)['userIds']).toEqual([staff5]);
  });

  it('an attendance.approve holder with organisation-wide view may decide any step (logged override); a line manager only for their team', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.owner }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    // e1 is not the line manager's report: no team reach, no organisation-wide key
    expect((await h.request('POST', `${base()}/approvals/${id}/decide`, { token: lineManager, body: { decision: 'APPROVE' } })).status).toBe(403);
    const over = await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE', comment: 'Owner is travelling' } });
    expect(over.body.data.status).toBe('APPROVED');
    expect(await eventsOf(id)).toEqual(['submitted', 'override', 'step_approved', 'approved']);
  });

  it('the person a request is about never decides it, even as HR — only the owner may, and it is logged', async () => {
    const own = await h.request('POST', `${base()}/leave-records`, { token: hrLinked, body: { employeeId: e6, leaveTypeId, ...nextRange(1) } });
    const id = (await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', own.body.data.id).executeTakeFirstOrThrow()).approvalRequestId!;
    const self = await h.request('POST', `${base()}/approvals/${id}/decide`, { token: hrLinked, body: { decision: 'APPROVE' } });
    expect(self.status).toBe(403);
    expect(self.body.message).toMatch(/about you/);
    expect((await h.request('PATCH', `${base()}/leave-records/${own.body.data.id}`, { token: hrLinked, body: { status: 'APPROVED' } })).status).toBe(403);
    // the owner is the one exception, and the bypass is on the timeline
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }]);
    const ownerLeave = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e7, leaveTypeId, ...nextRange(1) } });
    expect(ownerLeave.body.data.status).toBe('PENDING');
    const oid = (await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', ownerLeave.body.data.id).executeTakeFirstOrThrow()).approvalRequestId!;
    const bypass = await h.request('POST', `${base()}/approvals/${oid}/decide`, { token: ownerLinked, body: { decision: 'APPROVE', comment: 'Owner decides' } });
    expect(bypass.status).toBe(200);
    expect(await eventsOf(oid)).toEqual(expect.arrayContaining(['sod_owner_bypass', 'approved']));
  });

  it('concurrent approvals apply once', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    const results = await Promise.all([1, 2, 3].map(() => h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE' } })));
    // one approval; the others either see the closed request (409) or their own recorded decision (a no-op)
    expect(results.filter((x) => x.status === 200 && x.body.data.noop === false)).toHaveLength(1);
    expect(results.every((x) => x.status === 200 || x.status === 409)).toBe(true);
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).filter((j) => j.payload['correctionId'] === r.body.data.id)).toHaveLength(1);
  });
});

describe('delegations', () => {
  it('approval.delegate for one\'s own approvals; approval.manage on behalf of others; the delegate decides in the approver\'s seat', async () => {
    expect((await h.request('POST', `${base()}/approval-delegations`, { token: staff5, body: { delegateUserId: delegateUser, startsOn: isoToday(-1), endsOn: isoToday(10) } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approval-delegations`, { token: lineManager, body: { delegateUserId: lineManager, startsOn: isoToday(-1), endsOn: isoToday(10) } })).status).toBe(400);
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: lineManager, body: { delegateUserId: delegateUser, entityTypes: ['LEAVE'], startsOn: isoToday(-1), endsOn: isoToday(10), reason: 'Annual leave' } });
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ delegatorUserId: lineManager, delegateUserId: delegateUser, delegateName: 'Deputy', entityTypes: ['LEAVE'], isActive: true });
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Wedding' } });
    const id = r.body.data.approvalRequestId as string;
    expect(await actorsOf(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: lineManager, viaDelegationOf: null }),
      expect.objectContaining({ userId: delegateUser, viaDelegationOf: lineManager, resolutionPath: 'delegate' }),
    ]));
    const inbox = await h.request('GET', `${base()}/approvals`, { token: delegateUser });
    expect(inbox.body.data.map((x: { id: string }) => x.id)).toContain(id);
    const decided = await h.request('POST', `${base()}/approvals/${id}/decide`, { token: delegateUser, body: { decision: 'APPROVE' } });
    expect(decided.body.data.status).toBe('APPROVED');
    // the delegation does not cover corrections
    const mine = await h.request('GET', `${base()}/approval-delegations`, { token: delegateUser });
    expect(mine.body.data).toHaveLength(1);
    expect((await h.request('GET', `${base()}/approval-delegations?scope=all`, { token: lineManager })).status).toBe(403);
    // HR delegates on the line manager's behalf, then the delegator revokes
    const onBehalf = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegatorUserId: lineManager, delegateUserId: f.hrUser, startsOn: isoToday(20), endsOn: isoToday(25) } });
    expect(onBehalf.status).toBe(201);
    expect((await h.request('GET', `${base()}/approval-delegations?scope=all`, { token: f.hrAdmin })).body.data.length).toBeGreaterThanOrEqual(2);
    expect((await h.request('DELETE', `${base()}/approval-delegations/${onBehalf.body.data.id}`, { token: staff5 })).status).toBe(404); // not even visible
    expect((await h.request('DELETE', `${base()}/approval-delegations/${onBehalf.body.data.id}`, { token: lineManager })).status).toBe(204);
    expect((await h.request('DELETE', `${base()}/approval-delegations/${d.body.data.id}`, { token: lineManager })).status).toBe(204);
  });

  it('an absent manager (approved leave today) is replaced by their delegate; without one, by the secondary manager or HR', async () => {
    const away = await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: e4, branchId: f.branchA, leaveTypeId, startDate: isoToday(-1), endDate: isoToday(1), status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const noDelegate = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'While the manager is away' } });
    const step = await h.admin.selectFrom('approvalSteps').select(['resolutionPath', 'resolutionReason']).where('requestId', '=', noDelegate.body.data.approvalRequestId).executeTakeFirstOrThrow();
    expect(step.resolutionPath).toBe('hr_admin');
    expect(step.resolutionReason).toMatch(/on approved leave/);
    await h.admin.deleteFrom('leaveRecords').where('id', '=', away.id).execute();
  });
});

describe('reassign, ask for info, cancel', () => {
  it('approval.manage reassigns the current level; the new approver decides', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.owner }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: lineManager, body: { userId: f.payrollUser, reason: 'Owner away' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.hrAdmin, body: { userId: f.e1, reason: 'Owner away' } })).status).toBe(400);
    const moved = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.hrAdmin, body: { userId: f.payrollUser, reason: 'Owner away' } });
    expect(moved.status).toBe(200);
    expect(moved.body.data.steps[0]).toMatchObject({ approverUserId: f.payrollUser, resolutionPath: 'reassigned' });
    const done = await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.payrollUser, body: { decision: 'APPROVE' } });
    expect(done.body.data.status).toBe('APPROVED');
    expect(await eventsOf(id)).toEqual(['submitted', 'reassigned', 'step_approved', 'approved']);
  });

  it('asks the requester for information and records the answer on the timeline', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: f.employeeUser, body: { comment: 'Why?' } })).status).toBe(403);
    const asked = await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: f.hrAdmin, body: { comment: 'Which door did you use?' } });
    expect(asked.status).toBe(200);
    expect(asked.body.data.infoRequestedAt).not.toBeNull();
    expect((await h.request('POST', `${base()}/approvals/${id}/answer-info`, { token: f.hrAdmin, body: { comment: 'n/a' } })).status).toBe(403);
    const answered = await h.request('POST', `${base()}/approvals/${id}/answer-info`, { token: f.hrUser, body: { comment: 'The side gate — its reader was offline' } });
    expect(answered.body.data.infoRequestedAt).toBeNull();
    expect(answered.body.data.events.map((e: { kind: string }) => e.kind)).toEqual(['submitted', 'info_requested', 'info_answered']);
    const infoEvent = (await domainEvents(h.admin, 'approval.info_requested')).find((e) => e.aggregateId === id);
    expect((infoEvent?.payload as Record<string, unknown>)['userIds']).toEqual(expect.arrayContaining([f.hrUser]));
  });

  it('editing a pending leave invalidates its request and resubmits; withdrawing it cancels the request', async () => {
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(2), reason: 'Moving house' } });
    const firstId = r.body.data.approvalRequestId as string;
    const edited = await h.request('PATCH', `${base()}/leave-records/${r.body.data.id}`, { token: f.hrAdmin, body: { endDate: r.body.data.startDate } });
    expect(edited.status).toBe(200);
    expect(edited.body.data.status).toBe('PENDING');
    const first = await h.admin.selectFrom('approvalRequests').select(['status', 'invalidationReason']).where('id', '=', firstId).executeTakeFirstOrThrow();
    expect(first.status).toBe('INVALIDATED');
    const leave = await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(leave.approvalRequestId).not.toBe(firstId);
    const second = await h.admin.selectFrom('approvalRequests').select(['status', 'requestedBy', 'units']).where('id', '=', leave.approvalRequestId!).executeTakeFirstOrThrow();
    expect(second).toMatchObject({ status: 'PENDING', requestedBy: staff5 });
    expect(Number(second.units)).toBe(1);
    const withdrawn = await h.request('POST', `${base()}/me/leave/${r.body.data.id}/cancel`, { token: staff5 });
    expect(withdrawn.body.data).toMatchObject({ status: 'CANCELLED', approvalStatus: 'CANCELLED' });
    expect(await eventsOf(leave.approvalRequestId!)).toEqual(['submitted', 'cancelled']);
  });

  it('the requester withdraws through the engine; the subject of an HR filing cannot', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    expect((await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: f.employeeUser, body: {} })).status).toBe(403);
    const c = await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: f.hrUser, body: { reason: 'Filed twice' } });
    expect(c.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Filed twice' });
    // the correction follows
    expect((await h.admin.selectFrom('attendanceCorrections').select('status').where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
  });
});

describe('one-click e-mail tokens', () => {
  it('are single-use, bound to the recipient, expire, and still obey every decision rule', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = r.body.data.approvalRequestId as string;
    const step = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', id).executeTakeFirstOrThrow();
    const pair = await h.admin.transaction().execute((trx) => issueApprovalEmailTokens(trx, { organizationId: f.orgId, requestId: id, stepId: step.id, userId: f.hrAdmin }));
    const stored = await h.admin.selectFrom('approvalEmailTokens').select('tokenHash').where('requestId', '=', id).execute();
    expect(stored.map((t) => t.tokenHash)).not.toContain(pair.approve); // only the hash is stored
    // somebody else's link is worthless; a mismatched action is refused
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.owner, body: { token: pair.approve, action: 'APPROVE' } })).status).toBe(404);
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'REJECT' } })).status).toBe(400);
    const ok = await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'APPROVE' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.approve, action: 'APPROVE' } })).status).toBe(409);
    // the sibling (reject) link was spent with it
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: pair.reject, action: 'REJECT' } })).status).toBe(409);
    // an expired link
    const r2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const step2 = await h.admin.selectFrom('approvalSteps').select('id').where('requestId', '=', r2.body.data.approvalRequestId).executeTakeFirstOrThrow();
    const old = await h.admin.transaction().execute((trx) => issueApprovalEmailTokens(trx, { organizationId: f.orgId, requestId: r2.body.data.approvalRequestId, stepId: step2.id, userId: f.hrAdmin }, { now: new Date(Date.now() - 8 * 86_400_000) }));
    expect((await h.request('POST', `${base()}/approvals/email-action`, { token: f.hrAdmin, body: { token: old.approve, action: 'APPROVE' } })).status).toBe(409);
    expect((await h.admin.selectFrom('approvalRequests').select('status').where('id', '=', r2.body.data.approvalRequestId).executeTakeFirstOrThrow()).status).toBe('PENDING');
  });
});

describe('inbox', () => {
  it('scopes: mine (my queue), team (my direct reports — needs a team key), all (needs an organisation-wide key); history lists what I decided', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Team scope' } });
    const id = r.body.data.approvalRequestId as string;
    // the line manager is not an approver of this one, but e5 is their report
    const mine = await h.request('GET', `${base()}/approvals?scope=mine`, { token: lineManager });
    expect(mine.body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    const team = await h.request('GET', `${base()}/approvals?scope=team&entityType=LEAVE`, { token: lineManager });
    expect(team.status).toBe(200);
    expect(team.body.data.map((x: { id: string }) => x.id)).toContain(id);
    expect(team.body.data.every((x: { employeeId: string }) => x.employeeId === e5)).toBe(true);
    expect((await h.request('GET', `${base()}/approvals?scope=all`, { token: lineManager })).status).toBe(403);
    expect((await h.request('GET', `${base()}/approvals?scope=team`, { token: f.employeeUser })).status).toBe(403);
    const all = await h.request('GET', `${base()}/approvals?scope=all&entityType=LEAVE`, { token: f.hrUser });
    expect(all.body.data.map((x: { id: string }) => x.id)).toContain(id);
    const hr = await h.request('GET', `${base()}/approvals`, { token: f.hrAdmin });
    expect(hr.body.data.map((x: { id: string }) => x.id)).toContain(id);
    await h.request('POST', `${base()}/approvals/${id}/decide`, { token: f.hrAdmin, body: { decision: 'APPROVE' } });
    const history = await h.request('GET', `${base()}/approvals/history`, { token: f.hrAdmin });
    expect(history.body.data.map((x: { id: string }) => x.id)).toContain(id);
    expect((await h.request('GET', `${base()}/approvals?scope=mine`, { token: f.hrAdmin })).body.data.map((x: { id: string }) => x.id)).not.toContain(id);
    // my own requests (portal)
    const myRequests = await h.request('GET', `${base()}/approvals/mine`, { token: staff5 });
    expect(myRequests.body.data.map((x: { id: string }) => x.id)).toContain(id);
    const detail = await h.request('GET', `${base()}/approvals/${id}`, { token: staff5 });
    expect(detail.status).toBe(200);
    expect(detail.body.data.events.map((e: { kind: string }) => e.kind)).toEqual(['submitted', 'step_approved', 'approved']);
  });
});

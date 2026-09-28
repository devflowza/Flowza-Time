/**
 * Approval engine v2 — regression tests for the adversarial review (docs/hr-portal/reviews/02-approval-engine-v2-review.md).
 * Every test is named after the defect it pins. Who may decide (one seat per call, overrides must name the level, line
 * managers never override), self-approval, segregation of duties on the CURRENT membership link, reassignment on
 * QUORUM / ALL, stepNo everywhere, /me approvals, the single-owner organisation, the organisation's date for delegations,
 * info requests, withdrawal, resolution reasons, workflow validation, canonical applies-to and the dashboard count.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { auditRows, createApiHarness, isoToday, PLAN_TRIAL, queueJobs, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4: the line manager's record; e5 reports to e4; e6: an HR admin's own record; e7: a second owner's record; e20: no login yet
let e4: string; let e5: string; let e6: string; let e7: string; let e20: string;
const lineManager = uuid('c'); const staff5 = uuid('c'); const deputy = uuid('c'); const hrLinked = uuid('c'); const ownerLinked = uuid('c'); const hr20 = uuid('c');
let leaveTypeId: string;
const HR_ADMIN_ROLE = ROLE.hr_admin;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_approvals_review_${process.pid}`);
  f = await seedOrg(h.admin, 'arev');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4, { departmentId: f.departmentA });
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4, departmentId: f.departmentA });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  e20 = await seedEmployee(h.admin, f.orgId, f.branchA, 20);
  await seedUser(h.admin, lineManager, 'line-manager-arev@test.local', 'Line Manager');
  await seedUser(h.admin, staff5, 'staff5-arev@test.local', 'Staff Five');
  await seedUser(h.admin, deputy, 'deputy-arev@test.local', 'Deputy');
  await seedUser(h.admin, hrLinked, 'hr-linked-arev@test.local', 'HR Linked');
  await seedUser(h.admin, ownerLinked, 'owner-linked-arev@test.local', 'Owner Linked');
  await seedUser(h.admin, hr20, 'hr20-arev@test.local', 'HR Twenty');
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, staff5, ROLE.employee, { employeeId: e5 });
  await seedMembership(h.admin, f.orgId, deputy, ROLE.employee);
  await seedMembership(h.admin, f.orgId, hrLinked, ROLE.hr_admin, { employeeId: e6 });
  await seedMembership(h.admin, f.orgId, ownerLinked, ROLE.owner, { employeeId: e7 });
  await seedMembership(h.admin, f.orgId, hr20, ROLE.hr_admin);
  const lt = await h.request('POST', `/api/v1/orgs/${f.orgId}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
  leaveTypeId = lt.body.data.id;
});
afterAll(async () => { await h?.close(); });
const base = (orgId = f.orgId) => `/api/v1/orgs/${orgId}`;

async function clearWorkflows(orgId = f.orgId) { await h.admin.deleteFrom('approvalWorkflows').where('organizationId', '=', orgId).execute(); }
async function workflow(entityType: string, steps: unknown[], extra: Record<string, unknown> = {}, orgId = f.orgId, token = f.owner) {
  const r = await h.request('POST', `${base(orgId)}/approval-workflows`, { token, body: { name: `${entityType} ${Math.random().toString(36).slice(2, 7)}`, entityType, steps, ...extra } });
  expect(r.status).toBe(201);
  return r.body.data as { id: string; allowSelfApproval: boolean; appliesTo: Record<string, string[]> };
}
async function stepOf(requestId: string, stepNo = 1) {
  return h.admin.selectFrom('approvalSteps').selectAll().where('requestId', '=', requestId).where('stepNo', '=', stepNo).executeTakeFirstOrThrow();
}
async function actorsOf(requestId: string, stepNo = 1) {
  const step = await stepOf(requestId, stepNo);
  return h.admin.selectFrom('approvalStepActors').select(['userId', 'viaDelegationOf', 'onBehalfOfUserId', 'decision', 'resolutionPath']).where('stepId', '=', step.id).execute();
}
async function eventsOf(requestId: string) {
  return (await h.admin.selectFrom('approvalRequestEvents').select('kind').where('requestId', '=', requestId).orderBy('id').execute()).map((e) => e.kind);
}
async function requestRow(requestId: string) {
  return h.admin.selectFrom('approvalRequests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
}
let weekOffset = 3;
/** A fresh future range per leave request (a Sunday, weeks ahead; the fixture's weekly off is Friday + Saturday). */
function nextRange(days = 1) {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay());
  const start = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + days - 1);
  return { startDate: start, endDate: d.toISOString().slice(0, 10) };
}
let correctionDay = 1;
/** A correction on a fresh past day per call (from 2 June 2026 on, rolling into the following months — never an invalid date). */
function correction(employeeId: string, reason = 'Forgot to punch out') {
  correctionDay += 1;
  const day = new Date(Date.UTC(2026, 5, correctionDay)).toISOString().slice(0, 10);
  return { employeeId, attendanceDate: day, type: 'ADD_PUNCH', proposedPunchedAt: `${day}T13:05:00Z`, reason };
}
const decide = (requestId: string, token: string, body: Record<string, unknown>, orgId = f.orgId) => h.request('POST', `${base(orgId)}/approvals/${requestId}/decide`, { token, body });
const detail = (requestId: string, token: string, orgId = f.orgId) => h.request('GET', `${base(orgId)}/approvals/${requestId}`, { token });

beforeEach(async () => { await clearWorkflows(); });

describe('P0-1 / P2-13 — who may decide: one seat per call', () => {
  it('P0-1 manager cannot decide the HR level', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Doctor' } });
    const id = r.body.data.approvalRequestId as string;
    const l1 = await decide(id, lineManager, { decision: 'APPROVE', stepNo: 1 });
    expect(l1.body.data).toMatchObject({ status: 'PENDING', currentStep: 2 });
    // the line manager still reads the request (their report's), but may not decide the HR level
    const seen = await detail(id, lineManager);
    expect(seen.status).toBe(200);
    expect(seen.body.data.abilities).toMatchObject({ canDecide: false, decideVia: null });
    expect((await decide(id, lineManager, { decision: 'APPROVE', stepNo: 2 })).status).toBe(403);
    expect((await h.request('POST', `${base()}/approvals/${id}/approve`, { token: lineManager, body: { stepNo: 2 } })).status).toBe(403);
    expect(await requestRow(id)).toMatchObject({ status: 'PENDING', currentStep: 2 });
    expect((await h.admin.selectFrom('leaveRecords').select('status').where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).status).toBe('PENDING');

    // the same for a correction HR filed for the line manager's report
    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'HR_ADMIN' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(e5) });
    const cid = c.body.data.approvalRequestId as string;
    expect((await decide(cid, lineManager, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING', currentStep: 2 });
    expect((await decide(cid, lineManager, { decision: 'APPROVE', stepNo: 2 })).status).toBe(403);
    expect((await h.admin.selectFrom('attendanceCorrections').select('status').where('id', '=', c.body.data.id).executeTakeFirstOrThrow()).status).toBe('PENDING');
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).filter((j) => j.payload['correctionId'] === c.body.data.id)).toHaveLength(0);
  });

  it('P0-1 an organisation-wide HR override fills one seat in ALL mode and the level stays pending', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    const seats = (await actorsOf(id)).map((a) => a.userId).sort();
    expect(seats).toEqual([f.hrAdmin, hrLinked, hr20].sort());
    // the owner is not seated: an override, which says which seat it fills
    const owner = await detail(id, f.owner);
    expect(owner.body.data.abilities).toMatchObject({ canDecide: true, decideVia: 'override' });
    expect((await detail(id, f.hrAdmin)).body.data.abilities).toMatchObject({ canDecide: true, decideVia: 'actor' });
    const over = await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: f.hrAdmin, comment: 'For the HR admin' });
    expect(over.status).toBe(200);
    expect(over.body.data).toMatchObject({ status: 'PENDING', terminal: false, currentStep: 1 });
    expect(await actorsOf(id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: f.owner, decision: 'APPROVED', resolutionPath: 'override', onBehalfOfUserId: f.hrAdmin }),
      expect.objectContaining({ userId: f.hrAdmin, decision: 'SKIPPED' }),
      expect.objectContaining({ userId: hrLinked, decision: 'PENDING' }),
      expect.objectContaining({ userId: hr20, decision: 'PENDING' }),
    ]));
    expect(await eventsOf(id)).toEqual(['submitted', 'override', 'approval_recorded']);
    expect((await auditRows(h.admin, 'approval.override')).some((a) => (a as { entityId?: string }).entityId === id)).toBe(true);
    // a seat is never filled twice: naming a seat that is no longer pending is refused
    expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: f.hrAdmin })).body.data).toMatchObject({ noop: true });
    expect((await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('PENDING');
    const done = await decide(id, hr20, { decision: 'APPROVE', stepNo: 1 });
    expect(done.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
  });

  it('P0-1 an override without stepNo is refused with a clear message', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.owner }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    // decide: the level is required
    const noStep = await decide(id, f.hrAdmin, { decision: 'APPROVE' });
    expect(noStep.status).toBe(400);
    // the legacy alias without a level decides only a seat the caller holds — the HR admin holds none here
    const alias = await h.request('POST', `${base()}/approvals/${id}/approve`, { token: f.hrAdmin, body: {} });
    expect(alias.status).toBe(400);
    expect(alias.body.message).toMatch(/Name the level you are deciding/);
    // bulk: every line names its level
    expect((await h.request('POST', `${base()}/approvals/bulk-decide`, { token: f.hrAdmin, body: { items: [{ requestId: id }], decision: 'APPROVE' } })).status).toBe(400);
    expect((await requestRow(id)).status).toBe('PENDING');
    // naming the level makes it an explicit (and logged) override
    const named = await h.request('POST', `${base()}/approvals/${id}/approve`, { token: f.hrAdmin, body: { stepNo: 1 } });
    expect(named.body.data.status).toBe('APPROVED');
    // the seat holder themselves needs no level on the alias (their own seat)
    const c2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    expect((await h.request('POST', `${base()}/approvals/${c2.body.data.approvalRequestId}/approve`, { token: f.owner, body: {} })).body.data.status).toBe('APPROVED');
  });

  it('P0-1 an ANY-mode override settles the level', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ANY' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    const over = await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1 });
    expect(over.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect(await eventsOf(id)).toEqual(['submitted', 'override', 'step_approved', 'approved']);
    expect((await h.admin.selectFrom('attendanceCorrections').select('status').where('id', '=', c.body.data.id).executeTakeFirstOrThrow()).status).toBe('APPROVED');
  });

  it('P2-13 a QUORUM override counts one approval; a branch-scoped approver never overrides outside their branch', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'QUORUM', requiredCount: 2 }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    // three HR admins wait: the override names the seat it fills (it used to take a random one — the follow-up below)
    expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: f.hrAdmin })).body.data).toMatchObject({ status: 'PENDING', terminal: false });
    // branch B's manager holds attendance.approve + attendance.view, but e1 is in branch A
    expect((await detail(id, f.branchManagerB)).status).toBe(404);
    expect((await decide(id, f.branchManagerB, { decision: 'APPROVE', stepNo: 1 })).status).toBe(403);
    // hrLinked still holds their own seat after the override named the HR admin's: their approval is the second one
    expect((await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
  });
});

describe('P2-13 follow-up — an override names the seat it fills; seat order is deterministic', () => {
  const hrSeats = () => [f.hrAdmin, hrLinked, hr20].sort();

  it('P2-13 an unnamed override on an ALL or QUORUM level with several waiting seats is refused (choose the approver), and nothing is written', async () => {
    for (const level of [{ mode: 'QUORUM', requiredCount: 2 }, { mode: 'ALL' }] as const) {
      await clearWorkflows();
      await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, ...level }]);
      const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
      const id = c.body.data.approvalRequestId as string;
      // the DTO says a seat must be chosen, and lists the waiting seats in seat order with their names
      const seen = await detail(id, f.owner);
      expect(seen.body.data.abilities).toMatchObject({ canDecide: true, decideVia: 'override', mustChooseSeat: true });
      expect(seen.body.data.steps[0].pendingSeats.map((x: { userId: string }) => x.userId)).toEqual(hrSeats());
      expect(seen.body.data.steps[0].pendingSeats.every((x: { userName: string | null }) => !!x.userName)).toBe(true);
      // a seated approver decides their own seat: no choice to make
      expect((await detail(id, hrLinked)).body.data.abilities).toMatchObject({ decideVia: 'actor', mustChooseSeat: false });
      const unnamed = await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1 });
      expect(unnamed.status).toBe(400);
      expect(unnamed.body.message).toMatch(/^Choose which approver you are deciding for/);
      expect(JSON.stringify(unnamed.body)).toContain('onBehalfOfUserId');
      // nothing was decided, nothing was logged
      expect((await actorsOf(id)).map((a) => [a.userId, a.decision]).sort()).toEqual(hrSeats().map((u) => [u, 'PENDING']));
      expect(await eventsOf(id)).toEqual(['submitted']);
      // naming a seat that is not waiting is refused too; naming a waiting one fills exactly that seat
      expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: f.hrUser })).status).toBe(400);
      const named = await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: hr20 });
      expect(named.body.data).toMatchObject({ status: 'PENDING', terminal: false });
      expect((await actorsOf(id)).find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: hr20, decision: 'APPROVED', resolutionPath: 'override' });
      expect((await detail(id, f.hrAdmin)).body.data.steps[0].pendingSeats.map((x: { userId: string }) => x.userId)).toEqual(hrSeats().filter((u) => u !== hr20));
    }
  });

  it('P2-13 an escalated approver names the seat too when several wait', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    const step = await stepOf(id);
    await h.admin.insertInto('approvalStepActors').values({ organizationId: f.orgId, stepId: step.id, userId: f.payrollUser, resolutionPath: 'escalated' }).execute();
    expect((await detail(id, f.payrollUser)).body.data.abilities).toMatchObject({ decideVia: 'escalated', mustChooseSeat: true });
    const unnamed = await decide(id, f.payrollUser, { decision: 'APPROVE', stepNo: 1 });
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.message).toMatch(/^Choose which approver you are deciding for/);
    expect((await decide(id, f.payrollUser, { decision: 'APPROVE', stepNo: 1, onBehalfOfUserId: hrLinked })).body.data).toMatchObject({ status: 'PENDING' });
    expect((await actorsOf(id)).find((a) => a.userId === f.payrollUser)).toMatchObject({ onBehalfOfUserId: hrLinked, decision: 'APPROVED' });
  });

  it('P2-13 a stand-in seated on the primary\'s seat (the secondary manager) is one seat: an override on such a level needs no name', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER', mode: 'ALL' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Stand-in' } });
    const id = r.body.data.approvalRequestId as string;
    // the portal seats the secondary manager ON the primary's seat: via_delegation_of = primary, path `secondary`
    await h.admin.insertInto('approvalStepActors').values({ organizationId: f.orgId, stepId: (await stepOf(id)).id, userId: deputy, viaDelegationOf: lineManager, resolutionPath: 'secondary' }).execute();
    const seen = await detail(id, f.owner);
    expect(seen.body.data.steps[0].pendingSeats.map((x: { userId: string }) => x.userId)).toEqual([lineManager]);
    expect(seen.body.data.abilities).toMatchObject({ decideVia: 'override', mustChooseSeat: false });
    const over = await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1 });
    expect(over.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect((await actorsOf(id)).find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: lineManager, decision: 'APPROVED' });
    // both rows of that one seat are closed
    expect((await actorsOf(id)).filter((a) => a.userId === lineManager || a.userId === deputy).map((a) => a.decision)).toEqual(['SKIPPED', 'SKIPPED']);
  });

  it('P2-13 bulk lines name the seat too: a line that needs one and lacks it fails on its own, the others go through', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'QUORUM', requiredCount: 2 }]);
    const a = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
    const b = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
    const bulk = await h.request('POST', `${base()}/approvals/bulk-decide`, { token: f.owner, body: { items: [{ requestId: a, stepNo: 1 }, { requestId: b, stepNo: 1, onBehalfOfUserId: f.hrAdmin }], decision: 'APPROVE' } });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data).toMatchObject({ succeeded: 1, failed: 1 });
    expect(bulk.body.data.results[0]).toMatchObject({ requestId: a, ok: false, code: 'VALIDATION_ERROR' });
    expect(bulk.body.data.results[0].message).toMatch(/^Choose which approver you are deciding for/);
    expect(bulk.body.data.results[1]).toMatchObject({ requestId: b, ok: true, status: 'PENDING' });
    expect(await eventsOf(a)).toEqual(['submitted']);
    expect((await actorsOf(b)).find((x) => x.userId === f.owner)).toMatchObject({ onBehalfOfUserId: f.hrAdmin, decision: 'APPROVED' });
  });

  it('P2-13 with ANY, or a single waiting seat, the unnamed override takes the first seat in seat order — the same one every time', async () => {
    // ANY: approving settles whichever seat it fills; a rejection fills the first seat in seat order and leaves the others
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ANY' }]);
    const settle = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
    expect((await detail(settle, f.owner)).body.data.abilities).toMatchObject({ decideVia: 'override', mustChooseSeat: false });
    expect((await decide(settle, f.owner, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect((await actorsOf(settle)).find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: hrSeats()[0] });
    for (let i = 0; i < 5; i += 1) {
      const id = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
      const rejected = await decide(id, f.owner, { decision: 'REJECT', stepNo: 1, comment: 'Not this one' });
      expect(rejected.body.data).toMatchObject({ status: 'PENDING', terminal: false });
      expect((await actorsOf(id)).find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: hrSeats()[0], decision: 'REJECTED' });
      expect((await detail(id, f.hrAdmin)).body.data.steps[0].pendingSeats.map((x: { userId: string }) => x.userId)).toEqual(hrSeats().slice(1));
    }
    // ALL with one seat left: the override fills that seat, named or not
    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    const all = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
    const [first, second, last] = hrSeats();
    expect((await decide(all, first!, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('PENDING');
    expect((await decide(all, second!, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('PENDING');
    expect((await detail(all, f.owner)).body.data.abilities).toMatchObject({ decideVia: 'override', mustChooseSeat: false });
    const lastSeat = await decide(all, f.owner, { decision: 'APPROVE', stepNo: 1 });
    expect(lastSeat.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect((await actorsOf(all)).find((a) => a.userId === f.owner)).toMatchObject({ onBehalfOfUserId: last });
  });

  it('P2-13 every request lists a level\'s actors and waiting seats in the same order (seats written together share their creation time)', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    for (let i = 0; i < 4; i += 1) {
      const id = (await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) })).body.data.approvalRequestId as string;
      const step = (await detail(id, f.owner)).body.data.steps[0] as { actors: Array<{ userId: string }>; pendingSeats: Array<{ userId: string }> };
      expect(step.actors.map((a) => a.userId)).toEqual(hrSeats());
      expect(step.pendingSeats.map((x) => x.userId)).toEqual(hrSeats());
    }
  });
});

describe('P0-3 — self-approval is not configurable', () => {
  it('P0-3 a workflow cannot switch self-approval on, and an HR admin never approves their own request', async () => {
    const wf = await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }], { allowSelfApproval: true });
    expect(wf.allowSelfApproval).toBe(false);
    expect((await h.admin.selectFrom('approvalWorkflows').select('allowSelfApproval').where('id', '=', wf.id).executeTakeFirstOrThrow()).allowSelfApproval).toBe(false);
    // nothing can turn it back on, not even a direct write
    await expect(h.admin.updateTable('approvalWorkflows').set({ allowSelfApproval: true }).where('id', '=', wf.id).execute()).rejects.toThrow(/approval_workflows_no_self_approval/);
    const own = await h.request('POST', `${base()}/leave-records`, { token: hrLinked, body: { employeeId: e6, leaveTypeId, ...nextRange(1) } });
    expect(own.body.data.status).toBe('PENDING');
    const id = (await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', own.body.data.id).executeTakeFirstOrThrow()).approvalRequestId!;
    expect((await actorsOf(id)).map((a) => a.userId)).not.toContain(hrLinked);
    expect((await detail(id, hrLinked)).body.data.abilities.canDecide).toBe(false);
    const self = await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 });
    expect(self.status).toBe(403);
    expect(self.body.message).toMatch(/about you/);
    expect(await eventsOf(id)).toEqual(['submitted']);
  });
});

describe('P0-4 — segregation of duties on the current membership link', () => {
  it('P0-4 a login linked to the subject after submit can neither decide, bypass, ask about, withdraw nor be handed the request', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }]);
    const r = await h.request('POST', `${base()}/leave-records`, { token: f.hrAdmin, body: { employeeId: e20, leaveTypeId, ...nextRange(1) } });
    expect(r.body.data.status).toBe('PENDING');
    const id = (await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).approvalRequestId!;
    expect((await requestRow(id)).subjectUserId).toBeNull(); // e20 had no login at submit
    expect((await actorsOf(id)).map((a) => a.userId)).toContain(hr20);
    // the organisation links hr20's login to e20 afterwards (an accepted invitation does exactly this)
    await h.admin.updateTable('orgMemberships').set({ employeeId: e20 }).where('organizationId', '=', f.orgId).where('userId', '=', hr20).execute();
    try {
      const seen = await detail(id, hr20);
      expect(seen.body.data.abilities).toMatchObject({ canDecide: false, canBypass: false, canRequestInfo: false, canCancel: false, canReassign: false });
      const self = await decide(id, hr20, { decision: 'APPROVE', stepNo: 1 });
      expect(self.status).toBe(403);
      expect(self.body.message).toMatch(/about you/);
      expect((await h.request('POST', `${base()}/approvals/${id}/bypass`, { token: hr20, body: { reason: 'Mine anyway' } })).status).toBe(403);
      expect((await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: hr20, body: { comment: 'Anything?' } })).status).toBe(403);
      expect((await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: hr20, body: { reason: 'Not needed' } })).status).toBe(403);
      expect((await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: hr20, body: { userId: hrLinked, reason: 'Move it' } })).status).toBe(403);
      // nobody may hand it to them either
      const handed = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: hrLinked, body: { userId: hr20, reason: 'Cover' } });
      expect(handed.status).toBe(400);
      expect(handed.body.message).toMatch(/is about cannot be its approver/);
      expect(await requestRow(id)).toMatchObject({ status: 'PENDING' });
      expect(await eventsOf(id)).toEqual(['submitted']);
    } finally {
      await h.admin.updateTable('orgMemberships').set({ employeeId: null }).where('organizationId', '=', f.orgId).where('userId', '=', hr20).execute();
    }
  });
});

describe('P1-1 / P2-2 — reassignment', () => {
  it('P1-1 reassigning a QUORUM level never turns an approval into a rejection', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'HR_ADMIN', mode: 'QUORUM', requiredCount: 2 }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    expect(await actorsOf(id)).toHaveLength(3);
    const moved = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.owner, body: { userId: f.payrollUser, reason: 'HR away' } });
    expect(moved.status).toBe(200);
    expect(moved.body.data.steps[0]).toMatchObject({ requiredCount: 1, resolutionPath: 'reassigned', approverUserId: f.payrollUser });
    const done = await decide(id, f.payrollUser, { decision: 'APPROVE', comment: 'Looks right', stepNo: 1 });
    expect(done.body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect(await eventsOf(id)).toEqual(['submitted', 'reassigned', 'step_approved', 'approved']);
    const row = await h.admin.selectFrom('attendanceCorrections').select(['status', 'rejectionReason']).where('id', '=', c.body.data.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'APPROVED', rejectionReason: null });

    // an approval given before the reassignment still counts: QUORUM 2 with one approval needs the reassignee only
    const c2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id2 = c2.body.data.approvalRequestId as string;
    expect((await decide(id2, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('PENDING');
    const moved2 = await h.request('POST', `${base()}/approvals/${id2}/reassign`, { token: f.owner, body: { userId: f.payrollUser, reason: 'HR away' } });
    expect(moved2.body.data.steps[0].requiredCount).toBe(2);
    expect((await decide(id2, f.payrollUser, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });

    // ALL: the seats that approved stay, the pending ones become the reassignee's
    await clearWorkflows();
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ALL' }]);
    const c3 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id3 = c3.body.data.approvalRequestId as string;
    expect((await decide(id3, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('PENDING');
    await h.request('POST', `${base()}/approvals/${id3}/reassign`, { token: f.owner, body: { userId: f.payrollUser, reason: 'HR away' } });
    expect((await decide(id3, f.payrollUser, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
  });

  it('P2-2 reassignment never seats the requester or the subject, and never erases a decision already taken', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'HR_ADMIN' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(e5) });
    const id = c.body.data.approvalRequestId as string;
    // C2: the requester (hrUser) and the subject (staff5, e5's login)
    const toRequester = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.owner, body: { userId: f.hrUser, reason: 'Cover' } });
    expect(toRequester.status).toBe(400);
    expect(toRequester.body.message).toMatch(/filed the request cannot be its approver/);
    expect((await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.owner, body: { userId: staff5, reason: 'Cover' } })).status).toBe(400);
    // C3: hrLinked rejected (ANY: not terminal while somebody can still approve) — their decision stands
    expect((await decide(id, hrLinked, { decision: 'REJECT', comment: 'Not convinced', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING', terminal: false });
    const back = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.owner, body: { userId: hrLinked, reason: 'Ask again' } });
    expect(back.status).toBe(409);
    expect(back.body.message).toMatch(/already decided at this level/);
    expect((await actorsOf(id)).find((a) => a.userId === hrLinked)).toMatchObject({ decision: 'REJECTED' });
  });
});

describe('P1-2 — decisions name the level the caller saw', () => {
  it('P1-2 a late click never closes the next level (bulk, aliases, concurrent decisions)', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'HR_ADMIN' }, { order: 2, approverType: 'USER', userId: f.owner }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id = c.body.data.approvalRequestId as string;
    expect((await decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING', currentStep: 2 });
    // I4: hrLinked's bulk line still names level 1
    const bulk = await h.request('POST', `${base()}/approvals/bulk-decide`, { token: hrLinked, body: { items: [{ requestId: id, stepNo: 1 }], decision: 'APPROVE' } });
    expect(bulk.body.data.results[0]).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    // the aliases: level 1 is no longer current; without a level hrLinked holds no seat at level 2
    expect((await h.request('POST', `${base()}/approvals/${id}/approve`, { token: hrLinked, body: { stepNo: 1 } })).status).toBe(409);
    expect((await h.request('POST', `${base()}/approvals/${id}/approve`, { token: hrLinked, body: {} })).status).toBe(400);
    expect(await requestRow(id)).toMatchObject({ status: 'PENDING', currentStep: 2 });
    expect((await actorsOf(id, 2)).find((a) => a.userId === f.owner)).toMatchObject({ decision: 'PENDING' });

    // I1: three HR admins approve level 1 at once — one advances the request, nobody closes the owner's level
    const c2 = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    const id2 = c2.body.data.approvalRequestId as string;
    const results = await Promise.all([f.hrAdmin, hrLinked, hr20].map((u) => decide(id2, u, { decision: 'APPROVE', stepNo: 1 })));
    expect(results.filter((x) => x.status === 200 && x.body.data.noop === false)).toHaveLength(1);
    expect(results.every((x) => x.status === 200 || x.status === 409)).toBe(true);
    expect(await requestRow(id2)).toMatchObject({ status: 'PENDING', currentStep: 2 });
    expect((await actorsOf(id2, 2)).find((a) => a.userId === f.owner)).toMatchObject({ decision: 'PENDING' });
  });
});

describe('P1-6 — /me approvals for members without an approve key', () => {
  it('P1-6 /me reports the approvals waiting for a delegate or a named approver, and the inbox lists them', async () => {
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegatorUserId: lineManager, delegateUserId: deputy, entityTypes: ['LEAVE'], startsOn: isoToday(-1), endsOn: isoToday(10) } });
    expect(d.status).toBe(201);
    try {
      await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
      await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.payrollUser }]);
      const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Delegate me' } });
      const id = r.body.data.approvalRequestId as string;
      const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
      const membership = async (u: string) => ((await h.request('GET', '/api/v1/me', { token: u })).body.data.memberships as Array<{ organization: { id: string }; approvals: unknown }>).find((m) => m.organization.id === f.orgId)!;
      expect((await membership(deputy)).approvals).toEqual({ actionable: 1, delegatedToMe: true });
      expect((await membership(f.payrollUser)).approvals).toEqual({ actionable: 1, delegatedToMe: false });
      expect((await membership(f.employeeUser)).approvals).toEqual({ actionable: 0, delegatedToMe: false });
      // the inbox is open to them and lists exactly that
      const inbox = await h.request('GET', `${base()}/approvals?scope=mine&view=pending`, { token: deputy });
      expect(inbox.body.data.map((x: { id: string }) => x.id)).toEqual([id]);
      expect(inbox.body.meta.total).toBe(1);
      expect((await h.request('GET', `${base()}/approvals?scope=mine&view=pending`, { token: f.payrollUser })).body.data.map((x: { id: string }) => x.id)).toEqual([c.body.data.approvalRequestId]);
      expect((await decide(id, deputy, { decision: 'APPROVE', stepNo: 1 })).body.data.status).toBe('APPROVED');
      expect((await membership(deputy)).approvals).toEqual({ actionable: 0, delegatedToMe: true });
    } finally {
      await h.request('DELETE', `${base()}/approval-delegations/${d.body.data.id}`, { token: f.hrAdmin });
    }
  });
});

describe('P1-7 — the only owner of an organisation', () => {
  it('P1-7 the single owner files and decides their own leave, their HR-recorded leave and their own correction (owner bypass logged)', async () => {
    const orgId = uuid('a');
    await h.admin.insertInto('organizations').values({ id: orgId, companyCode: 'ORG-SOLO', legalName: 'Solo', displayName: 'Solo', timezone: 'Asia/Muscat' }).execute();
    await h.admin.insertInto('organizationSettings').values({ organizationId: orgId }).onConflict((oc) => oc.doNothing()).execute();
    await h.admin.insertInto('subscriptions').values({ organizationId: orgId, planId: PLAN_TRIAL, status: 'active' }).execute();
    const branch = uuid('b');
    await h.admin.insertInto('branches').values({ id: branch, organizationId: orgId, code: 'M', name: 'Main', timezone: 'Asia/Muscat' }).execute();
    const emp = await seedEmployee(h.admin, orgId, branch, 1);
    const solo = uuid('c');
    await seedUser(h.admin, solo, 'solo-owner@test.local', 'Solo Owner');
    await seedMembership(h.admin, orgId, solo, ROLE.owner, { employeeId: emp });
    const lt = await h.request('POST', `${base(orgId)}/leave-types`, { token: solo, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
    expect(lt.status).toBe(201);
    const approveOwn = async (requestId: string) => {
      const steps = await actorsOf(requestId);
      expect(steps.map((a) => a.userId)).toEqual([solo]);
      expect((await stepOf(requestId)).resolutionReason).toMatch(/subject kept/);
      const res = await decide(requestId, solo, { decision: 'APPROVE', stepNo: 1 }, orgId);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(await eventsOf(requestId)).toEqual(expect.arrayContaining(['sod_owner_bypass', 'approved']));
      expect((await auditRows(h.admin, 'approval.sod_owner_bypass')).some((a) => (a as { entityId?: string }).entityId === requestId)).toBe(true);
    };
    // self-service leave
    const own = await h.request('POST', `${base(orgId)}/me/leave`, { token: solo, body: { leaveTypeId: lt.body.data.id, ...nextRange(1), reason: 'Holiday' } });
    expect(own.status).toBe(201);
    await approveOwn(own.body.data.approvalRequestId as string);
    // HR-recorded own leave
    const recorded = await h.request('POST', `${base(orgId)}/leave-records`, { token: solo, body: { employeeId: emp, leaveTypeId: lt.body.data.id, ...nextRange(1) } });
    expect(recorded.status).toBe(201);
    expect(recorded.body.data.status).toBe('PENDING');
    await approveOwn((await h.admin.selectFrom('leaveRecords').select('approvalRequestId').where('id', '=', recorded.body.data.id).executeTakeFirstOrThrow()).approvalRequestId!);
    // own correction
    const corr = await h.request('POST', `${base(orgId)}/attendance/corrections`, { token: solo, body: correction(emp) });
    expect(corr.status).toBe(201);
    await approveOwn(corr.body.data.approvalRequestId as string);
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).filter((j) => j.payload['correctionId'] === corr.body.data.id)).toHaveLength(1);
  });
});

describe('P2-1 — one "today" for delegations: the organisation\'s date', () => {
  it('P2-1 a delegation window in the organisation\'s date works end to end in Kiritimati, Los Angeles and Pago Pago; the UTC date does not', async () => {
    let utcOnlyExercised = 0;
    for (const [i, tz] of ['Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Pago_Pago'].entries()) {
      const o = await seedOrg(h.admin, `tz${i}`);
      await h.admin.updateTable('organizations').set({ timezone: tz }).where('id', '=', o.orgId).execute();
      const dep = uuid('c');
      await seedUser(h.admin, dep, `deputy-tz${i}@test.local`, `Deputy ${i}`);
      await seedMembership(h.admin, o.orgId, dep, ROLE.employee);
      const lt = await h.request('POST', `${base(o.orgId)}/leave-types`, { token: o.hrAdmin, body: { code: 'AL', name: 'Annual Leave', annualAllowanceDays: 30 } });
      await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }], {}, o.orgId, o.owner);
      const { rows } = await sql<{ org: string; utc: string }>`select app.org_today(${o.orgId}::uuid)::text as org, (now() at time zone 'UTC')::date::text as utc`.execute(h.admin);
      const { org: orgDate, utc: utcDate } = rows[0]!;
      const delegate = (day: string) => h.request('POST', `${base(o.orgId)}/approval-delegations`, { token: o.hrAdmin, body: { delegatorUserId: o.managerUser, delegateUserId: dep, entityTypes: ['LEAVE'], startsOn: day, endsOn: day } });
      const apply = async () => (await h.request('POST', `${base(o.orgId)}/me/leave`, { token: o.employeeUser, body: { leaveTypeId: lt.body.data.id, ...nextRange(1), reason: tz } })).body.data.approvalRequestId as string;

      // window = the organisation's date: stamped at submit, visible, decidable, counted — the same answer everywhere
      const inForce = await delegate(orgDate);
      expect(inForce.status).toBe(201);
      const r1 = await apply();
      expect((await actorsOf(r1)).map((a) => a.userId)).toEqual(expect.arrayContaining([o.managerUser, dep]));
      expect((await h.request('GET', `${base(o.orgId)}/approvals?scope=mine&view=pending`, { token: dep })).body.data.map((x: { id: string }) => x.id)).toEqual([r1]);
      const seen = await detail(r1, dep, o.orgId);
      expect(seen.status).toBe(200);
      expect(seen.body.data.abilities.canDecide).toBe(true);
      const me = (await h.request('GET', '/api/v1/me', { token: dep })).body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === o.orgId);
      expect(me.approvals).toEqual({ actionable: 1, delegatedToMe: true });
      expect((await h.request('GET', `${base(o.orgId)}/approval-delegations?activeOnly=true`, { token: dep })).body.data.map((x: { id: string }) => x.id)).toEqual([inForce.body.data.id]);
      expect((await decide(r1, dep, { decision: 'APPROVE', stepNo: 1 }, o.orgId)).body.data.status).toBe('APPROVED');
      await h.request('DELETE', `${base(o.orgId)}/approval-delegations/${inForce.body.data.id}`, { token: o.hrAdmin });

      // window = the database's UTC date only (when it differs): not in force anywhere — invisible AND undecidable
      if (utcDate !== orgDate) {
        utcOnlyExercised += 1;
        const utcOnly = await delegate(utcDate);
        expect(utcOnly.status).toBe(201);
        const r2 = await apply();
        expect((await actorsOf(r2)).map((a) => a.userId)).toEqual([o.managerUser]);
        expect((await h.request('GET', `${base(o.orgId)}/approvals?scope=mine&view=pending`, { token: dep })).body.data).toEqual([]);
        expect((await detail(r2, dep, o.orgId)).status).toBe(404);
        expect((await decide(r2, dep, { decision: 'APPROVE', stepNo: 1 }, o.orgId)).status).toBe(403);
        const me2 = (await h.request('GET', '/api/v1/me', { token: dep })).body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === o.orgId);
        expect(me2.approvals).toEqual({ actionable: 0, delegatedToMe: false });
      }
    }
    // at any moment at least one of the three zones is on a different date from UTC
    expect(utcOnlyExercised).toBeGreaterThan(0);
  });
});

describe('P2-3 — information requests', () => {
  it('P2-3 the subject cannot ask about their own request, and an answer needs an outstanding question', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Info' } });
    const id = r.body.data.approvalRequestId as string;
    // D2: the subject (who is also the requester)
    expect((await detail(id, staff5)).body.data.abilities).toMatchObject({ canRequestInfo: false, canAnswerInfo: false });
    const asked = await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: staff5, body: { comment: 'Any news?' } });
    expect(asked.status).toBe(403);
    // M: nothing was asked yet
    const early = await h.request('POST', `${base()}/approvals/${id}/answer-info`, { token: staff5, body: { comment: 'Unprompted' } });
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/No question is waiting/);
    expect((await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: lineManager, body: { comment: 'Which day exactly?' } })).status).toBe(200);
    expect((await detail(id, staff5)).body.data.abilities.canAnswerInfo).toBe(true);
    expect((await h.request('POST', `${base()}/approvals/${id}/answer-info`, { token: staff5, body: { comment: 'The Sunday' } })).status).toBe(200);
    expect((await h.request('POST', `${base()}/approvals/${id}/answer-info`, { token: staff5, body: { comment: 'Again' } })).status).toBe(409);
    expect(await eventsOf(id)).toEqual(['submitted', 'info_requested', 'info_answered']);
  });
});

describe('P2-4 — withdrawal (engine)', () => {
  it('P2-4 only the requester, the entity\'s organisation-wide manager or approval.manage withdraws, always with a reason', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Withdraw me' } });
    const id = r.body.data.approvalRequestId as string;
    // the line manager is only seated on it
    expect((await detail(id, lineManager)).body.data.abilities.canCancel).toBe(false);
    expect((await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: lineManager, body: { reason: 'Not now' } })).status).toBe(403);
    // a reason is required (at least 3 characters)
    expect((await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: staff5, body: {} })).status).toBe(400);
    expect((await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: staff5, body: { reason: 'no' } })).status).toBe(400);
    const done = await h.request('POST', `${base()}/approvals/${id}/cancel`, { token: staff5, body: { reason: 'Plans changed' } });
    expect(done.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Plans changed' });
    // HR (leave.manage + leave.view, organisation-wide) may withdraw somebody else's request, with a reason
    const r2 = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'HR withdraws' } });
    const id2 = r2.body.data.approvalRequestId as string;
    expect((await detail(id2, f.hrUser)).body.data.abilities.canCancel).toBe(true);
    expect((await h.request('POST', `${base()}/approvals/${id2}/cancel`, { token: f.hrUser, body: { reason: 'Duplicate of an earlier request' } })).body.data.status).toBe('CANCELLED');
    // corrections follow the same rule: the approving line manager cannot withdraw their report's correction
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'MANAGER' }]);
    const c = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(e5) });
    expect((await h.request('POST', `${base()}/attendance/corrections/${c.body.data.id}/cancel`, { token: lineManager, body: { reason: 'nah' } })).status).toBe(403);
    const cc = await h.request('POST', `${base()}/attendance/corrections/${c.body.data.id}/cancel`, { token: f.hrUser, body: {} });
    expect(cc.body.data.status).toBe('CANCELLED');
    // an internal caller that passed no reason still records one
    expect((await requestRow(c.body.data.approvalRequestId)).cancelReason).toBe('Withdrawn by the requester');
  });
});

describe('P2-5 — resolution reasons', () => {
  it('P2-5 a suspended manager is reported as "membership suspended", not "no linked login"', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }]);
    await h.admin.updateTable('orgMemberships').set({ status: 'suspended' }).where('organizationId', '=', f.orgId).where('userId', '=', lineManager).execute();
    try {
      const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Manager suspended' } });
      const step = await stepOf(r.body.data.approvalRequestId as string);
      expect(step.resolutionPath).toBe('hr_admin');
      expect(step.resolutionReason).toMatch(/primary manager: membership suspended/);
      expect(step.resolutionReason).not.toMatch(/no linked login/);
    } finally {
      await h.admin.updateTable('orgMemberships').set({ status: 'active' }).where('organizationId', '=', f.orgId).where('userId', '=', lineManager).execute();
    }
  });
});

describe('P2-7 / P2-8 — workflow validation', () => {
  it('P2-7 a quorum above one is refused on single-seat approver types, with a field error', async () => {
    for (const step of [
      { order: 1, approverType: 'MANAGER', mode: 'QUORUM', requiredCount: 2 },
      { order: 1, approverType: 'USER', userId: f.owner, mode: 'QUORUM', requiredCount: 2 },
      { order: 1, approverType: 'SECONDARY_MANAGER', mode: 'ALL', requiredCount: 2 },
      { order: 1, approverType: 'MANAGER_CHAIN', chainLevel: 2, mode: 'QUORUM', requiredCount: 3 },
      { order: 1, approverType: 'DEPARTMENT_HEAD', mode: 'QUORUM', requiredCount: 2 },
    ]) {
      const r = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'single seat', entityType: 'LEAVE', steps: [step] } });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(/resolves to one approver/);
      expect(JSON.stringify(r.body)).toMatch(/requiredCount/);
    }
    // QUORUM 1 on a single seat is fine, and QUORUM 2 on a multi-seat type too
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER', mode: 'QUORUM', requiredCount: 1 }]);
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN', mode: 'QUORUM', requiredCount: 2 }], { minUnits: 5 });
  });

  it('P2-8 appliesTo is canonical: reordered or repeated ids are the same default workflow', async () => {
    const ids = [f.branchB, f.branchA].map((x) => x.toUpperCase());
    const first = await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }], { appliesTo: { branchIds: ids } });
    expect(first.appliesTo).toEqual({ branchIds: [f.branchA, f.branchB].sort() });
    const stored = await h.admin.selectFrom('approvalWorkflows').select('appliesTo').where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(stored.appliesTo).toEqual({ branchIds: [f.branchA, f.branchB].sort() });
    for (const branchIds of [[f.branchA, f.branchB], [f.branchB, f.branchA, f.branchB]]) {
      const dup = await h.request('POST', `${base()}/approval-workflows`, { token: f.owner, body: { name: 'dup', entityType: 'LEAVE', steps: [{ order: 1, approverType: 'MANAGER' }], appliesTo: { branchIds } } });
      expect(dup.status).toBe(409);
    }
  });
});

describe('P2-11 — the dashboard count is the caller\'s queue', () => {
  it('P2-11 pendingApprovals equals what the Approvals card lists for the caller', async () => {
    await workflow('ATTENDANCE_CORRECTION', [{ order: 1, approverType: 'USER', userId: f.hrAdmin }]);
    await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: correction(f.e1) });
    for (const u of [f.hrAdmin, f.owner]) {
      const summary = await h.request('GET', `${base()}/dashboard/summary`, { token: u });
      expect(summary.status).toBe(200);
      const queue = await h.request('GET', `${base()}/approvals?scope=mine&view=pending&pageSize=100`, { token: u });
      expect(summary.body.data.pendingApprovals).toBe(queue.body.meta.total);
    }
    // the owner reads every pending request but holds no seat on these two
    const ownerQueue = await h.request('GET', `${base()}/approvals?scope=mine&view=pending&pageSize=100`, { token: f.owner });
    const all = await h.request('GET', `${base()}/approvals?scope=all&view=pending&pageSize=100`, { token: f.owner });
    expect(all.body.meta.total).toBeGreaterThan(ownerQueue.body.meta.total);
  });
});

describe('5-O3 four-eyes — one person approves at most one level of a request', () => {
  it('5-O3 the reviewer\'s A3 probe is refused: a line manager who approved level 1 cannot approve level 2 as an HR admin\'s delegate', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ANY' }]);
    const d = await h.request('POST', `${base()}/approval-delegations`, { token: f.hrAdmin, body: { delegateUserId: lineManager, entityTypes: ['LEAVE'], startsOn: isoToday(-1), endsOn: isoToday(10), reason: 'Away' } });
    expect(d.status).toBe(201);
    try {
      const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Four eyes' } });
      const id = r.body.data.approvalRequestId as string;
      // level 2 seats the HR admins — and the line manager in the delegating HR admin's seat
      expect((await actorsOf(id, 2)).find((a) => a.userId === lineManager)).toMatchObject({ viaDelegationOf: f.hrAdmin, decision: 'PENDING' });
      expect((await decide(id, lineManager, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING', terminal: false });
      // level 2 opened without them: their delegate row is skipped and the timeline says why
      expect((await actorsOf(id, 2)).find((a) => a.userId === lineManager)).toMatchObject({ decision: 'SKIPPED' });
      expect(await eventsOf(id)).toContain('four_eyes_excluded');
      expect((await detail(id, lineManager)).body.data.abilities).toMatchObject({ canDecide: false, canRequestInfo: false, decideVia: null });
      const refused = await decide(id, lineManager, { decision: 'APPROVE', stepNo: 2 });
      expect(refused.status).toBe(403);
      expect(refused.body.message).toMatch(/approved an earlier level/);
      expect((await h.request('POST', `${base()}/approvals/${id}/request-info`, { token: lineManager, body: { comment: 'Sure?' } })).status).toBe(403);
      // not waiting for them on any surface
      const queue = await h.request('GET', `${base()}/approvals?scope=mine&view=pending&pageSize=100`, { token: lineManager });
      expect(queue.body.data.map((x: { id: string }) => x.id)).not.toContain(id);
      // the HR admins still decide the level
      expect((await decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 2 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    } finally {
      await h.request('DELETE', `${base()}/approval-delegations/${d.body.data.id}`, { token: f.hrAdmin });
    }
  });

  it('5-O3 a level held only by somebody who approved an earlier one falls through to the next rung of the ladder', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'USER', userId: lineManager }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Same person twice' } });
    const id = r.body.data.approvalRequestId as string;
    expect((await actorsOf(id, 2)).map((a) => a.userId)).toEqual([lineManager]);
    expect((await decide(id, lineManager, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING' });
    const step2 = await stepOf(id, 2);
    expect(step2.resolutionPath).toBe('hr_admin');
    const seats = await actorsOf(id, 2);
    expect(seats.find((a) => a.userId === lineManager)).toMatchObject({ decision: 'SKIPPED' });
    const waiting = seats.filter((a) => a.decision === 'PENDING').map((a) => a.userId);
    expect(waiting).toContain(f.hrAdmin);
    expect(waiting).not.toContain(lineManager);
    const ev = await h.admin.selectFrom('approvalRequestEvents').select('detail').where('requestId', '=', id).where('kind', '=', 'four_eyes_excluded').executeTakeFirstOrThrow();
    expect(ev.detail).toMatchObject({ stepNo: 2, excluded: [lineManager], fellBackTo: 'hr_admin' });
    expect((await decide(id, lineManager, { decision: 'APPROVE', stepNo: 2 })).status).toBe(403);
    expect((await decide(id, f.hrAdmin, { decision: 'APPROVE', stepNo: 2 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
  });

  it('5-O3 the owner keeps an override on a later level — logged', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'MANAGER' }, { order: 2, approverType: 'ROLE', roleId: HR_ADMIN_ROLE, mode: 'ANY' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Owner twice' } });
    const id = r.body.data.approvalRequestId as string;
    expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING' });
    expect((await detail(id, f.owner)).body.data.abilities).toMatchObject({ canDecide: true, decideVia: 'override' });
    expect((await decide(id, f.owner, { decision: 'APPROVE', stepNo: 2 })).body.data).toMatchObject({ status: 'APPROVED', terminal: true });
    expect(await eventsOf(id)).toContain('four_eyes_owner_bypass');
    expect((await auditRows(h.admin, 'approval.four_eyes_owner_bypass')).some((a) => a.entityId === id)).toBe(true);
  });

  it('5-O3 an exception approval or a reassignment never gives a second level to somebody who approved one', async () => {
    await workflow('LEAVE', [{ order: 1, approverType: 'HR_ADMIN' }, { order: 2, approverType: 'MANAGER' }]);
    const r = await h.request('POST', `${base()}/me/leave`, { token: staff5, body: { leaveTypeId, ...nextRange(1), reason: 'Exception' } });
    const id = r.body.data.approvalRequestId as string;
    expect((await decide(id, hrLinked, { decision: 'APPROVE', stepNo: 1 })).body.data).toMatchObject({ status: 'PENDING' });
    // hrLinked holds approval.manage — but approving the rest as an exception would be a second level
    expect((await detail(id, hrLinked)).body.data.abilities).toMatchObject({ canBypass: false });
    const bypass = await h.request('POST', `${base()}/approvals/${id}/bypass`, { token: hrLinked, body: { reason: 'Urgent' } });
    expect(bypass.status).toBe(403);
    expect(bypass.body.message).toMatch(/one person approves at most one level/);
    // nor can the level be moved to them
    const moved = await h.request('POST', `${base()}/approvals/${id}/reassign`, { token: f.owner, body: { userId: hrLinked, reason: 'Manager away' } });
    expect(moved.status).toBe(400);
    expect(moved.body.message).toMatch(/approved an earlier level/);
    expect((await requestRow(id)).status).toBe('PENDING');
    // another approval manager who approved nothing may approve it as an exception
    expect((await detail(id, hr20)).body.data.abilities).toMatchObject({ canBypass: true });
    expect((await h.request('POST', `${base()}/approvals/${id}/bypass`, { token: hr20, body: { reason: 'Manager away, urgent' } })).status).toBeLessThan(300);
    expect((await requestRow(id)).status).toBe('APPROVED');
  });
});

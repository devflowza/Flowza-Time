/**
 * Approval routing (organization_settings.approvals) — the customer's review of the approval inbox, October 2026:
 *  1. an employee's leave went to every admin holding leave.approve instead of the employee's line manager;
 *  2. a manager's leave never reached the manager's own reporting manager;
 *  3. a reason for being late reached the line manager AND the secondary manager — the secondary should hear of it only
 *     when the line manager is on leave;
 *  4. the leave of somebody at the top of the organisation must always reach somebody who can decide it.
 * Every behaviour is the organisation's choice under Settings → Approvals; the defaults are the customer's answers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiHarness, domainEvents, isoToday, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// ceo (top, no manager) ← mgr ← staff (secondary manager: backup); backup reports to ceo
let ceo: string; let mgr: string; let staff: string; let backup: string;
const ceoUser = uuid('c'); const mgrUser = uuid('c'); const staffUser = uuid('c'); const backupUser = uuid('c'); const adminUser = uuid('c'); const dgUser = uuid('c');
let leaveTypeId: string;
const base = () => `/api/v1/orgs/${f.orgId}`;
let weekOffset = 3;
/** A future Sunday (a working day: Fri + Sat are off) weeks ahead, one per call so nothing overlaps. */
function nextDay() {
  weekOffset += 1;
  const d = new Date(); d.setUTCDate(d.getUTCDate() + weekOffset * 7 - d.getUTCDay());
  const s = d.toISOString().slice(0, 10);
  return { startDate: s, endDate: s };
}
async function requestFor(entityId: string) {
  return h.admin.selectFrom('approvalRequests').selectAll().where('entityId', '=', entityId).orderBy('createdAt', 'desc').executeTakeFirstOrThrow();
}
async function seats(requestId: string) {
  return h.admin.selectFrom('approvalStepActors as a').innerJoin('approvalSteps as s', 's.id', 'a.stepId').select(['a.userId', 'a.viaDelegationOf', 'a.resolutionPath', 's.approverType', 's.stepNo']).where('s.requestId', '=', requestId).orderBy('a.userId').execute();
}
const seatUsers = async (requestId: string) => (await seats(requestId)).map((s) => s.userId).sort();
async function pendingNotified(requestId: string) {
  return (await domainEvents(h.admin, 'approval.pending')).filter((e) => e.aggregateId === requestId).flatMap((e) => ((e.payload as { userIds?: string[] }).userIds ?? [])).sort();
}
async function setPolicy(value: Record<string, unknown>) {
  const r = await h.request('PUT', `${base()}/settings/approvals`, { token: f.owner, body: value });
  expect(r.status).toBe(200);
}
const applyLeave = (token: string) => h.request('POST', `${base()}/me/leave`, { token, body: { leaveTypeId, reason: 'Family matters', ...nextDay() } });
async function inboxIds(token: string) {
  const r = await h.request('GET', `${base()}/approvals/inbox?scope=mine&view=pending&pageSize=100`, { token });
  expect(r.status).toBe(200);
  return (r.body.data as Array<{ id: string }>).map((x) => x.id);
}
async function onLeaveToday(employeeId: string) {
  await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId, branchId: f.branchA, leaveTypeId, startDate: isoToday(-1), endDate: isoToday(1), status: 'APPROVED', days: 3, reason: 'away' }).execute();
}
async function backAtWork(employeeId: string) {
  await h.admin.deleteFrom('leaveRecords').where('employeeId', '=', employeeId).where('reason', '=', 'away').execute();
}
async function seedDay(employeeId: string, date: string) {
  await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId: f.branchA, departmentId: f.departmentA, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags: ['LATE'], workedMinutes: 450, lateMinutes: 25, trace: JSON.stringify({ punches: [] }) }).execute();
}
let noteDay = -2;
async function lateReason(token: string, employeeId: string) {
  noteDay -= 1;
  const date = isoToday(noteDay);
  await seedDay(employeeId, date);
  const r = await h.request('POST', `${base()}/me/attendance/notes`, { token, body: { date, category: 'late_reason', note: 'Traffic on the expressway' } });
  expect(r.status).toBe(201);
  return requestFor(r.body.data.id);
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_routing_${process.pid}`);
  f = await seedOrg(h.admin, 'routing');
  ceo = await seedEmployee(h.admin, f.orgId, f.branchA, 40, { departmentId: f.departmentA });
  mgr = await seedEmployee(h.admin, f.orgId, f.branchA, 41, { managerEmployeeId: ceo, departmentId: f.departmentA });
  backup = await seedEmployee(h.admin, f.orgId, f.branchA, 43, { managerEmployeeId: ceo, departmentId: f.departmentA });
  staff = await seedEmployee(h.admin, f.orgId, f.branchA, 42, { managerEmployeeId: mgr, departmentId: f.departmentA });
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: backup }).where('id', '=', staff).execute();
  for (const [id, n] of [[ceoUser, 'ceo'], [mgrUser, 'mgr'], [staffUser, 'staff'], [backupUser, 'backup'], [adminUser, 'admin'], [dgUser, 'dg']] as const) await seedUser(h.admin, id, `${n}-routing@test.local`, n);
  await seedMembership(h.admin, f.orgId, ceoUser, ROLE.manager, { employeeId: ceo });
  await seedMembership(h.admin, f.orgId, mgrUser, ROLE.manager, { employeeId: mgr });
  await seedMembership(h.admin, f.orgId, backupUser, ROLE.manager, { employeeId: backup });
  await seedMembership(h.admin, f.orgId, staffUser, ROLE.employee, { employeeId: staff });
  await seedMembership(h.admin, f.orgId, adminUser, ROLE.org_admin);
  await seedMembership(h.admin, f.orgId, dgUser, ROLE.employee);
  const t = await h.request('POST', `${base()}/leave-types`, { token: f.hrAdmin, body: { code: 'AL', name: 'Annual Leave' } });
  expect(t.status).toBe(201);
  leaveTypeId = t.body.data.id;
});
afterAll(async () => { await h?.close(); });
beforeEach(async () => { await setPolicy({}); });

describe('settings → approvals', () => {
  it('reads the defaults, and is written by organization.manage only', async () => {
    const r = await h.request('GET', `${base()}/settings/approvals`, { token: f.owner });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ defaultRouting: 'line_manager', secondaryManager: 'backup', managerUnavailable: 'next_level_manager', topLevel: 'hr_admins', topLevelUserId: null });
    expect((await h.request('PUT', `${base()}/settings/approvals`, { token: mgrUser, body: { defaultRouting: 'permission_holders' } })).status).toBe(403);
    expect((await h.request('PUT', `${base()}/settings/approvals`, { token: f.owner, body: { defaultRouting: 'everyone' } })).status).toBe(400);
  });

  it('a named top-level approver must be chosen and must be an active member', async () => {
    expect((await h.request('PUT', `${base()}/settings/approvals`, { token: f.owner, body: { topLevel: 'named_user' } })).status).toBe(400);
    expect((await h.request('PUT', `${base()}/settings/approvals`, { token: f.owner, body: { topLevel: 'named_user', topLevelUserId: uuid('c') } })).status).toBe(400);
    expect((await h.request('PUT', `${base()}/settings/approvals`, { token: f.owner, body: { topLevel: 'named_user', topLevelUserId: dgUser } })).status).toBe(200);
  });
});

describe('leave goes to the line manager (screenshots 1 and 2)', () => {
  it('an employee\'s leave is decided by their line manager only — not by every admin holding leave.approve', async () => {
    const r = await applyLeave(staffUser);
    expect(r.status).toBe(201);
    const req = await requestFor(r.body.data.id);
    expect(await seats(req.id)).toEqual([{ userId: mgrUser, viaDelegationOf: null, resolutionPath: 'primary', approverType: 'MANAGER', stepNo: 1 }]);
    expect(await pendingNotified(req.id)).toEqual([mgrUser]);
    expect(await inboxIds(mgrUser)).toContain(req.id);
    for (const admin of [adminUser, f.owner, f.hrAdmin]) expect(await inboxIds(admin)).not.toContain(req.id);
    // the manager decides it
    const d = await h.request('POST', `${base()}/approvals/${req.id}/decide`, { token: mgrUser, body: { decision: 'APPROVE', stepNo: 1 } });
    expect(d.status).toBe(200);
    expect((await h.admin.selectFrom('leaveRecords').select('status').where('id', '=', r.body.data.id).executeTakeFirstOrThrow()).status).toBe('APPROVED');
  });

  it('a manager\'s leave reaches the manager\'s own reporting manager and is notified to them', async () => {
    const r = await applyLeave(mgrUser);
    expect(r.status).toBe(201);
    const req = await requestFor(r.body.data.id);
    expect(await seatUsers(req.id)).toEqual([ceoUser]);
    expect(await pendingNotified(req.id)).toEqual([ceoUser]);
    expect(await inboxIds(ceoUser)).toContain(req.id);
    expect(await inboxIds(mgrUser)).not.toContain(req.id);
  });

  it('permission_holders keeps the previous behaviour: every approve holder in reach decides', async () => {
    await setPolicy({ defaultRouting: 'permission_holders' });
    const r = await applyLeave(staffUser);
    const req = await requestFor(r.body.data.id);
    const s = await seats(req.id);
    expect(s.every((x) => x.approverType === 'ROLE' && x.resolutionPath === 'permission')).toBe(true);
    expect(s.map((x) => x.userId)).toEqual(expect.arrayContaining([mgrUser, adminUser, f.owner, f.hrAdmin]));
  });

  it('attendance corrections filed for oneself follow the same routing (a manager\'s correction reaches their manager)', async () => {
    expect((await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: { allowSelfServiceCorrections: true } })).status).toBe(200);
    const day = isoToday(-20);
    const r = await h.request('POST', `${base()}/attendance/corrections`, { token: mgrUser, body: { employeeId: mgr, attendanceDate: day, type: 'ADD_PUNCH', proposedPunchedAt: `${day}T05:00:00.000Z`, proposedEventType: 'PUNCH_IN', reason: 'Forgot to punch in' } });
    expect(r.status).toBe(201);
    expect(await seatUsers((await requestFor(r.body.data.id)).id)).toEqual([ceoUser]);
  });
});

describe('the top of the organisation (screenshot 4)', () => {
  it('default: somebody with no manager is decided by the HR admins, who see it and can decide it', async () => {
    const r = await applyLeave(ceoUser);
    const req = await requestFor(r.body.data.id);
    const s = await seats(req.id);
    expect(s.map((x) => x.resolutionPath)).toEqual(s.map(() => 'hr_admin'));
    expect(s.map((x) => x.userId)).toContain(f.hrAdmin);
    expect(await inboxIds(f.hrAdmin)).toContain(req.id);
    const one = (await h.request('GET', `${base()}/approvals/${req.id}`, { token: f.hrAdmin })).body.data;
    expect(one.abilities.canDecide).toBe(true);
  });

  it('a named approver (the Director General) decides requests from the top', async () => {
    await setPolicy({ topLevel: 'named_user', topLevelUserId: dgUser });
    const r = await applyLeave(ceoUser);
    const req = await requestFor(r.body.data.id);
    expect(await seats(req.id)).toEqual([{ userId: dgUser, viaDelegationOf: null, resolutionPath: 'top_level', approverType: 'MANAGER', stepNo: 1 }]);
    expect(await inboxIds(dgUser)).toContain(req.id);
    // somebody with a manager never reaches the named approver
    const staffLeave = await applyLeave(staffUser);
    expect(await seatUsers((await requestFor(staffLeave.body.data.id)).id)).toEqual([mgrUser]);
  });

  it('auto_approve approves requests from the top at once, with nobody recorded as the decider', async () => {
    await setPolicy({ topLevel: 'auto_approve' });
    const r = await applyLeave(ceoUser);
    expect(r.status).toBe(201);
    const req = await requestFor(r.body.data.id);
    expect(req).toMatchObject({ status: 'APPROVED', decidedBy: null });
    const leave = await h.admin.selectFrom('leaveRecords').select(['status', 'approvedBy']).where('id', '=', r.body.data.id).executeTakeFirstOrThrow();
    expect(leave).toEqual({ status: 'APPROVED', approvedBy: null });
    const ev = await h.admin.selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', req.id).execute();
    expect(ev).toContainEqual({ kind: 'auto_approved', detail: { reason: 'the requester has no manager: approved automatically (organisation policy)' } });
    // a manager's leave still goes to their manager
    expect(await seatUsers((await requestFor((await applyLeave(mgrUser)).body.data.id)).id)).toEqual([ceoUser]);
  });
});

describe('reasons for being late (screenshot 3)', () => {
  it('backup (default): only the immediate manager is asked and notified — the secondary manager is not', async () => {
    const req = await lateReason(staffUser, staff);
    expect(await seats(req.id)).toEqual([{ userId: mgrUser, viaDelegationOf: null, resolutionPath: 'primary', approverType: 'MANAGER', stepNo: 1 }]);
    expect(await pendingNotified(req.id)).toEqual([mgrUser]);
    expect(await inboxIds(backupUser)).not.toContain(req.id);
  });

  it('backup: the secondary manager decides when the immediate manager is on leave', async () => {
    await onLeaveToday(mgr);
    try {
      const req = await lateReason(staffUser, staff);
      expect(await seats(req.id)).toEqual([{ userId: backupUser, viaDelegationOf: null, resolutionPath: 'secondary', approverType: 'MANAGER', stepNo: 1 }]);
      expect(await pendingNotified(req.id)).toEqual([backupUser]);
    } finally { await backAtWork(mgr); }
  });

  it('next_level_manager: without a secondary manager, the manager\'s manager decides while the manager is on leave', async () => {
    await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: null }).where('id', '=', staff).execute();
    await onLeaveToday(mgr);
    try {
      const req = await lateReason(staffUser, staff);
      expect(await seats(req.id)).toEqual([{ userId: ceoUser, viaDelegationOf: null, resolutionPath: 'chain_step_2', approverType: 'MANAGER', stepNo: 1 }]);
      await setPolicy({ managerUnavailable: 'hr_admins' });
      const hr = await lateReason(staffUser, staff);
      expect((await seats(hr.id)).map((x) => x.resolutionPath)).toContain('hr_admin');
      expect(await seatUsers(hr.id)).not.toContain(ceoUser);
    } finally {
      await backAtWork(mgr);
      await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: backup }).where('id', '=', staff).execute();
    }
  });

  it('alongside: the secondary manager shares the line manager\'s seat on every request (the previous behaviour)', async () => {
    await setPolicy({ secondaryManager: 'alongside' });
    const req = await lateReason(staffUser, staff);
    expect(await seats(req.id)).toEqual([
      { userId: mgrUser, viaDelegationOf: null, resolutionPath: 'primary', approverType: 'MANAGER', stepNo: 1 },
      { userId: backupUser, viaDelegationOf: mgrUser, resolutionPath: 'secondary', approverType: 'MANAGER', stepNo: 1 },
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
    expect(await pendingNotified(req.id)).toEqual([backupUser, mgrUser].sort());
  });
});

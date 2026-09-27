/**
 * Line-manager semantics (HR portal Prompt 1): /me exposes the team, the RLS team predicate and requireTeamOrPermission
 * agree on who a direct report is, the auditor role is read-only, and an invitation carries its employee link through
 * to the membership created on acceptance.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withContext } from '@flowza/database';
import { createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 manages e5 (primary) and e6 (secondary); e7 reports to nobody; e8 reports to e5 (an indirect report of e4)
let e4: string; let e5: string; let e6: string; let e7: string; let e8: string;
const lineManager = uuid('c'); const auditor = uuid('c'); const newHire = uuid('c');
const NEW_HIRE_EMAIL = 'new-hire-team@test.local';
const DAY = '2026-09-01';
const punch = (employeeId: string, reason = 'Forgot to punch out', at = '13:05') => ({ employeeId, attendanceDate: DAY, type: 'ADD_PUNCH', proposedPunchedAt: `${DAY}T${at}:00Z`, reason });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_team_${process.pid}`); f = await seedOrg(h.admin, 'team');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchB, 6);
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: e4 }).where('id', '=', e6).execute();
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  e8 = await seedEmployee(h.admin, f.orgId, f.branchA, 8, { managerEmployeeId: e5 });
  await seedUser(h.admin, lineManager, 'line-manager-team@test.local', 'Line Manager');
  await seedUser(h.admin, auditor, 'auditor-team@test.local', 'Auditor');
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, auditor, ROLE.auditor);
  for (const [emp, branch] of [[e4, f.branchA], [e5, f.branchA], [e6, f.branchB], [e7, f.branchA], [e8, f.branchA]] as const) {
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: emp, attendanceDate: DAY, branchId: branch, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags: [], workedMinutes: 480 }).execute();
  }
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe('/me carries line-manager semantics', () => {
  it('reports isManager and the team size from the membership link (primary + secondary reports, direct only)', async () => {
    const me = await h.request('GET', '/api/v1/me', { token: lineManager });
    expect(me.status).toBe(200);
    expect(me.body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId)).toMatchObject({ roleKey: 'manager', employeeId: e4, isManager: true, teamSize: 2 });
    const aud = await h.request('GET', '/api/v1/me', { token: auditor });
    expect(aud.body.data.memberships[0]).toMatchObject({ roleKey: 'auditor', isManager: false, teamSize: 0 });
    // the hr_user linked to e3 manages e1 (seedOrg): the relationship counts whatever the role is
    const hr = await h.request('GET', '/api/v1/me', { token: f.managerUser });
    expect(hr.body.data.memberships[0]).toMatchObject({ roleKey: 'hr_user', isManager: true, teamSize: 1 });
    // a role that manages nobody
    const owner = await h.request('GET', '/api/v1/me', { token: f.owner });
    expect(owner.body.data.memberships[0]).toMatchObject({ isManager: false, teamSize: 0 });
  });

  it('lists the two new system roles with the permissions of the matrix', async () => {
    const roles = await h.request('GET', `${base()}/roles`, { token: f.owner });
    const manager = roles.body.data.find((r: { key: string }) => r.key === 'manager');
    const auditorRole = roles.body.data.find((r: { key: string }) => r.key === 'auditor');
    expect(manager).toMatchObject({ id: ROLE.manager, isSystem: true });
    expect(manager.permissions).toEqual(expect.arrayContaining(['attendance.view_team', 'leave.view_team', 'leave.approve', 'attendance.checkin', 'attendance.note', 'shift.request_swap', 'approval.delegate', 'employee.view_team']));
    // review fix (20260928000150): the line manager reads own record + direct reports, not the organisation's directory
    expect(manager.permissions).not.toContain('employee.view');
    expect(manager.permissions).not.toContain('attendance.view');
    expect(auditorRole).toMatchObject({ id: ROLE.auditor, isSystem: true });
    expect(auditorRole.permissions).toEqual(expect.arrayContaining(['attendance.view', 'attendance.view_raw', 'audit.view', 'payroll.view', 'report.export']));
    expect(auditorRole.permissions.some((p: string) => /\.(manage|update|create|delete|approve|correct|request|assign|import|finalize|recalculate|lock_period|checkin|note|schedule|delegate)$/.test(p))).toBe(false);
  });
});

describe('team predicate (RLS) and requireTeamOrPermission agree on who a direct report is', () => {
  it('a line manager reads the daily records of primary and secondary reports (and their own), nothing else', async () => {
    const asUser = (userId: string) => withContext(h.tdb.db, { kind: 'user', userId }, (trx) => trx.selectFrom('attendanceDailyRecords').select('employeeId').where('attendanceDate', '=', DAY).execute());
    const mine = (await asUser(lineManager)).map((r) => r.employeeId).sort();
    // own record through attendance.view_own; e8 reports to e5, not to e4 — direct reports only
    expect(mine).toEqual([e4, e5, e6].sort());
    const audited = (await asUser(auditor)).map((r) => r.employeeId).sort();
    expect(audited).toEqual([e4, e5, e6, e7, e8].sort());
    const denied = await withContext(h.tdb.db, { kind: 'user', userId: auditor }, (trx) => trx.updateTable('employees').set({ displayName: 'x' }).where('id', '=', e7).executeTakeFirst());
    expect(Number(denied.numUpdatedRows)).toBe(0);
  });

  it('a line manager may file a correction for a direct report but not for another employee; HR files for anyone', async () => {
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: lineManager, body: punch(e5) })).status).toBe(201);
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: lineManager, body: punch(e6) })).status).toBe(201);
    const denied = await h.request('POST', `${base()}/attendance/corrections`, { token: lineManager, body: punch(e7, 'Not my report') });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/direct reports/);
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrUser, body: punch(e7, 'HR files for anyone') })).status).toBe(201);
    // no organisation-wide attendance.view: the HR attendance grid answers the manager with their OWN record only
    // (attendance.view_own) — the team's rows reach the UI through the team workspace of a later release, not here
    const grid = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: lineManager });
    expect(grid.status).toBe(200);
    expect(grid.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([e4]);
  });

  it('GET /employees?teamOf= lists primary and secondary reports and exposes the secondary manager on the DTO', async () => {
    const team = await h.request('GET', `${base()}/employees?teamOf=${e4}`, { token: lineManager });
    expect(team.status).toBe(200);
    expect(ids(team.body.data)).toEqual([e5, e6].sort());
    expect(team.body.data.find((e: { id: string }) => e.id === e6)).toMatchObject({ managerEmployeeId: null, secondaryManagerEmployeeId: e4, secondaryManagerName: 'Employee 4' });
    expect(team.body.data.find((e: { id: string }) => e.id === e5)).toMatchObject({ managerEmployeeId: e4, managerName: 'Employee 4', secondaryManagerEmployeeId: null });
  });
});

describe('invitations carry the employee link', () => {
  it('an invitee without an account lands linked to the chosen employee; an employee is never linked twice', async () => {
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: NEW_HIRE_EMAIL, roleId: ROLE.employee, employeeId: e7 } });
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ employeeId: e7, membershipId: null });
    const listed = await h.request('GET', `${base()}/invitations`, { token: f.owner });
    expect(listed.body.data.find((i: { id: string }) => i.id === inv.body.data.id)).toMatchObject({ employeeId: e7, employeeNumber: 'EMP7' });

    // the pending invitation reserves the employee: a second invitation and a member re-link are refused
    const twice = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'someone-else-team@test.local', roleId: ROLE.employee, employeeId: e7 } });
    expect(twice.status).toBe(409);
    const auditorMembership = await h.admin.selectFrom('orgMemberships').select('id').where('organizationId', '=', f.orgId).where('userId', '=', auditor).executeTakeFirstOrThrow();
    expect((await h.request('PATCH', `${base()}/members/${auditorMembership.id}`, { token: f.owner, body: { employeeId: e7 } })).status).toBe(409);
    // an employee already linked to a login cannot be linked to a second one
    expect((await h.request('PATCH', `${base()}/members/${auditorMembership.id}`, { token: f.owner, body: { employeeId: f.e1 } })).status).toBe(409);
    // ...while a free employee can
    expect((await h.request('PATCH', `${base()}/members/${auditorMembership.id}`, { token: f.owner, body: { employeeId: e8 } })).status).toBe(200);
    await h.request('PATCH', `${base()}/members/${auditorMembership.id}`, { token: f.owner, body: { employeeId: null } });

    // the picker's candidate list: linked (e1, e3, e4) and reserved (e7) employees are excluded
    const unlinked = await h.request('GET', `${base()}/employees?unlinked=true&pageSize=50`, { token: f.owner });
    expect(ids(unlinked.body.data)).toEqual([f.e2, e5, e6, e8].sort());

    // the invitee signs up afterwards and accepts: the membership carries the employee link
    await seedUser(h.admin, newHire, NEW_HIRE_EMAIL, 'New Hire');
    const accept = await h.request('POST', '/api/v1/invitations/accept', { token: `${newHire}:${NEW_HIRE_EMAIL}`, body: { token: inv.body.data.token } });
    expect(accept.status).toBe(200);
    const membership = await h.admin.selectFrom('orgMemberships').select(['employeeId', 'status', 'roleId']).where('id', '=', accept.body.data.membershipId).executeTakeFirstOrThrow();
    expect(membership).toEqual({ employeeId: e7, status: 'active', roleId: ROLE.employee });
    const me = await h.request('GET', '/api/v1/me', { token: `${newHire}:${NEW_HIRE_EMAIL}` });
    expect(me.body.data.memberships[0]).toMatchObject({ employeeId: e7, roleKey: 'employee' });
    const after = await h.request('GET', `${base()}/employees?unlinked=true&pageSize=50`, { token: f.owner });
    expect(ids(after.body.data)).toEqual([f.e2, e5, e6, e8].sort());
  });
});

describe('auditor is read-only', () => {
  it('reads the directory and attendance; every write is refused at the service layer (and by RLS underneath)', async () => {
    expect((await h.request('GET', `${base()}/employees`, { token: auditor })).status).toBe(200);
    const daily = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: auditor });
    expect(daily.status).toBe(200);
    expect(daily.body.meta.total).toBe(5);
    expect((await h.request('PATCH', `${base()}/employees/${e7}`, { token: auditor, body: { firstName: 'X' } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employees`, { token: auditor, body: { employeeNumber: 'AUD1', firstName: 'A', lastName: 'B', joiningDate: '2026-01-01', branchId: f.branchA } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: auditor, body: punch(e7, 'Auditors only read') })).status).toBe(403);
    expect((await h.request('POST', `${base()}/roles`, { token: auditor, body: { key: 'xx_role', name: 'X', permissions: ['employee.view'] } })).status).toBe(403);
  });
});

describe('secondary manager on the employee record', () => {
  it('PATCH validates the manager pair and the team grows when a report is added', async () => {
    const same = await h.request('PATCH', `${base()}/employees/${e7}`, { token: f.hrAdmin, body: { managerEmployeeId: e4, secondaryManagerEmployeeId: e4 } });
    expect(same.status).toBe(400);
    const self = await h.request('PATCH', `${base()}/employees/${e7}`, { token: f.hrAdmin, body: { secondaryManagerEmployeeId: e7 } });
    expect(self.status).toBe(400);
    const ok = await h.request('PATCH', `${base()}/employees/${e7}`, { token: f.hrAdmin, body: { managerEmployeeId: e4, secondaryManagerEmployeeId: e5, effectiveFrom: DAY } });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ managerEmployeeId: e4, managerName: 'Employee 4', secondaryManagerEmployeeId: e5, secondaryManagerName: 'Employee 5' });
    // the primary cannot be moved onto the kept secondary later
    expect((await h.request('PATCH', `${base()}/employees/${e7}`, { token: f.hrAdmin, body: { managerEmployeeId: e5 } })).status).toBe(400);
    // clearing works with null
    const cleared = await h.request('PATCH', `${base()}/employees/${e7}`, { token: f.hrAdmin, body: { secondaryManagerEmployeeId: null } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.secondaryManagerEmployeeId).toBeNull();
    // e7 now reports to e4: the manager's team grew from 2 to 3 without any role change
    const me = await h.request('GET', '/api/v1/me', { token: lineManager });
    expect(me.body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId).teamSize).toBe(3);
    expect((await h.request('POST', `${base()}/attendance/corrections`, { token: lineManager, body: punch(e7, 'Now my report', '14:10') })).status).toBe(201);
  });
});

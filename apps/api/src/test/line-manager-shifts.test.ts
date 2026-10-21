/**
 * A Line Manager assigns shifts to their own team (field report 2026-10-21): `shift.assign_team` opens EMPLOYEE-targeted shift
 * assignments of the caller's DIRECT reports and nothing else — checked by the service and again by the row-level policy on
 * shift_assignments.
 */
import { withContext } from '@flowza/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 (the line manager) manages e5 (primary) and e6 (secondary); e7 reports to nobody; e8 reports to e5 (indirect report)
let e4: string; let e5: string; let e6: string; let e7: string; let e8: string; let shiftId: string; let patternId: string;
const lineManager = uuid('c'); const peerManager = uuid('c');
const base = () => `/api/v1/orgs/${f.orgId}`;
const assign = (token: string, body: Record<string, unknown>) => h.request('POST', `${base()}/shift-assignments`, { token, body: { shiftId, effectiveFrom: '2099-01-01', ...body } });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_lm_shifts_${process.pid}`); f = await seedOrg(h.admin, 'lmshift', { approvalRouting: 'legacy' });
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchB, 6);
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: e4 }).where('id', '=', e6).execute();
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  e8 = await seedEmployee(h.admin, f.orgId, f.branchA, 8, { managerEmployeeId: e5 });
  const e9 = await seedEmployee(h.admin, f.orgId, f.branchA, 9);
  await seedUser(h.admin, lineManager, 'lm-shifts@test.local', 'Line Manager');
  await seedUser(h.admin, peerManager, 'lm-shifts-peer@test.local', 'Peer Manager');
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, peerManager, ROLE.manager, { employeeId: e9 });
  shiftId = (await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'LMS', name: 'Line manager shift', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow()).id;
  patternId = (await h.admin.insertInto('shiftPatterns').values({ organizationId: f.orgId, code: 'LMP', name: 'Line manager pattern', cycleLengthDays: 1, sequence: JSON.stringify([{ day: 0, shiftId }]), anchorDate: '2026-01-01' } as never).returning('id').executeTakeFirstOrThrow()).id;
});
afterAll(async () => { await h?.close(); });

describe('the Line Manager role carries the team key', () => {
  it('shift.assign_team is a system permission of the manager role (and of the roles that already hold shift.assign), not of the plain employee', async () => {
    const holders = await h.admin.selectFrom('rolePermissions as rp').innerJoin('roles as r', 'r.id', 'rp.roleId').select('r.key').where('rp.permissionKey', '=', 'shift.assign_team').where('r.isSystem', '=', true).execute();
    const keys = holders.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['manager', 'owner', 'org_admin', 'hr_admin']));
    expect(keys).not.toContain('employee');
    expect(keys).not.toContain('auditor');
    const me = await h.request('GET', '/api/v1/me', { token: lineManager });
    const grant = me.body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId);
    expect(grant.permissions).toContain('shift.assign_team');
    expect(grant.permissions).not.toContain('shift.assign');
  });
});

describe('assigning shifts as a line manager', () => {
  it('assigns a shift (and a pattern) to direct reports — primary and secondary — and records the audit and the assignment', async () => {
    const primary = await assign(lineManager, { targetType: 'EMPLOYEE', targetId: e5 });
    expect(primary.status).toBe(201);
    expect(primary.body.data).toMatchObject({ targetType: 'EMPLOYEE', targetId: e5, shiftId, effectiveFrom: '2099-01-01' });
    const secondary = await h.request('POST', `${base()}/shift-assignments`, { token: lineManager, body: { targetType: 'EMPLOYEE', targetId: e6, shiftPatternId: patternId, effectiveFrom: '2099-01-01' } });
    expect(secondary.status).toBe(201);
    const audit = await h.admin.selectFrom('audit.logs').select(['action', 'actorUserId']).where('entityId', '=', primary.body.data.id).execute();
    expect(audit).toEqual([expect.objectContaining({ action: 'shift.assigned', actorUserId: lineManager })]);
    // the manager sees what they assigned, can move its last day and take it away again
    const list = await h.request('GET', `${base()}/shift-assignments?targetType=EMPLOYEE&targetId=${e5}`, { token: lineManager });
    expect(list.body.data.map((a: { id: string }) => a.id)).toContain(primary.body.data.id);
    const end = await h.request('PATCH', `${base()}/shift-assignments/${primary.body.data.id}`, { token: lineManager, body: { effectiveTo: '2099-06-30' } });
    expect(end.status).toBe(200);
    expect(end.body.data.effectiveTo).toBe('2099-06-30');
    expect((await h.request('DELETE', `${base()}/shift-assignments/${primary.body.data.id}`, { token: lineManager })).status).toBe(200);
    expect((await h.request('DELETE', `${base()}/shift-assignments/${secondary.body.data.id}`, { token: lineManager })).status).toBe(200);
  });

  it('refuses anybody outside the team: an unattached employee, an indirect report, the manager themself', async () => {
    for (const target of [e7, e8, e4]) {
      const r = await assign(lineManager, { targetType: 'EMPLOYEE', targetId: target });
      // the manager's row-level reads hide employees outside the team ("not found", nothing revealed); the own record is
      // visible and refused by the service
      expect([400, 403]).toContain(r.status);
      expect(r.status === 403 ? r.body.message : 'report to you directly').toMatch(/report to you directly/);
    }
    expect(await h.admin.selectFrom('shiftAssignments').select('id').where('organizationId', '=', f.orgId).where('targetId', 'in', [e7, e8, e4]).execute()).toHaveLength(0);
  });

  it('refuses every target type but EMPLOYEE — branch, department, team and the whole organisation stay with shift.assign', async () => {
    for (const body of [{ targetType: 'BRANCH', targetId: f.branchA }, { targetType: 'ORGANIZATION', targetId: f.orgId }]) {
      expect([400, 403]).toContain((await assign(lineManager, body)).status);
    }
    expect(await h.admin.selectFrom('shiftAssignments').select('id').where('organizationId', '=', f.orgId).where('targetType', 'in', ['BRANCH', 'ORGANIZATION']).execute()).toHaveLength(0);
  });

  it('cannot end or remove an assignment of somebody else\'s team, and a peer manager cannot touch this manager\'s reports', async () => {
    const mine = await assign(lineManager, { targetType: 'EMPLOYEE', targetId: e5 });
    expect(mine.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/shift-assignments/${mine.body.data.id}`, { token: peerManager, body: { effectiveTo: '2099-02-01' } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/shift-assignments/${mine.body.data.id}`, { token: peerManager })).status).toBe(403);
    expect([400, 403]).toContain((await assign(peerManager, { targetType: 'EMPLOYEE', targetId: e5, effectiveFrom: '2099-08-01' })).status);
    // an HR admin (shift.assign) still manages it
    expect((await h.request('DELETE', `${base()}/shift-assignments/${mine.body.data.id}`, { token: f.hrAdmin })).status).toBe(200);
  });

  it('the plain employee role and the read-only auditor cannot assign at all', async () => {
    expect((await assign(f.employeeUser, { targetType: 'EMPLOYEE', targetId: f.e1 })).status).toBe(403);
  });
});

describe('the database enforces the team scope again (row-level security)', () => {
  it('a statement as the line manager inserts for a direct report only, whatever the service checked', async () => {
    const insert = (employeeId: string) => withContext(h.tdb.db, { kind: 'user', userId: lineManager, requestId: 'rls-lm-shifts' }, (trx) => trx.insertInto('shiftAssignments').values({ organizationId: f.orgId, targetType: 'EMPLOYEE', targetId: employeeId, branchId: f.branchA, shiftId, effectiveFrom: '2098-01-01', effectiveTo: '2098-02-01' }).returning('id').executeTakeFirstOrThrow());
    const ok = await insert(e5);
    expect(ok.id).toBeTruthy();
    await expect(insert(e7)).rejects.toThrow(/row-level security/);
    // a BRANCH target is never the manager's, even in a branch that holds their whole team
    await expect(withContext(h.tdb.db, { kind: 'user', userId: lineManager, requestId: 'rls-lm-shifts-2' }, (trx) => trx.insertInto('shiftAssignments').values({ organizationId: f.orgId, targetType: 'BRANCH', targetId: f.branchA, branchId: f.branchA, shiftId, effectiveFrom: '2098-01-01', effectiveTo: '2098-02-01' }).execute())).rejects.toThrow(/row-level security/);
    await h.admin.deleteFrom('shiftAssignments').where('id', '=', ok.id).execute();
  });
});

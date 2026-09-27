/**
 * HR portal Prompt 1 — review fixes (docs/hr-portal/reports/01-roles-permissions.md §"Review fixes"):
 *  A. an employee who leaves (terminated / resigned / archived) loses every login linked to the record: memberships are
 *     suspended, pending invitations revoked, sessions ended (spy + the real auth.sessions rows), all audited — and the
 *     principal no longer carries the organisation, so every org route refuses the user;
 *  B. the reporting line refuses cycles (named 400 in the API, check violation in the database);
 *  C. GET /employees?unlinked=true needs user.view;
 *  D. the line manager reads their own record and their direct reports only (employee.view_team), not the directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { loadPrincipal } from '../lib/principal.js';
import { databaseSessionRevoker } from '../lib/sessions.js';
import type { SessionRevoker } from '../deps.js';
import { auditRows, createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
// e4 (the line manager's own record) manages e5 (primary) and e6 (secondary, other branch); e8 reports to e5; e7 to nobody
let e4: string; let e5: string; let e6: string; let e7: string; let e8: string;
const lineManager = uuid('c'); const auditor = uuid('c'); const orgAdmin = uuid('c');
const revokeSpy = vi.fn<SessionRevoker['revokeUserSessions']>((trx, input) => databaseSessionRevoker.revokeUserSessions(trx, input));
const base = () => `/api/v1/orgs/${f.orgId}`;
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
const EXIT = '2026-09-20';

/** A person with a login (role `roleId`) linked to a fresh employee record. */
async function personWithLogin(n: number, roleId: string, branch = f.branchA): Promise<{ employeeId: string; userId: string; membershipId: string }> {
  const employeeId = await seedEmployee(h.admin, f.orgId, branch, n);
  const userId = uuid('c');
  await seedUser(h.admin, userId, `person-${n}@test.local`, `Person ${n}`);
  const membershipId = await seedMembership(h.admin, f.orgId, userId, roleId, { employeeId });
  return { employeeId, userId, membershipId };
}
const membership = (id: string) => h.admin.selectFrom('orgMemberships').select(['status', 'employeeId']).where('id', '=', id).executeTakeFirstOrThrow();
const sessionsOf = async (userId: string) => Number((await sql<{ n: string }>`select count(*)::text as n from auth.sessions where user_id = ${userId}::uuid`.execute(h.admin)).rows[0]?.n);
const addSessions = (userId: string, n = 2) => sql`insert into auth.sessions (user_id) select ${userId}::uuid from generate_series(1, ${n})`.execute(h.admin);

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_roles_review_${process.pid}`); f = await seedOrg(h.admin, 'rolesreview');
  h.deps.sessions = { revokeUserSessions: revokeSpy };
  // the local shim has no Supabase Auth tables; this is the shape of auth.sessions that app.revoke_user_sessions deletes from
  await sql`create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, created_at timestamptz not null default now())`.execute(h.admin);
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  e6 = await seedEmployee(h.admin, f.orgId, f.branchB, 6);
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: e4 }).where('id', '=', e6).execute();
  e7 = await seedEmployee(h.admin, f.orgId, f.branchA, 7);
  e8 = await seedEmployee(h.admin, f.orgId, f.branchA, 8, { managerEmployeeId: e5 });
  await seedUser(h.admin, lineManager, 'line-manager-review@test.local', 'Line Manager');
  await seedUser(h.admin, auditor, 'auditor-review@test.local', 'Auditor');
  await seedUser(h.admin, orgAdmin, 'org-admin-review@test.local', 'Org Admin');
  await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, auditor, ROLE.auditor);
  await seedMembership(h.admin, f.orgId, orgAdmin, ROLE.org_admin);
});
afterAll(async () => { await h?.close(); });
beforeEach(() => { revokeSpy.mockClear(); });

describe('A. leaving the organisation ends every login linked to the employee record (B-75)', () => {
  it('PATCH employmentStatus=terminated suspends the membership (link kept), ends the sessions, audits, and closes the organisation', async () => {
    const p = await personWithLogin(20, ROLE.employee);
    await addSessions(p.userId, 2); await addSessions(f.owner, 1);
    const before = await loadPrincipal(h.tdb.db, p.userId, 'person-20@test.local');
    expect(before.principal.memberships.map((m) => m.organizationId)).toEqual([f.orgId]);
    expect((await h.request('GET', `${base()}/me/overview`, { token: p.userId })).status).toBe(200);

    const res = await h.request('PATCH', `${base()}/employees/${p.employeeId}`, { token: f.hrAdmin, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } });
    expect(res.status).toBe(200);
    expect(res.body.data.employmentStatus).toBe('terminated');
    expect(await membership(p.membershipId)).toEqual({ status: 'suspended', employeeId: p.employeeId });

    // the principal logic: the organisation is gone from the user's grants, so every org route refuses them
    const after = await loadPrincipal(h.tdb.db, p.userId, 'person-20@test.local');
    expect(after.principal.memberships).toEqual([]);
    const overview = await h.request('GET', `${base()}/me/overview`, { token: p.userId });
    expect(overview.status).toBe(403);
    expect(overview.body.message).toMatch(/not a member/);
    expect((await h.request('GET', '/api/v1/me', { token: p.userId })).body.data.memberships).toEqual([]);

    // sessions: the revoker was called for that user only, and the real function deleted their auth.sessions rows
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy.mock.calls[0]![1]).toMatchObject({ organizationId: f.orgId, userIds: [p.userId], reason: 'employee_left' });
    expect(await sessionsOf(p.userId)).toBe(0);
    expect(await sessionsOf(f.owner)).toBe(1);

    const audited = (await auditRows(h.admin, 'member.suspended')).find((r) => r.entityId === p.membershipId);
    expect(audited).toMatchObject({ actorUserId: f.hrAdmin, organizationId: f.orgId, oldValue: { status: 'active' } });
    expect(audited?.newValue).toMatchObject({ status: 'suspended', userId: p.userId, employeeId: p.employeeId, cause: 'employee_left', source: 'update', employmentStatus: 'terminated', sessionsRevoked: 2 });
  });

  it('re-activating the employee does NOT re-activate the login; the login can be re-activated only once the employee is back', async () => {
    const p = await personWithLogin(21, ROLE.employee);
    expect((await h.request('PATCH', `${base()}/employees/${p.employeeId}`, { token: f.hrAdmin, body: { employmentStatus: 'resigned', exitDate: EXIT, effectiveFrom: EXIT } })).status).toBe(200);
    expect((await membership(p.membershipId)).status).toBe('suspended');
    // while the employee is still gone, an administrator cannot bring the login back
    const early = await h.request('PATCH', `${base()}/members/${p.membershipId}`, { token: f.owner, body: { status: 'active' } });
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/left the organisation/);
    // HR re-activates the employee: the login stays suspended (explicit step)
    expect((await h.request('PATCH', `${base()}/employees/${p.employeeId}`, { token: f.hrAdmin, body: { employmentStatus: 'active', exitDate: null, effectiveFrom: '2026-09-25' } })).status).toBe(200);
    expect((await membership(p.membershipId)).status).toBe('suspended');
    expect((await h.request('PATCH', `${base()}/members/${p.membershipId}`, { token: f.owner, body: { status: 'active' } })).status).toBe(200);
    expect((await membership(p.membershipId)).status).toBe('active');
  });

  it('bulk set_status resigned suspends every linked login in one change and ends their sessions', async () => {
    const a = await personWithLogin(22, ROLE.employee); const b = await personWithLogin(23, ROLE.manager, f.branchB);
    const res = await h.request('POST', `${base()}/employees/bulk`, { token: f.hrAdmin, body: { action: 'set_status', employeeIds: [a.employeeId, b.employeeId, e7], employmentStatus: 'resigned', effectiveFrom: EXIT } });
    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(3);
    expect((await membership(a.membershipId)).status).toBe('suspended');
    expect((await membership(b.membershipId)).status).toBe('suspended');
    expect(revokeSpy.mock.calls.map((c) => c[1].userIds).flat().sort()).toEqual([a.userId, b.userId].sort());
    const audits = (await auditRows(h.admin, 'member.suspended')).filter((r) => r.entityId === a.membershipId || r.entityId === b.membershipId);
    expect(audits).toHaveLength(2);
    expect(audits.every((r) => (r.newValue as { source: string }).source === 'bulk_set_status')).toBe(true);
    // e7 has no login: nothing to end, and it is resigned like the others
    await h.admin.updateTable('employees').set({ employmentStatus: 'active', exitDate: null }).where('id', '=', e7).execute();
  });

  it('archiving (DELETE) the employee does the same, and revokes a pending invitation that would link the record', async () => {
    const p = await personWithLogin(24, ROLE.employee);
    const archivedOnly = await seedEmployee(h.admin, f.orgId, f.branchA, 25);
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'future-hire-review@test.local', roleId: ROLE.employee, employeeId: archivedOnly } });
    expect(inv.status).toBe(201);
    const del = await h.request('DELETE', `${base()}/employees/${p.employeeId}`, { token: f.hrAdmin, body: { exitDate: EXIT, reason: 'Contract ended' } });
    expect(del.status).toBe(200);
    expect(await membership(p.membershipId)).toEqual({ status: 'suspended', employeeId: p.employeeId });
    expect(revokeSpy.mock.calls[0]![1]).toMatchObject({ userIds: [p.userId], reason: 'employee_left' });
    expect((await auditRows(h.admin, 'member.suspended')).find((r) => r.entityId === p.membershipId)?.newValue).toMatchObject({ source: 'delete' });

    expect((await h.request('DELETE', `${base()}/employees/${archivedOnly}`, { token: f.hrAdmin, body: { exitDate: EXIT } })).status).toBe(200);
    expect(await h.admin.selectFrom('invitations').select('id').where('id', '=', inv.body.data.id).executeTakeFirst()).toBeUndefined();
    expect((await auditRows(h.admin, 'member.invitation_revoked')).some((r) => r.entityId === inv.body.data.id && (r.newValue as { cause: string }).cause === 'employee_left')).toBe(true);
    // the invitee cannot accept their way back in
    const invitee = uuid('c');
    await seedUser(h.admin, invitee, 'future-hire-review@test.local', 'Future Hire');
    expect((await h.request('POST', '/api/v1/invitations/accept', { token: `${invitee}:future-hire-review@test.local`, body: { token: inv.body.data.token } })).status).toBe(404);
  });

  it('keeps the rules of member suspension: only an owner ends an owner\'s login, and nobody ends their own', async () => {
    const coOwner = await personWithLogin(26, ROLE.owner);
    const hr = await h.request('PATCH', `${base()}/employees/${coOwner.employeeId}`, { token: f.hrAdmin, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } });
    expect(hr.status).toBe(403);
    // refused as a whole: the employee is NOT terminated and the login stays active
    expect((await h.admin.selectFrom('employees').select('employmentStatus').where('id', '=', coOwner.employeeId).executeTakeFirstOrThrow()).employmentStatus).toBe('active');
    expect((await membership(coOwner.membershipId)).status).toBe('active');
    expect(revokeSpy).not.toHaveBeenCalled();
    // an owner may end another owner's login (the organisation keeps an active owner)
    expect((await h.request('PATCH', `${base()}/employees/${coOwner.employeeId}`, { token: f.owner, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } })).status).toBe(200);
    expect((await membership(coOwner.membershipId)).status).toBe('suspended');
    // an HR admin whose own login is linked to the record cannot end it themselves
    const hrSelf = await personWithLogin(27, ROLE.hr_admin);
    const self = await h.request('PATCH', `${base()}/employees/${hrSelf.employeeId}`, { token: hrSelf.userId, body: { employmentStatus: 'resigned', exitDate: EXIT, effectiveFrom: EXIT } });
    expect(self.status).toBe(409);
    expect((await membership(hrSelf.membershipId)).status).toBe('active');
  });

  it('never links a login to somebody who left: invitation, member link and legacy invitations are refused', async () => {
    const gone = await seedEmployee(h.admin, f.orgId, f.branchA, 28, { employmentStatus: 'terminated' });
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'gone-review@test.local', roleId: ROLE.employee, employeeId: gone } });
    expect(inv.status).toBe(400);
    expect(inv.body.details.issues[0]).toMatchObject({ path: 'employeeId', message: 'Employee has left' });
    const auditorMembership = await h.admin.selectFrom('orgMemberships').select('id').where('userId', '=', auditor).executeTakeFirstOrThrow();
    expect((await h.request('PATCH', `${base()}/members/${auditorMembership.id}`, { token: f.owner, body: { employeeId: gone } })).status).toBe(400);
    // an invitation issued before its employee left (created before this rule): acceptance is refused
    const later = await seedEmployee(h.admin, f.orgId, f.branchA, 29);
    const legacy = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'legacy-review@test.local', roleId: ROLE.employee, employeeId: later } });
    expect(legacy.status).toBe(201);
    await h.admin.updateTable('employees').set({ employmentStatus: 'resigned' }).where('id', '=', later).execute(); // bypasses the service on purpose
    const invitee = uuid('c');
    await seedUser(h.admin, invitee, 'legacy-review@test.local', 'Legacy');
    const accept = await h.request('POST', '/api/v1/invitations/accept', { token: `${invitee}:legacy-review@test.local`, body: { token: legacy.body.data.token } });
    expect(accept.status).toBe(409);
    expect(await h.admin.selectFrom('orgMemberships').select('id').where('userId', '=', invitee).executeTakeFirst()).toBeUndefined();
  });

  it('member suspension and a role downgrade end the user\'s sessions too (same revoker)', async () => {
    const p = await personWithLogin(30, ROLE.hr_admin);
    await addSessions(p.userId, 1);
    expect((await h.request('PATCH', `${base()}/members/${p.membershipId}`, { token: f.owner, body: { roleId: ROLE.hr_user } })).status).toBe(200);
    expect(revokeSpy.mock.calls[0]![1]).toMatchObject({ userIds: [p.userId], reason: 'role_downgraded' });
    expect(await sessionsOf(p.userId)).toBe(0);
    revokeSpy.mockClear();
    // an upgrade ends nothing
    expect((await h.request('PATCH', `${base()}/members/${p.membershipId}`, { token: f.owner, body: { roleId: ROLE.hr_admin } })).status).toBe(200);
    expect(revokeSpy).not.toHaveBeenCalled();
    await addSessions(p.userId, 1);
    expect((await h.request('DELETE', `${base()}/members/${p.membershipId}`, { token: f.owner })).status).toBe(200);
    expect(revokeSpy.mock.calls[0]![1]).toMatchObject({ userIds: [p.userId], reason: 'member_suspended' });
    expect(await sessionsOf(p.userId)).toBe(0);
    expect((await auditRows(h.admin, 'member.suspended')).find((r) => r.entityId === p.membershipId)?.newValue).toMatchObject({ status: 'suspended', sessionsRevoked: 1 });
  });
});

describe('B. the reporting line cannot go round in a circle', () => {
  it('refuses a manager who already reports to the employee (primary and secondary links, any depth) with a named 400', async () => {
    const direct = await h.request('PATCH', `${base()}/employees/${e4}`, { token: f.hrAdmin, body: { managerEmployeeId: e5 } });
    expect(direct.status).toBe(400);
    expect(direct.body.details.issues).toEqual([{ path: 'managerEmployeeId', message: 'Reporting cycle' }]);
    // e8 → e5 → e4: e8 as e4's secondary manager would close a loop two levels up
    const deep = await h.request('PATCH', `${base()}/employees/${e4}`, { token: f.hrAdmin, body: { secondaryManagerEmployeeId: e8 } });
    expect(deep.status).toBe(400);
    expect(deep.body.details.issues).toEqual([{ path: 'secondaryManagerEmployeeId', message: 'Reporting cycle' }]);
    // e6 reports to e4 through the SECONDARY link only: still a loop
    expect((await h.request('PATCH', `${base()}/employees/${e4}`, { token: f.hrAdmin, body: { managerEmployeeId: e6 } })).status).toBe(400);
    // a branch-scoped HR user is refused too, although the chain leaves their branches
    const branchHr = uuid('c');
    await seedUser(h.admin, branchHr, 'branch-hr-review@test.local', 'Branch HR');
    await seedMembership(h.admin, f.orgId, branchHr, ROLE.hr_admin, { branchIds: [f.branchB] });
    expect((await h.request('PATCH', `${base()}/employees/${e6}`, { token: branchHr, body: { managerEmployeeId: e8 } })).status).toBe(400);
    // a link that closes no loop is accepted
    expect((await h.request('PATCH', `${base()}/employees/${e4}`, { token: f.hrAdmin, body: { managerEmployeeId: e7, effectiveFrom: EXIT } })).status).toBe(200);
    expect((await h.request('PATCH', `${base()}/employees/${e4}`, { token: f.hrAdmin, body: { managerEmployeeId: null, effectiveFrom: EXIT } })).status).toBe(200);
  });

  it('the database refuses a loop whatever writes it (trigger employees_no_manager_cycle)', async () => {
    const err = await sql`update public.employees set manager_employee_id = ${e8}::uuid where id = ${e4}::uuid`.execute(h.admin).then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
    expect(err).toMatchObject({ code: '23514', constraint: 'employees_no_manager_cycle' });
    const self = await sql`update public.employees set manager_employee_id = id where id = ${e7}::uuid`.execute(h.admin).then(() => null, (e: unknown) => e as { code?: string; constraint?: string });
    expect(self).toMatchObject({ code: '23514', constraint: 'employees_no_manager_cycle' });
  });
});

describe('C. which employees have a login is user-management knowledge', () => {
  it('GET /employees?unlinked=true needs user.view: manager and auditor 403, org admin 200', async () => {
    expect((await h.request('GET', `${base()}/employees?unlinked=true`, { token: lineManager })).status).toBe(403);
    expect((await h.request('GET', `${base()}/employees?unlinked=true`, { token: auditor })).status).toBe(403);
    const admin = await h.request('GET', `${base()}/employees?unlinked=true&pageSize=100`, { token: orgAdmin });
    expect(admin.status).toBe(200);
    // candidates for a login: not linked, not reserved, not somebody who left
    expect(admin.body.data.some((e: { id: string }) => e.id === e4)).toBe(false);
    expect(admin.body.data.every((e: { employmentStatus: string }) => !['terminated', 'resigned'].includes(e.employmentStatus))).toBe(true);
    // without the filter the auditor still reads the directory
    expect((await h.request('GET', `${base()}/employees`, { token: auditor })).status).toBe(200);
  });
});

describe('D. the line manager\'s directory is their own record plus their direct reports', () => {
  it('lists exactly own + direct reports, opens a report\'s profile, and gets 404 for anybody else', async () => {
    const list = await h.request('GET', `${base()}/employees?pageSize=100`, { token: lineManager });
    expect(list.status).toBe(200);
    expect(ids(list.body.data)).toEqual([e4, e5, e6].sort());
    expect(list.body.meta.total).toBe(3);
    expect(ids((await h.request('GET', `${base()}/employees?teamOf=${e4}`, { token: lineManager })).body.data)).toEqual([e5, e6].sort());
    // a branch filter narrows the same rows (e6 sits in branch B)
    expect(ids((await h.request('GET', `${base()}/employees?branchId=${f.branchB}`, { token: lineManager })).body.data)).toEqual([e6]);

    const profile = await h.request('GET', `${base()}/employees/${e5}`, { token: lineManager });
    expect(profile.status).toBe(200);
    expect(profile.body.data).toMatchObject({ id: e5, managerEmployeeId: e4, dateOfBirth: null, phone: null });
    expect((await h.request('GET', `${base()}/employees/${e6}/history`, { token: lineManager })).status).toBe(200);
    expect((await h.request('GET', `${base()}/employees/${e7}`, { token: lineManager })).status).toBe(404);
    expect((await h.request('GET', `${base()}/employees/${e8}`, { token: lineManager })).status).toBe(404); // a report's report
    expect((await h.request('GET', `${base()}/employees/${f.e2}/history`, { token: lineManager })).status).toBe(404);
  });

  it('a report who leaves drops out of the team, and a manager who leaves loses the organisation', async () => {
    const lead = await personWithLogin(40, ROLE.manager);
    const report = await seedEmployee(h.admin, f.orgId, f.branchA, 41, { managerEmployeeId: lead.employeeId });
    const other = await seedEmployee(h.admin, f.orgId, f.branchA, 42, { managerEmployeeId: lead.employeeId });
    const me = async () => (await h.request('GET', '/api/v1/me', { token: lead.userId })).body.data.memberships as Array<{ organization: { id: string }; teamSize: number }>;
    expect((await me())[0]).toMatchObject({ teamSize: 2 });
    expect((await h.request('PATCH', `${base()}/employees/${report}`, { token: f.hrAdmin, body: { employmentStatus: 'terminated', exitDate: EXIT, effectiveFrom: EXIT } })).status).toBe(200);
    expect((await me())[0]).toMatchObject({ teamSize: 1 });
    expect((await h.request('GET', `${base()}/employees/${report}`, { token: lead.userId })).status).toBe(404);
    expect((await h.request('GET', `${base()}/employees/${other}`, { token: lead.userId })).status).toBe(200);
    // the manager leaves: the login is suspended, so /me no longer lists the organisation
    expect((await h.request('PATCH', `${base()}/employees/${lead.employeeId}`, { token: f.hrAdmin, body: { employmentStatus: 'resigned', exitDate: EXIT, effectiveFrom: EXIT } })).status).toBe(200);
    expect(await me()).toEqual([]);
    expect((await h.request('GET', `${base()}/employees/${other}`, { token: lead.userId })).status).toBe(403);
  });
});

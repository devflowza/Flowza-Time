/**
 * Adversarial review regression suite: each test here reproduces a defect found in the security/correctness review
 * of the core API (default-clobbering PATCH schemas, query booleans, branch-scoped id allocation, role escalation,
 * import PIN redaction, MFA gate, invitation handling, sensitive-field masking, platform grant approvals).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import { withContext } from '@flowza/database';
import { withSystemScope } from '../lib/service.js';
import { createTestApi, F, EMAILS, type TestApi } from './harness.js';

let api: TestApi;
const scopedHr = 'a0000000-0000-0000-0000-000000000005'; // hr_user limited to branch B2
const membershipScopedHr = '0a000000-0000-0000-0000-0000000000a5';

beforeAll(async () => {
  api = await createTestApi('review');
  EMAILS[scopedHr] = 'hr-scoped-a@test.local';
  await sql`insert into auth.users (id, email) values (${scopedHr}::uuid, 'hr-scoped-a@test.local')`.execute(api.tdb.adminDb);
  await api.tdb.adminDb.insertInto('userProfiles').values({ id: scopedHr, email: 'hr-scoped-a@test.local', fullName: 'Scoped HR' }).execute();
  await api.tdb.adminDb.insertInto('orgMemberships').values({ id: membershipScopedHr, organizationId: F.orgA, userId: scopedHr, roleId: SYSTEM_ROLE_IDS.hr_user, status: 'active', allBranches: false, joinedAt: new Date() }).execute();
  await api.tdb.adminDb.insertInto('membershipBranches').values({ membershipId: membershipScopedHr, branchId: F.branchB2 }).execute();
}, 120_000);
afterAll(async () => { await api?.close(); });

describe('PATCH schemas must not re-apply creation defaults', () => {
  it('PATCH /orgs/:id with one field keeps timezone, weekly off days, contact and address', async () => {
    await api.tdb.adminDb.updateTable('organizations').set({ timezone: 'Asia/Dubai', weeklyOffDays: [4, 5], contact: JSON.stringify({ name: 'Ops desk' }) }).where('id', '=', F.orgA).execute();
    const res = await api.request('PATCH', `/orgs/${F.orgA}`, { user: F.ownerA, body: { displayName: 'Org A Renamed' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ displayName: 'Org A Renamed', timezone: 'Asia/Dubai', weeklyOffDays: [4, 5], contact: { name: 'Ops desk' } });
    await api.tdb.adminDb.updateTable('organizations').set({ timezone: 'Asia/Muscat', weeklyOffDays: [5, 6], contact: JSON.stringify({}) }).where('id', '=', F.orgA).execute();
  });

  it('PATCH branch/department/designation with one field keeps status, timezone and level', async () => {
    await api.tdb.adminDb.updateTable('branches').set({ timezone: 'Asia/Dubai', status: 'inactive' }).where('id', '=', F.branchB2).execute();
    const branch = await api.request('PATCH', `/orgs/${F.orgA}/branches/${F.branchB2}`, { user: F.ownerA, body: { city: 'Salalah' } });
    expect(branch.status).toBe(200);
    expect(branch.json.data).toMatchObject({ city: 'Salalah', timezone: 'Asia/Dubai', status: 'inactive', countryCode: 'OM' });
    await api.tdb.adminDb.updateTable('branches').set({ timezone: 'Asia/Muscat', status: 'active' }).where('id', '=', F.branchB2).execute();

    await api.tdb.adminDb.updateTable('departments').set({ status: 'archived' }).where('id', '=', F.deptSales).execute();
    const dept = await api.request('PATCH', `/orgs/${F.orgA}/departments/${F.deptSales}`, { user: F.ownerA, body: { nameAr: 'المبيعات' } });
    expect(dept.status).toBe(200);
    expect(dept.json.data.status).toBe('archived'); // PATCH must not silently un-archive
    await api.tdb.adminDb.updateTable('departments').set({ status: 'active' }).where('id', '=', F.deptSales).execute();

    const desig = await api.request('PATCH', `/orgs/${F.orgA}/designations/${F.desigEng}`, { user: F.ownerA, body: { name: 'Senior Engineer' } });
    expect(desig.status).toBe(200);
    expect(desig.json.data).toMatchObject({ name: 'Senior Engineer', level: 3, status: 'active' });
  });

  it('PATCH employee with one field keeps employment status/type/gender and writes no history transition', async () => {
    await api.tdb.adminDb.updateTable('employees').set({ employmentStatus: 'suspended', employmentType: 'contract', gender: 'female' }).where('id', '=', F.empE2).execute();
    await api.tdb.adminDb.updateTable('employmentHistory').set({ employmentStatus: 'suspended', employmentType: 'contract' }).where('employeeId', '=', F.empE2).execute();
    const res = await api.request('PATCH', `/orgs/${F.orgA}/employees/${F.empE2}`, { user: F.ownerA, body: { cardNumber: 'CARD-2' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ cardNumber: 'CARD-2', employmentStatus: 'suspended', employmentType: 'contract', gender: 'female' });
    const history = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE2}/history`, { user: F.ownerA });
    expect(history.json.data).toHaveLength(1);
    await api.tdb.adminDb.updateTable('employees').set({ employmentStatus: 'active', employmentType: 'full_time', gender: 'unspecified' }).where('id', '=', F.empE2).execute();
    await api.tdb.adminDb.updateTable('employmentHistory').set({ employmentStatus: 'active', employmentType: 'full_time' }).where('employeeId', '=', F.empE2).execute();
  });
});

describe('query booleans', () => {
  it('includeDeleted=false / unreadOnly=false / activeOnly=false are false', async () => {
    const deleted = '0a000000-0000-0000-0000-0000000000e9';
    await api.tdb.adminDb.insertInto('employees').values({ id: deleted, organizationId: F.orgA, employeeNumber: 'E-DEL', firstName: 'Gone', lastName: 'Away', displayName: 'Gone Away', joiningDate: '2025-01-01', branchId: F.branchHQ, deviceUserId: '99', deletedAt: new Date(), employmentStatus: 'terminated' }).execute();
    const off = await api.request('GET', `/orgs/${F.orgA}/employees?includeDeleted=false`, { user: F.ownerA });
    expect(off.json.data.map((e: any) => e.employeeNumber)).not.toContain('E-DEL');
    const on = await api.request('GET', `/orgs/${F.orgA}/employees?includeDeleted=true`, { user: F.ownerA });
    expect(on.json.data.map((e: any) => e.employeeNumber)).toContain('E-DEL');
    await api.tdb.adminDb.insertInto('notifications').values({ organizationId: F.orgA, userId: F.ownerA, category: 'SYSTEM', type: 'x', title: 'Read one', readAt: new Date() }).execute();
    const all = await api.request('GET', '/me/notifications?unreadOnly=false', { user: F.ownerA });
    expect(all.json.meta.total).toBe(1);
    const unread = await api.request('GET', '/me/notifications?unreadOnly=true', { user: F.ownerA });
    expect(unread.json.meta.total).toBe(0);
  });
});

describe('branch-scoped callers', () => {
  it('auto device_user_id is allocated org-wide even when the creator only sees one branch', async () => {
    const res = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: scopedHr, body: { employeeNumber: 'E-SCOPED', firstName: 'Scoped', lastName: 'Hire', joiningDate: '2026-03-01', branchId: F.branchB2 } });
    expect(res.status).toBe(201);
    expect(Number(res.json.data.deviceUserId)).toBeGreaterThanOrEqual(100); // 99 is taken by a (hidden) HQ employee
    const foreignBranch = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: scopedHr, body: { employeeNumber: 'E-SCOPED-2', firstName: 'Scoped', lastName: 'Hire', joiningDate: '2026-03-01', branchId: F.branchHQ } });
    expect(foreignBranch.status).toBe(403);
  });

  it('cannot create org-wide (branch-less) departments or teams', async () => {
    await api.tdb.adminDb.insertInto('rolePermissions').values({ roleId: SYSTEM_ROLE_IDS.hr_user, permissionKey: 'department.manage' }).onConflict((oc) => oc.doNothing()).execute();
    const dept = await api.request('POST', `/orgs/${F.orgA}/departments`, { user: scopedHr, body: { code: 'GLOBAL', name: 'Global' } });
    expect(dept.status).toBe(403);
    const team = await api.request('POST', `/orgs/${F.orgA}/teams`, { user: scopedHr, body: { code: 'T-GLOBAL', name: 'Global team', branchId: null } });
    expect(team.status).toBe(403);
    const ok = await api.request('POST', `/orgs/${F.orgA}/departments`, { user: scopedHr, body: { code: 'B2-OPS', name: 'B2 Ops', branchId: F.branchB2 } });
    expect(ok.status).toBe(201);
    await api.tdb.adminDb.deleteFrom('rolePermissions').where('roleId', '=', SYSTEM_ROLE_IDS.hr_user).where('permissionKey', '=', 'department.manage').execute();
  });

  it('masks date of birth and phone for callers without employee.view_sensitive', async () => {
    await api.tdb.adminDb.updateTable('employees').set({ dateOfBirth: '1990-05-05', phone: '+968 9111 1111' }).where('id', '=', F.empE2).execute();
    const owner = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE2}`, { user: F.ownerA });
    expect(owner.json.data).toMatchObject({ dateOfBirth: '1990-05-05', phone: '+968 9111 1111' });
    const hr = await api.request('GET', `/orgs/${F.orgA}/employees/${F.empE2}`, { user: F.hrUserA });
    expect(hr.json.data).toMatchObject({ dateOfBirth: null, phone: null });
    const list = await api.request('GET', `/orgs/${F.orgA}/employees?search=sara`, { user: F.branchManagerA });
    expect(list.json.data[0]).toMatchObject({ employeeNumber: 'E-002', dateOfBirth: null, phone: null });
  });
});

describe('withSystemScope', () => {
  it('sees the whole organisation inside the scope and restores the caller role, claims and RLS afterwards', async () => {
    await withContext(api.tdb.db, { kind: 'user', userId: scopedHr, requestId: 'req_scope' }, async (trx) => {
      const before = await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', F.orgA).executeTakeFirstOrThrow();
      const inside = await withSystemScope(trx, F.orgA, async (t) => {
        const who = await sql<{ role: string; isSystem: boolean }>`select current_user as role, app.is_system() as is_system`.execute(t);
        const n = await t.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', F.orgA).executeTakeFirstOrThrow();
        return { ...who.rows[0]!, n: Number(n.n) };
      });
      expect(inside).toMatchObject({ role: 'flowza_system', isSystem: true });
      expect(inside.n).toBeGreaterThan(Number(before.n));
      const after = await sql<{ role: string; uid: string | null; isSystem: boolean }>`select current_user as role, app.uid()::text as uid, app.is_system() as is_system`.execute(trx);
      expect(after.rows[0]).toMatchObject({ role: 'authenticated', uid: scopedHr, isSystem: false });
      const again = await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', F.orgA).executeTakeFirstOrThrow();
      expect(Number(again.n)).toBe(Number(before.n));
      // a failing scoped query still restores the caller scope
      await expect(withSystemScope(trx, F.orgA, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      expect((await sql<{ role: string }>`select current_user as role`.execute(trx)).rows[0]?.role).toBe('authenticated');
    });
  });
});

describe('role assignment cannot escalate privileges', () => {
  it('a user.manage holder cannot assign a role carrying permissions they do not hold', async () => {
    const promote = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipHrA}`, { user: F.ownerA, body: { roleId: SYSTEM_ROLE_IDS.org_admin } });
    expect(promote.status).toBe(200);
    // org_admin lacks payroll.finalize → cannot hand out the payroll role
    const escalate = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipBmA}`, { user: F.hrUserA, body: { roleId: SYSTEM_ROLE_IDS.payroll } });
    expect(escalate.status).toBe(403);
    const invite = await api.request('POST', `/orgs/${F.orgA}/invitations`, { user: F.hrUserA, body: { email: 'payroll@test.local', roleId: SYSTEM_ROLE_IDS.payroll } });
    expect(invite.status).toBe(403);
    const fine = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipBmA}`, { user: F.hrUserA, body: { roleId: SYSTEM_ROLE_IDS.hr_user, allBranches: true } });
    expect(fine.status).toBe(200);
    // owners hold everything and may assign any role
    const byOwner = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipBmA}`, { user: F.ownerA, body: { roleId: SYSTEM_ROLE_IDS.branch_manager, allBranches: false, branchIds: [F.branchB2] } });
    expect(byOwner.status).toBe(200);
    await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipHrA}`, { user: F.ownerA, body: { roleId: SYSTEM_ROLE_IDS.hr_user } });
  });
});

describe('invitations', () => {
  it('accept binds to the invitee email, rejects tampered and expired tokens, and is single use', async () => {
    const res = await api.request('POST', `/orgs/${F.orgA}/invitations`, { user: F.ownerA, body: { email: 'invitee@test.local', roleId: SYSTEM_ROLE_IDS.hr_user } });
    expect(res.status).toBe(201);
    const token: string = res.json.data.token;
    const [orgPart, secret] = token.split('.') as [string, string];
    const tampered = `${orgPart}.${secret.slice(0, -1)}${secret.endsWith('a') ? 'b' : 'a'}`;
    expect((await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token: tampered } })).status).toBe(404);
    expect((await api.request('POST', '/invitations/accept', { user: F.ownerB, body: { token } })).status).toBe(403);
    await api.tdb.adminDb.updateTable('invitations').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', res.json.data.id).execute();
    expect((await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token } })).status).toBe(409);
    await api.tdb.adminDb.updateTable('invitations').set({ expiresAt: new Date(Date.now() + 86_400_000) }).where('id', '=', res.json.data.id).execute();
    expect((await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token } })).status).toBe(200);
    expect((await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token } })).status).toBe(409);
    const listed = await api.request('GET', `/orgs/${F.orgA}/invitations`, { user: F.ownerA });
    expect(JSON.stringify(listed.json)).not.toContain(secret);
  });
});

describe('imports', () => {
  it('never stores a PIN in clear (valid or invalid rows) and rejects duplicate headers', async () => {
    const csv = 'employeeNumber,firstName,lastName,joiningDate,branchCode,pin\nI-1,Ok,Row,2026-01-01,A-HQ,1234\nI-2,Bad,Row,not-a-date,A-HQ,5678\n';
    const res = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'pins.csv', contentBase64: Buffer.from(csv).toString('base64') } });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ validRows: 1, errorRows: 1 });
    const rows = await api.tdb.adminDb.selectFrom('importJobRows').select(['data']).where('importJobId', '=', res.json.data.id).execute();
    const stored = JSON.stringify(rows.map((r) => r.data));
    expect(stored).not.toContain('1234');
    expect(stored).not.toContain('5678');
    expect(JSON.stringify(res.json)).not.toContain('5678');
    const dup = 'employeeNumber,firstName,lastName,joiningDate,branchCode,first_name\nI-3,A,B,2026-01-01,A-HQ,C\n';
    const dupRes = await api.request('POST', `/orgs/${F.orgA}/employees/imports`, { user: F.ownerA, body: { fileName: 'dup.csv', contentBase64: Buffer.from(dup).toString('base64') } });
    expect(dupRes.status).toBe(400);
  });
});

describe('MFA enforcement', () => {
  it('platform admins need aal2; organisations with security.mfaRequired reject aal1 sessions', async () => {
    const weak = await api.request('GET', '/platform/orgs', { user: F.platformAdmin, aal: 'aal1' });
    expect(weak.status).toBe(403);
    expect(weak.json.details?.reason).toBe('MFA_REQUIRED');
    expect((await api.request('GET', '/platform/orgs', { user: F.platformAdmin, aal: 'aal2' })).status).toBe(200);

    expect((await api.request('PUT', `/orgs/${F.orgB}/settings/security`, { user: F.ownerB, body: { mfaRequired: true } })).status).toBe(200);
    const blocked = await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.ownerB, aal: 'aal1' });
    expect(blocked.status).toBe(403);
    expect(blocked.json.details?.reason).toBe('MFA_REQUIRED');
    expect((await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.ownerB, aal: 'aal2' })).status).toBe(200);
    // /me stays reachable so the UI can prompt for MFA enrolment
    expect((await api.request('GET', '/me', { user: F.ownerB, aal: 'aal1' })).status).toBe(200);
    expect((await api.request('PUT', `/orgs/${F.orgB}/settings/security`, { user: F.ownerB, aal: 'aal2', body: { mfaRequired: false } })).status).toBe(200);
  });
});

describe('platform grants', () => {
  it('the approver of a write grant must differ from both the grantee and the granter', async () => {
    const other = 'c0000000-0000-0000-0000-000000000002';
    await sql`insert into auth.users (id, email) values (${other}::uuid, 'platform2@test.local')`.execute(api.tdb.adminDb);
    await api.tdb.adminDb.insertInto('userProfiles').values({ id: other, email: 'platform2@test.local', fullName: 'Platform Two' }).execute();
    await api.tdb.adminDb.insertInto('platformAdmins').values({ userId: other, level: 'support' }).execute();
    const selfApproved = await api.request('POST', '/platform/access-grants', { user: F.platformAdmin, body: { organizationId: F.orgB, accessLevel: 'write', reason: 'Ticket 999 data repair', platformAdminUserId: other, approvedBy: F.platformAdmin } });
    expect(selfApproved.status).toBe(400);
    const ok = await api.request('POST', '/platform/access-grants', { user: F.platformAdmin, body: { organizationId: F.orgB, accessLevel: 'write', reason: 'Ticket 999 data repair', approvedBy: other, hours: 2 } });
    expect(ok.status).toBe(201);
    expect(ok.json.data).toMatchObject({ accessLevel: 'write', approvedBy: other });
  });
});

describe('employee deletion', () => {
  it('soft delete marks device states undesired inside the same transaction', async () => {
    const id = '0a000000-0000-0000-0000-0000000000e8';
    await api.tdb.adminDb.insertInto('employees').values({ id, organizationId: F.orgA, employeeNumber: 'E-DEL2', firstName: 'To', lastName: 'Delete', displayName: 'To Delete', joiningDate: '2025-01-01', branchId: F.branchHQ, deviceUserId: '98' }).execute();
    await api.tdb.adminDb.insertInto('deviceEmployeeStates').values({ organizationId: F.orgA, deviceId: F.deviceA, employeeId: id, branchId: F.branchHQ, deviceUserId: '98', syncStatus: 'IN_SYNC' }).execute();
    const res = await api.request('DELETE', `/orgs/${F.orgA}/employees/${id}`, { user: F.ownerA, body: { reason: 'Left' } });
    expect(res.status).toBe(200);
    const state = await api.tdb.adminDb.selectFrom('deviceEmployeeStates').select('desired').where('employeeId', '=', id).executeTakeFirstOrThrow();
    expect(state.desired).toBe(false);
  });
});

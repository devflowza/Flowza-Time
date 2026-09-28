/**
 * Members, invitations and FlowZa Time access — regression tests for the adversarial review of Prompt 5 / 6b
 * (docs/hr-portal/reviews/05-manager-workspace-review.md). Every test is named after the defect it pins:
 *   5-P0-1  a branch-scoped user admin never reaches every branch (own membership, invitations, the access card);
 *   5-P0-2  a portal invitation goes only to an address the administrator chose, with its provenance shown and recorded;
 *   5-P0-3  a lower user admin never suspends, restores, resends or revokes a more privileged member or invitation;
 *   5-P1-2  an old invitation stays reachable behind any number of newer rows (indexed hash lookup);
 *   5-P1-5  deleting a role counts its open invitations whatever the caller may read, and audits the closed ones removed;
 *   5-P2-7  the public validate answers the same 404 for malformed and unknown tokens;
 *   5-P2-9  accepting is atomic: concurrent accepts create one membership and one audit row.
 * The legitimate paths of an organisation-wide (and a properly scoped) user admin are pinned alongside.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomToken, sha256Hex } from '@flowza/shared';
import { auditRows, createApiHarness, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
const validate = (token: string, ip = '203.0.113.40') => h.request('POST', '/api/v1/invitations/validate', { headers: { 'x-forwarded-for': ip }, body: { token } });
const accept = (userId: string, email: string, token: string) => h.request('POST', '/api/v1/invitations/accept', { token: `${userId}:${email}`, body: { token } });
const membershipOf = async (userId: string) => h.admin.selectFrom('orgMemberships').select(['id', 'status', 'allBranches', 'roleId']).where('organizationId', '=', f.orgId).where('userId', '=', userId).executeTakeFirstOrThrow();

// the reviewer's caller: a custom `user_admin_b` role (user.* + employee.view/update, nothing else) scoped to branch B
const UA_PERMISSIONS = ['user.view', 'user.manage', 'employee.view', 'employee.update', 'dashboard.view'];
// a branch-scoped user admin who also holds every permission of the `employee` role (so may hand it out)
const EMPLOYEE_ROLE_PERMISSIONS = ['attendance.checkin', 'attendance.note', 'attendance.request_correction', 'attendance.view_own', 'holiday.view', 'leave.request', 'shift.request_swap'];
let roleUA: string; let roleBUA: string;
const uaB = uuid('c'); const buaB = uuid('c'); const orgAdmin = uuid('c'); const adminB = uuid('c'); const staffB = uuid('c'); const roleAdmin = uuid('c');
let msUaB: string; let msAdminB: string; let msStaffB: string;
let eB: string; let eB2: string; let eB3: string;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_members_review_${process.pid}`, { config: { DATABASE_POOL_MAX: 10 } });
  f = await seedOrg(h.admin, 'mrev');
  await sql`create table if not exists auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, created_at timestamptz not null default now())`.execute(h.admin);
  const ua = await h.request('POST', `${base()}/roles`, { token: f.owner, body: { key: 'user_admin_b', name: 'User admin (branch)', permissions: UA_PERMISSIONS } });
  expect(ua.status).toBe(201); roleUA = ua.body.data.id;
  const bua = await h.request('POST', `${base()}/roles`, { token: f.owner, body: { key: 'branch_user_admin', name: 'Branch user admin', permissions: [...UA_PERMISSIONS, ...EMPLOYEE_ROLE_PERMISSIONS] } });
  expect(bua.status).toBe(201); roleBUA = bua.body.data.id;
  const ra = await h.request('POST', `${base()}/roles`, { token: f.owner, body: { key: 'role_admin', name: 'Role admin', permissions: ['role.manage', 'dashboard.view'] } });
  expect(ra.status).toBe(201);
  eB = await seedEmployee(h.admin, f.orgId, f.branchB, 60);
  eB2 = await seedEmployee(h.admin, f.orgId, f.branchB, 61);
  eB3 = await seedEmployee(h.admin, f.orgId, f.branchB, 62);
  for (const [id, key] of [[uaB, 'ua-b'], [buaB, 'bua-b'], [orgAdmin, 'org-admin'], [adminB, 'admin-b'], [staffB, 'staff-b'], [roleAdmin, 'role-admin']] as const) await seedUser(h.admin, id, `${key}-mrev@test.local`, key);
  msUaB = await seedMembership(h.admin, f.orgId, uaB, roleUA, { branchIds: [f.branchB] });
  await seedMembership(h.admin, f.orgId, buaB, roleBUA, { branchIds: [f.branchB] });
  await seedMembership(h.admin, f.orgId, orgAdmin, ROLE.org_admin);
  // the more privileged member of the P0-3 probe: an org admin whose login is scoped to branch B and linked to eB
  msAdminB = await seedMembership(h.admin, f.orgId, adminB, ROLE.org_admin, { branchIds: [f.branchB], employeeId: eB });
  msStaffB = await seedMembership(h.admin, f.orgId, staffB, ROLE.employee, { branchIds: [f.branchB], employeeId: eB3 });
  await seedMembership(h.admin, f.orgId, roleAdmin, ra.body.data.id);
});
afterAll(async () => { await h?.close(); });

describe('5-P0-1 branch scope of user administration', () => {
  it('5-P0-1 a branch-scoped user admin cannot give themselves every branch — nobody changes their own membership', async () => {
    const r = await h.request('PATCH', `${base()}/members/${msUaB}`, { token: uaB, body: { allBranches: true } });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/your own membership/);
    // nor their own role or status, through either route
    expect((await h.request('PATCH', `${base()}/members/${msUaB}`, { token: uaB, body: { roleId: ROLE.hr_admin } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/members/${msUaB}`, { token: uaB, body: { branchIds: [f.branchA, f.branchB] } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/members/${msUaB}`, { token: uaB })).status).toBe(403);
    const me = await h.request('GET', '/api/v1/me', { token: uaB });
    expect(me.body.data.memberships.find((m: { organization: { id: string } }) => m.organization.id === f.orgId)).toMatchObject({ allBranches: false, branchIds: [f.branchB] });
    expect(await membershipOf(uaB)).toMatchObject({ status: 'active', allBranches: false });
  });

  it('5-P0-1 a branch-scoped user admin never manages a member of another branch — even one whose role they could grant', async () => {
    // the caller holds no branch.view: the member's branches are judged as stored, not as the caller can read them
    const peerA = uuid('c');
    await seedUser(h.admin, peerA, 'peer-a-mrev@test.local', 'peer-a');
    const msPeerA = await seedMembership(h.admin, f.orgId, peerA, roleUA, { branchIds: [f.branchA] });
    const r = await h.request('DELETE', `${base()}/members/${msPeerA}`, { token: uaB });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/outside your access scope/);
    expect((await h.request('PATCH', `${base()}/members/${msPeerA}`, { token: uaB, body: { branchIds: [f.branchB] } })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/members/${msPeerA}`, { token: uaB, body: { status: 'suspended' } })).status).toBe(403);
    expect(await membershipOf(peerA)).toMatchObject({ status: 'active', allBranches: false });
  });

  it('5-P0-1 a branch-scoped user admin cannot invite to every branch; left out, the scope is their own', async () => {
    const all = await h.request('POST', `${base()}/invitations`, { token: uaB, body: { email: 'all-branches@test.local', roleId: roleUA, allBranches: true } });
    expect(all.status).toBe(403);
    expect(all.body.message).toMatch(/every branch/);
    // the schema no longer defaults to every branch: the caller's own scope applies
    const mine = await h.request('POST', `${base()}/invitations`, { token: uaB, body: { email: 'own-scope@test.local', roleId: roleUA } });
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ allBranches: false, branchIds: [f.branchB] });
    // the controls of the review still hold
    expect((await h.request('POST', `${base()}/invitations`, { token: uaB, body: { email: 'a@test.local', roleId: roleUA, allBranches: false, branchIds: [f.branchA] } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/invitations`, { token: uaB, body: { email: 'b@test.local', roleId: ROLE.org_admin, allBranches: false, branchIds: [f.branchB] } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/invitations`, { token: uaB, body: { email: 'c@test.local', roleId: ROLE.owner, allBranches: false, branchIds: [f.branchB] } })).status).toBe(403);
    expect(await h.admin.selectFrom('invitations').select('id').where('organizationId', '=', f.orgId).where('allBranches', '=', true).where('invitedBy', '=', uaB).execute()).toEqual([]);
  });

  it('5-P0-1 the employee access card cannot grant every branch either', async () => {
    const r = await h.request('POST', `${base()}/employees/${eB2}/portal-access/invite`, { token: uaB, body: { email: 'eb2@test.local', roleId: roleUA, allBranches: true } });
    expect(r.status).toBe(403);
    const ok = await h.request('POST', `${base()}/employees/${eB2}/portal-access/invite`, { token: uaB, body: { email: 'eb2@test.local', roleId: roleUA } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.invitation).toMatchObject({ allBranches: false, branchIds: [f.branchB], employeeId: eB2 });
  });

  it('5-P0-1 an organisation-wide user admin keeps every legitimate path; a scoped one keeps theirs', async () => {
    const wide = await h.request('POST', `${base()}/invitations`, { token: orgAdmin, body: { email: 'wide@test.local', roleId: ROLE.hr_user, allBranches: true } });
    expect(wide.status).toBe(201);
    expect(wide.body.data).toMatchObject({ allBranches: true, branchIds: [] });
    // left out, an organisation-wide admin's own scope is every branch (the previous default)
    const dflt = await h.request('POST', `${base()}/invitations`, { token: orgAdmin, body: { email: 'wide-default@test.local', roleId: ROLE.hr_user } });
    expect(dflt.body.data).toMatchObject({ allBranches: true, branchIds: [] });
    const target = uuid('c');
    await seedUser(h.admin, target, 'target-mrev@test.local', 'Target');
    const ms = await seedMembership(h.admin, f.orgId, target, ROLE.hr_user);
    expect((await h.request('PATCH', `${base()}/members/${ms}`, { token: orgAdmin, body: { allBranches: false, branchIds: [f.branchA] } })).body.data).toMatchObject({ allBranches: false, branchIds: [f.branchA] });
    expect((await h.request('PATCH', `${base()}/members/${ms}`, { token: orgAdmin, body: { allBranches: true } })).body.data).toMatchObject({ allBranches: true });
    expect((await h.request('DELETE', `${base()}/members/${ms}`, { token: orgAdmin })).body.data.status).toBe('suspended');
    expect((await h.request('PATCH', `${base()}/members/${ms}`, { token: orgAdmin, body: { status: 'active' } })).body.data.status).toBe('active');
    const card = await h.request('POST', `${base()}/employees/${f.e2}/portal-access/invite`, { token: orgAdmin, body: { email: 'e2-card@test.local', allBranches: true } });
    expect(card.status).toBe(201);
    // a branch-scoped admin who holds the employee role's permissions invites and manages inside their branch
    const scoped = await h.request('POST', `${base()}/invitations`, { token: buaB, body: { email: 'scoped-employee@test.local', roleId: ROLE.employee } });
    expect(scoped.status).toBe(201);
    expect(scoped.body.data).toMatchObject({ roleId: ROLE.employee, allBranches: false, branchIds: [f.branchB] });
    expect((await h.request('DELETE', `${base()}/members/${msStaffB}`, { token: buaB })).body.data.status).toBe('suspended');
    expect((await h.request('PATCH', `${base()}/members/${msStaffB}`, { token: buaB, body: { status: 'active' } })).status).toBe(200);
    // … but never a member with access to every branch (the seeded employee login is organisation-wide)
    const wideMember = await membershipOf(f.employeeUser);
    expect(wideMember.allBranches).toBe(true);
    const refused = await h.request('DELETE', `${base()}/members/${wideMember.id}`, { token: buaB });
    expect(refused.status).toBe(403);
  });
});

describe('5-P0-2 the invitation address', () => {
  it('5-P0-2 a portal invitation never goes to an address the admin did not choose; an address changed by someone else is flagged', async () => {
    const eV = await seedEmployee(h.admin, f.orgId, f.branchA, 50);
    // 1. an hr_user (employee.update, no user.* key) points the personal e-mail field at their own mailbox
    const patch = await h.request('PATCH', `${base()}/employees/${eV}`, { token: f.hrUser, body: { customFields: { personalEmail: 'attacker@evil.test' } } });
    expect(patch.status).toBe(200);
    // 2. the owner's card offers the address as a CHOICE, with where it comes from and who changed it when — flagged
    const card = await h.request('GET', `${base()}/employees/${eV}/portal-access`, { token: f.owner });
    expect(card.status).toBe(200);
    expect(card.body.data).not.toHaveProperty('suggestedEmail');
    expect(card.body.data.addresses).toEqual([{ email: 'attacker@evil.test', source: 'personal', changedAt: expect.any(String), changedByUserId: f.hrUser, changedByName: 'hrUser', recentlyChangedByOther: true }]);
    // 3. the one-click default is gone: an invitation without an address is refused and nothing is issued or mailed
    const blind = await h.request('POST', `${base()}/employees/${eV}/portal-access/invite`, { token: f.owner, body: {} });
    expect(blind.status).toBe(400);
    expect(await h.admin.selectFrom('invitations').select('id').where('employeeId', '=', eV).execute()).toEqual([]);
    // 4. only an explicit choice issues it — and the audit row says where the address came from and who last changed it
    const chosen = await h.request('POST', `${base()}/employees/${eV}/portal-access/invite`, { token: f.owner, body: { email: 'attacker@evil.test' } });
    expect(chosen.status).toBe(201);
    const invited = (await auditRows(h.admin, 'member.invited')).find((a) => a.entityId === chosen.body.data.invitation.id);
    expect(invited!.newValue).toMatchObject({ source: 'employee_profile', addressSource: 'personal', addressChangedBy: f.hrUser, addressChangedAt: expect.any(String) });
  });

  it('5-P0-2 the work e-mail field is treated the same way (probe W2); the admin\'s own change and a typed address are told apart', async () => {
    const eW = await seedEmployee(h.admin, f.orgId, f.branchA, 51);
    expect((await h.request('PATCH', `${base()}/employees/${eW}`, { token: f.hrUser, body: { email: 'attacker2@evil.test' } })).status).toBe(200);
    const card = (await h.request('GET', `${base()}/employees/${eW}/portal-access`, { token: f.owner })).body.data;
    expect(card.addresses).toEqual([expect.objectContaining({ email: 'attacker2@evil.test', source: 'work', changedByUserId: f.hrUser, recentlyChangedByOther: true })]);
    // a change the reader made themselves is not flagged for them — it is for the next reader
    expect((await h.request('PATCH', `${base()}/employees/${eW}`, { token: f.owner, body: { customFields: { personalEmail: 'w.personal@test.local' } } })).status).toBe(200);
    const own = (await h.request('GET', `${base()}/employees/${eW}/portal-access`, { token: f.owner })).body.data.addresses;
    expect(own.find((a: { source: string }) => a.source === 'personal')).toMatchObject({ email: 'w.personal@test.local', changedByUserId: f.owner, recentlyChangedByOther: false });
    const other = (await h.request('GET', `${base()}/employees/${eW}/portal-access`, { token: f.hrAdmin })).body.data.addresses;
    expect(other.find((a: { source: string }) => a.source === 'personal')).toMatchObject({ recentlyChangedByOther: true });
    // an address the administrator typed in is recorded as entered
    const typed = await h.request('POST', `${base()}/employees/${eW}/portal-access/invite`, { token: f.owner, body: { email: 'typed-in@test.local' } });
    expect(typed.status).toBe(201);
    const row = (await auditRows(h.admin, 'member.invited')).find((a) => a.entityId === typed.body.data.invitation.id);
    expect(row!.newValue).toMatchObject({ addressSource: 'entered', addressChangedBy: null });
  });
});

describe('5-P0-3 more privileged members', () => {
  it('5-P0-3 a lower user admin cannot suspend, restore or resend the access of an org admin (access card and members API)', async () => {
    const card = await h.request('GET', `${base()}/employees/${eB}/portal-access`, { token: uaB });
    expect(card.status).toBe(200);
    expect(card.body.data).toMatchObject({ state: 'active', membership: { roleName: 'Organisation Admin' } });
    const revoke = await h.request('POST', `${base()}/employees/${eB}/portal-access/revoke`, { token: uaB, body: { reason: 'probe' } });
    expect(revoke.status).toBe(403);
    expect(revoke.body.message).toMatch(/permissions you do not hold/);
    expect((await h.request('DELETE', `${base()}/members/${msAdminB}`, { token: uaB })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/members/${msAdminB}`, { token: uaB, body: { status: 'suspended' } })).status).toBe(403);
    expect((await membershipOf(adminB)).status).toBe('active');
    // an owner suspends it; the lower admin can bring it back by none of the three routes
    expect((await h.request('POST', `${base()}/employees/${eB}/portal-access/revoke`, { token: f.owner, body: {} })).status).toBe(200);
    expect((await h.request('POST', `${base()}/employees/${eB}/portal-access/restore`, { token: uaB, body: {} })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employees/${eB}/portal-access/resend`, { token: uaB })).status).toBe(403);
    expect((await h.request('PATCH', `${base()}/members/${msAdminB}`, { token: uaB, body: { status: 'active' } })).status).toBe(403);
    expect((await membershipOf(adminB)).status).toBe('suspended');
    // an administrator who may grant the role restores it (an organisation-wide org admin), and the owner too
    const restored = await h.request('POST', `${base()}/employees/${eB}/portal-access/restore`, { token: orgAdmin, body: {} });
    expect(restored.status).toBe(200);
    expect((await membershipOf(adminB)).status).toBe('active');
  });

  it('5-P0-3 an open invitation of a more privileged role is not the lower admin\'s to revoke or resend', async () => {
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'admin-invite@test.local', roleId: ROLE.org_admin, allBranches: false, branchIds: [f.branchB] } });
    expect(inv.status).toBe(201);
    expect((await h.request('DELETE', `${base()}/invitations/${inv.body.data.id}`, { token: uaB })).status).toBe(403);
    expect((await h.request('POST', `${base()}/invitations/${inv.body.data.id}/resend`, { token: uaB })).status).toBe(403);
    const row = await h.admin.selectFrom('invitations').select(['revokedAt', 'acceptedAt']).where('id', '=', inv.body.data.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ revokedAt: null, acceptedAt: null });
    // … nor through the access card (an open invitation of an employee is revoked with the access)
    const cardInv = await h.request('POST', `${base()}/employees/${eB2}/portal-access/invite`, { token: f.owner, body: { email: 'eb2-admin@test.local', roleId: ROLE.org_admin, branchIds: [f.branchB] } });
    expect(cardInv.status).toBe(201);
    expect((await h.request('POST', `${base()}/employees/${eB2}/portal-access/revoke`, { token: uaB, body: {} })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employees/${eB2}/portal-access/resend`, { token: uaB })).status).toBe(403);
    expect((await h.request('POST', `${base()}/employees/${eB2}/portal-access/invite`, { token: uaB, body: { email: 'eb2-other@test.local', roleId: roleUA } })).status).toBe(403);
    // the owner may
    expect((await h.request('DELETE', `${base()}/invitations/${inv.body.data.id}`, { token: f.owner })).status).toBe(204);
  });
});

describe('5-P1-2 invitation lookup', () => {
  it('5-P1-2 an old open invitation validates and is accepted behind more than 1 000 newer rows (indexed hash lookup)', async () => {
    const old = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'old-invite@test.local', roleId: ROLE.employee } });
    expect(old.status).toBe(201);
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      organizationId: f.orgId, email: `bulk-${i}@test.local`, roleId: ROLE.employee, allBranches: true, branchIds: [], tokenHash: sha256Hex(randomToken(32)), invitedBy: f.owner,
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(Date.now() + 1000 + i),
    }));
    for (let i = 0; i < rows.length; i += 250) await h.admin.insertInto('invitations').values(rows.slice(i, i + 250)).execute();
    const newer = await h.admin.selectFrom('invitations').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', f.orgId).where('createdAt', '>', new Date(old.body.data.createdAt)).executeTakeFirstOrThrow();
    expect(Number(newer.n)).toBeGreaterThan(1000);
    const v = await validate(old.body.data.token);
    expect(v.status).toBe(200);
    expect(v.body.data.state).toBe('valid');
    const invitee = uuid('c');
    await seedUser(h.admin, invitee, 'old-invite@test.local', 'Old invite');
    const ok = await accept(invitee, 'old-invite@test.local', old.body.data.token);
    expect(ok.status).toBe(200);
    expect((await validate(old.body.data.token)).body.data.state).toBe('accepted');
  });
});

describe('5-P1-5 role deletion', () => {
  it('5-P1-5 a role administrator who cannot read invitations cannot delete a role an open invitation uses; closed ones are counted', async () => {
    expect((await h.request('GET', `${base()}/invitations`, { token: roleAdmin })).status).toBe(403);
    const role = await h.request('POST', `${base()}/roles`, { token: f.owner, body: { key: 'temp_kiosk', name: 'Temp kiosk', permissions: ['attendance.view_own'] } });
    expect(role.status).toBe(201);
    const open = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'temp-open@test.local', roleId: role.body.data.id } });
    const closed = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'temp-closed@test.local', roleId: role.body.data.id } });
    expect((await h.request('DELETE', `${base()}/invitations/${closed.body.data.id}`, { token: f.owner })).status).toBe(204);
    const refused = await h.request('DELETE', `${base()}/roles/${role.body.data.id}`, { token: roleAdmin });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/Open invitations use this role/);
    expect((await validate(open.body.data.token)).body.data.state).toBe('valid');
    // revoked first, the role goes — with both (now closed) invitations, counted on the audit row
    expect((await h.request('DELETE', `${base()}/invitations/${open.body.data.id}`, { token: f.owner })).status).toBe(204);
    expect((await h.request('DELETE', `${base()}/roles/${role.body.data.id}`, { token: roleAdmin })).status).toBe(204);
    expect(await h.admin.selectFrom('invitations').select('id').where('id', 'in', [open.body.data.id, closed.body.data.id]).execute()).toEqual([]);
    const deleted = (await auditRows(h.admin, 'role.deleted')).find((a) => a.entityId === role.body.data.id);
    expect(deleted!.newValue).toMatchObject({ closedInvitationsRemoved: 2 });
  });
});

describe('5-P2-7 public validate', () => {
  it('5-P2-7 malformed and unknown tokens get the same 404', async () => {
    const tokens = [
      `${'-'.repeat(36)}.${'x'.repeat(40)}`, // the reviewer's 36 dashes (used to fail the uuid cast → 400)
      `${uuid('a')}.${'x'.repeat(40)}`, // unknown organisation
      `${f.orgId}.${'z'.repeat(40)}`, // wrong secret
      'x'.repeat(60), // no dot
      `${f.orgId}.short`, // secret too short
      `${'g'.repeat(36)}.${'x'.repeat(40)}`, // not hex
      'short', // not even token-shaped
    ];
    const answers = [];
    for (const [i, t] of tokens.entries()) {
      const r = await validate(t, `203.0.113.${100 + i}`);
      answers.push({ status: r.status, code: r.body?.code, message: r.body?.message });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
  });
});

describe('5-P2-9 accepting is atomic', () => {
  it('5-P2-9 concurrent accepts of one token: one membership, one audit row, the same answer for each', async () => {
    const inv = await h.request('POST', `${base()}/invitations`, { token: f.owner, body: { email: 'race@test.local', roleId: ROLE.employee } });
    expect(inv.status).toBe(201);
    const invitee = uuid('c');
    await seedUser(h.admin, invitee, 'race@test.local', 'Race');
    // hold the invitation row so that every accept has read it as open before any of them may claim it
    const results = await h.admin.transaction().execute(async (tx) => {
      await tx.selectFrom('invitations').select('id').where('id', '=', inv.body.data.id).forUpdate().execute();
      const pending = Array.from({ length: 4 }, () => accept(invitee, 'race@test.local', inv.body.data.token));
      for (let i = 0; i < 200; i += 1) {
        const waiting = await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike 'update "invitations"%'`.execute(h.admin);
        if (Number(waiting.rows[0]?.n) >= 4) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return pending;
    }).then((pending) => Promise.all(pending));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.data.membershipId)).size).toBe(1);
    expect(await h.admin.selectFrom('orgMemberships').select('id').where('organizationId', '=', f.orgId).where('userId', '=', invitee).execute()).toHaveLength(1);
    const accepted = (await auditRows(h.admin, 'member.invitation_accepted')).filter((a) => (a.newValue as { invitationId?: string }).invitationId === inv.body.data.id);
    expect(accepted).toHaveLength(1);
    // afterwards the token is spent: a later accept is refused as before (single use, B-71)
    expect((await accept(invitee, 'race@test.local', inv.body.data.token)).status).toBe(409);
  });
});

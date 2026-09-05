import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import { createTestApi, F, type TestApi } from './harness.js';

let api: TestApi;
beforeAll(async () => { api = await createTestApi('core'); }, 120_000);
afterAll(async () => { await api?.close(); });

describe('authentication & bootstrap', () => {
  it('rejects requests without a bearer token', async () => {
    const res = await api.request('GET', '/me');
    expect(res.status).toBe(401);
    expect(res.json.code).toBe('UNAUTHENTICATED');
    expect(res.json.requestId).toBeTruthy();
  });

  it('GET /me returns profile, memberships with permissions, settings defaults and feature flags', async () => {
    const res = await api.request('GET', '/me', { user: F.ownerA });
    expect(res.status).toBe(200);
    const me = res.json.data;
    expect(me.user).toMatchObject({ id: F.ownerA, email: 'owner-a@test.local', isPlatformAdmin: false });
    expect(me.memberships).toHaveLength(1);
    const m = me.memberships[0];
    expect(m.organization.id).toBe(F.orgA);
    expect(m.roleKey).toBe('owner');
    expect(m.permissions).toContain('employee.view');
    expect(m.allBranches).toBe(true);
    expect(m.settings.sync.autoPushNewEmployees).toBe(true);
    expect(m.settings.general.dateFormat).toBe('DD/MM/YYYY');
    expect(m.featureFlags.arabic_ui).toBe(true);
    expect(m.featureFlags.advanced_reports).toBe(false);
  });

  it('creates the user profile on first request for a brand-new auth user', async () => {
    const newUser = 'e0000000-0000-0000-0000-000000000001';
    await sql`insert into auth.users (id, email) values (${newUser}::uuid, 'fresh@test.local')`.execute(api.tdb.adminDb);
    const res = await api.request('GET', '/me', { user: newUser });
    expect(res.status).toBe(200);
    expect(res.json.data.memberships).toEqual([]);
    const profile = await api.tdb.adminDb.selectFrom('userProfiles').select('email').where('id', '=', newUser).executeTakeFirst();
    expect(profile?.email).toBe(`${newUser}@users.flowza.invalid`);
  });

  it('PATCH /me updates name and locale', async () => {
    const res = await api.request('PATCH', '/me', { user: F.ownerA, body: { fullName: 'Owner A Full', locale: 'ar' } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ fullName: 'Owner A Full', locale: 'ar' });
  });

  it('notifications endpoints work for own rows only', async () => {
    await api.tdb.adminDb.insertInto('notifications').values([
      { organizationId: F.orgA, userId: F.ownerA, category: 'DEVICE', type: 'device.offline', title: 'Device offline' },
      { organizationId: F.orgA, userId: F.hrUserA, category: 'SYSTEM', type: 'x', title: 'Not mine' },
    ]).execute();
    const list = await api.request('GET', '/me/notifications', { user: F.ownerA });
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.meta).toMatchObject({ page: 1, pageSize: 25, total: 1 });
    const unread = await api.request('GET', '/me/notifications/unread-count', { user: F.ownerA });
    expect(unread.json.data.unread).toBe(1);
    const read = await api.request('POST', `/me/notifications/${list.json.data[0].id}/read`, { user: F.ownerA });
    expect(read.status).toBe(200);
    expect(read.json.data.readAt).toBeTruthy();
    expect((await api.request('GET', '/me/notifications/unread-count', { user: F.ownerA })).json.data.unread).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('org A owner cannot read org B resources (403 FORBIDDEN from requireMembership)', async () => {
    const res = await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.ownerA });
    expect(res.status).toBe(403);
    expect(res.json.code).toBe('FORBIDDEN');
    const org = await api.request('GET', `/orgs/${F.orgB}`, { user: F.ownerA });
    expect(org.status).toBe(403);
  });

  it('org B owner sees only org B employees', async () => {
    const res = await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.ownerB });
    expect(res.status).toBe(200);
    expect(res.json.data.map((e: any) => e.employeeNumber)).toEqual(['B-001']);
  });
});

describe('organizations & settings', () => {
  it('GET /orgs/:id returns the organisation dto', async () => {
    const res = await api.request('GET', `/orgs/${F.orgA}`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ id: F.orgA, companyCode: 'TEST-A', timezone: 'Asia/Muscat', weeklyOffDays: [5, 6] });
  });

  it('PATCH /orgs/:id requires organization.manage and audits', async () => {
    const denied = await api.request('PATCH', `/orgs/${F.orgA}`, { user: F.hrUserA, body: { displayName: 'Nope' } });
    expect(denied.status).toBe(403);
    const badTz = await api.request('PATCH', `/orgs/${F.orgA}`, { user: F.ownerA, body: { timezone: 'Mars/Olympus' } });
    expect(badTz.status).toBe(400);
    const res = await api.request('PATCH', `/orgs/${F.orgA}`, { user: F.ownerA, body: { displayName: 'Org A Renamed', timezone: 'Asia/Dubai' } });
    expect(res.status).toBe(200);
    expect(res.json.data.displayName).toBe('Org A Renamed');
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'newValue']).where('organizationId', '=', F.orgA).where('action', '=', 'organization.updated').executeTakeFirst();
    expect(audit).toBeTruthy();
    expect((audit!.newValue as any).displayName).toBe('Org A Renamed');
  });

  it('PUT settings group returns the standard validation envelope on bad input', async () => {
    const res = await api.request('PUT', `/orgs/${F.orgA}/settings/sync`, { user: F.ownerA, body: { defaultIntervalMinutes: 'often' } });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('VALIDATION_ERROR');
    expect(res.json.requestId).toBeTruthy();
    expect(res.json.details.issues[0].path).toBe('defaultIntervalMinutes');
    const unknown = await api.request('PUT', `/orgs/${F.orgA}/settings/nope`, { user: F.ownerA, body: {} });
    expect(unknown.status).toBe(404);
  });

  it('PUT settings group stores the group, audits old/new and is reflected in GET', async () => {
    const res = await api.request('PUT', `/orgs/${F.orgA}/settings/sync`, { user: F.ownerA, body: { autoPushNewEmployees: false, defaultIntervalMinutes: 10 } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ autoPushNewEmployees: false, defaultIntervalMinutes: 10, adaptivePolling: true });
    const group = await api.request('GET', `/orgs/${F.orgA}/settings/sync`, { user: F.ownerA });
    expect(group.json.data.autoPushNewEmployees).toBe(false);
    const all = await api.request('GET', `/orgs/${F.orgA}/settings`, { user: F.hrUserA });
    expect(all.status).toBe(200);
    expect(all.json.data.sync.defaultIntervalMinutes).toBe(10);
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['oldValue', 'newValue']).where('organizationId', '=', F.orgA).where('action', '=', 'organization.settings_updated').executeTakeFirst();
    expect((audit!.oldValue as any).autoPushNewEmployees).toBe(true);
    expect((audit!.newValue as any).autoPushNewEmployees).toBe(false);
    // restore for the other suites' expectations
    await api.request('PUT', `/orgs/${F.orgA}/settings/sync`, { user: F.ownerA, body: {} });
  });
});

describe('members, invitations and roles', () => {
  let customRoleId: string;

  it('lists members with role and branch scope', async () => {
    const res = await api.request('GET', `/orgs/${F.orgA}/members?sort=email&order=asc`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.meta.total).toBe(3);
    const bm = res.json.data.find((m: any) => m.userId === F.branchManagerA);
    expect(bm).toMatchObject({ roleKey: 'branch_manager', allBranches: false, branchIds: [F.branchB2], branchNames: ['A Branch 2'] });
    const denied = await api.request('GET', `/orgs/${F.orgA}/members`, { user: F.branchManagerA });
    expect(denied.status).toBe(403);
    const badSort = await api.request('GET', `/orgs/${F.orgA}/members?sort=password`, { user: F.ownerA });
    expect(badSort.status).toBe(400);
  });

  it('GET /permissions lists the vocabulary', async () => {
    const res = await api.request('GET', '/permissions', { user: F.hrUserA });
    expect(res.status).toBe(200);
    expect(res.json.data.some((p: any) => p.key === 'employee.view')).toBe(true);
  });

  it('creates a custom role (owner), refuses for users without role.manage and for permissions the actor lacks', async () => {
    const denied = await api.request('POST', `/orgs/${F.orgA}/roles`, { user: F.hrUserA, body: { key: 'x_role', name: 'X', permissions: ['employee.view'] } });
    expect(denied.status).toBe(403);
    const res = await api.request('POST', `/orgs/${F.orgA}/roles`, { user: F.ownerA, body: { key: 'auditor', name: 'Auditor', description: 'Read-only + audit', permissions: ['dashboard.view', 'employee.view', 'audit.view'] } });
    expect(res.status).toBe(201);
    customRoleId = res.json.data.id;
    expect(res.json.data).toMatchObject({ key: 'auditor', isSystem: false, permissions: ['audit.view', 'dashboard.view', 'employee.view'] });
    const list = await api.request('GET', `/orgs/${F.orgA}/roles`, { user: F.hrUserA });
    expect(list.json.data.filter((r: any) => r.isSystem)).toHaveLength(8);
    expect(list.json.data.find((r: any) => r.id === customRoleId).memberCount).toBe(0);
    const dup = await api.request('POST', `/orgs/${F.orgA}/roles`, { user: F.ownerA, body: { key: 'auditor', name: 'Auditor 2', permissions: ['employee.view'] } });
    expect(dup.status).toBe(409);
  });

  it('assigns the custom role to a member; permissions take effect immediately (DB-driven)', async () => {
    const res = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipHrA}`, { user: F.ownerA, body: { roleId: customRoleId } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ roleId: customRoleId, roleKey: 'auditor' });
    const me = await api.request('GET', '/me', { user: F.hrUserA });
    expect(me.json.data.memberships[0].permissions.sort()).toEqual(['audit.view', 'dashboard.view', 'employee.view']);
    const create = await api.request('POST', `/orgs/${F.orgA}/employees`, { user: F.hrUserA, body: { employeeNumber: 'X', firstName: 'A', lastName: 'B', joiningDate: '2026-01-01', branchId: F.branchHQ } });
    expect(create.status).toBe(403);
    const inUse = await api.request('DELETE', `/orgs/${F.orgA}/roles/${customRoleId}`, { user: F.ownerA });
    expect(inUse.status).toBe(409);
    const patched = await api.request('PATCH', `/orgs/${F.orgA}/roles/${customRoleId}`, { user: F.ownerA, body: { permissions: ['employee.view'] } });
    expect(patched.json.data.permissions).toEqual(['employee.view']);
    const sys = await api.request('PATCH', `/orgs/${F.orgA}/roles/${SYSTEM_ROLE_IDS.owner}`, { user: F.ownerA, body: { name: 'Hacked' } });
    expect(sys.status).toBe(409);
    // move hr user back to hr_user so later suites see the expected permissions
    await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipHrA}`, { user: F.ownerA, body: { roleId: SYSTEM_ROLE_IDS.hr_user } });
    const del = await api.request('DELETE', `/orgs/${F.orgA}/roles/${customRoleId}`, { user: F.ownerA });
    expect(del.status).toBe(204);
  });

  it('protects the last active owner', async () => {
    const demote = await api.request('PATCH', `/orgs/${F.orgA}/members/${F.membershipOwnerA}`, { user: F.ownerA, body: { roleId: SYSTEM_ROLE_IDS.hr_admin } });
    expect(demote.status).toBe(409);
    expect(demote.json.code).toBe('INVALID_STATE');
    const suspendSelf = await api.request('DELETE', `/orgs/${F.orgA}/members/${F.membershipOwnerA}`, { user: F.ownerA });
    expect(suspendSelf.status).toBe(409);
  });

  it('invitation create (existing account → invited membership) and accept flow', async () => {
    const bad = await api.request('POST', `/orgs/${F.orgA}/invitations`, { user: F.ownerA, body: { email: 'invitee@test.local', roleId: SYSTEM_ROLE_IDS.hr_admin, allBranches: false, branchIds: [] } });
    expect(bad.status).toBe(400);
    const res = await api.request('POST', `/orgs/${F.orgA}/invitations`, { user: F.ownerA, body: { email: 'invitee@test.local', roleId: SYSTEM_ROLE_IDS.hr_admin, allBranches: false, branchIds: [F.branchHQ] } });
    expect(res.status).toBe(201);
    expect(res.json.data.token).toMatch(new RegExp(`^${F.orgA}\\.`));
    expect(res.json.data.membershipId).toBeTruthy();
    const stored = await api.tdb.adminDb.selectFrom('invitations').select(['tokenHash']).where('id', '=', res.json.data.id).executeTakeFirstOrThrow();
    expect(stored.tokenHash).not.toContain(res.json.data.token.split('.')[1]);
    // not yet a member: invited memberships do not grant access
    expect((await api.request('GET', `/orgs/${F.orgA}`, { user: F.invitee })).status).toBe(403);
    const pending = await api.request('GET', `/orgs/${F.orgA}/invitations`, { user: F.ownerA });
    expect(pending.json.data).toHaveLength(1);
    const wrongUser = await api.request('POST', '/invitations/accept', { user: F.ownerB, body: { token: res.json.data.token } });
    expect(wrongUser.status).toBe(403);
    const accept = await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token: res.json.data.token } });
    expect(accept.status).toBe(200);
    expect(accept.json.data.organizationId).toBe(F.orgA);
    const me = await api.request('GET', '/me', { user: F.invitee });
    expect(me.json.data.memberships[0]).toMatchObject({ roleKey: 'hr_admin', allBranches: false, branchIds: [F.branchHQ] });
    const again = await api.request('POST', '/invitations/accept', { user: F.invitee, body: { token: res.json.data.token } });
    expect(again.status).toBe(409);
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select('action').where('organizationId', '=', F.orgA).where('action', 'in', ['member.invited', 'member.invitation_accepted']).execute();
    expect(audit.map((a) => a.action).sort()).toEqual(['member.invitation_accepted', 'member.invited']);
  });

  it('suspends a member (DELETE) and they lose access immediately', async () => {
    const membership = await api.tdb.adminDb.selectFrom('orgMemberships').select('id').where('userId', '=', F.invitee).executeTakeFirstOrThrow();
    const res = await api.request('DELETE', `/orgs/${F.orgA}/members/${membership.id}`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe('suspended');
    expect((await api.request('GET', `/orgs/${F.orgA}`, { user: F.invitee })).status).toBe(403);
  });
});

describe('audit log', () => {
  it('lists audit rows with actor names and filters (audit.view required)', async () => {
    const denied = await api.request('GET', `/orgs/${F.orgA}/audit`, { user: F.hrUserA });
    expect(denied.status).toBe(403);
    const res = await api.request('GET', `/orgs/${F.orgA}/audit?action=organization.settings_updated`, { user: F.ownerA });
    expect(res.status).toBe(200);
    expect(res.json.meta.total).toBeGreaterThanOrEqual(2);
    expect(res.json.data[0]).toMatchObject({ action: 'organization.settings_updated', actorUserId: F.ownerA, entityType: 'organization_settings' });
    expect(res.json.data[0].actorName).toBeTruthy();
    const byEntity = await api.request('GET', `/orgs/${F.orgA}/audit?entityType=role&pageSize=2`, { user: F.ownerA });
    expect(byEntity.json.data.every((a: any) => a.entityType === 'role')).toBe(true);
    expect(byEntity.json.data.length).toBeLessThanOrEqual(2);
    const other = await api.request('GET', `/orgs/${F.orgB}/audit`, { user: F.ownerB });
    expect(other.json.data.every((a: any) => a.organizationId === F.orgB)).toBe(true);
  });
});

describe('platform administration', () => {
  it('refuses non platform admins', async () => {
    expect((await api.request('GET', '/platform/orgs', { user: F.ownerA })).status).toBe(403);
    expect((await api.request('GET', '/platform/health', { user: F.ownerA })).status).toBe(403);
  });

  it('lists organisations, plans, flags and health', async () => {
    const orgs = await api.request('GET', '/platform/orgs?sort=companyCode', { user: F.platformAdmin });
    expect(orgs.status).toBe(200);
    expect(orgs.json.meta.total).toBe(2);
    expect(orgs.json.data[0].subscription.planKey).toBe('business');
    const plans = await api.request('GET', '/platform/plans', { user: F.platformAdmin });
    expect(plans.json.data.map((p: any) => p.key)).toContain('enterprise');
    const flags = await api.request('GET', '/platform/feature-flags', { user: F.platformAdmin });
    expect(flags.json.data.find((f: any) => f.key === 'arabic_ui').defaultEnabled).toBe(true);
    const health = await api.request('GET', '/platform/health', { user: F.platformAdmin });
    expect(health.status).toBe(200);
    expect(health.json.data.organizations).toMatchObject({ trial: 2 });
    expect(health.json.data.platformAdmins).toBe(1);
  });

  it('creates an organisation with an existing owner account (membership) or a missing one (invitation)', async () => {
    const res = await api.request('POST', '/platform/orgs', { user: F.platformAdmin, body: { companyCode: 'NEW-C', legalName: 'New Co LLC', displayName: 'New Co', ownerEmail: 'owner-b@test.local', ownerFullName: 'Owner B', planKey: 'starter' } });
    expect(res.status).toBe(201);
    expect(res.json.data.organization.companyCode).toBe('NEW-C');
    expect(res.json.data.ownerMembershipId).toBeTruthy();
    expect(res.json.data.invitation).toBeNull();
    const meB = await api.request('GET', '/me', { user: F.ownerB });
    expect(meB.json.data.memberships.map((m: any) => m.organization.companyCode).sort()).toEqual(['NEW-C', 'TEST-B']);
    const detail = await api.request('GET', `/platform/orgs/${res.json.data.organization.id}`, { user: F.platformAdmin });
    expect(detail.json.data.counts).toMatchObject({ users: 1, employees: 0 });
    expect(detail.json.data.subscription.status).toBe('active');
    const inv = await api.request('POST', '/platform/orgs', { user: F.platformAdmin, body: { companyCode: 'NEW-D', legalName: 'New D LLC', displayName: 'New D', ownerEmail: 'nobody-yet@test.local', ownerFullName: 'Nobody' } });
    expect(inv.status).toBe(201);
    expect(inv.json.data.ownerMembershipId).toBeNull();
    expect(inv.json.data.invitation.token).toBeTruthy();
    const dup = await api.request('POST', '/platform/orgs', { user: F.platformAdmin, body: { companyCode: 'new-c', legalName: 'Dup LLC', displayName: 'Dup', ownerEmail: 'owner-b@test.local', ownerFullName: 'x' } });
    expect(dup.status).toBe(409);
    const status = await api.request('PATCH', `/platform/orgs/${res.json.data.organization.id}/status`, { user: F.platformAdmin, body: { status: 'suspended', reason: 'Non-payment' } });
    expect(status.json.data.status).toBe('suspended');
    const audit = await api.tdb.adminDb.selectFrom('audit.logs').select(['action', 'actorType']).where('organizationId', '=', res.json.data.organization.id).orderBy('id').execute();
    expect(audit.map((a) => a.action)).toEqual(['organization.created', 'organization.status_changed']);
    expect(audit[0]!.actorType).toBe('PLATFORM_ADMIN');
  });

  it('time-boxed access grants give the platform admin read access to a tenant until revoked', async () => {
    expect((await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.platformAdmin })).status).toBe(403);
    const short = await api.request('POST', '/platform/access-grants', { user: F.platformAdmin, body: { organizationId: F.orgB, reason: 'short' } });
    expect(short.status).toBe(400);
    const write = await api.request('POST', '/platform/access-grants', { user: F.platformAdmin, body: { organizationId: F.orgB, accessLevel: 'write', reason: 'Ticket 123 investigation' } });
    expect(write.status).toBe(400);
    const res = await api.request('POST', '/platform/access-grants', { user: F.platformAdmin, body: { organizationId: F.orgB, reason: 'Ticket 123 investigation', ticketRef: 'SUP-123', hours: 4 } });
    expect(res.status).toBe(201);
    expect(res.json.data).toMatchObject({ accessLevel: 'read', active: true, organizationName: 'Org B' });
    const employees = await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.platformAdmin });
    expect(employees.status).toBe(200);
    expect(employees.json.data).toHaveLength(1);
    const writeAttempt = await api.request('POST', `/orgs/${F.orgB}/employees`, { user: F.platformAdmin, body: { employeeNumber: 'B-999', firstName: 'X', lastName: 'Y', joiningDate: '2026-01-01', branchId: F.branchBHQ } });
    expect(writeAttempt.status).toBe(403);
    const tenantAudit = await api.request('GET', `/orgs/${F.orgB}/audit?action=platform.access_granted`, { user: F.ownerB });
    expect(tenantAudit.json.meta.total).toBe(1);
    const list = await api.request('GET', '/platform/access-grants?activeOnly=true', { user: F.platformAdmin });
    expect(list.json.meta.total).toBe(1);
    const revoke = await api.request('DELETE', `/platform/access-grants/${res.json.data.id}`, { user: F.platformAdmin });
    expect(revoke.json.data.active).toBe(false);
    expect((await api.request('GET', `/orgs/${F.orgB}/employees`, { user: F.platformAdmin })).status).toBe(403);
  });

  it('feature flag overrides per organisation are reflected in /me', async () => {
    const put = await api.request('PUT', `/platform/orgs/${F.orgA}/feature-flags`, { user: F.platformAdmin, body: { flags: { advanced_reports: true, arabic_ui: false } } });
    expect(put.status).toBe(200);
    expect(put.json.data.find((f: any) => f.key === 'advanced_reports')).toMatchObject({ override: true, effective: true });
    const me = await api.request('GET', '/me', { user: F.ownerA });
    expect(me.json.data.memberships[0].featureFlags).toMatchObject({ advanced_reports: true, arabic_ui: false });
    const unknown = await api.request('PUT', `/platform/orgs/${F.orgA}/feature-flags`, { user: F.platformAdmin, body: { flags: { not_a_flag: true } } });
    expect(unknown.status).toBe(400);
    const global = await api.request('PUT', '/platform/feature-flags', { user: F.platformAdmin, body: { flags: [{ key: 'mobile_attendance', defaultEnabled: true }] } });
    expect(global.json.data.find((f: any) => f.key === 'mobile_attendance').defaultEnabled).toBe(true);
  });
});

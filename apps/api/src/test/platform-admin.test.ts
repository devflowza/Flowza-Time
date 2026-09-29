/**
 * Super-admin portal (/adm) API — migration 20260929000400: dashboard overview, tenant details / subscription / members /
 * account / notes, users directory, platform administrator team, platform activity. Authorisation of every route for
 * non-platform-admins is proven generically by route-authz.test.ts (e); this file proves behaviour and the guard rails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestApi, EMAILS, F, type TestApi } from './harness.js';

const OWNER_ADMIN = 'c0000000-0000-0000-0000-000000000002';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi('platformadm');
  const a = api.tdb.adminDb;
  EMAILS[OWNER_ADMIN] = 'platform-owner@test.local';
  await sql`insert into auth.users (id, email) values (${OWNER_ADMIN}::uuid, 'platform-owner@test.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER_ADMIN, email: 'platform-owner@test.local', fullName: 'Platform Owner' }).execute();
  await a.insertInto('platformAdmins').values({ userId: OWNER_ADMIN, level: 'owner' }).execute();
}, 120_000);
afterAll(async () => { await api?.close(); });

const asOwner = { user: OWNER_ADMIN, aal: 'aal2' as const };
const asSupport = { user: F.platformAdmin };

describe('overview', () => {
  it('returns fleet counts, subscriptions and recent tenants to a platform admin', async () => {
    const res = await api.request('GET', '/platform/overview', asSupport);
    expect(res.status).toBe(200);
    const o = res.json.data;
    expect(o.organizations.total).toBeGreaterThanOrEqual(2);
    expect(o.totals.employees).toBeGreaterThan(0);
    expect(o.totals.users).toBeGreaterThanOrEqual(6);
    expect(o.platformAdmins).toBe(2);
    expect(o.recentOrganizations.length).toBeGreaterThanOrEqual(2);
    expect(o.subscriptions.byPlan.length).toBeGreaterThan(0);
  });

  it('refuses a platform admin below aal2 and a tenant owner', async () => {
    expect((await api.request('GET', '/platform/overview', { user: OWNER_ADMIN })).status).toBe(403);
    expect((await api.request('GET', '/platform/overview', { user: F.ownerA })).status).toBe(403);
  });
});

describe('tenant list and details', () => {
  it('lists tenants with counts and account fields, filtered by plan and subscription status', async () => {
    const all = await api.request('GET', '/platform/orgs?sort=companyCode', asSupport);
    expect(all.status).toBe(200);
    const a = all.json.data.find((o: { id: string }) => o.id === F.orgA);
    expect(a.counts.employees).toBeGreaterThan(0);
    expect(a.account).toEqual({ accountManagerUserId: null, accountManagerEmail: null, tags: [] });
    const trialing = await api.request('GET', '/platform/orgs?subscriptionStatus=trialing', asSupport);
    expect(trialing.json.data.map((o: { id: string }) => o.id)).toEqual([F.orgB]);
  });

  it('updates the tenant profile and audits it as a platform change on the organisation', async () => {
    const res = await api.request('PATCH', `/platform/orgs/${F.orgB}`, { ...asSupport, body: { displayName: 'Org B Renamed', contact: { name: 'Sara', phone: '+968 9123 4567' }, address: { city: 'Muscat' } } });
    expect(res.status).toBe(200);
    expect(res.json.data.displayName).toBe('Org B Renamed');
    expect(res.json.data.contact).toEqual({ name: 'Sara', phone: '+968 9123 4567' });
    // a single-field PATCH leaves every other field alone
    const one = await api.request('PATCH', `/platform/orgs/${F.orgB}`, { ...asSupport, body: { legalName: 'Org B Holding LLC' } });
    expect(one.json.data).toMatchObject({ legalName: 'Org B Holding LLC', displayName: 'Org B Renamed', timezone: 'Asia/Muscat' });
    expect(one.json.data.address).toEqual({ city: 'Muscat' });
    const tenantAudit = await api.request('GET', `/orgs/${F.orgB}/audit?action=organization.updated`, { user: F.ownerB });
    expect(tenantAudit.status).toBe(200);
    expect(tenantAudit.json.data.some((e: { actorType: string }) => e.actorType === 'PLATFORM_ADMIN')).toBe(true);
    expect((await api.request('PATCH', `/platform/orgs/${F.orgB}`, { ...asSupport, body: { timezone: 'Mars/Olympus' } })).status).toBe(400);
  });

  it('changes the plan, status and trial end of a subscription, with a reason', async () => {
    const before = await api.request('GET', `/platform/orgs/${F.orgB}/subscription`, asSupport);
    expect(before.json.data.status).toBe('trialing');
    const trialEndsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const res = await api.request('PATCH', `/platform/orgs/${F.orgB}/subscription`, { ...asSupport, body: { trialEndsAt, reason: 'Extended the trial for onboarding' } });
    expect(res.status).toBe(200);
    expect(new Date(res.json.data.trialEndsAt).getTime()).toBe(new Date(trialEndsAt).getTime());
    const upgrade = await api.request('PATCH', `/platform/orgs/${F.orgB}/subscription`, { ...asSupport, body: { planKey: 'business', status: 'active', reason: 'Signed the annual contract' } });
    expect(upgrade.status).toBe(200);
    expect(upgrade.json.data).toMatchObject({ planKey: 'business', status: 'active' });
    expect((await api.request('PATCH', `/platform/orgs/${F.orgB}/subscription`, { ...asSupport, body: { planKey: 'no_such_plan', reason: 'typo' } })).status).toBe(400);
    expect((await api.request('PATCH', `/platform/orgs/${F.orgB}/subscription`, { ...asSupport, body: { reason: 'nothing changes' } })).status).toBe(400);
    const log = await api.request('GET', `/platform/activity?organizationId=${F.orgB}&action=subscription`, asSupport);
    expect(log.json.data.map((e: { action: string }) => e.action)).toEqual(['organization.subscription_changed', 'organization.subscription_changed']);
    expect(log.json.data[0].reason).toBe('Signed the annual contract');
  });

  it('lists the members and pending invitations of a tenant', async () => {
    const res = await api.request('GET', `/platform/orgs/${F.orgA}/members`, asSupport);
    expect(res.status).toBe(200);
    const owner = res.json.data.members.find((m: { userId: string }) => m.userId === F.ownerA);
    expect(owner).toMatchObject({ email: 'owner-a@test.local', roleKey: 'owner', organizationId: F.orgA });
    expect(Array.isArray(res.json.data.invitations)).toBe(true);
    expect((await api.request('GET', `/platform/orgs/${crypto.randomUUID()}/members`, asSupport)).status).toBe(404);
  });
});

describe('account management and notes', () => {
  it('assigns an account manager and tags, visible in the tenant list', async () => {
    const res = await api.request('PUT', `/platform/orgs/${F.orgA}/account`, { ...asSupport, body: { accountManagerUserId: OWNER_ADMIN, tags: ['Enterprise', 'pilot', 'pilot'] } });
    expect(res.status).toBe(200);
    expect(res.json.data.accountManager).toMatchObject({ userId: OWNER_ADMIN, email: 'platform-owner@test.local' });
    expect(res.json.data.tags).toEqual(['enterprise', 'pilot']);
    // a tags-only update keeps the manager
    const tagsOnly = await api.request('PUT', `/platform/orgs/${F.orgA}/account`, { ...asSupport, body: { tags: ['vip'] } });
    expect(tagsOnly.json.data.accountManager.userId).toBe(OWNER_ADMIN);
    const list = await api.request('GET', '/platform/orgs?search=Org A', asSupport);
    expect(list.json.data[0].account).toMatchObject({ accountManagerUserId: OWNER_ADMIN, tags: ['vip'] });
    expect((await api.request('PUT', `/platform/orgs/${F.orgA}/account`, { ...asSupport, body: { accountManagerUserId: F.ownerA } })).status).toBe(400);
  });

  it('keeps internal notes append-only and out of the tenant\'s reach', async () => {
    const add = await api.request('POST', `/platform/orgs/${F.orgA}/notes`, { ...asSupport, body: { body: 'Called the owner about renewal.' } });
    expect(add.status).toBe(201);
    expect(add.json.data).toMatchObject({ body: 'Called the owner about renewal.', authorUserId: F.platformAdmin, authorLabel: 'platform@test.local' });
    const notes = await api.request('GET', `/platform/orgs/${F.orgA}/notes`, asSupport);
    expect(notes.json.data).toHaveLength(1);
    expect((await api.request('POST', `/platform/orgs/${F.orgA}/notes`, { ...asSupport, body: { body: '   ' } })).status).toBe(400);
    // the tenant's audit trail records that a note was added, never its text
    const tenantAudit = await api.request('GET', `/orgs/${F.orgA}/audit?action=platform.tenant_note_added`, { user: F.ownerA });
    expect(tenantAudit.json.data).toHaveLength(1);
    expect(JSON.stringify(tenantAudit.json.data)).not.toContain('renewal');
    // the database refuses edits and hides the table from members
    await expect(sql`update public.platform_tenant_notes set body = 'x'`.execute(api.tdb.adminDb)).rejects.toThrow(/append-only/);
    const seen = await api.tdb.db.transaction().execute(async (trx) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: F.ownerA, role: 'authenticated' })}, true)`.execute(trx);
      await sql`set local role authenticated`.execute(trx);
      return (await sql<{ n: string }>`select count(*)::text as n from public.platform_tenant_notes`.execute(trx)).rows[0]?.n;
    });
    expect(seen).toBe('0');
  });
});

describe('users directory', () => {
  it('searches accounts and shows their memberships', async () => {
    const res = await api.request('GET', '/platform/users?search=owner-a', asSupport);
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(1);
    expect(res.json.data[0]).toMatchObject({ id: F.ownerA, membershipCount: 1, platformAdminLevel: null });
    const admins = await api.request('GET', '/platform/users?platformAdmin=true', asSupport);
    expect(admins.json.data.map((u: { id: string }) => u.id).sort()).toEqual([F.platformAdmin, OWNER_ADMIN].sort());
    const detail = await api.request('GET', `/platform/users/${F.ownerA}`, asSupport);
    expect(detail.json.data.memberships).toHaveLength(1);
    expect(detail.json.data.memberships[0]).toMatchObject({ organizationId: F.orgA, roleKey: 'owner' });
  });
});

describe('platform administrator team', () => {
  it('lists the team; only an owner-level admin adds or changes admins', async () => {
    const list = await api.request('GET', '/platform/admins', asSupport);
    expect(list.status).toBe(200);
    expect(list.json.data.find((a: { userId: string }) => a.userId === F.platformAdmin)).toMatchObject({ level: 'support', isSelf: true });
    expect((await api.request('POST', '/platform/admins', { ...asSupport, body: { email: 'hr-a@test.local' } })).status).toBe(403);
    const add = await api.request('POST', '/platform/admins', { ...asOwner, body: { email: 'HR-A@test.local', level: 'admin' } });
    expect(add.status).toBe(201);
    expect(add.json.data).toMatchObject({ userId: F.hrUserA, level: 'admin', status: 'active' });
    expect((await api.request('POST', '/platform/admins', { ...asOwner, body: { email: 'hr-a@test.local' } })).status).toBe(409);
    expect((await api.request('POST', '/platform/admins', { ...asOwner, body: { email: 'nobody@test.local' } })).status).toBe(400);
    const disable = await api.request('PATCH', `/platform/admins/${F.hrUserA}`, { ...asOwner, body: { status: 'disabled' } });
    expect(disable.json.data.status).toBe('disabled');
    // a disabled admin is no platform admin any more
    expect((await api.request('GET', '/platform/overview', { user: F.hrUserA, aal: 'aal2' })).status).toBe(403);
    const audit = await api.request('GET', '/platform/activity?action=platform.admin', asSupport);
    expect(audit.json.data.map((e: { action: string }) => e.action)).toEqual(['platform.admin_updated', 'platform.admin_added']);
  });

  it('never lets an owner change themselves or remove the last active owner', async () => {
    expect((await api.request('PATCH', `/platform/admins/${OWNER_ADMIN}`, { ...asOwner, body: { level: 'support' } })).status).toBe(409);
    // promote support → owner, then that second owner may not be the one to demote the first below one owner
    await api.request('PATCH', `/platform/admins/${F.platformAdmin}`, { ...asOwner, body: { level: 'owner' } });
    const demoteFirst = await api.request('PATCH', `/platform/admins/${OWNER_ADMIN}`, { ...asSupport, body: { level: 'admin' } });
    expect(demoteFirst.status).toBe(200);
    // OWNER_ADMIN is now 'admin'; F.platformAdmin is the last owner and cannot be demoted by anyone else (nobody else is owner)
    expect((await api.request('PATCH', `/platform/admins/${F.platformAdmin}`, { ...asOwner, body: { level: 'support' } })).status).toBe(403);
  });
});

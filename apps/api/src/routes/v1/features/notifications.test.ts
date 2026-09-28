/**
 * Notifications & reminders (HR portal Prompt 8), API side: the member's own preferences (GET / PUT
 * /me/notification-preferences — own rows only, the organisation from the query and membership required, validated against
 * the catalogue), `notification.manage` on the notifications settings group (and only there), the inbox leaving out e-mail
 * only notices, the approver's question on a leave request reaching the employee, and — end to end through the worker's
 * relay — a preference that switches e-mail off keeps the in-app notice.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createLogger } from '@flowza/shared';
import { PgJobQueue, withContext } from '@flowza/database';
import { relayOutbox } from '../../../../../worker/src/handlers/notifications/outbox.js';
import { auditRows, createApiHarness, domainEvents, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture; let g: OrgFixture;
const lineMgr = uuid('c'); const staff = uuid('c'); const orgOnly = uuid('c'); const notifOnly = uuid('c');
const P = '/api/v1/me/notification-preferences';

/** The worker's relay over the worker's own database role (the real handler, deps reduced to what it touches). */
async function relay() {
  const deps = { db: h.tdb.workerDb, now: () => new Date(), log: createLogger({ name: 'relay-test', level: 'silent' }), realtime: { async publish() {} }, queue: new PgJobQueue(h.tdb.workerDb), config: { WEB_PUBLIC_URL: 'http://web.test' } };
  return relayOutbox({ job: { id: '1', queueName: 'notifications', jobType: 'RELAY_OUTBOX', organizationId: null, payload: {}, priority: 5, attempts: 1, maxAttempts: 1, correlationId: null, lockedBy: 'test', runAt: new Date() }, log: deps.log, deps: deps as never, signal: new AbortController().signal });
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_notif_${process.pid}`);
  f = await seedOrg(h.admin, 'ntf');
  g = await seedOrg(h.admin, 'ntg');
  const e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4);
  const e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5, { managerEmployeeId: e4 });
  await seedUser(h.admin, lineMgr, 'line-mgr-ntf@test.local', 'Line Manager');
  await seedUser(h.admin, staff, 'staff-ntf@test.local', 'Staff Five');
  await seedMembership(h.admin, f.orgId, lineMgr, ROLE.manager, { employeeId: e4 });
  await seedMembership(h.admin, f.orgId, staff, ROLE.employee, { employeeId: e5 });
  // custom roles: organisation settings without the notifications key, and the notifications key alone
  for (const [key, permissions, user] of [['org_settings_only', ['organization.view', 'organization.manage'], orgOnly], ['notification_admin', ['organization.view', 'notification.manage'], notifOnly]] as const) {
    const role = await h.request('POST', `/api/v1/orgs/${f.orgId}/roles`, { token: f.owner, body: { key, name: key, permissions } });
    expect(role.status).toBe(201);
    await seedUser(h.admin, user, `${key}@test.local`, key);
    await seedMembership(h.admin, f.orgId, user, role.body.data.id);
  }
});
afterAll(async () => { await h?.close(); });

describe('GET / PUT /me/notification-preferences', () => {
  it('returns the member\'s matrix: every category and channel, defaults on, locked cells marked, relevance by permissions', async () => {
    const r = await h.request('GET', `${P}?organizationId=${f.orgId}`, { token: f.employeeUser });
    expect(r.status).toBe(200);
    expect(r.body.data.organizationId).toBe(f.orgId);
    expect(r.body.data.locale).toBe('en');
    const cats = r.body.data.categories as Array<{ category: string; relevant: boolean; channels: Array<{ channel: string; enabled: boolean; configurable: boolean; alwaysOn: string[] }> }>;
    expect(cats.map((c) => c.category)).toEqual(['APPROVAL', 'ATTENDANCE', 'LEAVE', 'REPORTS', 'DEVICE', 'SYSTEM', 'SUBSCRIPTION']);
    expect(cats.flatMap((c) => c.channels)).toHaveLength(14);
    expect(cats.every((c) => c.channels.every((x) => x.enabled))).toBe(true);
    const cell = (cat: string, ch: string) => cats.find((c) => c.category === cat)!.channels.find((x) => x.channel === ch)!;
    expect(cell('SYSTEM', 'EMAIL')).toMatchObject({ configurable: false });
    expect(cell('SUBSCRIPTION', 'IN_APP')).toMatchObject({ configurable: false });
    expect(cell('APPROVAL', 'IN_APP').alwaysOn).toContain('approval.pending');
    // an employee is not reached by device, report or subscription notices; the owner is
    expect(cats.filter((c) => c.relevant).map((c) => c.category)).toEqual(['APPROVAL', 'ATTENDANCE', 'LEAVE', 'SYSTEM']);
    const owner = await h.request('GET', `${P}?organizationId=${f.orgId}`, { token: f.owner });
    expect(owner.body.data.categories.every((c: { relevant: boolean }) => c.relevant)).toBe(true);
  });

  it('stores the caller\'s own cells (bulk upsert), audited, and answers with the new matrix', async () => {
    const put = await h.request('PUT', `${P}?organizationId=${f.orgId}`, { token: f.employeeUser, body: { preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }, { category: 'ATTENDANCE', channel: 'IN_APP', enabled: false }] } });
    expect(put.status).toBe(200);
    const leave = put.body.data.categories.find((c: { category: string }) => c.category === 'LEAVE');
    expect(leave.channels.find((x: { channel: string }) => x.channel === 'EMAIL').enabled).toBe(false);
    const rows = await h.admin.selectFrom('notificationPreferences').select(['userId', 'organizationId', 'category', 'channel', 'enabled']).where('organizationId', '=', f.orgId).orderBy('category').execute();
    expect(rows).toEqual([
      { userId: f.employeeUser, organizationId: f.orgId, category: 'ATTENDANCE', channel: 'IN_APP', enabled: false },
      { userId: f.employeeUser, organizationId: f.orgId, category: 'LEAVE', channel: 'EMAIL', enabled: false },
    ]);
    // switching back updates the same row
    const back = await h.request('PUT', `${P}?organizationId=${f.orgId}`, { token: f.employeeUser, body: { preferences: [{ category: 'ATTENDANCE', channel: 'IN_APP', enabled: true }] } });
    expect(back.status).toBe(200);
    expect((await h.admin.selectFrom('notificationPreferences').select('enabled').where('userId', '=', f.employeeUser).where('category', '=', 'ATTENDANCE').executeTakeFirstOrThrow()).enabled).toBe(true);
    const audit = await auditRows(h.admin, 'notification.preferences_updated');
    expect(audit[0]).toMatchObject({ organizationId: f.orgId, actorUserId: f.employeeUser, entityId: f.employeeUser });
    // another member's view is untouched
    const other = await h.request('GET', `${P}?organizationId=${f.orgId}`, { token: f.hrUser });
    expect(other.body.data.categories.find((c: { category: string }) => c.category === 'LEAVE').channels.every((x: { enabled: boolean }) => x.enabled)).toBe(true);
  });

  it('refuses a cell that cannot be switched off, unknown values, duplicates and anything but the cells', async () => {
    const put = (body: unknown) => h.request('PUT', `${P}?organizationId=${f.orgId}`, { token: f.employeeUser, body });
    const locked = await put({ preferences: [{ category: 'SYSTEM', channel: 'EMAIL', enabled: false }] });
    expect(locked.status).toBe(400);
    expect(locked.body.code).toBe('VALIDATION_ERROR');
    expect(locked.body.details).toMatchObject({ cells: ['SYSTEM:EMAIL'] });
    expect((await put({ preferences: [{ category: 'PAYROLL', channel: 'EMAIL', enabled: false }] })).status).toBe(400);
    expect((await put({ preferences: [{ category: 'LEAVE', channel: 'SMS', enabled: false }] })).status).toBe(400);
    expect((await put({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }, { category: 'LEAVE', channel: 'EMAIL', enabled: true }] })).status).toBe(400);
    expect((await put({ preferences: [] })).status).toBe(400);
    // no user id and no organisation in the body: a member only ever writes their own rows of the queried organisation
    expect((await put({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false, userId: f.owner }] })).status).toBe(400);
    expect((await put({ preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }], organizationId: g.orgId })).status).toBe(400);
    expect((await h.admin.selectFrom('notificationPreferences').select('userId').where('userId', '=', f.owner).execute())).toHaveLength(0);
  });

  it('needs a membership of the queried organisation, and the organisation', async () => {
    expect((await h.request('GET', `${P}?organizationId=${g.orgId}`, { token: f.employeeUser })).status).toBe(403);
    expect((await h.request('PUT', `${P}?organizationId=${g.orgId}`, { token: f.employeeUser, body: { preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }] } })).status).toBe(403);
    expect((await h.request('GET', P, { token: f.employeeUser })).status).toBe(400);
    expect((await h.request('GET', `${P}?organizationId=not-a-uuid`, { token: f.employeeUser })).status).toBe(400);
    expect((await h.request('GET', `${P}?organizationId=${f.orgId}`, {})).status).toBe(401);
    expect(await h.admin.selectFrom('notificationPreferences').select('userId').where('organizationId', '=', g.orgId).execute()).toHaveLength(0);
  });
});

describe('the notifications settings group needs notification.manage', () => {
  const settings = (org: string, group: string) => `/api/v1/orgs/${org}/settings/${group}`;
  it('organization.manage alone no longer writes it; notification.manage alone does (and nothing else)', async () => {
    const body = { leaveUpdates: false, missingPunchReminderHours: 3 };
    const denied = await h.request('PUT', settings(f.orgId, 'notifications'), { token: orgOnly, body });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/notification\.manage/);
    const ok = await h.request('PUT', settings(f.orgId, 'notifications'), { token: notifOnly, body });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ leaveUpdates: false, missingPunchReminderHours: 3, approvalPending: true, missingPunchReminder: true, dailyDigest: false });
    // the other groups stay with organization.manage
    expect((await h.request('PUT', settings(f.orgId, 'sync'), { token: notifOnly, body: { defaultIntervalMinutes: 10 } })).status).toBe(403);
    expect((await h.request('PUT', settings(f.orgId, 'sync'), { token: orgOnly, body: { defaultIntervalMinutes: 10 } })).status).toBe(200);
    // the owner holds both
    expect((await h.request('PUT', settings(f.orgId, 'notifications'), { token: f.owner, body: {} })).status).toBe(200);
  });

  it('validates the reminder delay (1–12 hours)', async () => {
    expect((await h.request('PUT', settings(f.orgId, 'notifications'), { token: f.owner, body: { missingPunchReminderHours: 0 } })).status).toBe(400);
    expect((await h.request('PUT', settings(f.orgId, 'notifications'), { token: f.owner, body: { missingPunchReminderHours: 13 } })).status).toBe(400);
    expect((await h.request('PUT', settings(f.orgId, 'notifications'), { token: f.owner, body: { missingPunchReminderHours: 2.5 } })).status).toBe(400);
  });

  it('the database refuses the same write for a member without the key (RLS + group guard)', async () => {
    await expect(withContext(h.tdb.db, { kind: 'user', userId: orgOnly }, (trx) =>
      sql`update public.organization_settings set notifications = '{"leaveUpdates": true}'::jsonb where organization_id = ${f.orgId}::uuid`.execute(trx))).rejects.toThrow(/notification\.manage/);
    await expect(withContext(h.tdb.db, { kind: 'user', userId: notifOnly }, (trx) =>
      sql`update public.organization_settings set sync = '{"defaultIntervalMinutes": 20}'::jsonb where organization_id = ${f.orgId}::uuid`.execute(trx))).rejects.toThrow(/organization\.manage/);
    // a member with neither key matches no row at all
    const none = await withContext(h.tdb.db, { kind: 'user', userId: f.employeeUser }, (trx) =>
      sql`update public.organization_settings set notifications = '{}'::jsonb where organization_id = ${f.orgId}::uuid`.execute(trx));
    expect(Number(none.numAffectedRows ?? 0)).toBe(0);
  });
});

describe('notices reaching the member', () => {
  it('an approver\'s question on a leave request reaches the employee (leave.info_requested); with leave e-mails off it stays in-app only', async () => {
    const hrAdmin = f.hrAdmin;
    const type = await h.request('POST', `/api/v1/orgs/${f.orgId}/leave-types`, { token: hrAdmin, body: { code: 'CL', name: 'Casual Leave', annualAllowanceDays: 12 } });
    expect(type.status).toBe(201);
    const wf = await h.request('POST', `/api/v1/orgs/${f.orgId}/approval-workflows`, { token: f.owner, body: { name: 'Leave by manager', entityType: 'LEAVE', steps: [{ order: 1, approverType: 'MANAGER' }] } });
    expect(wf.status).toBe(201);
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 60 - d.getUTCDay());
    const start = d.toISOString().slice(0, 10);
    const apply = await h.request('POST', `/api/v1/orgs/${f.orgId}/me/leave`, { token: staff, body: { leaveTypeId: type.body.data.id, startDate: start, endDate: start, reason: 'Family matters' } });
    expect(apply.status).toBe(201);
    const off = await h.request('PUT', `${P}?organizationId=${f.orgId}`, { token: staff, body: { preferences: [{ category: 'LEAVE', channel: 'EMAIL', enabled: false }] } });
    expect(off.status).toBe(200);
    const ask = await h.request('POST', `/api/v1/orgs/${f.orgId}/approvals/${apply.body.data.approvalRequestId}/request-info`, { token: lineMgr, body: { comment: 'Who covers your shift?' } });
    expect(ask.status).toBe(200);
    const events = (await domainEvents(h.admin, 'leave.info_requested')).filter((e) => e.organizationId === f.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ userIds: [staff], leaveRecordId: apply.body.data.id, approvalRequestId: apply.body.data.approvalRequestId, question: 'Who covers your shift?', leaveTypeName: 'Casual Leave', startDate: start });

    await relay();
    const n = await h.admin.selectFrom('notifications').select(['id', 'userId', 'inApp', 'readAt', 'title', 'body', 'link', 'category']).where('type', '=', 'leave.info_requested').execute();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ userId: staff, inApp: true, readAt: null, category: 'LEAVE', title: 'Question about your leave request', link: `/my/leave?request=${apply.body.data.id}` });
    expect(n[0]!.body).toContain('Who covers your shift?');
    // the e-mail preference is off: no delivery queued, the in-app notice is there
    expect(await h.admin.selectFrom('notificationDeliveries').select('id').where('notificationId', '=', n[0]!.id).execute()).toHaveLength(0);
    const inbox = await h.request('GET', '/api/v1/me/notifications', { token: staff });
    expect(inbox.body.data.map((x: { type: string }) => x.type)).toContain('leave.info_requested');
  });

  it('the inbox leaves out a notice kept only as the record of its e-mail', async () => {
    // the member switched leave notices off in-app: the relay keeps the row (in_app = false, read) for the e-mail only
    await h.request('PUT', `${P}?organizationId=${f.orgId}`, { token: f.employeeUser, body: { preferences: [{ category: 'LEAVE', channel: 'IN_APP', enabled: false }, { category: 'LEAVE', channel: 'EMAIL', enabled: true }] } });
    await h.admin.insertInto('domainEvents').values({ organizationId: f.orgId, eventType: 'leave.approved', aggregateType: 'leave_record', aggregateId: uuid('9'), payload: JSON.stringify({ userId: f.employeeUser, employeeId: f.e1, leaveTypeName: 'Casual Leave', startDate: '2026-10-01', endDate: '2026-10-01' }) }).execute();
    await relay();
    const row = await h.admin.selectFrom('notifications').select(['id', 'inApp', 'readAt']).where('userId', '=', f.employeeUser).where('type', '=', 'leave.approved').executeTakeFirstOrThrow();
    expect(row.inApp).toBe(false);
    expect(row.readAt).not.toBeNull();
    expect(await h.admin.selectFrom('notificationDeliveries').select('status').where('notificationId', '=', row.id).execute()).toEqual([{ status: 'pending' }]);
    const inbox = await h.request('GET', '/api/v1/me/notifications', { token: f.employeeUser });
    expect(inbox.body.data.map((x: { id: string }) => x.id)).not.toContain(row.id);
    const unread = await h.request('GET', '/api/v1/me/notifications/unread-count', { token: f.employeeUser });
    expect(unread.body.data.unread).toBe(0);
  });
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { NotificationCategory, NotificationDeliveryChannel } from '@flowza/contracts';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { DELIVERY_MAX_ATTEMPTS, MAX_PUBLISH_ATTEMPTS, deliverNotifications, deliveryBackoffMs, isDeliverableAddress, relayOutbox } from './outbox.js';
import { MISSING_PUNCH_REMINDER_JOB_TYPE, runMissingPunchReminders } from './missing-punch.js';
import { NOTIFICATION_RETENTION_JOB_TYPE, runNotificationRetention } from './retention.js';
import { notificationTasks } from './tasks.js';
import { runApprovalReminders } from '../approvals/index.js';

/**
 * Notifications & reminders (HR portal Prompt 8) against a real database: the relay's per-recipient channel decision (org
 * switch × user preference × non-configurable), the recipient's language and the minimal data, e-mail delivery robustness
 * (back-off, max attempts, own address only), the missing check-out reminder, the retention purge, and a reminder for an
 * approval entity other than leave.
 */
const ORG = '0c000000-0000-4000-8000-000000000000';
const ORG_NY = '0c000000-0000-4000-8000-0000000000a1';
const ORG_OFF = '0c000000-0000-4000-8000-0000000000a2';
const ORG_HOLD = '0c000000-0000-4000-8000-0000000000a3';
const ORG_POLICY = '0c000000-0000-4000-8000-0000000000a4';
const BRANCH = '0c000000-0000-4000-8000-00000000000b';
const BRANCH_NY = '0c000000-0000-4000-8000-0000000000bb';
const BRANCH_OFF = '0c000000-0000-4000-8000-0000000000bc';
const U = {
  owner: 'c0000000-0000-4000-8000-000000000001', emp: 'c0000000-0000-4000-8000-000000000002', approver: 'c0000000-0000-4000-8000-000000000003',
  bad: 'c0000000-0000-4000-8000-000000000004', gone: 'c0000000-0000-4000-8000-000000000005', e6: 'c0000000-0000-4000-8000-000000000006',
  ny: 'c0000000-0000-4000-8000-000000000007', off: 'c0000000-0000-4000-8000-000000000008',
};
const E = {
  one: '0c000000-0000-4000-8000-0000000000e1', onLeaveStatus: '0c000000-0000-4000-8000-0000000000e2', holiday: '0c000000-0000-4000-8000-0000000000e3',
  approvedLeave: '0c000000-0000-4000-8000-0000000000e4', checkedOut: '0c000000-0000-4000-8000-0000000000e5', noShift: '0c000000-0000-4000-8000-0000000000e6',
  stale: '0c000000-0000-4000-8000-0000000000e7', ny: '0c000000-0000-4000-8000-0000000000e8', off: '0c000000-0000-4000-8000-0000000000e9',
};
const ROLE = { owner: '10000000-0000-0000-0000-000000000001', employee: '10000000-0000-0000-0000-000000000008', manager: '10000000-0000-0000-0000-000000000009' };

let clock = new Date('2026-09-15T03:00:00Z'); // 07:00 in Muscat
let h: TestHarness;
const a = () => h.tdb.adminDb;
const ctx = (jobType: string, payload: Record<string, unknown> = {}) => ({ job: fakeJob(jobType, payload), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const relay = () => relayOutbox(ctx('RELAY_OUTBOX'));
const deliver = () => deliverNotifications(ctx('DELIVER_NOTIFICATIONS'));

async function setSwitches(orgId: string, notifications: Record<string, unknown>): Promise<void> {
  await a().insertInto('organizationSettings').values({ organizationId: orgId, notifications: JSON.stringify(notifications) })
    .onConflict((oc) => oc.column('organizationId').doUpdateSet({ notifications: JSON.stringify(notifications) })).execute();
}
async function setPrefs(userId: string, rows: Array<[NotificationCategory, NotificationDeliveryChannel, boolean]>): Promise<void> {
  await a().deleteFrom('notificationPreferences').where('userId', '=', userId).execute();
  if (rows.length) await a().insertInto('notificationPreferences').values(rows.map(([category, channel, enabled]) => ({ userId, organizationId: ORG, category, channel, enabled }))).execute();
}
async function emit(orgId: string, eventType: string, payload: Record<string, unknown>, aggregateType = 'test'): Promise<string> {
  const aggregateId = randomUUID();
  await a().insertInto('domainEvents').values({ organizationId: orgId, eventType: eventType as never, aggregateType, aggregateId, payload: JSON.stringify(payload) }).execute();
  return aggregateId;
}
async function outcome(type: string, aggregateId: string, userId: string) {
  const n = await a().selectFrom('notifications').select(['id', 'inApp', 'readAt', 'title', 'link', 'data', 'category']).where('type', '=', type).where('userId', '=', userId)
    .where(sql<boolean>`data->>'aggregateId' = ${aggregateId}`).executeTakeFirst();
  const emails = n ? await a().selectFrom('notificationDeliveries').select(['id', 'status']).where('notificationId', '=', n.id).execute() : [];
  return { n, row: !!n, inApp: n ? n.inApp : null, read: n ? n.readAt !== null : null, email: emails.length > 0 };
}

beforeAll(async () => {
  h = await createHarness(`flowza_worker_ntf_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } }, () => clock);
  const emails: Record<string, string> = { [U.bad]: `${U.bad}@users.flowza.invalid` };
  await sql`insert into auth.users (id, email) values ${sql.join(Object.values(U).map((id) => sql`(${id}::uuid, ${`${id}@n.local`})`))}`.execute(a());
  await a().insertInto('userProfiles').values(Object.entries(U).map(([k, id]) => ({ id, email: emails[id] ?? `${k}@n.local`, fullName: k, locale: id === U.emp ? 'ar' : 'en' }))).execute();
  await a().insertInto('organizations').values([
    { id: ORG, companyCode: 'NTF', legalName: 'Notify', displayName: 'Notify & Co', timezone: 'Asia/Muscat' },
    { id: ORG_NY, companyCode: 'NTFNY', legalName: 'NY', displayName: 'NY', timezone: 'America/New_York' },
    { id: ORG_OFF, companyCode: 'NTFOFF', legalName: 'Off', displayName: 'Off', timezone: 'Asia/Muscat' },
    { id: ORG_HOLD, companyCode: 'NTFHOLD', legalName: 'Hold', displayName: 'Hold', timezone: 'Asia/Muscat', legalHold: true },
    { id: ORG_POLICY, companyCode: 'NTFPOL', legalName: 'Policy', displayName: 'Policy', timezone: 'Asia/Muscat' },
  ]).execute();
  await a().insertInto('branches').values([
    { id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }, { id: BRANCH_NY, organizationId: ORG_NY, code: 'HQ', name: 'HQ' }, { id: BRANCH_OFF, organizationId: ORG_OFF, code: 'HQ', name: 'HQ' },
  ]).execute();
  const emp = (id: string, org: string, branch: string, n: string) => ({ id, organizationId: org, branchId: branch, employeeNumber: n, firstName: 'Emp', lastName: n, displayName: `Emp ${n}`, joiningDate: '2024-01-01', deviceUserId: n });
  await a().insertInto('employees').values([
    emp(E.one, ORG, BRANCH, '1'), emp(E.onLeaveStatus, ORG, BRANCH, '2'), emp(E.holiday, ORG, BRANCH, '3'), emp(E.approvedLeave, ORG, BRANCH, '4'), emp(E.checkedOut, ORG, BRANCH, '5'),
    emp(E.noShift, ORG, BRANCH, '6'), emp(E.stale, ORG, BRANCH, '7'), emp(E.ny, ORG_NY, BRANCH_NY, '8'), emp(E.off, ORG_OFF, BRANCH_OFF, '9'),
  ]).execute();
  await a().insertInto('orgMemberships').values([
    { organizationId: ORG, userId: U.owner, roleId: ROLE.owner, status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.emp, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: E.one },
    { organizationId: ORG, userId: U.approver, roleId: ROLE.manager, status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.bad, roleId: ROLE.employee, status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.gone, roleId: ROLE.employee, status: 'active', allBranches: true },
    { organizationId: ORG, userId: U.e6, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: E.noShift },
    { organizationId: ORG_NY, userId: U.ny, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: E.ny },
    { organizationId: ORG_OFF, userId: U.off, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: E.off },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('relay: the channel decision per recipient', () => {
  const approval = (extra: Record<string, unknown> = {}) => ({ entityType: 'ATTENDANCE_CORRECTION', employeeName: 'Emp 1', stepNo: 1, date: '2026-09-12', requestId: randomUUID(), userIds: [U.owner], ...extra });
  const leave = { userId: U.owner, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-02' };
  const MATRIX: Array<{ name: string; type: string; payload: Record<string, unknown>; org?: Record<string, unknown>; prefs?: Array<[NotificationCategory, NotificationDeliveryChannel, boolean]>; expect: { row: boolean; inApp?: boolean; read?: boolean; email?: boolean } }> = [
    { name: 'approval pending, defaults: in-app + e-mail', type: 'approval.pending', payload: approval(), expect: { row: true, inApp: true, read: false, email: true } },
    { name: 'approval pending, e-mail preference off: in-app only', type: 'approval.pending', payload: approval(), prefs: [['APPROVAL', 'EMAIL', false]], expect: { row: true, inApp: true, email: false } },
    { name: 'approval pending, organisation switch off: in-app only', type: 'approval.pending', payload: approval(), org: { approvalPending: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'approval pending, in-app preference off: still in the inbox (an item to act on)', type: 'approval.pending', payload: approval(), prefs: [['APPROVAL', 'IN_APP', false]], expect: { row: true, inApp: true, read: false, email: true } },
    { name: 'leave decision, in-app preference off: e-mail only (stored read, out of the inbox)', type: 'leave.approved', payload: leave, prefs: [['LEAVE', 'IN_APP', false]], expect: { row: true, inApp: false, read: true, email: true } },
    { name: 'leave decision, both preferences off: nothing', type: 'leave.approved', payload: leave, prefs: [['LEAVE', 'IN_APP', false], ['LEAVE', 'EMAIL', false]], expect: { row: false } },
    { name: 'leave decision, leaveUpdates off: in-app only', type: 'leave.approved', payload: leave, org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'a decision on leave follows leaveUpdates', type: 'approval.decided', payload: approval({ entityType: 'LEAVE', decision: 'APPROVED' }), org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'a decision on a correction does not follow leaveUpdates', type: 'approval.decided', payload: approval({ decision: 'REJECTED' }), org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: true } },
    { name: 'a decision on a correction follows attendanceNotes', type: 'approval.decided', payload: approval({ decision: 'REJECTED' }), org: { attendanceNotes: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'subscription notice ignores the member\'s preferences', type: 'subscription.limit_reached', payload: { metric: 'employees', limit: 5 }, prefs: [['SUBSCRIPTION', 'IN_APP', false], ['SUBSCRIPTION', 'EMAIL', false]], expect: { row: true, inApp: true, email: true } },
    { name: 'system notice ignores the member\'s preferences', type: 'employee.imported', payload: { phase: 'queued', validRows: 3 }, prefs: [['SYSTEM', 'IN_APP', false], ['SYSTEM', 'EMAIL', false]], expect: { row: true, inApp: true, email: true } },
    { name: 'daily digest: in-app only by default', type: 'approval.reminder', payload: { kind: 'digest', total: 2, counts: [{ entityType: 'LEAVE', count: 2 }], digestDate: '2026-09-15', userIds: [U.owner] }, expect: { row: true, inApp: true, email: false } },
    { name: 'daily digest: e-mailed with dailyDigest on', type: 'approval.reminder', payload: { kind: 'digest', total: 2, counts: [{ entityType: 'LEAVE', count: 2 }], digestDate: '2026-09-15', userIds: [U.owner] }, org: { dailyDigest: true }, expect: { row: true, inApp: true, email: true } },
    { name: 'report delivery asked for e-mail only with the e-mail preference off: nothing', type: 'report.scheduled_delivery', payload: { userIds: [U.owner], channels: ['email'], mode: 'send_now', reportType: 'late_report' }, prefs: [['REPORTS', 'EMAIL', false]], expect: { row: false } },
    { name: 'flagged punch with punchFlagged off: in-app only', type: 'attendance.punch_flagged', payload: { userIds: [U.owner], employeeId: E.one, employeeName: 'Emp 1', outcome: 'flagged', reason: 'outside', at: '2026-09-15T04:00:00Z' }, org: { punchFlagged: false }, expect: { row: true, inApp: true, email: false } },
  ];

  it.each(MATRIX)('$name', async (c) => {
    await setSwitches(ORG, c.org ?? {});
    await setPrefs(U.owner, c.prefs ?? []);
    const agg = await emit(ORG, c.type, c.payload, c.type.startsWith('approval.') ? 'approval_request' : 'test');
    await relay();
    const o = await outcome(c.type, agg, U.owner);
    expect(o.row).toBe(c.expect.row);
    if (c.expect.inApp !== undefined) expect(o.inApp).toBe(c.expect.inApp);
    if (c.expect.read !== undefined) expect(o.read).toBe(c.expect.read);
    if (c.expect.email !== undefined) expect(o.email).toBe(c.expect.email);
    await setSwitches(ORG, {});
    await setPrefs(U.owner, []);
  });

  it('writes the recipient\'s language, the canonical link and only the data the templates need', async () => {
    const agg = await emit(ORG, 'attendance.unexcused_marked', { employeeId: E.one, employeeName: 'Emp 1', dates: ['2026-09-10', '2026-09-11'], count: 2, autoDeduct: false, userIds: [U.emp, U.owner], secretNote: 'x' }, 'employee');
    await relay();
    const self = await outcome('attendance.unexcused_marked', agg, U.emp);
    const manager = await outcome('attendance.unexcused_marked', agg, U.owner);
    expect(self.n?.title).toMatch(/[؀-ۿ]/); // the employee's profile is Arabic
    expect(self.n?.link).toBe('/my/attendance?month=2026-09'); // the subject's own page
    expect(self.n?.category).toBe('ATTENDANCE');
    expect(manager.n?.title).toBe('Emp 1: 2 attendance days marked unexcused');
    expect(manager.n?.link).toBe(`/attendance?employeeId=${E.one}`);
    const data = self.n!.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['aggregateId', 'aggregateType', 'autoDeduct', 'count', 'date', 'dates', 'employeeId', 'employeeName', 'entityId', 'entityType'].sort());
    expect(JSON.stringify(data)).not.toContain(U.owner); // no recipient lists, no other people's logins
  });

  it('a failing event is rolled back alone, retried later, and never stops the events behind it', async () => {
    // a test-only trigger makes the notification insert of one event fail
    await sql`create or replace function public.p8_test_poison() returns trigger language plpgsql as $f$ begin if new.title like '%POISON%' then raise exception 'poisoned'; end if; return new; end $f$`.execute(a());
    await sql`create trigger p8_test_poison before insert on public.notifications for each row execute function public.p8_test_poison()`.execute(a());
    let bad = '';
    let good = '';
    try {
      bad = await emit(ORG, 'device.offline', { deviceName: 'POISON' });
      good = await emit(ORG, 'device.online', { deviceName: 'Fine' });
      const res = await relay();
      expect(res.failed).toBe(1);
      expect((await outcome('device.offline', bad, U.owner)).row).toBe(false);
      expect((await outcome('device.online', good, U.owner)).row).toBe(true);
      const ev = await a().selectFrom('domainEvents').select(['publishedAt', 'publishAttempts', 'publishError']).where('aggregateId', '=', bad).executeTakeFirstOrThrow();
      expect(ev).toMatchObject({ publishedAt: null, publishAttempts: 1 });
      expect(ev.publishError).toContain('poisoned');
    } finally {
      await sql`drop trigger if exists p8_test_poison on public.notifications`.execute(a());
      await sql`drop function if exists public.p8_test_poison()`.execute(a());
    }
    await relay(); // the next run publishes it
    expect((await outcome('device.offline', bad, U.owner)).row).toBe(true);
    // an event that failed MAX_PUBLISH_ATTEMPTS times is a dead letter: kept, never selected again
    const dead = await emit(ORG, 'device.offline', { deviceName: 'Dead' });
    await a().updateTable('domainEvents').set({ publishAttempts: MAX_PUBLISH_ATTEMPTS }).where('aggregateId', '=', dead).execute();
    await relay();
    expect((await a().selectFrom('domainEvents').select('publishedAt').where('aggregateId', '=', dead).executeTakeFirstOrThrow()).publishedAt).toBeNull();
  });
});

describe('delivery', () => {
  it('backs off after a failed send, retries when due, gives up after the max attempts — the in-app notice untouched', async () => {
    await a().updateTable('notificationDeliveries').set({ status: 'skipped' }).where('status', '=', 'pending').execute();
    const agg = await emit(ORG, 'device.offline', { deviceName: 'Door' });
    await relay();
    const n = (await outcome('device.offline', agg, U.owner)).n!;
    const delivery = await a().selectFrom('notificationDeliveries').select('id').where('notificationId', '=', n.id).executeTakeFirstOrThrow();
    const real = h.deps.mailer;
    h.deps.mailer = { async send() { throw new Error('smtp down'); } };
    try {
      const state = () => a().selectFrom('notificationDeliveries').select(['status', 'attempts', 'nextAttemptAt', 'error']).where('id', '=', delivery.id).executeTakeFirstOrThrow();
      for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
        const res = await deliver();
        expect(res.attempted).toBe(1);
        const s = await state();
        expect(s.attempts).toBe(attempt);
        expect(s.error).toBe('smtp down');
        if (attempt < DELIVERY_MAX_ATTEMPTS) {
          expect(s.status).toBe('pending');
          expect(s.nextAttemptAt?.toISOString()).toBe(new Date(clock.getTime() + deliveryBackoffMs(attempt)).toISOString());
          expect((await deliver()).attempted).toBe(0); // not due yet
          clock = new Date(clock.getTime() + deliveryBackoffMs(attempt));
        } else {
          expect(s.status).toBe('failed');
        }
      }
      expect((await deliver()).attempted).toBe(0);
    } finally {
      h.deps.mailer = real;
    }
    const after = await a().selectFrom('notifications').select(['readAt', 'inApp']).where('id', '=', n.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ readAt: null, inApp: true });
  });

  it('never hands the mailer an address that is not the recipient\'s own, deliverable one, nor mails a former member', async () => {
    const sentBefore = h.emails.length;
    const toBad = await emit(ORG, 'leave.approved', { userId: U.bad, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-01' });
    const toGone = await emit(ORG, 'leave.approved', { userId: U.gone, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-01' });
    await relay();
    await a().updateTable('orgMemberships').set({ status: 'suspended' }).where('userId', '=', U.gone).where('organizationId', '=', ORG).execute();
    await deliver();
    const statusOf = async (agg: string, userId: string) => {
      const n = (await outcome('leave.approved', agg, userId)).n!;
      return a().selectFrom('notificationDeliveries').select(['status', 'error']).where('notificationId', '=', n.id).executeTakeFirstOrThrow();
    };
    expect(await statusOf(toBad, U.bad)).toEqual({ status: 'skipped', error: 'invalid_recipient_address' });
    expect(await statusOf(toGone, U.gone)).toEqual({ status: 'skipped', error: 'recipient_not_member' });
    expect(h.emails.slice(sentBefore).some((e) => e.to.includes(U.bad) || e.to === 'gone@n.local')).toBe(false);
    expect(isDeliverableAddress('a@b.co')).toBe(true);
    for (const bad of ['a@b', 'x\r\n@b.co', 'Name <a@b.co>', 'a@b.co, c@d.co', `${'x'.repeat(250)}@b.co`, 'u@users.flowza.invalid']) expect(isDeliverableAddress(bad), bad).toBe(false);
  });

  it('mails the recipient in their language with the deep link, the organisation name and their preferences link', async () => {
    const sentBefore = h.emails.length;
    const agg = await emit(ORG, 'leave.approved', { userId: U.emp, employeeId: E.one, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-02' }, 'leave_record');
    await relay();
    await deliver();
    const mail = h.emails.slice(sentBefore).find((e) => e.to === 'emp@n.local')!;
    expect(mail.html).toContain('lang="ar" dir="rtl"');
    expect(mail.html).toContain(`href="http://web.test/my/leave?request=${agg}"`);
    expect(mail.html).toContain('Notify &amp; Co'); // the organisation's display name, escaped
    expect(mail.subject.startsWith('[Notify & Co] ')).toBe(true);
    expect(mail.text).toContain(`http://web.test/my/leave?request=${agg}`);
    expect(mail.html).toContain('http://web.test/my/profile'); // an employee manages e-mails on their profile
  });
});

describe('attendance.missing-punch-reminder', () => {
  const record = (employeeId: string, date: string, o: { firstInAt: string; expectedEndAt?: string | null; lastOutAt?: string | null; status?: string; flags?: string[]; organizationId?: string; branchId?: string; timezone?: string }) =>
    a().insertInto('attendanceDailyRecords').values({
      organizationId: o.organizationId ?? ORG, employeeId, attendanceDate: date, branchId: o.branchId ?? BRANCH, timezone: o.timezone ?? 'Asia/Muscat', engineVersion: 'test',
      status: (o.status ?? 'PENDING') as never, flags: o.flags ?? [], trace: JSON.stringify({}), firstInAt: new Date(o.firstInAt), expectedEndAt: o.expectedEndAt ? new Date(o.expectedEndAt) : null, lastOutAt: o.lastOutAt ? new Date(o.lastOutAt) : null,
    }).execute();
  const reminders = (orgId = ORG) => a().selectFrom('domainEvents').select(['aggregateId', 'payload']).where('eventType', '=', 'punch.missing_out' as never).where('organizationId', '=', orgId).orderBy('id').execute();

  beforeAll(async () => {
    // 15 Sept in Muscat: shift 08:00–17:00 local (04:00–13:00 UTC)
    await record(E.one, '2026-09-15', { firstInAt: '2026-09-15T04:10:00Z', expectedEndAt: '2026-09-15T13:00:00Z' });
    await record(E.onLeaveStatus, '2026-09-15', { firstInAt: '2026-09-15T04:00:00Z', expectedEndAt: '2026-09-15T13:00:00Z', status: 'LEAVE' });
    await record(E.holiday, '2026-09-15', { firstInAt: '2026-09-15T04:00:00Z', expectedEndAt: null, status: 'HOLIDAY' });
    await record(E.approvedLeave, '2026-09-15', { firstInAt: '2026-09-15T04:00:00Z', expectedEndAt: '2026-09-15T13:00:00Z' });
    await record(E.checkedOut, '2026-09-15', { firstInAt: '2026-09-15T04:00:00Z', expectedEndAt: '2026-09-15T13:00:00Z', lastOutAt: '2026-09-15T13:05:00Z', status: 'PRESENT' });
    await record(E.noShift, '2026-09-15', { firstInAt: '2026-09-15T05:00:00Z', expectedEndAt: null }); // no shift: first IN + 8 h = 13:00 UTC
    await record(E.stale, '2026-09-14', { firstInAt: '2026-09-14T04:00:00Z', expectedEndAt: '2026-09-14T13:00:00Z', status: 'MISSING_PUNCH', flags: ['MISSING_OUT'] });
    const lt = (await a().insertInto('leaveTypes').values({ organizationId: ORG, code: 'AL', name: 'Annual' }).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.approvedLeave, leaveTypeId: lt, startDate: '2026-09-14', endDate: '2026-09-16', status: 'APPROVED' }).execute();
    // New York night shift: 14 Sept 21:00 → 15 Sept 05:00 local (01:00 → 09:00 UTC on the 15th)
    await record(E.ny, '2026-09-14', { organizationId: ORG_NY, branchId: BRANCH_NY, timezone: 'America/New_York', firstInAt: '2026-09-15T01:00:00Z', expectedEndAt: '2026-09-15T09:00:00Z' });
    await record(E.off, '2026-09-15', { organizationId: ORG_OFF, branchId: BRANCH_OFF, firstInAt: '2026-09-15T04:00:00Z', expectedEndAt: '2026-09-15T13:00:00Z' });
    await setSwitches(ORG_OFF, { missingPunchReminder: false });
  });

  it('the scheduler task enqueues one deduped job every tick', async () => {
    await notificationTasks[0]!.run(h.deps);
    await notificationTasks[0]!.run(h.deps);
    const jobs = await a().selectFrom('jobs.queue').select(['jobType', 'dedupeKey']).where('jobType', '=', MISSING_PUNCH_REMINDER_JOB_TYPE).execute();
    expect(jobs).toEqual([{ jobType: MISSING_PUNCH_REMINDER_JOB_TYPE, dedupeKey: 'missing-punch-reminders' }]);
  });

  it('does not fire before the shift end + the configured hours', async () => {
    clock = new Date('2026-09-15T14:59:00Z'); // 18:59 local: the 2-hour grace after 17:00 is not over
    const res = await runMissingPunchReminders(h.deps, ORG);
    expect(res.reminded).toBe(0);
    expect(res.notDue).toBe(2); // E1 (shift) and E6 (default end)
    expect(await reminders()).toHaveLength(0);
  });

  it('fires once per employee-day after the threshold — never on leave, a holiday, a checked-out or a stale day', async () => {
    clock = new Date('2026-09-15T15:00:00Z');
    const res = await runMissingPunchReminders(h.deps, ORG);
    expect(res).toMatchObject({ today: '2026-09-15', reminded: 2, skippedLeave: 1, stale: 1 });
    const evs = await reminders();
    expect(evs.map((e) => e.aggregateId).sort()).toEqual([E.one, E.noShift].sort());
    const one = evs.find((e) => e.aggregateId === E.one)!.payload as Record<string, unknown>;
    expect(one).toMatchObject({ employeeId: E.one, attendanceDate: '2026-09-15', endSource: 'shift', expectedEndAt: '2026-09-15T13:00:00.000Z', hours: 2, userIds: [U.emp] });
    expect((evs.find((e) => e.aggregateId === E.noShift)!.payload as Record<string, unknown>)).toMatchObject({ endSource: 'default', expectedEndAt: '2026-09-15T13:00:00.000Z', userIds: [U.e6] });
    // the next quarter hour changes nothing
    clock = new Date('2026-09-15T15:15:00Z');
    expect((await runMissingPunchReminders(h.deps, ORG)).reminded).toBe(0);
    expect(await reminders()).toHaveLength(2);
    const ledger = await a().selectFrom('missingPunchReminders').select(['employeeId', 'recipients']).where('organizationId', '=', ORG).orderBy('employeeId').execute();
    expect(ledger).toEqual([{ employeeId: E.one, recipients: 1 }, { employeeId: E.noShift, recipients: 1 }].sort((x, y) => x.employeeId.localeCompare(y.employeeId)));
  });

  it('respects the organisation timezone across midnight (a night shift that started yesterday)', async () => {
    clock = new Date('2026-09-15T10:59:00Z'); // 06:59 in New York: 05:00 + 2 h not reached
    expect((await runMissingPunchReminders(h.deps, ORG_NY)).reminded).toBe(0);
    clock = new Date('2026-09-15T11:05:00Z');
    const res = await runMissingPunchReminders(h.deps, ORG_NY);
    expect(res).toMatchObject({ today: '2026-09-15', reminded: 1 });
    expect((await reminders(ORG_NY))[0]!.payload).toMatchObject({ employeeId: E.ny, attendanceDate: '2026-09-14', userIds: [U.ny] });
  });

  it('does nothing when the organisation switched the reminder off', async () => {
    clock = new Date('2026-09-15T16:00:00Z');
    expect(await runMissingPunchReminders(h.deps, ORG_OFF)).toMatchObject({ skipped: 'disabled', reminded: 0 });
    expect(await reminders(ORG_OFF)).toHaveLength(0);
  });

  it('the relay tells the employee, in their language, with a link to check out', async () => {
    await relay();
    const n = await a().selectFrom('notifications').select(['userId', 'title', 'link', 'category']).where('type', '=', 'punch.missing_out').where('organizationId', '=', ORG).orderBy('userId').execute();
    expect(n.map((x) => x.userId).sort()).toEqual([U.emp, U.e6].sort());
    const emp = n.find((x) => x.userId === U.emp)!;
    expect(emp.link).toBe('/my/checkin?date=2026-09-15');
    expect(emp.category).toBe('ATTENDANCE');
    expect(emp.title).toMatch(/[؀-ۿ]/);
    expect(n.find((x) => x.userId === U.e6)!.title).toBe('You have not checked out yet (15 Sep 2026)');
  });
});

describe('approval reminders use the catalogue for every entity type (B-102)', () => {
  it('a 24-hour reminder on an attendance correction names the day, links the request and carries the one-click links', async () => {
    const correction = (await a().insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E.one, branchId: BRANCH, attendanceDate: '2026-09-12', type: 'ADD_PUNCH', proposedPunchedAt: new Date('2026-09-12T13:00:00Z'), proposedEventType: 'PUNCH_OUT', reason: 'Forgot', status: 'PENDING' }).returning('id').executeTakeFirstOrThrow()).id;
    const created = new Date('2026-09-16T00:00:00Z'); // 04:00 Muscat
    const req = (await a().insertInto('approvalRequests').values({ organizationId: ORG, entityType: 'ATTENDANCE_CORRECTION', entityId: correction, branchId: BRANCH, employeeId: E.one, subjectUserId: U.emp, requestedBy: U.emp, currentStep: 1, status: 'PENDING', createdAt: created }).returning('id').executeTakeFirstOrThrow()).id;
    const step = (await a().insertInto('approvalSteps').values({ organizationId: ORG, requestId: req, stepNo: 1, approverType: 'USER', approverUserId: U.approver, mode: 'ANY', requiredCount: 1, status: 'PENDING', activatedAt: created }).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('approvalStepActors').values({ organizationId: ORG, stepId: step, userId: U.approver, resolutionPath: 'user' }).execute();
    // a request type without a document table still reminds, with the entity and the person only
    const req2 = (await a().insertInto('approvalRequests').values({ organizationId: ORG, entityType: 'OVERTIME_CLAIM', entityId: randomUUID(), branchId: BRANCH, employeeId: E.one, subjectUserId: U.emp, requestedBy: U.emp, currentStep: 1, status: 'PENDING', createdAt: created }).returning('id').executeTakeFirstOrThrow()).id;
    const step2 = (await a().insertInto('approvalSteps').values({ organizationId: ORG, requestId: req2, stepNo: 1, approverType: 'USER', approverUserId: U.approver, mode: 'ANY', requiredCount: 1, status: 'PENDING', activatedAt: created }).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('approvalStepActors').values({ organizationId: ORG, stepId: step2, userId: U.approver, resolutionPath: 'user' }).execute();

    clock = new Date('2026-09-17T02:00:00Z'); // 06:00 Muscat, 26 h later, before the digest hour
    const r = await runApprovalReminders(h.deps, ORG);
    expect(r.reminded).toBe(2);
    const ev = await a().selectFrom('domainEvents').select('payload').where('eventType', '=', 'approval.reminder').where('aggregateId', '=', req).executeTakeFirstOrThrow();
    expect(ev.payload).toMatchObject({ kind: 'reminder', entityType: 'ATTENDANCE_CORRECTION', date: '2026-09-12', employeeName: 'Emp 1' });
    await a().updateTable('notificationDeliveries').set({ status: 'skipped' }).where('status', '=', 'pending').execute();
    const sentBefore = h.emails.length;
    await relay();
    const n = await a().selectFrom('notifications').select(['title', 'body', 'link', 'category']).where('userId', '=', U.approver).where('type', '=', 'approval.reminder').where(sql<boolean>`data->>'requestId' = ${req}`).executeTakeFirstOrThrow();
    expect(n).toEqual({ title: 'Reminder: Attendance correction — Emp 1 is waiting for your approval', body: 'Pending for 26 hours · 12 Sep 2026', link: `/approvals?request=${req}`, category: 'APPROVAL' });
    const n2 = await a().selectFrom('notifications').select(['title', 'body']).where('userId', '=', U.approver).where(sql<boolean>`data->>'requestId' = ${req2}`).executeTakeFirstOrThrow();
    expect(n2).toEqual({ title: 'Reminder: Overtime claim — Emp 1 is waiting for your approval', body: 'Pending for 26 hours' });
    await deliver();
    const mails = h.emails.slice(sentBefore).filter((e) => e.to === 'approver@n.local');
    expect(mails).toHaveLength(2);
    for (const m of mails) {
      expect(m.html).toContain('/approvals/email-action?org=');
      expect(m.html).toContain('action=APPROVE');
      expect(m.text).toContain('You will be asked to confirm in FlowZa Time before anything is recorded.');
    }
  });
});

describe('notifications.retention', () => {
  it('purges old processed events, read notifications and settled deliveries in batches — never unprocessed or unread rows, nor a held or self-governed organisation', async () => {
    clock = new Date('2026-09-20T00:00:00Z');
    const old = (days: number) => new Date(clock.getTime() - days * 86_400_000);
    await a().insertInto('dataRetentionPolicies').values({ organizationId: ORG_POLICY, dataClass: 'notifications', retentionDays: 365, enabled: true }).execute();
    const ev = (org: string | null, occurredAt: Date, published: boolean) => ({ organizationId: org, eventType: 'device.online' as never, aggregateType: 'device', aggregateId: randomUUID(), payload: '{}', occurredAt, publishedAt: published ? occurredAt : null });
    await a().insertInto('domainEvents').values([
      ...Array.from({ length: 5 }, () => ev(ORG, old(100), true)),
      ev(null, old(100), true),
      ev(ORG, old(100), false), // unprocessed: kept
      ev(ORG, old(10), true), // recent: kept
      ev(ORG_HOLD, old(100), true), // legal hold: kept
    ]).execute();
    const notif = (org: string, createdAt: Date, read: boolean) => ({ organizationId: org, userId: U.owner, category: 'DEVICE' as const, type: 'device.online', title: 'x', data: '{}', createdAt, readAt: read ? createdAt : null });
    const recentNotif = (await a().insertInto('notifications').values(notif(ORG, old(5), true)).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('notifications').values([notif(ORG, old(200), true), notif(ORG, old(200), true), notif(ORG, old(200), true), notif(ORG, old(200), false), notif(ORG_POLICY, old(200), true), notif(ORG_HOLD, old(200), true)]).execute();
    await a().insertInto('notificationDeliveries').values([
      { organizationId: ORG, notificationId: recentNotif, channel: 'EMAIL', status: 'sent', createdAt: old(100) },
      { organizationId: ORG, notificationId: recentNotif, channel: 'EMAIL', status: 'failed', createdAt: old(100) },
      { organizationId: ORG, notificationId: recentNotif, channel: 'EMAIL', status: 'pending', createdAt: old(100) },
      { organizationId: ORG, notificationId: recentNotif, channel: 'EMAIL', status: 'sent', createdAt: old(10) },
    ]).execute();
    const count = async (q: Promise<Array<{ n: number | string | bigint }>>) => Number((await q)[0]?.n ?? 0);
    const oldEvents = () => count(sql<{ n: number }>`select count(*) as n from public.domain_events where occurred_at < ${old(90)} and published_at is not null`.execute(a()).then((r) => r.rows));
    const before = await oldEvents();
    expect(before).toBeGreaterThanOrEqual(7);

    // a capped run stops after one batch and says so; the next run carries on
    const capped = await runNotificationRetention(h.deps, { batchSize: 2, maxBatches: 1 });
    expect(capped.capped).toEqual(['deliveries', 'notifications', 'domainEvents']);
    expect(capped.domainEvents).toBe(2);

    const res = await runNotificationRetention(h.deps, { batchSize: 2 });
    expect(res.capped).toEqual([]);
    expect(res.domainEvents + capped.domainEvents).toBe(6); // 5 of ORG + 1 without organisation, in batches of 2
    expect(await oldEvents()).toBe(1); // the legal-hold organisation's
    expect(await count(sql<{ n: number }>`select count(*) as n from public.domain_events where published_at is null and occurred_at < ${old(90)}`.execute(a()).then((r) => r.rows))).toBe(1);
    const left = await a().selectFrom('notifications').select(['organizationId', 'readAt']).where('createdAt', '<', old(180)).execute();
    expect(left.map((n) => [n.organizationId, n.readAt === null]).sort()).toEqual([[ORG, true], [ORG_HOLD, false], [ORG_POLICY, false]].sort());
    const deliveries = await a().selectFrom('notificationDeliveries').select(['status', 'createdAt']).where('notificationId', '=', recentNotif).execute();
    expect(deliveries.map((d) => d.status).sort()).toEqual(['pending', 'sent']);
    const audit = await a().selectFrom('audit.logs').select(['action', 'newValue']).where('action', '=', 'notifications.retention_applied').execute();
    expect(audit.length).toBe(2);
  });

  it('the scheduler task enqueues one deduped retention job', async () => {
    await notificationTasks[1]!.run(h.deps);
    await notificationTasks[1]!.run(h.deps);
    const jobs = await a().selectFrom('jobs.queue').select(['jobType', 'dedupeKey']).where('jobType', '=', NOTIFICATION_RETENTION_JOB_TYPE).execute();
    expect(jobs).toEqual([{ jobType: NOTIFICATION_RETENTION_JOB_TYPE, dedupeKey: 'notification-retention' }]);
  });
});

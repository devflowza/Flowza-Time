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
/**
 * An approval notice the way the engine writes it (review 8-P0-1 — the relay derives every approval notice from its request):
 * the request, its level with the recipients SEATED on it (they are parties of the request), and the timeline entry written
 * in the same transaction as the event. Returns the request id (the event's aggregate).
 */
async function approvalEvent(type: string, o: { kind: string; userIds: string[]; entityType?: string; entityId?: string; employeeId?: string; subjectUserId?: string | null; detail?: Record<string, unknown>; payload?: Record<string, unknown>; seats?: Array<{ userId: string; resolutionPath?: string; viaDelegationOf?: string | null }>; mode?: 'ANY' | 'ALL' | 'QUORUM'; requiredCount?: number | null; requestId?: string }): Promise<string> {
  const requestId = o.requestId ?? randomUUID();
  await a().transaction().execute(async (t) => {
    if (!o.requestId) {
      const subject = o.subjectUserId === undefined ? U.emp : o.subjectUserId;
      await t.insertInto('approvalRequests').values({ id: requestId, organizationId: ORG, entityType: (o.entityType ?? 'ATTENDANCE_CORRECTION') as never, entityId: o.entityId ?? randomUUID(), branchId: BRANCH, employeeId: o.employeeId ?? E.one, subjectUserId: subject, requestedBy: subject, currentStep: 1, status: 'PENDING' }).execute();
      // already reminded: the reminder sweeps of the tests below leave these levels alone
      const step = await t.insertInto('approvalSteps').values({ organizationId: ORG, requestId, stepNo: 1, approverType: 'USER', mode: o.mode ?? 'ANY', requiredCount: o.requiredCount === undefined ? 1 : o.requiredCount, status: 'PENDING', activatedAt: clock, remindedAt: clock }).returning('id').executeTakeFirstOrThrow();
      const seats = o.seats ?? o.userIds.map((userId) => ({ userId }));
      await t.insertInto('approvalStepActors').values(seats.map((x) => ({ organizationId: ORG, stepId: step.id, userId: x.userId, viaDelegationOf: x.viaDelegationOf ?? null, resolutionPath: x.resolutionPath ?? 'user' }))).execute();
    }
    await t.insertInto('approvalRequestEvents').values({ organizationId: ORG, requestId, kind: o.kind, detail: JSON.stringify(o.detail ?? { stepNo: 1 }) }).execute();
    await t.insertInto('domainEvents').values({ organizationId: ORG, eventType: type as never, aggregateType: 'approval_request', aggregateId: requestId, payload: JSON.stringify({ ...(o.payload ?? {}), userIds: o.userIds }) }).execute();
  });
  return requestId;
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
  const pending = { kind: 'submitted' };
  const leave = { userId: U.owner, leaveTypeName: 'Annual', startDate: '2026-10-01', endDate: '2026-10-02' };
  const digest = { kind: 'digest', total: 2, counts: [{ entityType: 'LEAVE', count: 2 }], digestDate: '2026-09-15', userIds: [U.owner] };
  const MATRIX: Array<{ name: string; type: string; payload?: Record<string, unknown>; request?: { kind: string; entityType?: string }; aggregateType?: string; org?: Record<string, unknown>; prefs?: Array<[NotificationCategory, NotificationDeliveryChannel, boolean]>; expect: { row: boolean; inApp?: boolean; read?: boolean; email?: boolean } }> = [
    { name: 'approval pending, defaults: in-app + e-mail', type: 'approval.pending', request: pending, expect: { row: true, inApp: true, read: false, email: true } },
    { name: 'approval pending, e-mail preference off: in-app only', type: 'approval.pending', request: pending, prefs: [['APPROVAL', 'EMAIL', false]], expect: { row: true, inApp: true, email: false } },
    { name: 'approval pending, organisation switch off: in-app only', type: 'approval.pending', request: pending, org: { approvalPending: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'approval pending, in-app preference off: still in the inbox (an item to act on)', type: 'approval.pending', request: pending, prefs: [['APPROVAL', 'IN_APP', false]], expect: { row: true, inApp: true, read: false, email: true } },
    { name: 'leave decision, in-app preference off: e-mail only (stored read, out of the inbox)', type: 'leave.approved', payload: leave, prefs: [['LEAVE', 'IN_APP', false]], expect: { row: true, inApp: false, read: true, email: true } },
    { name: 'leave decision, both preferences off: nothing', type: 'leave.approved', payload: leave, prefs: [['LEAVE', 'IN_APP', false], ['LEAVE', 'EMAIL', false]], expect: { row: false } },
    { name: 'leave decision, leaveUpdates off: in-app only', type: 'leave.approved', payload: leave, org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'a decision on leave follows leaveUpdates', type: 'approval.decided', request: { kind: 'approved', entityType: 'LEAVE' }, org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'a decision on a correction does not follow leaveUpdates', type: 'approval.decided', request: { kind: 'rejected' }, org: { leaveUpdates: false }, expect: { row: true, inApp: true, email: true } },
    { name: 'a decision on a correction follows attendanceNotes', type: 'approval.decided', request: { kind: 'rejected' }, org: { attendanceNotes: false }, expect: { row: true, inApp: true, email: false } },
    { name: 'subscription notice ignores the member\'s preferences', type: 'subscription.limit_reached', payload: { metric: 'employees', limit: 5 }, prefs: [['SUBSCRIPTION', 'IN_APP', false], ['SUBSCRIPTION', 'EMAIL', false]], expect: { row: true, inApp: true, email: true } },
    { name: 'system notice ignores the member\'s preferences', type: 'employee.imported', payload: { phase: 'queued', validRows: 3 }, prefs: [['SYSTEM', 'IN_APP', false], ['SYSTEM', 'EMAIL', false]], expect: { row: true, inApp: true, email: true } },
    { name: 'daily digest: in-app only by default', type: 'approval.reminder', payload: digest, aggregateType: 'approval_digest', expect: { row: true, inApp: true, email: false } },
    { name: 'daily digest: e-mailed with dailyDigest on', type: 'approval.reminder', payload: digest, aggregateType: 'approval_digest', org: { dailyDigest: true }, expect: { row: true, inApp: true, email: true } },
    { name: 'report delivery asked for e-mail only with the e-mail preference off: nothing', type: 'report.scheduled_delivery', payload: { userIds: [U.owner], channels: ['email'], mode: 'send_now', reportType: 'late_report' }, prefs: [['REPORTS', 'EMAIL', false]], expect: { row: false } },
    { name: 'flagged punch with punchFlagged off: in-app only', type: 'attendance.punch_flagged', payload: { userIds: [U.owner], employeeId: E.one, employeeName: 'Emp 1', outcome: 'flagged', reason: 'outside', at: '2026-09-15T04:00:00Z' }, org: { punchFlagged: false }, expect: { row: true, inApp: true, email: false } },
  ];

  it.each(MATRIX)('$name', async (c) => {
    await setSwitches(ORG, c.org ?? {});
    await setPrefs(U.owner, c.prefs ?? []);
    const agg = c.request ? await approvalEvent(c.type, { ...c.request, userIds: [U.owner] }) : await emit(ORG, c.type, c.payload ?? {}, c.aggregateType ?? 'test');
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

  it('8-P1-4 a member without an employee link manages their e-mails at /account/notifications (every member can open it), never at Settings', async () => {
    const sentBefore = h.emails.length;
    await emit(ORG, 'report.ready', { userId: U.approver, reportTitle: 'Attendance summary', reportType: 'attendance_summary', format: 'xlsx' }, 'report');
    await relay();
    await deliver();
    const mail = h.emails.slice(sentBefore).find((e) => e.to === 'approver@n.local')!; // a manager with no employee link
    expect(mail.html).toContain('href="http://web.test/account/notifications"');
    expect(mail.text).toContain('http://web.test/account/notifications');
    expect(`${mail.html}${mail.text}`).not.toContain('/settings/notifications');
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

  it('8-P2-4 the relay tells the employee, in their language, with a link to /my (the check-in card — a page of the live bundle too)', async () => {
    await relay();
    const n = await a().selectFrom('notifications').select(['userId', 'title', 'link', 'category']).where('type', '=', 'punch.missing_out').where('organizationId', '=', ORG).orderBy('userId').execute();
    expect(n.map((x) => x.userId).sort()).toEqual([U.emp, U.e6].sort());
    const emp = n.find((x) => x.userId === U.emp)!;
    expect(emp.link).toBe('/my');
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

    // a capped run: every organisation and the organisation-less bucket still get their first batch (review 8-P1-1), then ONE
    // further batch (the cap) for the organisation with more to purge; it says so, and the next run carries on
    const capped = await runNotificationRetention(h.deps, { batchSize: 2, maxBatches: 1 });
    expect(capped.capped).toEqual(['domainEvents']);
    expect(capped.domainEvents).toBe(5); // ORG 2 + 2 (the one extra batch), the organisation-less event 1
    expect(capped.notifications).toBe(3); // ORG 2 + 1: done within the cap
    expect(capped.deliveries).toBe(2);

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

// ================================================================================================================================
// Notifications review fixes (docs/hr-portal/reviews/08-notifications-review.md)
// ================================================================================================================================
/** Relay whatever earlier tests left unpublished and settle the pending e-mails, so a test counts only its own. */
const settle = async () => { await relay(); await a().updateTable('notificationDeliveries').set({ status: 'skipped' }).where('status', '=', 'pending').execute(); };
const tokenCount = async (userId?: string) => (await (userId ? a().selectFrom('approvalEmailTokens').select('id').where('userId', '=', userId) : a().selectFrom('approvalEmailTokens').select('id')).execute()).length;
const noticeOf = (type: string, requestId: string, userId: string) => a().selectFrom('notifications').select(['id', 'title', 'body', 'link', 'data']).where('type', '=', type).where('userId', '=', userId).where(sql<boolean>`data->>'aggregateId' = ${requestId}`).executeTakeFirst();

describe('8-P0-1 an approval notice says what its REQUEST says, never what the event claims', () => {
  it('8-P0-1 a forged approval event — no request behind it, or no timeline entry of its own transaction — notifies nobody and mints no link', async () => {
    await settle();
    const tokens = await tokenCount();
    // a made-up request id (what a client could write before the outbox was locked)
    const ghost = await emit(ORG, 'approval.pending', { requestId: randomUUID(), entityType: 'LEAVE', employeeName: 'Somebody', userIds: [U.approver] }, 'approval_request');
    // a REAL request with the approver seated — the genuine notice goes out …
    const real = await approvalEvent('approval.pending', { kind: 'submitted', userIds: [U.approver] });
    await relay();
    expect(await noticeOf('approval.pending', real, U.approver)).toBeDefined();
    expect(await noticeOf('approval.pending', ghost, U.approver)).toBeUndefined();
    // … but a row naming that request, written by another transaction (no timeline entry of its own), is a forgery
    await a().insertInto('domainEvents').values({ organizationId: ORG, eventType: 'approval.decided', aggregateType: 'approval_request', aggregateId: real, payload: JSON.stringify({ decision: 'REJECTED', comment: 'Verify your account at https://evil.example', userIds: [U.approver, U.owner] }) }).execute();
    await a().insertInto('domainEvents').values({ organizationId: ORG, eventType: 'approval.pending', aggregateType: 'approval_request', aggregateId: real, payload: JSON.stringify({ employeeName: 'Somebody else', userIds: [U.approver] }) }).execute();
    const res = await relay();
    expect(res.failed).toBe(0);
    expect(await noticeOf('approval.decided', real, U.approver)).toBeUndefined();
    expect(await noticeOf('approval.decided', real, U.owner)).toBeUndefined();
    expect((await a().selectFrom('notifications').select('id').where('type', '=', 'approval.pending').where(sql<boolean>`data->>'aggregateId' = ${real}`).execute())).toHaveLength(1);
    // the forged rows are published (realtime) and never retried
    expect(await a().selectFrom('domainEvents').select('id').where('publishedAt', 'is', null).where('aggregateId', 'in', [real, ghost]).execute()).toHaveLength(0);
    const sentBefore = h.emails.length;
    await deliver();
    const mails = h.emails.slice(sentBefore);
    expect(mails).toHaveLength(1); // the genuine notice only
    expect(mails.some((m) => m.html.includes('evil.example'))).toBe(false);
    expect(await tokenCount()).toBe(tokens + 2); // one approve / reject pair, for the genuine notice
  });

  it('8-P0-1 a genuine notice renders the request\'s facts and its timeline\'s own comment; only the request\'s parties hear it', async () => {
    const req = await approvalEvent('approval.decided', {
      kind: 'rejected', detail: { stepNo: 1, comment: 'No proof given' }, userIds: [U.owner, U.approver], seats: [{ userId: U.owner }],
      // what the event claims: none of it reaches the notice
      payload: { decision: 'APPROVED', entityType: 'LEAVE', employeeName: 'Forged Name', comment: 'Click https://evil.example', leaveTypeName: 'Fake leave', date: '2020-01-01' },
    });
    await relay();
    const n = await noticeOf('approval.decided', req, U.owner);
    expect(n?.title).toBe('Attendance correction — Emp 1 was rejected');
    expect(n?.body).toContain('No proof given');
    expect(`${n?.title} ${n?.body}`).not.toMatch(/Forged|evil|Fake|2020/);
    expect(n?.data).toMatchObject({ decision: 'REJECTED', entityType: 'ATTENDANCE_CORRECTION', employeeName: 'Emp 1', comment: 'No proof given', requestId: req });
    // U.approver was named by the event but is no party of this request (not seated, not the requester, not the subject)
    expect(await noticeOf('approval.decided', req, U.approver)).toBeUndefined();
  });

  it('8-P0-1 the daily digest carries its counts only: no request, no entity, no one-click link, whatever the row claims', async () => {
    await settle();
    await setSwitches(ORG, { dailyDigest: true });
    const req = await approvalEvent('approval.pending', { kind: 'submitted', userIds: [U.owner] });
    await relay();
    const tokens = await tokenCount(U.owner);
    await deliver();
    expect(await tokenCount(U.owner)).toBe(tokens + 2); // the genuine pending notice: the owner holds the seat
    const digest = await emit(ORG, 'approval.reminder', { kind: 'reminder', requestId: req, entityType: 'LEAVE', employeeName: 'Somebody', total: 1, counts: [{ entityType: 'LEAVE', count: 1 }], digestDate: '2026-09-16', userIds: [U.owner] }, 'approval_digest');
    await relay();
    const n = await a().selectFrom('notifications').select(['title', 'link', 'data']).where('type', '=', 'approval.reminder').where('userId', '=', U.owner).where(sql<boolean>`data->>'aggregateId' = ${digest}`).executeTakeFirstOrThrow();
    expect(n.link).toBe('/approvals');
    expect(n.title).toBe('1 approval waiting for you');
    expect(n.data).not.toHaveProperty('requestId');
    expect(n.data).not.toHaveProperty('employeeName');
    const tokensAfterDigest = await tokenCount(U.owner);
    await deliver();
    expect(await tokenCount(U.owner)).toBe(tokensAfterDigest); // the digest mints nothing
    await setSwitches(ORG, {});
  });
});

describe('8-P1-2 one-click links only for the recipient\'s OWN pending seat on the current level', () => {
  it.each(['ALL', 'QUORUM'] as const)('8-P1-2 on an %s level with several seats waiting, the escalation target gets the request link only; the seat holders get working pairs', async (mode) => {
    await settle();
    const req = await approvalEvent('approval.pending', { kind: 'submitted', userIds: [U.approver, U.e6], mode, requiredCount: mode === 'QUORUM' ? 2 : null, subjectUserId: U.emp });
    const step = (await a().selectFrom('approvalSteps').select('id').where('requestId', '=', req).executeTakeFirstOrThrow()).id;
    // the level escalated to the owner: an extra hand, who would fill one of the two waiting seats and must choose which
    await a().insertInto('approvalStepActors').values({ organizationId: ORG, stepId: step, userId: U.owner, resolutionPath: 'escalated' }).execute();
    await approvalEvent('approval.escalated', { requestId: req, kind: 'escalated', detail: { stepNo: 1, target: 'OWNER', added: [U.owner] }, userIds: [U.owner] });
    await relay();
    const before = { owner: await tokenCount(U.owner), approver: await tokenCount(U.approver), e6: await tokenCount(U.e6) };
    const sentBefore = h.emails.length;
    await deliver();
    expect(await tokenCount(U.owner)).toBe(before.owner);
    expect(await tokenCount(U.approver)).toBe(before.approver + 2);
    expect(await tokenCount(U.e6)).toBe(before.e6 + 2);
    const ownerMail = h.emails.slice(sentBefore).find((m) => m.to === 'owner@n.local')!;
    expect(ownerMail.subject).toContain('Escalated to you');
    expect(ownerMail.html).not.toContain('/approvals/email-action');
    expect(ownerMail.html).toContain(`http://web.test/approvals?request=${req}`);
    expect(h.emails.slice(sentBefore).find((m) => m.to === 'approver@n.local')!.html).toContain('/approvals/email-action');
  });

  it('8-P1-2 a delegate\'s seat gets links only while the delegation is in force; a seat decided for its holder gets none', async () => {
    await settle();
    // U.e6 was stamped at submit as the delegate of U.approver
    const lapsed = await approvalEvent('approval.pending', { kind: 'submitted', userIds: [U.e6], seats: [{ userId: U.e6, resolutionPath: 'delegate', viaDelegationOf: U.approver }] });
    await relay();
    const e6 = await tokenCount(U.e6);
    await deliver();
    expect(await tokenCount(U.e6)).toBe(e6); // no delegation in force today: the seat is the approver's again
    expect(await noticeOf('approval.pending', lapsed, U.e6)).toBeDefined(); // the notice itself still goes out
    const delegation = (await a().insertInto('approvalDelegations').values({ organizationId: ORG, delegatorUserId: U.approver, delegateUserId: U.e6, startsOn: '2000-01-01', endsOn: '2099-12-31', isActive: true }).returning('id').executeTakeFirstOrThrow()).id;
    try {
      await approvalEvent('approval.reminder', { requestId: lapsed, kind: 'reminded', detail: { stepNo: 1, waitingSince: clock.toISOString() }, userIds: [U.e6] });
      await relay();
      await deliver();
      expect(await tokenCount(U.e6)).toBe(e6 + 2); // in force: the delegate decides the seat
      // the approver decided their seat themselves meanwhile: the delegate's row still reads PENDING, the seat does not
      const step = (await a().selectFrom('approvalSteps').select('id').where('requestId', '=', lapsed).executeTakeFirstOrThrow()).id;
      await a().insertInto('approvalStepActors').values({ organizationId: ORG, stepId: step, userId: U.approver, resolutionPath: 'user', decision: 'APPROVED', decidedAt: new Date() }).execute();
      await approvalEvent('approval.reminder', { requestId: lapsed, kind: 'reminded', detail: { stepNo: 1, waitingSince: clock.toISOString() }, userIds: [U.e6] });
      await relay();
      await deliver();
      expect(await tokenCount(U.e6)).toBe(e6 + 2);
    } finally {
      await a().deleteFrom('approvalDelegations').where('id', '=', delegation).execute();
    }
  });
});

describe('8-P2-2 leave-type names in the recipient\'s language, read from the leave', () => {
  it('8-P2-2 an Arabic recipient reads the Arabic name of the leave type — never the English one the event carried', async () => {
    const lt = (await a().insertInto('leaveTypes').values({ organizationId: ORG, code: 'CL', name: 'Casual Leave', nameAr: 'إجازة عارضة' }).returning('id').executeTakeFirstOrThrow()).id;
    const own = (await a().insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.one, leaveTypeId: lt, startDate: '2026-10-05', endDate: '2026-10-06', status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow()).id;
    // leave.approved as the leave hook writes it: the English name only
    await a().insertInto('domainEvents').values({ organizationId: ORG, eventType: 'leave.approved', aggregateType: 'leave_record', aggregateId: own, payload: JSON.stringify({ userId: U.emp, employeeId: E.one, leaveTypeName: 'Casual Leave', startDate: '2026-10-05', endDate: '2026-10-06' }) }).execute();
    await relay();
    const decided = await a().selectFrom('notifications').select(['title', 'data']).where('type', '=', 'leave.approved').where('userId', '=', U.emp).where(sql<boolean>`data->>'aggregateId' = ${own}`).executeTakeFirstOrThrow();
    expect(decided.title).toContain('إجازة عارضة');
    expect(decided.title).not.toContain('Casual');
    expect(decided.data).toMatchObject({ leaveTypeName: 'Casual Leave', leaveTypeNameAr: 'إجازة عارضة' });
    // the approval notice of somebody else's leave, to an Arabic approver: the facts come from the leave record, in Arabic
    const theirs = (await a().insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.noShift, leaveTypeId: lt, startDate: '2026-10-12', endDate: '2026-10-13', status: 'PENDING' }).returning('id').executeTakeFirstOrThrow()).id;
    const req = await approvalEvent('approval.pending', { kind: 'submitted', entityType: 'LEAVE', entityId: theirs, employeeId: E.noShift, subjectUserId: U.e6, userIds: [U.emp], payload: { leaveTypeName: 'Casual Leave' } });
    await relay();
    const pending = await noticeOf('approval.pending', req, U.emp);
    expect(pending?.body).toContain('إجازة عارضة');
    expect(pending?.body).not.toContain('Casual');
    // a rejected reason charged to that type's balance: the name, not the code
    const note = await emit(ORG, 'attendance.note_decided', { userIds: [U.emp], employeeId: E.one, attendanceDate: '2026-09-14', decision: 'rejected', payEffectDays: 1, chargeOutcome: 'charged_leave', leaveTypeCode: 'CL', lossOfPay: false }, 'attendance_note');
    await relay();
    const charged = await a().selectFrom('notifications').select('body').where('type', '=', 'attendance.note_decided').where('userId', '=', U.emp).where(sql<boolean>`data->>'aggregateId' = ${note}`).executeTakeFirstOrThrow();
    expect(charged.body).toContain('إجازة عارضة');
    expect(charged.body).not.toMatch(/\bCL\b/);
  });
});

describe('8-P2-3 delivery: one failing row never aborts, re-mails or stalls the batch', () => {
  it('8-P2-3 a failing delivery rolls back alone: the rows before it stay sent (never mailed twice), the rows after it are delivered', async () => {
    await settle();
    const first = await emit(ORG, 'device.offline', { deviceName: 'First' });
    await relay();
    const middle = await approvalEvent('approval.pending', { kind: 'submitted', userIds: [U.approver] });
    await relay();
    const last = await emit(ORG, 'device.online', { deviceName: 'Last' });
    await relay();
    const deliveryOf = async (type: string, agg: string, userId: string) => {
      const n = (await outcome(type, agg, userId)).n!;
      return a().selectFrom('notificationDeliveries').select(['status', 'attempts', 'error']).where('notificationId', '=', n.id).executeTakeFirstOrThrow();
    };
    // a test-only trigger makes the middle row's one-click token fail to mint
    await sql`create or replace function public.p8f_token_fail() returns trigger language plpgsql as $f$ begin if new.user_id = ${sql.lit(U.approver)}::uuid then raise exception 'token store down'; end if; return new; end $f$`.execute(a());
    await sql`create trigger p8f_token_fail before insert on public.approval_email_tokens for each row execute function public.p8f_token_fail()`.execute(a());
    const sentBefore = h.emails.length;
    try {
      const res = await deliver();
      expect(res).toMatchObject({ sent: 2, retried: 1, failed: 0 });
      expect(await deliveryOf('device.offline', first, U.owner)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(await deliveryOf('approval.pending', middle, U.approver)).toMatchObject({ status: 'pending', attempts: 1, error: 'token store down' });
      expect(await deliveryOf('device.online', last, U.owner)).toMatchObject({ status: 'sent', attempts: 1 });
    } finally {
      await sql`drop trigger if exists p8f_token_fail on public.approval_email_tokens`.execute(a());
      await sql`drop function if exists public.p8f_token_fail()`.execute(a());
    }
    clock = new Date(clock.getTime() + deliveryBackoffMs(1));
    await deliver();
    expect(await deliveryOf('approval.pending', middle, U.approver)).toMatchObject({ status: 'sent', attempts: 2 });
    const mails = h.emails.slice(sentBefore);
    expect(mails.filter((m) => m.to === 'owner@n.local')).toHaveLength(2); // never mailed twice
    expect(mails.filter((m) => m.to === 'approver@n.local')).toHaveLength(1);
  });
});

describe('8-P2-6 the missing check-out window follows the BRANCH timezone', () => {
  const PP = { org: '0c000000-0000-4000-8000-0000000000d1', branch: '0c000000-0000-4000-8000-0000000000d2', emp: '0c000000-0000-4000-8000-0000000000d3' };
  const KI = { org: '0c000000-0000-4000-8000-0000000000d4', branch: '0c000000-0000-4000-8000-0000000000d5', emp: '0c000000-0000-4000-8000-0000000000d6' };
  const USERS = { east: 'c0000000-0000-4000-8000-0000000000d1', west: 'c0000000-0000-4000-8000-0000000000d2' };
  const reminded = async (orgId: string) => (await a().selectFrom('domainEvents').select('payload').where('eventType', '=', 'punch.missing_out' as never).where('organizationId', '=', orgId).execute()).map((e) => e.payload as Record<string, unknown>);
  const record = (o: { organizationId: string; branchId: string; employeeId: string; date: string; timezone: string; firstInAt: string; expectedEndAt: string }) =>
    a().insertInto('attendanceDailyRecords').values({ organizationId: o.organizationId, employeeId: o.employeeId, attendanceDate: o.date, branchId: o.branchId, timezone: o.timezone, engineVersion: 'test', status: 'PENDING' as never, flags: [], trace: JSON.stringify({}), firstInAt: new Date(o.firstInAt), expectedEndAt: new Date(o.expectedEndAt), lastOutAt: null }).execute();

  beforeAll(async () => {
    await sql`insert into auth.users (id, email) values (${USERS.east}::uuid, 'east@n.local'), (${USERS.west}::uuid, 'west@n.local')`.execute(a());
    await a().insertInto('userProfiles').values([{ id: USERS.east, email: 'east@n.local', fullName: 'East' }, { id: USERS.west, email: 'west@n.local', fullName: 'West' }]).execute();
    // the organisation in Pago Pago (UTC−11) with a branch in Kiritimati (UTC+14) — the reviewer's case — and the reverse
    await a().insertInto('organizations').values([
      { id: PP.org, companyCode: 'NTFPP', legalName: 'PP', displayName: 'PP', timezone: 'Pacific/Pago_Pago' },
      { id: KI.org, companyCode: 'NTFKI', legalName: 'KI', displayName: 'KI', timezone: 'Pacific/Kiritimati' },
    ]).execute();
    await a().insertInto('branches').values([
      { id: PP.branch, organizationId: PP.org, code: 'EAST', name: 'East', timezone: 'Pacific/Kiritimati' },
      { id: KI.branch, organizationId: KI.org, code: 'WEST', name: 'West', timezone: 'Pacific/Pago_Pago' },
    ]).execute();
    await a().insertInto('employees').values([
      { id: PP.emp, organizationId: PP.org, branchId: PP.branch, employeeNumber: 'E', firstName: 'East', lastName: 'E', displayName: 'East', joiningDate: '2024-01-01', deviceUserId: '1' },
      { id: KI.emp, organizationId: KI.org, branchId: KI.branch, employeeNumber: 'W', firstName: 'West', lastName: 'W', displayName: 'West', joiningDate: '2024-01-01', deviceUserId: '1' },
    ]).execute();
    await a().insertInto('orgMemberships').values([
      { organizationId: PP.org, userId: USERS.east, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: PP.emp },
      { organizationId: KI.org, userId: USERS.west, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: KI.emp },
    ]).execute();
    // East: 16 Sept in Kiritimati, shift 08:00–17:00 local = 15 Sept 18:00 → 16 Sept 03:00 UTC; due 19:00 local = 05:00 UTC —
    // when the organisation's own date (Pago Pago) is still the 15th
    await record({ organizationId: PP.org, branchId: PP.branch, employeeId: PP.emp, date: '2026-09-16', timezone: 'Pacific/Kiritimati', firstInAt: '2026-09-15T18:05:00Z', expectedEndAt: '2026-09-16T03:00:00Z' });
    // West: 15 Sept in Pago Pago, shift 14:00–23:00 local = 16 Sept 01:00 → 10:00 UTC; due 01:00 local on the 16th = 12:00 UTC —
    // when the organisation's own date (Kiritimati) is already the 17th, so the 15th is not even its "yesterday"
    await record({ organizationId: KI.org, branchId: KI.branch, employeeId: KI.emp, date: '2026-09-15', timezone: 'Pacific/Pago_Pago', firstInAt: '2026-09-16T01:05:00Z', expectedEndAt: '2026-09-16T10:00:00Z' });
  });

  it('8-P2-6 a branch far EAST of the organisation (the reviewer\'s mp.branch_tz) is reminded once, at the right minute', async () => {
    clock = new Date('2026-09-16T04:59:00Z'); // 18:59 in Kiritimati (still 15 Sept 17:59 in Pago Pago)
    expect(await runMissingPunchReminders(h.deps, PP.org)).toMatchObject({ today: '2026-09-15', candidates: 1, notDue: 1, reminded: 0 });
    clock = new Date('2026-09-16T05:01:00Z');
    expect(await runMissingPunchReminders(h.deps, PP.org)).toMatchObject({ candidates: 1, reminded: 1, stale: 0 });
    clock = new Date('2026-09-16T11:30:00Z');
    expect(await runMissingPunchReminders(h.deps, PP.org)).toMatchObject({ reminded: 0 });
    expect(await reminded(PP.org)).toEqual([expect.objectContaining({ employeeId: PP.emp, attendanceDate: '2026-09-16', userIds: [USERS.east] })]);
  });

  it('8-P2-6 and a branch far WEST of the organisation too', async () => {
    clock = new Date('2026-09-16T11:59:00Z'); // 00:59 on the 16th in Pago Pago; already 17 Sept 01:59 in Kiritimati
    expect(await runMissingPunchReminders(h.deps, KI.org)).toMatchObject({ today: '2026-09-17', candidates: 1, notDue: 1, reminded: 0 });
    clock = new Date('2026-09-16T12:01:00Z');
    expect(await runMissingPunchReminders(h.deps, KI.org)).toMatchObject({ candidates: 1, reminded: 1 });
    expect(await reminded(KI.org)).toEqual([expect.objectContaining({ employeeId: KI.emp, attendanceDate: '2026-09-15', userIds: [USERS.west] })]);
  });
});

describe('8-P1-1 retention reaches every organisation', () => {
  it('8-P1-1 every organisation and the organisation-less bucket make progress in each run — even behind 205 organisations with nothing to purge', async () => {
    clock = new Date('2026-09-20T00:00:00Z');
    const old = new Date(clock.getTime() - 200 * 86_400_000);
    // whatever the tests above left to purge goes first, so that this run counts its own batches only
    await settle();
    await runNotificationRetention(h.deps);
    // 205 empty organisations whose ids sort before the tail's
    const empties = Array.from({ length: 205 }, (_, i) => ({ id: `1f000000-0000-4000-8000-${String(i).padStart(12, '0')}`, companyCode: `RET${i}`, legalName: `R${i}`, displayName: `R${i}`, timezone: 'Asia/Muscat' }));
    await a().insertInto('organizations').values(empties).execute();
    const TAIL = 'fe000000-0000-4000-8000-000000000001';
    await a().insertInto('organizations').values({ id: TAIL, companyCode: 'RETTAIL', legalName: 'Tail', displayName: 'Tail', timezone: 'Asia/Muscat' }).execute();
    const ev = (org: string | null) => ({ organizationId: org, eventType: 'device.online' as never, aggregateType: 'device', aggregateId: randomUUID(), payload: '{}', occurredAt: old, publishedAt: old });
    await a().insertInto('domainEvents').values([ev(TAIL), ev(TAIL), ev(TAIL), ev(null), ev(null), ev(null)]).execute();
    await a().insertInto('notifications').values(Array.from({ length: 3 }, () => ({ organizationId: TAIL, userId: U.owner, category: 'DEVICE' as const, type: 'device.online', title: 'x', data: '{}', createdAt: old, readAt: old }))).execute();
    const left = async () => ({
      tailEvents: Number((await sql<{ n: string }>`select count(*) as n from public.domain_events where organization_id = ${TAIL}::uuid`.execute(a())).rows[0]!.n),
      orphanEvents: Number((await sql<{ n: string }>`select count(*) as n from public.domain_events where organization_id is null and occurred_at < ${new Date(clock.getTime() - 90 * 86_400_000)}`.execute(a())).rows[0]!.n),
      tailNotifications: Number((await sql<{ n: string }>`select count(*) as n from public.notifications where organization_id = ${TAIL}::uuid`.execute(a())).rows[0]!.n),
    });
    expect(await left()).toEqual({ tailEvents: 3, orphanEvents: 3, tailNotifications: 3 });
    // the default constants (RETENTION_MAX_BATCHES = 200 < the organisations in front of the tail)
    const res = await runNotificationRetention(h.deps);
    expect(await left()).toEqual({ tailEvents: 0, orphanEvents: 0, tailNotifications: 0 });
    expect(res.organizations).toBeGreaterThan(205);
    expect(res.capped).toEqual([]);
    expect(res.batches).toBe(3); // the batches that deleted something: tail events, organisation-less events, tail notifications
  });
});

describe('8-P2-1 a pending question pauses the reminder and the escalation', () => {
  it('8-P2-1 no reminder, escalation or digest while INFO_REQUESTED; the reminder clock restarts from the answer', async () => {
    const Q = { org: '0c000000-0000-4000-8000-0000000000c1', branch: '0c000000-0000-4000-8000-0000000000c2', emp: '0c000000-0000-4000-8000-0000000000c3' };
    await a().insertInto('organizations').values({ id: Q.org, companyCode: 'NTFQ', legalName: 'Q', displayName: 'Q', timezone: 'Asia/Muscat' }).execute();
    await a().insertInto('branches').values({ id: Q.branch, organizationId: Q.org, code: 'HQ', name: 'HQ' }).execute();
    await a().insertInto('employees').values({ id: Q.emp, organizationId: Q.org, branchId: Q.branch, employeeNumber: 'Q1', firstName: 'Q', lastName: 'One', displayName: 'Q One', joiningDate: '2024-01-01', deviceUserId: '1' }).execute();
    await a().insertInto('orgMemberships').values([
      { organizationId: Q.org, userId: U.owner, roleId: ROLE.owner, status: 'active', allBranches: true },
      { organizationId: Q.org, userId: U.approver, roleId: ROLE.manager, status: 'active', allBranches: true },
      { organizationId: Q.org, userId: U.emp, roleId: ROLE.employee, status: 'active', allBranches: true, employeeId: Q.emp },
    ]).execute();
    const T = new Date('2026-09-19T20:00:00Z'); // 00:00 in Muscat on 20 Sept
    const H = (hours: number) => new Date(T.getTime() + hours * 3_600_000);
    const req = (await a().insertInto('approvalRequests').values({ organizationId: Q.org, entityType: 'OVERTIME_CLAIM', entityId: randomUUID(), branchId: Q.branch, employeeId: Q.emp, subjectUserId: U.emp, requestedBy: U.emp, currentStep: 1, status: 'PENDING', infoRequestedAt: H(1), createdAt: T }).returning('id').executeTakeFirstOrThrow()).id;
    const step = (await a().insertInto('approvalSteps').values({ organizationId: Q.org, requestId: req, stepNo: 1, approverType: 'USER', approverUserId: U.approver, mode: 'ANY', requiredCount: 1, status: 'PENDING', activatedAt: T, dueAt: H(2), escalateTo: 'OWNER', escalateAfterHours: 2 }).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('approvalStepActors').values({ organizationId: Q.org, stepId: step, userId: U.approver, resolutionPath: 'user' }).execute();
    await a().insertInto('approvalRequestEvents').values({ organizationId: Q.org, requestId: req, kind: 'info_requested', actorUserId: U.approver, at: H(1), detail: JSON.stringify({ stepNo: 1, comment: 'Which project?' }) }).execute();
    // past due and a day old — but the request waits for the requester's answer
    clock = H(30); // 06:00 Muscat on 21 Sept
    expect(await runApprovalReminders(h.deps, Q.org)).toEqual({ escalated: 0, reminded: 0, digests: 0 });
    clock = H(37); // 13:00 Muscat: the digest hour passed — nothing waits for an approver
    expect(await runApprovalReminders(h.deps, Q.org)).toEqual({ escalated: 0, reminded: 0, digests: 0 });
    // the answer (what answerInfo writes: the marker cleared, the timeline entry, the escalation deadline re-armed from it)
    const A = H(40);
    await a().updateTable('approvalRequests').set({ infoRequestedAt: null }).where('id', '=', req).execute();
    await a().insertInto('approvalRequestEvents').values({ organizationId: Q.org, requestId: req, kind: 'info_answered', actorUserId: U.emp, at: A, detail: JSON.stringify({ stepNo: 1, comment: 'Project X', dueAt: new Date(A.getTime() + 2 * 3_600_000).toISOString() }) }).execute();
    await a().updateTable('approvalSteps').set({ dueAt: new Date(A.getTime() + 2 * 3_600_000), remindedAt: null }).where('id', '=', step).execute();
    clock = new Date(A.getTime() + 1 * 3_600_000);
    expect(await runApprovalReminders(h.deps, Q.org)).toMatchObject({ escalated: 0, reminded: 0 });
    clock = new Date(A.getTime() + 3 * 3_600_000);
    expect(await runApprovalReminders(h.deps, Q.org)).toMatchObject({ escalated: 1, reminded: 0 });
    // the level became current 64 h ago, but the reminder waits a day from the ANSWER
    clock = new Date(A.getTime() + 23 * 3_600_000);
    expect(await runApprovalReminders(h.deps, Q.org)).toMatchObject({ reminded: 0 });
    clock = new Date(A.getTime() + 25 * 3_600_000);
    expect(await runApprovalReminders(h.deps, Q.org)).toMatchObject({ reminded: 1 });
    const reminder = await a().selectFrom('domainEvents').select('payload').where('eventType', '=', 'approval.reminder').where('aggregateId', '=', req).executeTakeFirstOrThrow();
    expect(reminder.payload).toMatchObject({ kind: 'reminder', waitingSince: A.toISOString() });
    const timeline = await a().selectFrom('approvalRequestEvents').select(['kind', 'detail']).where('requestId', '=', req).orderBy('id').execute();
    expect(timeline.map((t) => t.kind)).toEqual(['info_requested', 'info_answered', 'escalated', 'reminded']);
    expect(timeline[3]!.detail).toMatchObject({ waitingSince: A.toISOString() });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { withContext, type Trx } from '@flowza/database';
import { auditRows, createApiHarness, queueJobs, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * Report sharing and schedules (HR portal Prompt 6a): CRUD (report.view read, report.schedule write), validation, the next run
 * in the organisation's zone (Asia/Muscat), run-now, Send now, the delivery trail and the recipient picker. Tests named `6a-…`
 * are the regressions of the adversarial review (docs/hr-portal/reviews/06a-hr-attendance-workspace-review.md).
 */
let h: ApiHarness; let f: OrgFixture;
let restrictedScheduler: string; // payroll role limited to branch B
let lineManager: string;         // role manager linked to e3 (manages e1)
let branchBScheduleId: string;   // the restricted scheduler's own branch-B schedule

const schedule = (extra: Record<string, unknown> = {}) => ({
  name: 'Monthly late report', reportType: 'late_report', format: 'csv', cadence: 'monthly', runDay: 1, runTime: '07:00', periodRule: 'previous_month',
  recipients: { userIds: [] as string[], roleKeys: ['hr_admin'] }, channels: ['in_app', 'email'], ...extra,
});

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_rsched_${process.pid}`); f = await seedOrg(h.admin, 'rsched');
  restrictedScheduler = uuid('c'); await seedUser(h.admin, restrictedScheduler, 'restricted-rsched@test.local', 'Restricted'); await seedMembership(h.admin, f.orgId, restrictedScheduler, ROLE.payroll, { branchIds: [f.branchB] });
  lineManager = uuid('c'); await seedUser(h.admin, lineManager, 'line-manager-rsched@test.local', 'Line Manager'); await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: f.e3 });
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const local = (iso: string) => DateTime.fromISO(iso).setZone('Asia/Muscat');

describe('report schedules — CRUD and permissions', () => {
  let id: string;
  it('creates a monthly schedule whose next run is the next run day at the run time in the organisation zone', async () => {
    const res = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule() });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    const next = local(res.body.data.nextRunAt);
    expect(next.day).toBe(1);
    expect(next.toFormat('HH:mm')).toBe('07:00');
    expect(next.toMillis()).toBeGreaterThan(Date.now());
    expect(next.diffNow('days').days).toBeLessThanOrEqual(31);
    expect(res.body.data.nextPeriod.from.endsWith('-01')).toBe(true);
    expect(res.body.data).toMatchObject({ timezone: 'Asia/Muscat', lastStatus: null, createdByName: 'owner', recipients: { userIds: [], roleKeys: ['hr_admin'] } });
    expect((await auditRows(h.admin, 'report_schedule.created'))[0]).toMatchObject({ entityId: id });
  });

  it('computes weekly and month-end runs', async () => {
    const weekly = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule({ name: 'Weekly', reportType: 'weekly_attendance', cadence: 'weekly', runDay: 0, runTime: '06:30', periodRule: 'previous_week' }) });
    expect(weekly.status).toBe(201);
    const w = local(weekly.body.data.nextRunAt);
    expect(w.weekday).toBe(7); // Sunday
    expect(w.toFormat('HH:mm')).toBe('06:30');
    expect(w.diffNow('days').days).toBeLessThanOrEqual(7);
    const nextPeriod = weekly.body.data.nextPeriod;
    expect(DateTime.fromISO(nextPeriod.to).diff(DateTime.fromISO(nextPeriod.from), 'days').days).toBe(6);
    const monthEnd = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule({ name: 'Payroll cut-off', cadence: 'monthly', runDay: 28, runTime: '23:45', periodRule: 'custom', customFromDay: 26, customToDay: 25 }) });
    expect(monthEnd.status).toBe(201);
    const m = local(monthEnd.body.data.nextRunAt);
    expect([m.day, m.toFormat('HH:mm')]).toEqual([28, '23:45']);
    expect(monthEnd.body.data.nextPeriod.from.endsWith('-26')).toBe(true);
    expect(monthEnd.body.data.nextPeriod.to.endsWith('-25')).toBe(true);
  });

  it('PATCH of one field changes nothing else; a timing change recomputes the next run', async () => {
    const before = (await h.request('GET', `${base()}/report-schedules/${id}`, { token: f.owner })).body.data;
    const renamed = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: f.owner, body: { name: 'Renamed' } });
    expect(renamed.status).toBe(200);
    expect({ ...renamed.body.data, name: before.name, updatedAt: before.updatedAt }).toEqual(before);
    const moved = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: f.owner, body: { runDay: 15, runTime: '09:15' } });
    expect(moved.status).toBe(200);
    const next = local(moved.body.data.nextRunAt);
    expect([next.day, next.toFormat('HH:mm')]).toEqual([15, '09:15']);
    const paused = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: f.owner, body: { isActive: false } });
    expect(paused.body.data).toMatchObject({ isActive: false, nextRunAt: null });
    const resumed = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: f.owner, body: { isActive: true } });
    expect(resumed.body.data.nextRunAt).not.toBeNull();
  });

  it('reads need report.view, writes report.schedule (+ the report type permissions)', async () => {
    const hrAdminList = await h.request('GET', `${base()}/report-schedules`, { token: f.hrAdmin });
    expect(hrAdminList.status).toBe(200);
    expect(hrAdminList.body.data.length).toBeGreaterThan(0);
    // hr_user holds report.view without report.schedule
    const hrUserCreate = await h.request('POST', `${base()}/report-schedules`, { token: f.hrUser, body: schedule() });
    expect(hrUserCreate.status).toBe(403);
    const employee = await h.request('GET', `${base()}/report-schedules`, { token: f.employeeUser });
    expect(employee.status).toBe(403);
    // payroll holds report.schedule but not audit.view: it may not distribute the audit trail
    const audit = await h.request('POST', `${base()}/report-schedules`, { token: f.payrollUser, body: schedule({ reportType: 'audit_report' }) });
    expect(audit.status).toBe(403);
    const outsider = await h.request('POST', `${base()}/report-schedules`, { token: f.outsider, body: schedule() });
    expect(outsider.status).toBe(403);
  });

  it('6a-P report.schedule is held by owner, org_admin, hr_admin and payroll — hr_admin now schedules and shares', async () => {
    const holders = (await h.admin.selectFrom('rolePermissions as rp').innerJoin('roles as r', 'r.id', 'rp.roleId').select('r.key')
      .where('r.isSystem', '=', true).where('r.organizationId', 'is', null).where('rp.permissionKey', '=', 'report.schedule').execute()).map((r) => r.key).sort();
    expect(holders).toEqual(['hr_admin', 'org_admin', 'owner', 'payroll']);
    const created = await h.request('POST', `${base()}/report-schedules`, { token: f.hrAdmin, body: schedule({ name: 'HR monthly' }) });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ createdBy: f.hrAdmin, branchId: null });
  });

  it('6a-D3 a branch-scoped scheduler must pick one of their branches, and sees only those schedules', async () => {
    const noBranch = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule() });
    expect(noBranch.status).toBe(403);
    const otherBranch = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule({ filters: { branchId: f.branchA } }) });
    expect(otherBranch.status).toBe(403);
    const own = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule({ name: 'Branch B', filters: { branchId: f.branchB } }) });
    expect(own.status).toBe(201);
    expect(own.body.data.branchId).toBe(f.branchB);
    branchBScheduleId = own.body.data.id;
    const list = await h.request('GET', `${base()}/report-schedules`, { token: restrictedScheduler });
    // organisation-wide schedules (branch null) are for unrestricted memberships only; branch A ones never
    expect(list.body.data.map((s: { id: string }) => s.id)).toEqual([branchBScheduleId]);
    expect((await h.request('GET', `${base()}/report-schedules/${id}`, { token: restrictedScheduler })).status).toBe(404);
    const cannotEditOrgWide = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: restrictedScheduler, body: { name: 'hijack' } });
    expect(cannotEditOrgWide.status).toBe(403);
  });

  it('6a-D3 branch scheduler cannot re-point, run or delete an organisation-wide schedule (review probe B)', async () => {
    const stored = async (scheduleId: string) => h.admin.selectFrom('reportSchedules').selectAll().where('id', '=', scheduleId).executeTakeFirstOrThrow();
    const before = await stored(id);
    const jobsBefore = (await queueJobs(h.admin, 'RUN_REPORT_SCHEDULE')).length;
    // the probe: re-point the owner's organisation-wide schedule to the scheduler's own branch with themselves as the recipient
    const repoint = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: restrictedScheduler, body: { filters: { branchId: f.branchB }, recipients: { userIds: [restrictedScheduler], roleKeys: [] } } });
    expect(repoint.status).toBe(403);
    expect((await h.request('POST', `${base()}/report-schedules/${id}/run-now`, { token: restrictedScheduler })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/report-schedules/${id}`, { token: restrictedScheduler })).status).toBe(403);
    expect(await stored(id)).toEqual(before);
    expect((await queueJobs(h.admin, 'RUN_REPORT_SCHEDULE')).length).toBe(jobsBefore);
    // another branch's schedule is not theirs either
    const branchA = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule({ name: 'Branch A', filters: { branchId: f.branchA } }) });
    expect(branchA.status).toBe(201);
    expect((await h.request('PATCH', `${base()}/report-schedules/${branchA.body.data.id}`, { token: restrictedScheduler, body: { filters: { branchId: f.branchB } } })).status).toBe(403);
    expect((await h.request('DELETE', `${base()}/report-schedules/${branchA.body.data.id}`, { token: restrictedScheduler })).status).toBe(403);
    // their own branch's schedule stays theirs: rename, run now
    const renamed = await h.request('PATCH', `${base()}/report-schedules/${branchBScheduleId}`, { token: restrictedScheduler, body: { name: 'Branch B late' } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Branch B late', branchId: f.branchB });
    expect((await h.request('POST', `${base()}/report-schedules/${branchBScheduleId}/run-now`, { token: restrictedScheduler })).status).toBe(202);
  });

  it('6a-D3 schedules are written by the service only: a direct client write (PostgREST) raises, next_run_at cannot be rewound', async () => {
    const asUser = <T>(userId: string, fn: (trx: Trx) => Promise<T>) => withContext(h.tdb.db, { kind: 'user', userId, requestId: `probe-${userId}` }, fn);
    const rewind = new Date(Date.now() - 60_000);
    await expect(asUser(restrictedScheduler, (trx) => trx.updateTable('reportSchedules').set({ nextRunAt: rewind }).where('id', '=', branchBScheduleId).execute())).rejects.toThrow(/permission denied/);
    await expect(asUser(f.owner, (trx) => trx.updateTable('reportSchedules').set({ nextRunAt: rewind }).where('id', '=', id).execute())).rejects.toThrow(/permission denied/);
    await expect(asUser(restrictedScheduler, (trx) => trx.deleteFrom('reportSchedules').where('id', '=', id).execute())).rejects.toThrow(/permission denied/);
    await expect(asUser(restrictedScheduler, (trx) => trx.insertInto('reportSchedules').values({ organizationId: f.orgId, name: 'direct', reportType: 'late_report', format: 'csv', filters: '{}', branchId: null, cadence: 'monthly', runDay: 1, runTime: '07:00', periodRule: 'previous_month', recipients: JSON.stringify({ userIds: [restrictedScheduler], roleKeys: [] }), channels: ['in_app'], isActive: true, nextRunAt: rewind }).execute())).rejects.toThrow(/permission denied/);
    const row = await h.admin.selectFrom('reportSchedules').select('nextRunAt').where('id', '=', branchBScheduleId).executeTakeFirstOrThrow();
    expect(new Date(row.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('validates cadence / period / parameters / recipients', async () => {
    const cases: Array<[Record<string, unknown>, number]> = [
      [{ cadence: 'weekly', runDay: 1, periodRule: 'previous_month' }, 400],
      [{ periodRule: 'custom', customFromDay: 1, customToDay: 28 }, 400],
      [{ reportType: 'monthly_attendance', periodRule: 'custom', customFromDay: 26, customToDay: 25 }, 400],
      [{ reportType: 'daily_attendance' }, 400],
      [{ runDay: 29 }, 400],
      [{ reportType: 'employee_attendance' }, 400], // needs employeeIds
      [{ reportType: 'leave_report', filters: { leaveTypeCode: 'NOPE' } }, 400],
      [{ recipients: { userIds: [uuid('c')], roleKeys: [] } }, 400],
      [{ recipients: { userIds: [], roleKeys: ['no_such_role'] } }, 400],
      [{ recipients: { userIds: [], roleKeys: [] } }, 400],
      [{ channels: [] }, 400],
    ];
    for (const [extra, status] of cases) {
      const res = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule(extra) });
      expect([JSON.stringify(extra), res.status]).toEqual([JSON.stringify(extra), status]);
    }
  });

  it('run-now queues one RUN_REPORT_SCHEDULE for the period the schedule would cover now; DELETE removes it', async () => {
    const run = await h.request('POST', `${base()}/report-schedules/${id}/run-now`, { token: f.owner });
    expect(run.status).toBe(202);
    expect(run.body.data.runKey).toMatch(/^manual:/);
    const job = (await queueJobs(h.admin, 'RUN_REPORT_SCHEDULE')).find((j) => j.payload['runKey'] === run.body.data.runKey);
    expect(job?.payload).toMatchObject({ mode: 'manual', scheduleId: id, organizationId: f.orgId, requestedBy: f.owner });
    expect(job?.queueName).toBe('reports');
    const today = DateTime.now().setZone('Asia/Muscat');
    expect(run.body.data.period.from).toBe(today.startOf('month').minus({ months: 1 }).toISODate());
    const hrUser = await h.request('POST', `${base()}/report-schedules/${id}/run-now`, { token: f.hrUser });
    expect(hrUser.status).toBe(403);
    const del = await h.request('DELETE', `${base()}/report-schedules/${id}`, { token: f.owner });
    expect(del.status).toBe(204);
    expect((await h.request('GET', `${base()}/report-schedules/${id}`, { token: f.owner })).status).toBe(404);
    expect((await auditRows(h.admin, 'report_schedule.deleted'))[0]).toMatchObject({ entityId: id });
  });
});

describe('Send now, deliveries and the recipient picker', () => {
  it('queues one run for the resolved recipients; the sender needs report.schedule and the type permissions', async () => {
    const res = await h.request('POST', `${base()}/reports/share`, { token: f.owner, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' }, recipients: { userIds: [f.hrUser, lineManager], roleKeys: ['hr_admin'] }, channels: ['email'], note: 'For the monthly review' } });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', recipients: 3 });
    const job = (await queueJobs(h.admin, 'RUN_REPORT_SCHEDULE')).find((j) => j.payload['runKey'] === res.body.data.runKey);
    expect(job?.payload).toMatchObject({ mode: 'send_now', requestedBy: f.owner, spec: { reportType: 'late_report', format: 'csv', channels: ['email'], parameters: { from: '2026-08-01', to: '2026-08-31' }, note: 'For the monthly review' } });
    expect((await auditRows(h.admin, 'report.shared'))[0]?.newValue).toMatchObject({ resolvedRecipients: 3, reportType: 'late_report' });
    const missing = await h.request('POST', `${base()}/reports/share`, { token: f.owner, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01' }, recipients: { userIds: [f.hrUser] } } });
    expect(missing.status).toBe(400);
    const hrUser = await h.request('POST', `${base()}/reports/share`, { token: f.hrUser, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' }, recipients: { userIds: [f.owner] } } });
    expect(hrUser.status).toBe(403);
    // hr_admin holds report.schedule since the review
    const hrAdmin = await h.request('POST', `${base()}/reports/share`, { token: f.hrAdmin, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' }, recipients: { userIds: [f.hrUser] } } });
    expect(hrAdmin.status).toBe(202);
    const stranger = await h.request('POST', `${base()}/reports/share`, { token: f.owner, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' }, recipients: { userIds: [f.outsider] } } });
    expect(stranger.status).toBe(400);
  });

  it('the delivery trail: a recipient sees their own rows, a scheduler sees all', async () => {
    const runKey = `send:${uuid('7')}`;
    await h.admin.insertInto('reportDeliveries').values([
      { organizationId: f.orgId, runKey, mode: 'send_now', reportType: 'late_report', format: 'csv', recipientUserId: f.hrUser, sentBy: f.owner, status: 'queued', scope: JSON.stringify({ kind: 'ORGANIZATION' }) },
      { organizationId: f.orgId, runKey, mode: 'send_now', reportType: 'late_report', format: 'csv', recipientUserId: lineManager, sentBy: f.owner, status: 'skipped', skipReason: 'missing_permission:report.export' },
    ]).execute();
    const owner = await h.request('GET', `${base()}/report-deliveries`, { token: f.owner });
    expect(owner.status).toBe(200);
    expect(owner.body.data.filter((d: { status: string }) => ['queued', 'skipped'].includes(d.status)).length).toBeGreaterThanOrEqual(2);
    const skipped = owner.body.data.find((d: { recipientUserId: string }) => d.recipientUserId === lineManager);
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'missing_permission:report.export', recipientName: 'Line Manager', sentByName: 'owner' });
    const recipient = await h.request('GET', `${base()}/report-deliveries`, { token: f.hrUser });
    expect(recipient.status).toBe(200);
    expect(recipient.body.data.every((d: { recipientUserId: string }) => d.recipientUserId === f.hrUser)).toBe(true);
    const employee = await h.request('GET', `${base()}/report-deliveries`, { token: f.employeeUser });
    expect(employee.status).toBe(403);
  });

  it('6a-D3 a branch-scoped scheduler sees what they sent, received or scheduled for their branches — not the organisation trail', async () => {
    const orgWide = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule({ name: 'Org-wide absences', reportType: 'absence_report' }) });
    expect(orgWide.status).toBe(201);
    const key = () => `probe:${uuid('7')}`;
    const rows = [
      { organizationId: f.orgId, runKey: key(), mode: 'schedule', reportType: 'absence_report', format: 'csv', scheduleId: orgWide.body.data.id, recipientUserId: f.hrUser, sentBy: null, status: 'delivered' }, // org-wide schedule
      { organizationId: f.orgId, runKey: key(), mode: 'schedule', reportType: 'late_report', format: 'csv', scheduleId: branchBScheduleId, recipientUserId: lineManager, sentBy: null, status: 'delivered' }, // their branch's schedule
      { organizationId: f.orgId, runKey: key(), mode: 'send_now', reportType: 'late_report', format: 'csv', scheduleId: null, recipientUserId: f.hrUser, sentBy: restrictedScheduler, status: 'queued' }, // they sent it
      { organizationId: f.orgId, runKey: key(), mode: 'send_now', reportType: 'late_report', format: 'csv', scheduleId: null, recipientUserId: restrictedScheduler, sentBy: f.owner, status: 'queued' }, // they received it
      { organizationId: f.orgId, runKey: key(), mode: 'send_now', reportType: 'late_report', format: 'csv', scheduleId: null, recipientUserId: f.hrUser, sentBy: f.owner, status: 'queued' }, // somebody else's
    ];
    const ids = (await h.admin.insertInto('reportDeliveries').values(rows).returning('id').execute()).map((r) => r.id);
    const seen = async (token: string) => new Set((await h.request('GET', `${base()}/report-deliveries?pageSize=200`, { token })).body.data.map((d: { id: string }) => d.id));
    const restricted = await seen(restrictedScheduler);
    expect(ids.map((i) => restricted.has(i))).toEqual([false, true, true, true, false]);
    // RLS applies the same rule to a direct read (PostgREST)
    const direct = await withContext(h.tdb.db, { kind: 'user', userId: restrictedScheduler, requestId: 'probe-deliveries' }, (trx) => trx.selectFrom('reportDeliveries').select('id').where('id', 'in', ids).execute());
    expect(ids.map((i) => direct.some((d) => d.id === i))).toEqual([false, true, true, true, false]);
    const hrAdmin = await seen(f.hrAdmin); // unrestricted report.schedule: the whole trail
    expect(ids.every((i) => hrAdmin.has(i))).toBe(true);
    const recipient = await seen(f.hrUser); // no report.schedule: their own rows
    expect(ids.map((i) => recipient.has(i))).toEqual([true, false, true, false, true]);
  });

  it('the picker lists members (manager flag, branch scope) and roles for report.schedule holders only', async () => {
    const res = await h.request('GET', `${base()}/report-recipients`, { token: f.owner });
    expect(res.status).toBe(200);
    const manager = res.body.data.users.find((u: { userId: string }) => u.userId === lineManager);
    expect(manager).toMatchObject({ roleKey: 'manager', isManager: true, branchCount: null, email: 'line-manager-rsched@test.local' });
    expect(res.body.data.users.find((u: { userId: string }) => u.userId === f.branchManagerB)).toMatchObject({ branchCount: 1, isManager: false });
    expect(res.body.data.roles.find((r: { key: string }) => r.key === 'hr_admin')).toMatchObject({ members: 1 });
    expect(res.body.data.users.some((u: { userId: string }) => u.userId === f.outsider)).toBe(false);
    const hrUser = await h.request('GET', `${base()}/report-recipients`, { token: f.hrUser });
    expect(hrUser.status).toBe(403);
  });

  it('6a-M12 the picker is scoped to the caller\'s branches and shows e-mail addresses to user.view holders only', async () => {
    const branchAOnly = uuid('c'); await seedUser(h.admin, branchAOnly, 'branch-a-only-rsched@test.local', 'Branch A only'); await seedMembership(h.admin, f.orgId, branchAOnly, ROLE.hr_user, { branchIds: [f.branchA] });
    const users = async (token: string) => (await h.request('GET', `${base()}/report-recipients`, { token })).body.data as { users: Array<{ userId: string; email: string | null; displayName: string }>; roles: Array<{ key: string; members: number }> };
    const owner = await users(f.owner);
    expect(owner.users.find((u) => u.userId === branchAOnly)).toMatchObject({ email: 'branch-a-only-rsched@test.local', displayName: 'Branch A only' });
    expect(owner.roles.find((r) => r.key === 'hr_user')?.members).toBe(3);
    // hr_admin holds user.view: e-mail addresses
    expect((await users(f.hrAdmin)).users.find((u) => u.userId === lineManager)?.email).toBe('line-manager-rsched@test.local');
    // payroll schedules reports without user.view: names only, never an address
    const payroll = await users(f.payrollUser);
    expect(payroll.users.length).toBeGreaterThan(0);
    expect(payroll.users.every((u) => u.email === null)).toBe(true);
    expect(payroll.users.find((u) => u.userId === lineManager)?.displayName).toBe('Line Manager');
    // a branch-B scheduler: members whose access reaches branch B, never a branch-A-only member; role counts over that set
    const restricted = await users(restrictedScheduler);
    expect(restricted.users.some((u) => u.userId === branchAOnly)).toBe(false);
    expect(restricted.users.some((u) => u.userId === f.branchManagerB)).toBe(true);
    expect(restricted.users.some((u) => u.userId === f.owner)).toBe(true);
    expect(restricted.users.every((u) => u.email === null)).toBe(true);
    expect(restricted.roles.find((r) => r.key === 'hr_user')?.members).toBe(2);
    // … and a Send now to such a member is refused like an unknown recipient
    const share = (userIds: string[]) => h.request('POST', `${base()}/reports/share`, { token: restrictedScheduler, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31', branchId: f.branchB }, recipients: { userIds } } });
    expect((await share([branchAOnly])).status).toBe(400);
    expect((await share([f.branchManagerB])).status).toBe(202);
  });
});

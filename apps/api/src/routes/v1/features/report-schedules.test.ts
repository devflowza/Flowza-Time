import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { auditRows, createApiHarness, queueJobs, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * Report sharing and schedules (HR portal Prompt 6a): CRUD (report.view read, report.schedule write), validation, the next run
 * in the organisation's zone (Asia/Muscat), run-now, Send now, the delivery trail and the recipient picker.
 */
let h: ApiHarness; let f: OrgFixture;
let restrictedScheduler: string; // payroll role limited to branch B
let lineManager: string;         // role manager linked to e3 (manages e1)

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
    const hrAdminCreate = await h.request('POST', `${base()}/report-schedules`, { token: f.hrAdmin, body: schedule() });
    expect(hrAdminCreate.status).toBe(403);
    const employee = await h.request('GET', `${base()}/report-schedules`, { token: f.employeeUser });
    expect(employee.status).toBe(403);
    // payroll holds report.schedule but not audit.view: it may not distribute the audit trail
    const audit = await h.request('POST', `${base()}/report-schedules`, { token: f.payrollUser, body: schedule({ reportType: 'audit_report' }) });
    expect(audit.status).toBe(403);
    const outsider = await h.request('POST', `${base()}/report-schedules`, { token: f.outsider, body: schedule() });
    expect(outsider.status).toBe(403);
  });

  it('a branch-scoped scheduler must pick one of their branches, and sees only those schedules', async () => {
    const noBranch = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule() });
    expect(noBranch.status).toBe(403);
    const otherBranch = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule({ filters: { branchId: f.branchA } }) });
    expect(otherBranch.status).toBe(403);
    const own = await h.request('POST', `${base()}/report-schedules`, { token: restrictedScheduler, body: schedule({ name: 'Branch B', filters: { branchId: f.branchB } }) });
    expect(own.status).toBe(201);
    expect(own.body.data.branchId).toBe(f.branchB);
    const list = await h.request('GET', `${base()}/report-schedules`, { token: restrictedScheduler });
    // organisation-wide schedules (branch null) stay readable; branch A ones would not
    expect(list.body.data.every((s: { branchId: string | null }) => s.branchId === null || s.branchId === f.branchB)).toBe(true);
    const cannotEditOrgWide = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: restrictedScheduler, body: { name: 'hijack' } });
    expect(cannotEditOrgWide.status).toBe(403);
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
    const hrAdmin = await h.request('POST', `${base()}/report-schedules/${id}/run-now`, { token: f.hrAdmin });
    expect(hrAdmin.status).toBe(403);
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
    const hrAdmin = await h.request('POST', `${base()}/reports/share`, { token: f.hrAdmin, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31' }, recipients: { userIds: [f.hrUser] } } });
    expect(hrAdmin.status).toBe(403);
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

  it('the picker lists members (manager flag, branch scope) and roles for report.schedule holders only', async () => {
    const res = await h.request('GET', `${base()}/report-recipients`, { token: f.owner });
    expect(res.status).toBe(200);
    const manager = res.body.data.users.find((u: { userId: string }) => u.userId === lineManager);
    expect(manager).toMatchObject({ roleKey: 'manager', isManager: true, branchCount: null });
    expect(res.body.data.users.find((u: { userId: string }) => u.userId === f.branchManagerB)).toMatchObject({ branchCount: 1, isManager: false });
    expect(res.body.data.roles.find((r: { key: string }) => r.key === 'hr_admin')).toMatchObject({ members: 1 });
    expect(res.body.data.users.some((u: { userId: string }) => u.userId === f.outsider)).toBe(false);
    const hrAdmin = await h.request('GET', `${base()}/report-recipients`, { token: f.hrAdmin });
    expect(hrAdmin.status).toBe(403);
  });
});

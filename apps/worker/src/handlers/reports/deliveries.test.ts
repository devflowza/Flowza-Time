import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { relayOutbox } from '../notifications/outbox.js';
import { scheduleDueReports } from '../../tasks/reports.js';
import { runReportDeliveryHandler, settleDelivery } from './deliveries.js';
import { generateReportRequest } from './generate.js';

/**
 * RUN_REPORT_SCHEDULE (HR portal Prompt 6a) with an injected clock: the scheduler admits a due occurrence once, the run
 * generates one report per recipient under the recipient's own scope (organisation / branches / team) or records why not,
 * advances next_run_at in the organisation zone, and a replay of the same occurrence is a no-op. Completion notifies the
 * recipient through report.scheduled_delivery with the chosen channels.
 */
const ORG = '0c600000-0000-4000-a000-000000000001';
const BRANCH_A = '0c600000-0000-4000-a000-00000000000a';
const BRANCH_B = '0c600000-0000-4000-a000-00000000000b';
const E1 = '0c600000-0000-4000-a000-0000000000e1'; // branch A, reports to E3
const E2 = '0c600000-0000-4000-a000-0000000000e2'; // branch B
const E3 = '0c600000-0000-4000-a000-0000000000e3'; // branch A, manages E1
const OWNER = 'c6000000-0000-4000-a000-000000000001';   // owner: organisation-wide
const HR_B = 'c6000000-0000-4000-a000-000000000002';    // hr_user limited to branch B
const LEAD = 'c6000000-0000-4000-a000-000000000003';    // custom team lead (attendance.view_team + report.export), linked to E3
const NO_EXPORT = 'c6000000-0000-4000-a000-000000000004'; // system `manager` role: report.view without report.export
const TEAM_LEAD_ROLE = '0c600000-0000-4000-a000-0000000000f1';
const SCHEDULE = '0c600000-0000-4000-a000-0000000000c1';
const FIRST_RUN = '2026-09-01T03:00:00.000Z'; // 1 Sep 07:00 in Muscat

let clock = new Date('2026-09-01T03:04:00Z');
let h: TestHarness;
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: { ...fakeJob(jobType, payload, ORG), queueName: 'reports' }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const deliveries = (runKey?: string) => {
  let q = h.tdb.adminDb.selectFrom('reportDeliveries').selectAll().where('organizationId', '=', ORG);
  if (runKey) q = q.where('runKey', '=', runKey);
  return q.orderBy('createdAt').execute();
};
const scheduleRow = () => h.tdb.adminDb.selectFrom('reportSchedules').selectAll().where('id', '=', SCHEDULE).executeTakeFirstOrThrow();

beforeAll(async () => {
  h = await createHarness(`flowza_worker_rdel_${process.pid}`, defaultRegistry(), () => clock);
  const a = h.tdb.adminDb;
  const users = [[OWNER, 'Owner'], [HR_B, 'HR B'], [LEAD, 'Team Lead'], [NO_EXPORT, 'No Export']] as const;
  for (const [id, name] of users) {
    await sql`insert into auth.users (id, email) values (${id}::uuid, ${`${name.replace(' ', '.').toLowerCase()}@rdel.local`})`.execute(a);
    await a.insertInto('userProfiles').values({ id, email: `${name.replace(' ', '.').toLowerCase()}@rdel.local`, fullName: name }).execute();
  }
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'RDEL', legalName: 'Deliveries LLC', displayName: 'Deliveries', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).execute();
  await a.insertInto('branches').values([{ id: BRANCH_A, organizationId: ORG, code: 'A', name: 'A', timezone: 'Asia/Muscat' }, { id: BRANCH_B, organizationId: ORG, code: 'B', name: 'B', timezone: 'Asia/Muscat' }]).execute();
  const emp = (id: string, n: string, branchId: string, managerEmployeeId: string | null = null) => ({ id, organizationId: ORG, employeeNumber: n, firstName: n, lastName: '.', displayName: `Employee ${n}`, joiningDate: '2024-01-01', branchId, deviceUserId: n, managerEmployeeId });
  await a.insertInto('employees').values([emp(E3, '3', BRANCH_A), emp(E1, '1', BRANCH_A, E3), emp(E2, '2', BRANCH_B)]).execute();
  // a custom role is written in the organisation's system context (the no-escalation trigger checks the actor)
  await withContext(h.tdb.workerDb, { kind: 'system', organizationId: ORG }, async (trx) => {
    await trx.insertInto('roles').values({ id: TEAM_LEAD_ROLE, organizationId: ORG, key: 'team_lead', name: 'Team lead', isSystem: false }).execute();
    await trx.insertInto('rolePermissions').values(['report.view', 'report.export', 'attendance.view_team'].map((permissionKey) => ({ roleId: TEAM_LEAD_ROLE, permissionKey }))).execute();
  });
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: OWNER, roleId: SYSTEM_ROLE_IDS.owner, status: 'active', allBranches: true },
    { organizationId: ORG, userId: HR_B, roleId: SYSTEM_ROLE_IDS.hr_user, status: 'active', allBranches: false },
    { organizationId: ORG, userId: LEAD, roleId: TEAM_LEAD_ROLE, status: 'active', allBranches: true, employeeId: E3 },
    { organizationId: ORG, userId: NO_EXPORT, roleId: SYSTEM_ROLE_IDS.manager, status: 'active', allBranches: true },
  ]).execute();
  const hrB = await a.selectFrom('orgMemberships').select('id').where('userId', '=', HR_B).executeTakeFirstOrThrow();
  await a.insertInto('membershipBranches').values({ membershipId: hrB.id, branchId: BRANCH_B }).execute();
  await a.insertInto('reportSchedules').values({
    id: SCHEDULE, organizationId: ORG, name: 'Monthly lates', reportType: 'late_report', format: 'csv', filters: JSON.stringify({}), cadence: 'monthly', runDay: 1, runTime: '07:00',
    periodRule: 'previous_month', recipients: JSON.stringify({ userIds: [OWNER, HR_B, LEAD, NO_EXPORT], roleKeys: [] }), channels: ['in_app'], isActive: true, nextRunAt: new Date(FIRST_RUN), createdBy: OWNER,
  }).execute();
});
afterAll(async () => { await h?.close(); });

const runJobs = () => h.tdb.adminDb.selectFrom('jobs.queue').select(['id', 'jobType', 'payload', 'dedupeKey', 'queueName', 'status']).where('jobType', '=', 'RUN_REPORT_SCHEDULE').execute();

describe('reports.schedules scheduler task', () => {
  it('admits a due occurrence once (dedupe on the occurrence) and ignores schedules not yet due', async () => {
    clock = new Date('2026-09-01T02:59:00Z');
    expect(await scheduleDueReports(h.deps)).toEqual({ due: 0, enqueued: 0, alreadyQueued: 0 });
    clock = new Date('2026-09-01T03:04:00Z');
    expect(await scheduleDueReports(h.deps)).toEqual({ due: 1, enqueued: 1, alreadyQueued: 0 });
    // 6a-M15b: the next tick meets the occurrence still waiting — reported as already queued, not as a new enqueue
    expect(await scheduleDueReports(h.deps)).toEqual({ due: 1, enqueued: 0, alreadyQueued: 1 });
    const jobs = await runJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queueName: 'reports', dedupeKey: `report-schedule:${SCHEDULE}:${FIRST_RUN}`, payload: { mode: 'schedule', scheduleId: SCHEDULE, scheduledFor: FIRST_RUN } });
  });

  it('6a-M15b an occurrence whose job is running is neither enqueued again nor counted as enqueued', async () => {
    // the queue's dedupe covers pending jobs only: a running job used to be enqueued a second time on every tick
    await h.tdb.adminDb.updateTable('jobs.queue').set({ status: 'running', lockedAt: clock, lockedBy: 'probe' }).where('jobType', '=', 'RUN_REPORT_SCHEDULE').execute();
    expect(await scheduleDueReports(h.deps)).toEqual({ due: 1, enqueued: 0, alreadyQueued: 1 });
    expect(await runJobs()).toHaveLength(1);
    await h.tdb.adminDb.updateTable('jobs.queue').set({ status: 'pending', lockedAt: null, lockedBy: null }).where('jobType', '=', 'RUN_REPORT_SCHEDULE').execute();
  });
});

describe('RUN_REPORT_SCHEDULE', () => {
  it('generates per recipient under the recipient scope, skips who may not export, advances next_run_at', async () => {
    const res = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', { organizationId: ORG, mode: 'schedule', scheduleId: SCHEDULE, scheduledFor: FIRST_RUN }));
    expect(res).toMatchObject({ outcome: 'delivered', recipients: 4, queued: 3, skipped: 1, period: { from: '2026-08-01', to: '2026-08-31' }, nextRunAt: '2026-10-01T03:00:00.000Z' });
    const rows = await deliveries(`schedule:${SCHEDULE}:${FIRST_RUN}`);
    const by = (u: string) => rows.find((r) => r.recipientUserId === u)!;
    expect(by(OWNER)).toMatchObject({ status: 'queued', scope: { kind: 'ORGANIZATION' }, mode: 'schedule', channels: ['in_app'], sentBy: OWNER });
    expect(by(HR_B)).toMatchObject({ status: 'queued', scope: { kind: 'BRANCHES', branchCount: 1 } });
    expect(by(LEAD)).toMatchObject({ status: 'queued', scope: { kind: 'TEAM', employeeCount: 1 } });
    expect(by(NO_EXPORT)).toMatchObject({ status: 'skipped', skipReason: 'missing_permission:report.export', reportRequestId: null });
    const requests = await h.tdb.adminDb.selectFrom('reportRequests').select(['id', 'requestedBy', 'parameters', 'branchId', 'status']).where('organizationId', '=', ORG).execute();
    const req = (u: string) => requests.find((r) => r.requestedBy === u)!;
    expect(req(OWNER).parameters).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(req(HR_B)).toMatchObject({ branchId: BRANCH_B, parameters: { from: '2026-08-01', to: '2026-08-31', branchId: BRANCH_B, branchScope: [BRANCH_B] } });
    expect(req(LEAD).parameters).toEqual({ from: '2026-08-01', to: '2026-08-31', employeeIds: [E1] });
    expect(requests.every((r) => r.status === 'QUEUED')).toBe(true);
    const generate = await h.tdb.adminDb.selectFrom('jobs.queue').select('payload').where('jobType', '=', 'GENERATE_REPORT').execute();
    expect(generate.map((j) => (j.payload as { reportRequestId: string }).reportRequestId).sort()).toEqual([req(OWNER).id, req(HR_B).id, req(LEAD).id].sort());
    const s = await scheduleRow();
    expect(s).toMatchObject({ lastStatus: 'partial', lastError: null });
    expect(new Date(s.nextRunAt!).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(s.lastSummary).toMatchObject({ recipients: 4, queued: 3, skipped: 1, period: { from: '2026-08-01', to: '2026-08-31' } });
  });

  it('a replayed job is a no-op (the occurrence moved on); so is a late replay of the same occurrence', async () => {
    const again = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', { organizationId: ORG, mode: 'schedule', scheduleId: SCHEDULE, scheduledFor: FIRST_RUN }));
    expect(again).toMatchObject({ outcome: 'skipped', reason: 'not_due' });
    // the schedule's stored run is stale by three months (the scheduler was down): the run covers the LATEST occurrence only,
    // which is the one already delivered — every recipient is already served, nobody gets a second copy
    await h.tdb.adminDb.updateTable('reportSchedules').set({ nextRunAt: new Date('2026-06-01T03:00:00Z') }).where('id', '=', SCHEDULE).execute();
    clock = new Date('2026-09-10T00:00:00Z');
    const late = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', { organizationId: ORG, mode: 'schedule', scheduleId: SCHEDULE, scheduledFor: '2026-06-01T03:00:00.000Z' }));
    expect(late).toMatchObject({ outcome: 'delivered', queued: 0, alreadyDelivered: 4, period: { from: '2026-08-01', to: '2026-08-31' }, nextRunAt: '2026-10-01T03:00:00.000Z' });
    expect((await scheduleRow()).lastSummary).toMatchObject({ missedOccurrences: 3 });
    expect(await deliveries()).toHaveLength(4);
    const stale = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', { organizationId: ORG, mode: 'schedule', scheduleId: SCHEDULE, scheduledFor: FIRST_RUN }));
    expect(stale).toMatchObject({ outcome: 'skipped' });
  });

  it('run-now covers the period of the current clock and never runs twice for one run key', async () => {
    clock = new Date('2026-09-15T05:00:00Z');
    const payload = { organizationId: ORG, mode: 'manual', scheduleId: SCHEDULE, runKey: 'manual:once', requestedBy: OWNER };
    const first = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', payload));
    expect(first).toMatchObject({ outcome: 'delivered', queued: 3, period: { from: '2026-08-01', to: '2026-08-31' } });
    const second = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', payload));
    expect(second).toMatchObject({ queued: 0, alreadyDelivered: 4 });
    expect(new Date((await scheduleRow()).nextRunAt!).toISOString()).toBe('2026-10-01T03:00:00.000Z'); // run-now leaves the schedule alone
  });

  it('send now: explicit employees must sit inside each recipient scope', async () => {
    const res = await runReportDeliveryHandler(ctx('RUN_REPORT_SCHEDULE', {
      organizationId: ORG, mode: 'send_now', runKey: 'send:e2', requestedBy: OWNER,
      spec: { reportType: 'employee_attendance', format: 'csv', parameters: { from: '2026-08-01', to: '2026-08-31', employeeIds: [E2] }, recipients: { userIds: [OWNER, HR_B, LEAD], roleKeys: [] }, channels: ['email'] },
    }));
    expect(res).toMatchObject({ outcome: 'delivered', queued: 2, skipped: 1, period: { from: '2026-08-01', to: '2026-08-31' } });
    const rows = await deliveries('send:e2');
    expect(rows.find((r) => r.recipientUserId === LEAD)).toMatchObject({ status: 'skipped', skipReason: 'outside_scope:employees' });
    expect(rows.find((r) => r.recipientUserId === HR_B)).toMatchObject({ status: 'queued', mode: 'send_now', channels: ['email'] });
  });
});

describe('6a-M14 a recipient cancelled their copy', () => {
  it('6a-M14 the worker settles the delivery as cancelled and notifies nobody', async () => {
    const d = (await deliveries('manual:once')).find((r) => r.recipientUserId === LEAD)!;
    expect(d.status).toBe('queued');
    // what POST /reports/:id/cancel leaves behind when the worker meets the job later (the API also settles it at once)
    await h.tdb.adminDb.updateTable('reportRequests').set({ status: 'CANCELLED', completedAt: clock }).where('id', '=', d.reportRequestId!).execute();
    const res = await generateReportRequest(h.deps, h.deps.log, fakeJob('GENERATE_REPORT', {}, ORG), ORG, d.reportRequestId!);
    expect(res).toMatchObject({ status: 'SKIPPED', reason: 'CANCELLED' });
    expect((await deliveries('manual:once')).find((r) => r.recipientUserId === LEAD)).toMatchObject({ status: 'cancelled', deliveredAt: null, error: null });
    expect(await h.tdb.adminDb.selectFrom('domainEvents').select('eventType').where('aggregateId', '=', d.reportRequestId!).execute()).toEqual([]);
  });
});

describe('completion → notification', () => {
  it('marks the delivery delivered and notifies the recipient in-app only (channels) instead of report.ready', async () => {
    const d = (await deliveries(`schedule:${SCHEDULE}:${FIRST_RUN}`)).find((r) => r.recipientUserId === OWNER)!;
    const done = await generateReportRequest(h.deps, h.deps.log, fakeJob('GENERATE_REPORT', {}, ORG), ORG, d.reportRequestId!);
    expect(done.status).toBe('COMPLETED');
    const after = (await deliveries(`schedule:${SCHEDULE}:${FIRST_RUN}`)).find((r) => r.recipientUserId === OWNER)!;
    expect(after.status).toBe('delivered');
    const events = await h.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'payload', 'aggregateId']).where('aggregateId', '=', d.reportRequestId!).execute();
    expect(events.map((e) => e.eventType)).toEqual(['report.scheduled_delivery']);
    expect(events[0]!.payload).toMatchObject({ userIds: [OWNER], channels: ['in_app'], mode: 'schedule', scheduleName: 'Monthly lates', periodFrom: '2026-08-01', periodTo: '2026-08-31' });
    await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const n = await h.tdb.adminDb.selectFrom('notifications').select(['id', 'userId', 'type', 'link', 'readAt', 'title']).where('type', '=', 'report.scheduled_delivery').execute();
    expect(n).toEqual([expect.objectContaining({ userId: OWNER, link: `/reports?download=${d.reportRequestId}`, readAt: null })]);
    expect(n[0]!.title).toMatch(/^Scheduled report: /);
    const emails = await h.tdb.adminDb.selectFrom('notificationDeliveries').select('id').where('notificationId', '=', n[0]!.id).execute();
    expect(emails).toHaveLength(0);
  });

  it('an e-mail-only share mails the recipient without an unread in-app badge', async () => {
    const d = (await deliveries('send:e2')).find((r) => r.recipientUserId === HR_B)!;
    await generateReportRequest(h.deps, h.deps.log, fakeJob('GENERATE_REPORT', {}, ORG), ORG, d.reportRequestId!);
    await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const n = await h.tdb.adminDb.selectFrom('notifications').select(['id', 'readAt', 'title']).where('userId', '=', HR_B).where('type', '=', 'report.scheduled_delivery').executeTakeFirstOrThrow();
    expect(n.readAt).not.toBeNull();
    expect(n.title).toMatch(/^Report shared with you: /);
    expect(await h.tdb.adminDb.selectFrom('notificationDeliveries').select('status').where('notificationId', '=', n.id).execute()).toEqual([{ status: 'pending' }]);
  });

  it('a failed copy is reported to whoever shared it, not to the recipient', async () => {
    const d = (await deliveries(`schedule:${SCHEDULE}:${FIRST_RUN}`)).find((r) => r.recipientUserId === LEAD)!;
    await withContext(h.tdb.workerDb, { kind: 'system', organizationId: ORG }, (trx) => settleDelivery(trx, ORG, d.reportRequestId!, { ok: false, error: 'boom' }, clock));
    const after = (await deliveries(`schedule:${SCHEDULE}:${FIRST_RUN}`)).find((r) => r.recipientUserId === LEAD)!;
    expect(after).toMatchObject({ status: 'failed', error: 'boom' });
    const failed = await h.tdb.adminDb.selectFrom('domainEvents').select('payload').where('eventType', '=', 'report.failed').where('aggregateId', '=', d.reportRequestId!).executeTakeFirstOrThrow();
    expect(failed.payload).toMatchObject({ userId: OWNER, error: 'boom' });
  });
});

describe('6a-D3 nextRunAbuse (review worker probe): next_run_at is server-computed', () => {
  it('6a-D3 a scheduler cannot rewind next_run_at from a user session, so later ticks admit nothing extra', async () => {
    clock = new Date('2026-09-15T05:09:00Z');
    const before = await scheduleRow();
    const jobsBefore = (await runJobs()).length;
    const requestsBefore = (await h.tdb.adminDb.selectFrom('reportRequests').select('id').where('organizationId', '=', ORG).execute()).length;
    for (const at of ['2026-09-15T05:10:00Z', '2026-09-15T05:15:00Z', '2026-09-15T05:20:00Z']) {
      clock = new Date(at);
      // the probe's write: one minute before "now", as the schedule's owner (report.schedule) through the API role (PostgREST)
      await expect(withContext(h.tdb.db, { kind: 'user', userId: OWNER, requestId: 'probe' }, (trx) =>
        trx.updateTable('reportSchedules').set({ nextRunAt: new Date(clock.getTime() - 60_000) }).where('id', '=', SCHEDULE).execute())).rejects.toThrow(/permission denied/);
      expect(await scheduleDueReports(h.deps)).toEqual({ due: 0, enqueued: 0, alreadyQueued: 0 });
    }
    expect((await runJobs()).length).toBe(jobsBefore);
    expect((await h.tdb.adminDb.selectFrom('reportRequests').select('id').where('organizationId', '=', ORG).execute()).length).toBe(requestsBefore);
    expect((await scheduleRow()).nextRunAt).toEqual(before.nextRunAt);
  });
});

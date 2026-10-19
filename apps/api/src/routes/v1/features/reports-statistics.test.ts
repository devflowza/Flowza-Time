import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { auditRows, createApiHarness, isoTodayIn, queueJobs, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * Customer requirements 2026-10-19 — periodic reports on irregular cases (daily schedules, each employee's line manager as a
 * recipient, their team copy opened without report.export), search and export of the daily register, statistics and indicators
 * (per department, month to date) and the shortfall on every daily record.
 */
let h: ApiHarness; let f: OrgFixture;
let lineManager: string; // system Line Manager role (report.view, attendance.view_team, no report.export), linked to e3 (manages e1)
const DAY = '2026-10-18';
const base = () => `/api/v1/orgs/${f.orgId}`;
const local = (iso: string) => DateTime.fromISO(iso).setZone('Asia/Muscat');

const record = (employeeId: string, branchId: string, attendanceDate: string, values: Record<string, unknown>) => h.admin.insertInto('attendanceDailyRecords').values({
  organizationId: f.orgId, employeeId, attendanceDate, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', scheduledMinutes: 480, trace: JSON.stringify({ punches: [] }), ...values,
} as never).execute();

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_rstat_${process.pid}`); f = await seedOrg(h.admin, 'rstat');
  lineManager = uuid('c'); await seedUser(h.admin, lineManager, 'line-manager-rstat@test.local', 'Line Manager'); await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: f.e3 });
  // the register / dashboard day: e1 late and 75 min short (Operations, branch A), e2 absent (no department, branch B), e3 present
  await record(f.e1, f.branchA, DAY, { departmentId: f.departmentA, status: 'PRESENT', flags: ['LATE'], lateMinutes: 45, workedMinutes: 405, firstInAt: new Date('2026-10-18T04:45:00Z'), lastOutAt: new Date('2026-10-18T12:00:00Z'), punchCount: 2 });
  await record(f.e2, f.branchB, DAY, { status: 'ABSENT', flags: [], workedMinutes: 0 });
  await record(f.e3, f.branchA, DAY, { departmentId: f.departmentA, status: 'PRESENT', flags: [], workedMinutes: 480, firstInAt: new Date('2026-10-18T04:00:00Z'), lastOutAt: new Date('2026-10-18T12:00:00Z'), punchCount: 2 });
  // earlier in the month: e3 on leave, e1 present with overtime
  await record(f.e3, f.branchA, '2026-10-05', { departmentId: f.departmentA, status: 'LEAVE', flags: [], workedMinutes: 0 });
  await record(f.e1, f.branchA, '2026-10-05', { departmentId: f.departmentA, status: 'PRESENT', flags: ['OVERTIME'], workedMinutes: 540, overtimeMinutes: 60, overtimeCategory: 'REGULAR', punchCount: 2 });
  // last month must not count in October's figures
  await record(f.e2, f.branchB, '2026-09-30', { status: 'ABSENT', flags: [], workedMinutes: 0 });
});
afterAll(async () => { await h?.close(); });

describe('daily schedules and line-manager recipients', () => {
  const daily = (extra: Record<string, unknown> = {}) => ({
    name: 'Morning irregular cases', reportType: 'irregularities_report', format: 'xlsx', cadence: 'daily', runDay: 0, runTime: '07:30', periodRule: 'previous_day',
    recipients: { userIds: [] as string[], roleKeys: [] as string[], lineManagers: true }, channels: ['in_app', 'email'], ...extra,
  });
  let id: string;

  it('creates a daily schedule whose next run is the next 07:30 in the organisation zone and covers yesterday', async () => {
    const res = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily() });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    const next = local(res.body.data.nextRunAt);
    expect(next.toFormat('HH:mm')).toBe('07:30');
    expect(next.toMillis()).toBeGreaterThan(Date.now());
    expect(next.diffNow('hours').hours).toBeLessThanOrEqual(24);
    expect(res.body.data).toMatchObject({ cadence: 'daily', runDay: 0, periodRule: 'previous_day', recipients: { userIds: [], roleKeys: [], lineManagers: true } });
    const yesterday = next.startOf('day').minus({ days: 1 }).toISODate();
    expect(res.body.data.nextPeriod).toEqual({ from: yesterday, to: yesterday });
    const stored = await h.admin.selectFrom('reportSchedules').select(['recipients', 'runDay']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(stored).toEqual({ recipients: { userIds: [], roleKeys: [], lineManagers: true }, runDay: 0 });
    expect((await auditRows(h.admin, 'report_schedule.created')).find((a) => a.entityId === id)?.newValue).toMatchObject({ cadence: 'daily', recipients: { lineManagers: true } });
  });

  it('PATCH of one field keeps the line managers and the cadence; a monthly schedule can become daily', async () => {
    const before = (await h.request('GET', `${base()}/report-schedules/${id}`, { token: f.owner })).body.data;
    const renamed = await h.request('PATCH', `${base()}/report-schedules/${id}`, { token: f.owner, body: { name: 'Renamed' } });
    expect(renamed.status).toBe(200);
    expect({ ...renamed.body.data, name: before.name, updatedAt: before.updatedAt }).toEqual(before);
    // the Director General's monthly report, by name, then moved to a daily morning run
    const monthly = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily({ name: 'DG monthly', cadence: 'monthly', runDay: 1, periodRule: 'previous_month', format: 'pdf', recipients: { userIds: [f.hrAdmin], roleKeys: ['owner'] } }) });
    expect(monthly.status).toBe(201);
    expect(monthly.body.data.nextPeriod.from.endsWith('-01')).toBe(true);
    const moved = await h.request('PATCH', `${base()}/report-schedules/${monthly.body.data.id}`, { token: f.owner, body: { cadence: 'daily', periodRule: 'previous_day' } });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ cadence: 'daily', runDay: 0, recipients: { userIds: [f.hrAdmin], roleKeys: ['owner'], lineManagers: false } });
  });

  it('refuses what a daily run cannot cover, and a recipient list that reaches nobody', async () => {
    expect((await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily({ reportType: 'monthly_summary' }) })).status).toBe(400);
    expect((await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily({ periodRule: 'previous_week' }) })).status).toBe(400);
    expect((await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily({ recipients: { userIds: [], roleKeys: [], lineManagers: false } }) })).status).toBe(400);
    // the Daily Report itself can now be scheduled, on any cadence
    expect((await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: daily({ name: 'Daily sheet', reportType: 'daily_attendance' }) })).status).toBe(201);
    // only report.schedule holders distribute, line managers or not
    expect((await h.request('POST', `${base()}/report-schedules`, { token: lineManager, body: daily() })).status).toBe(403);
  });

  it('the recipient picker says how many line managers a run would reach', async () => {
    const res = await h.request('GET', `${base()}/report-recipients`, { token: f.owner });
    expect(res.status).toBe(200);
    // e3 manages e1: the hr_user linked to e3 and the Line Manager linked to e3
    expect(res.body.data.lineManagers).toBe(2);
  });

  it('send now to the line managers queues one distribution run carrying the choice', async () => {
    const res = await h.request('POST', `${base()}/reports/share`, { token: f.owner, body: { reportType: 'irregularities_report', format: 'csv', parameters: { from: DAY, to: DAY }, recipients: { lineManagers: true }, channels: ['in_app'] } });
    expect(res.status).toBe(202);
    const job = (await queueJobs(h.admin, 'RUN_REPORT_SCHEDULE')).find((j) => j.id === res.body.data.jobId)!;
    expect(job.payload).toMatchObject({ mode: 'send_now', spec: { reportType: 'irregularities_report', recipients: { userIds: [], roleKeys: [], lineManagers: true } } });
  });
});

describe('a line manager opens the copy about their team without report.export', () => {
  const teamCopy = async (userId: string, over: Record<string, unknown> = {}) => (await h.admin.insertInto('reportRequests').values({
    organizationId: f.orgId, reportType: 'irregularities_report', format: 'xlsx', status: 'COMPLETED', requestedBy: userId, filePath: `${f.orgId}/team-${uuid('9')}.xlsx`, rowCount: 2, completedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000), parameters: JSON.stringify({ from: DAY, to: DAY, employeeIds: [f.e1], teamManagerEmployeeId: f.e3, ...over }),
  }).returning('id').executeTakeFirstOrThrow()).id;

  it('downloads their own team copy, audited as such', async () => {
    const mine = await teamCopy(lineManager);
    const dl = await h.request('GET', `${base()}/reports/${mine}/download`, { token: lineManager });
    expect(dl.status).toBe(200);
    expect(dl.body.data.url).toContain(`/reports/${f.orgId}/team-`);
    const trail = (await auditRows(h.admin, 'report.exported')).find((a) => a.entityId === mine);
    expect(trail?.newValue).toMatchObject({ reportType: 'irregularities_report', rowCount: 2, teamCopy: true });
    // it is in their list on the Reports page (report.view), like any report addressed to them
    const list = await h.request('GET', `${base()}/reports`, { token: lineManager });
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(mine);
  });

  it('never anything wider: a copy about somebody outside the team, another manager\'s marker, somebody else\'s copy, an ordinary report', async () => {
    const outside = await teamCopy(lineManager, { employeeIds: [f.e1, f.e2] });
    const otherMarker = await teamCopy(lineManager, { teamManagerEmployeeId: f.e1 });
    const notTheirs = await teamCopy(f.managerUser);
    const plain = (await h.admin.insertInto('reportRequests').values({ organizationId: f.orgId, reportType: 'late_report', format: 'csv', status: 'COMPLETED', requestedBy: lineManager, filePath: `${f.orgId}/plain.csv`, completedAt: new Date(), parameters: JSON.stringify({ from: DAY, to: DAY }) }).returning('id').executeTakeFirstOrThrow()).id;
    const directory = await teamCopy(lineManager);
    await h.admin.updateTable('reportRequests').set({ reportType: 'employee_directory' }).where('id', '=', directory).execute();
    for (const id of [outside, otherMarker, notTheirs, plain, directory]) expect((await h.request('GET', `${base()}/reports/${id}/download`, { token: lineManager })).status).toBe(403);
    // an employee (no team) cannot open a team copy addressed to them either
    const forged = await teamCopy(f.employeeUser, { teamManagerEmployeeId: f.e1, employeeIds: [f.e1] });
    expect((await h.request('GET', `${base()}/reports/${forged}/download`, { token: f.employeeUser })).status).toBe(403);
  });
});

describe('the daily register: shortfall and the export of its current view', () => {
  it('every record carries its shortfall (the reports\' UT): 75 min for the late arrival, 0 for the others', async () => {
    const res = await h.request('GET', `${base()}/attendance/daily?date=${DAY}`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    const by = (id: string) => res.body.data.find((r: { employeeId: string }) => r.employeeId === id);
    expect(by(f.e1)).toMatchObject({ scheduledMinutes: 480, workedMinutes: 405, shortfallMinutes: 75 });
    expect(by(f.e2).shortfallMinutes).toBe(0); // an absence is not short hours
    expect(by(f.e3).shortfallMinutes).toBe(0);
  });

  it('queues a daily_attendance report with the register filters (202 + report and queue job ids), audited with its row count', async () => {
    const res = await h.request('POST', `${base()}/attendance/daily/export`, { token: f.hrAdmin, body: { date: DAY, departmentId: f.departmentA, status: 'PRESENT', flag: 'LATE', search: 'Employee', format: 'xlsx' } });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', reportType: 'daily_attendance', rowCount: 1 });
    const req = await h.admin.selectFrom('reportRequests').selectAll().where('id', '=', res.body.data.reportId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ reportType: 'daily_attendance', format: 'xlsx', status: 'QUEUED', requestedBy: f.hrAdmin, branchId: null, queueJobId: res.body.data.jobId });
    expect(req.parameters).toEqual({ from: DAY, departmentId: f.departmentA, status: 'PRESENT', flag: 'LATE', search: 'Employee' });
    const job = (await queueJobs(h.admin, 'GENERATE_REPORT')).find((j) => j.id === res.body.data.jobId)!;
    expect(job).toMatchObject({ queueName: 'reports', payload: { organizationId: f.orgId, reportRequestId: req.id } });
    const trail = (await auditRows(h.admin, 'attendance.register_export_requested')).find((a) => a.entityId === req.id);
    expect(trail?.newValue).toMatchObject({ reportType: 'daily_attendance', rowCount: 1, date: DAY, filters: { departmentId: f.departmentA, status: 'PRESENT', flag: 'LATE', search: 'Employee' } });
  });

  it('a branch-scoped caller exports their branches only; a branch outside them is refused', async () => {
    const res = await h.request('POST', `${base()}/attendance/daily/export`, { token: f.branchManagerB, body: { date: DAY } });
    expect(res.status).toBe(202);
    expect(res.body.data.rowCount).toBe(1); // e2 in branch B
    const req = await h.admin.selectFrom('reportRequests').select(['parameters', 'branchId']).where('id', '=', res.body.data.reportId).executeTakeFirstOrThrow();
    expect(req).toEqual({ branchId: f.branchB, parameters: { from: DAY, branchId: f.branchB, branchScope: [f.branchB] } });
    expect((await h.request('POST', `${base()}/attendance/daily/export`, { token: f.branchManagerB, body: { date: DAY, branchId: f.branchA } })).status).toBe(403);
  });

  it('needs report.export with attendance.view; a PDF is not a register export', async () => {
    expect((await h.request('POST', `${base()}/attendance/daily/export`, { token: lineManager, body: { date: DAY } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/daily/export`, { token: f.employeeUser, body: { date: DAY } })).status).toBe(403);
    expect((await h.request('POST', `${base()}/attendance/daily/export`, { token: f.hrAdmin, body: { date: DAY, format: 'pdf' } })).status).toBe(400);
    expect((await h.request('POST', `${base()}/attendance/daily/export`, { token: f.outsider, body: { date: DAY } })).status).toBe(403);
  });
});

describe('statistics and indicators', () => {
  it('the day per department: attendance rate, late, absent — in the caller\'s branch scope', async () => {
    const res = await h.request('GET', `${base()}/dashboard/departments?date=${DAY}`, { token: f.owner });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { departmentId: f.departmentA, departmentName: 'Operations', employees: 2, present: 2, absent: 0, late: 1, onLeave: 0, missingPunch: 0, attendanceRate: 100 },
      { departmentId: null, departmentName: null, employees: 1, present: 0, absent: 1, late: 0, onLeave: 0, missingPunch: 0, attendanceRate: 0 },
    ]);
    const branchB = await h.request('GET', `${base()}/dashboard/departments?date=${DAY}`, { token: f.branchManagerB });
    expect(branchB.body.data).toEqual([expect.objectContaining({ departmentId: null, absent: 1 })]);
    const filtered = await h.request('GET', `${base()}/dashboard/departments?date=${DAY}&branchId=${f.branchA}`, { token: f.owner });
    expect(filtered.body.data.map((d: { departmentId: string | null }) => d.departmentId)).toEqual([f.departmentA]);
    expect((await h.request('GET', `${base()}/dashboard/departments?date=${DAY}&branchId=${f.branchA}`, { token: f.branchManagerB })).status).toBe(403);
    expect((await h.request('GET', `${base()}/dashboard/departments`, { token: f.outsider })).status).toBe(403);
  });

  it('the month to date: attendance rate, late days and minutes, absences, average worked hours, shortfall', async () => {
    const res = await h.request('GET', `${base()}/dashboard/month-to-date?date=${DAY}`, { token: f.owner });
    expect(res.status).toBe(200);
    // October 1–18: e1 present twice (once late, 45 min, 75 min short), e3 present once and on leave once, e2 absent once
    expect(res.body.data).toEqual({
      from: '2026-10-01', to: DAY, workingDays: 4, presentDays: 3, absentDays: 1, lateDays: 1, lateMinutes: 45, earlyDepartureDays: 0, missingPunchDays: 0, leaveDays: 1,
      shortfallMinutes: 75, overtimeMinutes: 60, attendanceRate: 75, avgWorkedMinutes: Math.round((405 + 540 + 480) / 3),
    });
    const branchB = await h.request('GET', `${base()}/dashboard/month-to-date?date=${DAY}`, { token: f.branchManagerB });
    expect(branchB.body.data).toMatchObject({ workingDays: 1, absentDays: 1, attendanceRate: 0, avgWorkedMinutes: null });
    // no date: the month of today in the organisation's zone
    const today = await h.request('GET', `${base()}/dashboard/month-to-date`, { token: f.owner });
    expect(today.body.data.to).toBe(isoTodayIn('Asia/Muscat'));
    expect(today.body.data.from).toBe(`${isoTodayIn('Asia/Muscat').slice(0, 7)}-01`);
    expect((await h.request('GET', `${base()}/dashboard/month-to-date`, { token: f.outsider })).status).toBe(403);
  });
});

describe('My reports: searched by the day they were requested', () => {
  it('keeps the reports requested in the range (organisation calendar)', async () => {
    const at = async (iso: string) => (await h.admin.insertInto('reportRequests').values({ organizationId: f.orgId, reportType: 'late_report', format: 'csv', status: 'COMPLETED', requestedBy: f.hrUser, parameters: JSON.stringify({ from: DAY, to: DAY }), createdAt: new Date(iso) }).returning('id').executeTakeFirstOrThrow()).id;
    const september = await at('2026-09-30T20:30:00Z'); // 30 Sep in UTC, already 1 Oct (00:30) in Muscat
    const august = await at('2026-08-31T10:00:00Z');
    const res = await h.request('GET', `${base()}/reports?from=2026-10-01&to=2026-10-31`, { token: f.hrUser });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: { id: string }) => r.id);
    expect(ids).toContain(september);
    expect(ids).not.toContain(august);
    expect((await h.request('GET', `${base()}/reports?to=2026-08-31`, { token: f.hrUser })).body.data.map((r: { id: string }) => r.id)).toEqual([august]);
  });
});

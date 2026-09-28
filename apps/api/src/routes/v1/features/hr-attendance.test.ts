import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { loadDailyInputs, withContext } from '@flowza/database';
import { calculateDailyRecord, summarisePeriod } from '@flowza/domain';
import { auditRows, createApiHarness, queueJobs, seedDevice, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * HR attendance workspace (HR portal Prompt 6a): preview (no writes, equals the engine), record edits and bulk status through
 * the correction path, the Auto/Manual source, calendar, monthly summary (+ the queued `monthly_summary` report behind
 * report.export), the punch timeline and the unmatched-punch triage; plus report.export enforced on report downloads and the
 * employee export. Tests named `6a-…` are the regressions of the adversarial review (docs/hr-portal/reviews/06a-…).
 */
let h: ApiHarness; let f: OrgFixture; let device: string;
let lineManager: string; // role `manager`, linked to e3 (e1's manager): team scope, no report.export
let auditor: string;     // role `auditor`: attendance.view_raw, no device.sync
const DAY = '2026-08-03';     // e1 punched 08:10 → 17:00 Muscat (04:10Z → 13:00Z)
const MONTH = '2026-07';
let inEvent: string; let outEvent: string;

const rec = (employeeId: string, branchId: string, date: string, status: string, flags: string[] = [], worked = 0, overtime = 0) => ({
  organizationId: f.orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: status as never, flags,
  workedMinutes: worked, overtimeMinutes: overtime, overtimeCategory: overtime > 0 ? 'REGULAR' as const : null, lateMinutes: flags.includes('LATE') ? 15 : 0, trace: JSON.stringify({ punches: [] }),
});

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_hrws_${process.pid}`); f = await seedOrg(h.admin, 'hrws');
  device = await seedDevice(h.admin, f.orgId, f.branchA, { code: 'HRWS-1' });
  lineManager = uuid('c'); await seedUser(h.admin, lineManager, 'line-manager-hrws@test.local', 'Line Manager'); await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: f.e3 });
  auditor = uuid('c'); await seedUser(h.admin, auditor, 'auditor-hrws@test.local', 'Auditor'); await seedMembership(h.admin, f.orgId, auditor, ROLE.auditor);
  inEvent = (await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(`${DAY}T04:10:00Z`), eventType: 'PUNCH', source: 'DEVICE', deviceId: device }).returning('id').executeTakeFirstOrThrow()).id;
  outEvent = (await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(`${DAY}T13:00:00Z`), eventType: 'PUNCH', source: 'DEVICE', deviceId: device }).returning('id').executeTakeFirstOrThrow()).id;
  await h.admin.insertInto('attendanceDailyRecords').values(rec(f.e1, f.branchA, DAY, 'PRESENT', [], 530)).execute();
  // a month of records for the summary
  await h.admin.insertInto('attendanceDailyRecords').values([
    rec(f.e1, f.branchA, '2026-07-01', 'PRESENT', ['LATE'], 480, 30), rec(f.e1, f.branchA, '2026-07-02', 'HALF_DAY', [], 240), rec(f.e1, f.branchA, '2026-07-03', 'HALF_DAY', ['HALF_DAY_LEAVE'], 240),
    rec(f.e1, f.branchA, '2026-07-04', 'WEEKLY_OFF'), rec(f.e1, f.branchA, '2026-07-05', 'ABSENT', ['LOP', 'PAY_EFFECT_FULL', 'UNEXCUSED']), rec(f.e1, f.branchA, '2026-07-06', 'PRESENT', ['MISSING_OUT'], 300),
    rec(f.e1, f.branchA, '2026-07-07', 'LEAVE'), rec(f.e1, f.branchA, '2026-07-08', 'HOLIDAY'), rec(f.e1, f.branchA, '2026-07-09', 'WEEKLY_OFF', ['WORKED_ON_WEEKLY_OFF', 'NON_WORKING_DAY_WORK'], 240, 240),
    rec(f.e2, f.branchB, '2026-07-01', 'PRESENT', [], 480), rec(f.e2, f.branchB, '2026-07-02', 'ABSENT', ['HALF_DAY_LEAVE']),
    rec(f.e3, f.branchA, '2026-07-01', 'PRESENT', [], 500),
  ]).execute();
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const counts = async () => {
  const one = async (table: string) => Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} where organization_id = ${f.orgId}::uuid`.execute(h.admin)).rows[0]?.n ?? 0);
  return { corrections: await one('public.attendance_corrections'), events: await one('public.attendance_events'), records: await one('public.attendance_daily_records'), jobs: Number((await sql<{ n: string }>`select count(*) as n from jobs.queue`.execute(h.admin)).rows[0]?.n ?? 0), audit: await one('audit.logs') };
};

describe('POST /attendance/preview', () => {
  it('runs the engine on the real inputs, simulates the proposed times and writes nothing', async () => {
    const before = await counts();
    const res = await h.request('POST', `${base()}/attendance/preview`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:00:00Z` } });
    expect(res.status).toBe(200);
    const expected = await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => calculateDailyRecord((await loadDailyInputs(trx, f.orgId, f.e1, DAY, new Date()))!.input));
    expect(res.body.data.current).toMatchObject({ status: expected.status, workedMinutes: expected.workedMinutes, firstInAt: expected.firstInAt, lastOutAt: expected.lastOutAt, flags: expected.flags });
    expect(res.body.data.punches.in.eventId).toBe(inEvent);
    expect(res.body.data.punches.out.eventId).toBe(outEvent);
    expect(res.body.data.plan).toEqual([expect.objectContaining({ type: 'EDIT_PUNCH', originalEventId: inEvent, proposedPunchedAt: `${DAY}T04:00:00.000Z`, proposedEventType: 'PUNCH' })]);
    expect(Date.parse(res.body.data.preview.firstInAt)).toBe(Date.parse(`${DAY}T04:00:00Z`));
    expect(res.body.data.preview.workedMinutes).toBeGreaterThan(res.body.data.current.workedMinutes);
    expect(res.body.data).toMatchObject({ statusSource: 'AUTO', manualStatus: null, locked: false, timezone: 'Asia/Muscat' });
    expect(await counts()).toEqual(before);
  });

  it('refuses a check-out before the check-in, a punch in the future and callers without attendance.view', async () => {
    const reversed = await h.request('POST', `${base()}/attendance/preview`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T13:00:00Z`, outAt: `${DAY}T04:00:00Z` } });
    expect(reversed.status).toBe(400);
    const beforeIn = await h.request('POST', `${base()}/attendance/preview`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, outAt: `${DAY}T03:00:00Z` } });
    expect(beforeIn.status).toBe(400);
    const future = await h.request('POST', `${base()}/attendance/preview`, { token: f.hrAdmin, body: { employeeId: f.e1, date: '2099-01-01', inAt: '2099-01-01T04:00:00Z' } });
    expect(future.status).toBe(400);
    const employee = await h.request('POST', `${base()}/attendance/preview`, { token: f.employeeUser, body: { employeeId: f.e1, date: DAY } });
    expect(employee.status).toBe(403);
    const otherBranch = await h.request('POST', `${base()}/attendance/preview`, { token: f.branchManagerB, body: { employeeId: f.e1, date: DAY } });
    expect([403, 404]).toContain(otherBranch.status);
  });
});

describe('POST /attendance/record-edits', () => {
  it('needs attendance.correct + attendance.approve + attendance.view and a reason', async () => {
    const hrUser = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrUser, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:05:00Z`, reason: 'Clock drift' } });
    expect(hrUser.status).toBe(403); // hr_user has no attendance.approve
    const manager = await h.request('POST', `${base()}/attendance/record-edits`, { token: lineManager, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:05:00Z`, reason: 'Clock drift' } });
    expect(manager.status).toBe(403); // team scope only, no organisation-wide attendance.view
    const noReason = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:05:00Z` } });
    expect(noReason.status).toBe(400);
    const nothing = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, reason: 'nothing' } });
    expect(nothing.status).toBe(400);
    const same = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:10:00Z`, reason: 'unchanged' } });
    expect(same.status).toBe(400);
  });

  it('files EDIT_PUNCH / SET_STATUS corrections through createCorrection, auto-approved for HR', async () => {
    const jobsBefore = (await queueJobs(h.admin, 'APPLY_CORRECTION')).length;
    const res = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:00:00Z`, outAt: `${DAY}T13:30:00Z`, status: 'PRESENT', reason: 'Device clock was ten minutes late' } });
    expect(res.status).toBe(201);
    expect(res.body.data.applied).toBe(true);
    expect(res.body.data.corrections.map((c: { type: string; approval: string }) => [c.type, c.approval])).toEqual([['EDIT_PUNCH', 'AUTO_APPROVED'], ['EDIT_PUNCH', 'AUTO_APPROVED'], ['SET_STATUS', 'AUTO_APPROVED']]);
    const rows = await h.admin.selectFrom('attendanceCorrections').selectAll().where('organizationId', '=', f.orgId).where('employeeId', '=', f.e1).orderBy('createdAt').execute();
    expect(rows.map((r) => [r.type, r.status, r.originalEventId, r.proposedEventType, r.proposedStatus])).toEqual([
      ['EDIT_PUNCH', 'APPROVED', inEvent, 'PUNCH', null], ['EDIT_PUNCH', 'APPROVED', outEvent, 'PUNCH', null], ['SET_STATUS', 'APPROVED', null, null, 'PRESENT'],
    ]);
    expect((await queueJobs(h.admin, 'APPLY_CORRECTION')).length - jobsBefore).toBe(3);
    expect((await auditRows(h.admin, 'attendance.correction_auto_approved')).length).toBeGreaterThanOrEqual(3);
    // the same edit again: the equivalent corrections are already approved → the first item is refused outright
    const again = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e1, date: DAY, inAt: `${DAY}T04:00:00Z`, reason: 'twice' } });
    expect(again.status).toBe(409);
  });
});

describe('POST /attendance/bulk-status', () => {
  it('caps the request at 200 items and needs the HR edit permissions', async () => {
    const tooMany = await h.request('POST', `${base()}/attendance/bulk-status`, { token: f.owner, body: { status: 'ABSENT', reason: 'bulk', items: Array.from({ length: 201 }, (_, i) => ({ employeeId: f.e2, date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}` })) } });
    expect(tooMany.status).toBe(400);
    const hrUser = await h.request('POST', `${base()}/attendance/bulk-status`, { token: f.hrUser, body: { status: 'ABSENT', reason: 'bulk', items: [{ employeeId: f.e2, date: '2026-06-01' }] } });
    expect(hrUser.status).toBe(403);
  });

  it('files one SET_STATUS per item and reports per-item errors', async () => {
    const res = await h.request('POST', `${base()}/attendance/bulk-status`, { token: f.branchManagerB, body: { status: 'HOLIDAY', reason: 'Branch closed for the national day', items: [
      { employeeId: f.e2, date: '2026-06-10' }, { employeeId: f.e2, date: '2026-06-10' }, { employeeId: f.e1, date: '2026-06-10' }, { employeeId: uuid('e'), date: '2026-06-10' },
    ] } });
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(3);
    expect(r.autoApproved).toBe(1);
    expect(r.results[0]).toMatchObject({ ok: true, approval: 'AUTO_APPROVED' });
    expect(r.results[1].error.code).toBe('DUPLICATE_ITEM');
    expect(r.results[2].ok).toBe(false); // e1 is in branch A, outside the branch manager's scope
    expect(r.results[3].ok).toBe(false);
    const c = await h.admin.selectFrom('attendanceCorrections').select(['type', 'status', 'proposedStatus']).where('organizationId', '=', f.orgId).where('employeeId', '=', f.e2).where('attendanceDate', '=', sql<Date>`'2026-06-10'::date`).execute();
    expect(c).toEqual([{ type: 'SET_STATUS', status: 'APPROVED', proposedStatus: 'HOLIDAY' }]);
    expect((await auditRows(h.admin, 'attendance.bulk_status_set'))[0]?.newValue).toMatchObject({ status: 'HOLIDAY', succeeded: 1, failed: 3 });
  });
});

describe('Auto / Manual and the calendar', () => {
  it('reports applied SET_STATUS overrides as MANUAL', async () => {
    await h.admin.insertInto('attendanceCorrections').values({ organizationId: f.orgId, employeeId: f.e3, branchId: f.branchA, attendanceDate: '2026-07-01', type: 'SET_STATUS', proposedStatus: 'LEAVE', reason: 'Forgot to file leave', status: 'APPLIED', appliedAt: new Date(), requestedBy: f.hrAdmin }).execute();
    const manual = await h.request('GET', `${base()}/attendance/manual-statuses?from=2026-07-01&to=2026-07-31`, { token: f.hrAdmin });
    expect(manual.status).toBe(200);
    expect(manual.body.data).toEqual([expect.objectContaining({ employeeId: f.e3, date: '2026-07-01', status: 'LEAVE' })]);
    const cal = await h.request('GET', `${base()}/attendance/calendar?month=${MONTH}`, { token: f.hrAdmin });
    expect(cal.status).toBe(200);
    expect(cal.body.meta.days).toHaveLength(31);
    const e3 = cal.body.data.find((r: { employeeId: string }) => r.employeeId === f.e3);
    expect(e3.days['2026-07-01']).toMatchObject({ status: 'PRESENT', statusSource: 'MANUAL' });
    const e1 = cal.body.data.find((r: { employeeId: string }) => r.employeeId === f.e1);
    expect(e1.days['2026-07-01']).toMatchObject({ status: 'PRESENT', statusSource: 'AUTO', flags: ['LATE'] });
    // a line manager sees their team (e1) and themselves (e3), never the other branch's e2
    const team = await h.request('GET', `${base()}/attendance/calendar?month=${MONTH}`, { token: lineManager });
    expect(team.status).toBe(200);
    expect(team.body.data.map((r: { employeeId: string }) => r.employeeId).sort()).toEqual([f.e1, f.e3].sort());
    const employee = await h.request('GET', `${base()}/attendance/calendar?month=${MONTH}`, { token: f.employeeUser });
    expect(employee.status).toBe(403);
  });
});

describe('GET /attendance/summary', () => {
  it('matches summarisePeriod over the same daily records', async () => {
    const res = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    const e1Records = (await h.admin.selectFrom('attendanceDailyRecords').selectAll().where('organizationId', '=', f.orgId).where('employeeId', '=', f.e1).execute())
      .map((r) => ({ attendanceDate: String(r.attendanceDate instanceof Date ? r.attendanceDate.toISOString().slice(0, 10) : r.attendanceDate).slice(0, 10), status: r.status, flags: r.flags as never, workedMinutes: r.workedMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: r.overtimeCategory, lateMinutes: r.lateMinutes, earlyDepartureMinutes: r.earlyDepartureMinutes }));
    const expected = summarisePeriod(e1Records.map((r) => ({ ...r, attendanceDate: r.attendanceDate })), { periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    const row = res.body.data.find((r: { employeeId: string }) => r.employeeId === f.e1);
    expect(row).toMatchObject({
      presentDays: expected.presentDays, lateDays: expected.lateDays, halfDays: expected.halfDays, leaveDays: expected.leaveDays, absentDays: expected.absentDays,
      missingPunchDays: expected.missingPunchDays, holidayDays: expected.holidayDays, weeklyOffDays: expected.weeklyOffDays, lopDays: expected.lopDays, unexcusedDays: expected.unexcusedDays,
      workedMinutes: 480 + 240 + 240 + 300 + 240, overtimeMinutes: 270, daysWorked: 5, averageWorkedMinutes: Math.round(1500 / 5), source: 'LIVE', branchName: 'Branch A', departmentName: 'Operations',
    });
    expect(row.presentDays).toBe(3); // PRESENT(LATE) 1 + HALF_DAY 0.5 + HALF_DAY+HDL 0.5 + PRESENT(MISSING_OUT) 1
    expect(res.body.meta.totals.presentDays).toBe(expected.presentDays + 1 + 1); // + e2 PRESENT + e3 PRESENT
    expect(res.body.meta.total).toBe(3);
  });

  it('scopes to the caller: branch manager = own branch, line manager = team (+ self)', async () => {
    const bm = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}`, { token: f.branchManagerB });
    expect(bm.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e2]);
    const denied = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&branchId=${f.branchA}`, { token: f.branchManagerB });
    expect(denied.status).toBe(403);
    const team = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}`, { token: lineManager });
    expect(team.status).toBe(200);
    expect(team.body.data.map((r: { employeeId: string }) => r.employeeId).sort()).toEqual([f.e1, f.e3].sort());
    expect(team.body.data.find((r: { employeeId: string }) => r.employeeId === f.e1).presentDays).toBe(3);
  });

  it('prefers the finalized period summary where the caller may read it (payroll.view)', async () => {
    await h.admin.insertInto('attendancePeriodSummaries').values({ organizationId: f.orgId, employeeId: f.e2, branchId: f.branchB, periodStart: '2026-07-01', periodEnd: '2026-07-31', presentDays: '20', absentDays: '1', leaveDays: '2', status: 'finalized', finalizedAt: new Date() }).execute();
    const owner = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&branchId=${f.branchB}`, { token: f.owner });
    expect(owner.body.data[0]).toMatchObject({ employeeId: f.e2, source: 'FINALIZED', presentDays: 20, absentDays: 1, leaveDays: 2 });
    const hrUser = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&branchId=${f.branchB}`, { token: f.hrUser });
    expect(hrUser.body.data[0]).toMatchObject({ employeeId: f.e2, source: 'LIVE', presentDays: 1 });
  });

  it('6a-D10 the export is a queued monthly_summary report (202 + report id), report.view + report.export, audited', async () => {
    const res = await h.request('POST', `${base()}/attendance/summary/export`, { token: f.hrUser, body: { month: MONTH } });
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ status: 'QUEUED', reportType: 'monthly_summary', rowCount: 3 });
    const req = await h.admin.selectFrom('reportRequests').selectAll().where('id', '=', res.body.data.reportId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ reportType: 'monthly_summary', format: 'csv', status: 'QUEUED', requestedBy: f.hrUser });
    expect(req.parameters).toMatchObject({ month: MONTH, finalizedFigures: false });
    const job = (await queueJobs(h.admin, 'GENERATE_REPORT')).find((j) => j.payload['reportRequestId'] === res.body.data.reportId);
    expect(job?.id).toBe(res.body.data.jobId);
    expect((await auditRows(h.admin, 'attendance.summary_export_requested'))[0]?.newValue).toMatchObject({ month: MONTH, rowCount: 3, reportType: 'monthly_summary' });
    // the file is fetched from the Reports page like every report: the requester's own copy
    const mine = await h.request('GET', `${base()}/reports/${res.body.data.reportId}`, { token: f.hrUser });
    expect(mine.status).toBe(200);
    // a branch-scoped caller's scope travels with the request (the worker runs in the organisation's system context)
    const bm = await h.request('POST', `${base()}/attendance/summary/export`, { token: f.branchManagerB, body: { month: MONTH, search: 'Employee' } });
    expect(bm.status).toBe(202);
    const bmReq = await h.admin.selectFrom('reportRequests').select(['parameters', 'branchId']).where('id', '=', bm.body.data.reportId).executeTakeFirstOrThrow();
    expect(bmReq.parameters).toMatchObject({ month: MONTH, branchId: f.branchB, branchScope: [f.branchB], search: 'Employee' });
    expect(bmReq.branchId).toBe(f.branchB);
    // no report.export → refused; the synchronous GET is gone
    expect((await h.request('POST', `${base()}/attendance/summary/export`, { token: lineManager, body: { month: MONTH } })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/summary/export?month=${MONTH}`, { token: f.hrUser })).status).toBe(404);
  });

  it('6a-D10 a line manager with report.export exports their team (+ self) only', async () => {
    const roleId = uuid('9');
    await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
      await trx.insertInto('roles').values({ id: roleId, organizationId: f.orgId, key: 'team_exporter', name: 'Team exporter', isSystem: false }).execute();
      await trx.insertInto('rolePermissions').values(['attendance.view_team', 'report.view', 'report.export'].map((permissionKey) => ({ roleId, permissionKey }))).execute();
    });
    const lead = uuid('c'); await seedUser(h.admin, lead, 'team-exporter-hrws@test.local', 'Team exporter'); await seedMembership(h.admin, f.orgId, lead, roleId, { employeeId: f.e3 });
    const res = await h.request('POST', `${base()}/attendance/summary/export`, { token: lead, body: { month: MONTH } });
    expect(res.status).toBe(202);
    expect(res.body.data.rowCount).toBe(2);
    const req = await h.admin.selectFrom('reportRequests').select('parameters').where('id', '=', res.body.data.reportId).executeTakeFirstOrThrow();
    expect(((req.parameters as { employeeIds: string[] }).employeeIds).sort()).toEqual([f.e1, f.e3].sort());
  });

  it('6a-D9 pages in SQL: each page carries its rows, the totals always cover the whole filtered set', async () => {
    const all = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&pageSize=200`, { token: f.hrAdmin });
    const pages = await Promise.all([1, 2, 3, 4].map((page) => h.request('GET', `${base()}/attendance/summary?month=${MONTH}&page=${page}&pageSize=1`, { token: f.hrAdmin })));
    expect(pages.map((p) => p.body.data.length)).toEqual([1, 1, 1, 0]);
    expect(pages.flatMap((p) => p.body.data.map((r: { employeeId: string }) => r.employeeId))).toEqual(all.body.data.map((r: { employeeId: string }) => r.employeeId));
    for (const p of pages) {
      expect(p.body.meta.total).toBe(3);
      expect(p.body.meta.totals).toEqual(all.body.meta.totals);
    }
  });

  it('6a-D8 the month strip reads the same summary: a view_own caller gets exactly their own row', async () => {
    const own = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&pageSize=1`, { token: f.employeeUser });
    expect(own.status).toBe(200);
    expect(own.body.data.map((r: { employeeId: string }) => r.employeeId)).toEqual([f.e1]);
    const hr = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&employeeId=${f.e1}`, { token: f.hrAdmin });
    const { branchName: _b, departmentName: _d, ...ownFigures } = own.body.data[0];
    const { branchName: _b2, departmentName: _d2, ...hrFigures } = hr.body.data[0];
    expect(ownFigures).toEqual(hrFigures);
    expect(own.body.data[0]).toMatchObject({ presentDays: 3, absentDays: 1.5, leaveDays: 1.5 });
    // somebody else's row stays out of reach
    const other = await h.request('GET', `${base()}/attendance/summary?month=${MONTH}&employeeId=${f.e2}`, { token: f.employeeUser });
    expect(other.body.data).toEqual([]);
    // the calendar (a register surface) stays closed to view_own callers
    expect((await h.request('GET', `${base()}/attendance/calendar?month=${MONTH}`, { token: f.employeeUser })).status).toBe(403);
  });
});

describe('GET /attendance/timeline', () => {
  it('lists events with their engine role, voided markers, and raw rows only for attendance.view_raw', async () => {
    await h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId: f.e1, branchId: f.branchA, punchedAt: new Date(`${DAY}T08:00:00Z`), eventType: 'PUNCH', source: 'MOBILE', deviceId: null, voidedAt: new Date() }).execute();
    await sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status, employee_id, raw_payload)
      values (${f.orgId}::uuid, ${device}::uuid, ${f.branchA}::uuid, 'mock', '1001', ${`${DAY}T04:10:00Z`}, 'tl1', 'POLL', 'normalized', ${f.e1}::uuid, ${JSON.stringify({ channel: 'mobile', geofenceVerdict: 'inside', distanceM: 12.5, lat: 23.58, lng: 58.4, secret: 'x' })}::jsonb)`.execute(h.admin);
    await h.admin.updateTable('attendanceDailyRecords').set({ trace: JSON.stringify({ punches: [{ eventId: inEvent, role: 'IN' }, { eventId: outEvent, role: 'OUT' }] }) }).where('employeeId', '=', f.e1).where('attendanceDate', '=', sql<Date>`${DAY}::date`).execute();
    const owner = await h.request('GET', `${base()}/attendance/timeline?employeeId=${f.e1}&date=${DAY}`, { token: f.owner });
    expect(owner.status).toBe(200);
    const d = owner.body.data;
    expect(d.events.find((e: { id: string }) => e.id === inEvent)).toMatchObject({ role: 'IN', source: 'DEVICE', deviceName: expect.any(String) });
    expect(d.events.some((e: { voidedAt: string | null }) => e.voidedAt !== null)).toBe(true);
    expect(d.raw).toHaveLength(1);
    expect(d.raw[0].facts).toEqual({ channel: 'mobile', geofenceVerdict: 'inside', distanceM: 12.5, lat: 23.58, lng: 58.4 });
    const hrUser = await h.request('GET', `${base()}/attendance/timeline?employeeId=${f.e1}&date=${DAY}`, { token: f.hrUser });
    expect(hrUser.status).toBe(200);
    expect(hrUser.body.data.raw).toBeNull();
    const employee = await h.request('GET', `${base()}/attendance/timeline?employeeId=${f.e1}&date=${DAY}`, { token: f.employeeUser });
    expect(employee.status).toBe(403);
  });
});

describe('unmatched punch triage', () => {
  const raw = (user: string, minute: number, status = 'unmatched') => sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status)
    values (${f.orgId}::uuid, ${device}::uuid, null, 'mock', ${user}, ${`2026-08-05T05:${String(minute).padStart(2, '0')}:00Z`}, ${`um-${user}-${minute}`}, 'POLL', ${status})`.execute(h.admin);
  beforeAll(async () => {
    for (let i = 0; i < 3; i += 1) await raw('9999', i);
    await raw('8888', 10);
  });

  it('groups by device user with count and first / last seen; needs attendance.view_raw', async () => {
    const res = await h.request('GET', `${base()}/attendance/unmatched`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    const g = res.body.data.find((x: { deviceEmployeeId: string }) => x.deviceEmployeeId === '9999');
    expect(g).toMatchObject({ deviceId: device, count: 3, firstPunchAt: '2026-08-05T05:00:00.000Z', lastPunchAt: '2026-08-05T05:02:00.000Z', branchId: f.branchA });
    expect(res.body.data.find((x: { deviceEmployeeId: string }) => x.deviceEmployeeId === '8888').count).toBe(1);
    expect((await h.request('GET', `${base()}/attendance/unmatched`, { token: f.hrUser })).status).toBe(403);
    expect((await h.request('GET', `${base()}/attendance/unmatched`, { token: auditor })).status).toBe(200);
    expect((await h.request('POST', `${base()}/attendance/unmatched/assign`, { token: auditor, body: { deviceId: device, deviceEmployeeId: '9999', employeeId: f.e2 } })).status).toBe(403);
    // the branch manager of B does not see branch A's device
    expect((await h.request('GET', `${base()}/attendance/unmatched`, { token: f.branchManagerB })).status).toBe(403);
  });

  it('assign maps the device user on the device and re-queues its unmatched rows; conflicts are refused', async () => {
    const res = await h.request('POST', `${base()}/attendance/unmatched/assign`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '9999', employeeId: f.e2 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ rows: 3, employeeId: f.e2 });
    const state = await h.admin.selectFrom('deviceEmployeeStates').selectAll().where('deviceId', '=', device).where('deviceUserId', '=', '9999').executeTakeFirstOrThrow();
    expect(state).toMatchObject({ employeeId: f.e2, desired: true });
    const statuses = (await h.admin.selectFrom('attendanceRawTransactions').select('processingStatus').where('deviceId', '=', device).where('deviceEmployeeId', '=', '9999').execute()).map((r) => r.processingStatus);
    expect(statuses).toEqual(['pending', 'pending', 'pending']);
    expect((await queueJobs(h.admin, 'NORMALIZE_RAW')).some((j) => j.dedupeKey === `normalize:${f.orgId}`)).toBe(true);
    expect((await auditRows(h.admin, 'attendance.unmatched_assigned'))[0]?.newValue).toMatchObject({ deviceEmployeeId: '9999', employeeId: f.e2, rowsRequeued: 3 });
    const taken = await h.request('POST', `${base()}/attendance/unmatched/assign`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '9999', employeeId: f.e3 } });
    expect(taken.status).toBe(409);
    const alreadyMapped = await h.request('POST', `${base()}/attendance/unmatched/assign`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '8888', employeeId: f.e2 } });
    expect(alreadyMapped.status).toBe(409);
  });

  it('ignore sets rows aside with a reason and restore gives them back to the normaliser', async () => {
    const ignore = await h.request('POST', `${base()}/attendance/unmatched/ignore`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '8888', reason: 'Visitor card' } });
    expect(ignore.status).toBe(200);
    expect(ignore.body.data.rows).toBe(1);
    const ignored = await h.request('GET', `${base()}/attendance/unmatched?status=ignored`, { token: f.hrAdmin });
    expect(ignored.body.data.map((x: { deviceEmployeeId: string }) => x.deviceEmployeeId)).toEqual(['8888']);
    expect((await auditRows(h.admin, 'attendance.raw_ignored'))[0]).toMatchObject({ reason: 'Visitor card' });
    const again = await h.request('POST', `${base()}/attendance/unmatched/ignore`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '8888', reason: 'Visitor card' } });
    expect(again.status).toBe(409);
    const restore = await h.request('POST', `${base()}/attendance/unmatched/restore`, { token: f.hrAdmin, body: { deviceId: device, deviceEmployeeId: '8888' } });
    expect(restore.status).toBe(200);
    expect(restore.body.data.rows).toBe(1);
    const row = await h.admin.selectFrom('attendanceRawTransactions').select('processingStatus').where('deviceId', '=', device).where('deviceEmployeeId', '=', '8888').executeTakeFirstOrThrow();
    expect(row.processingStatus).toBe('pending');
  });
});

describe('report.export is enforced where the app exports (backward compatibility: 403 without it)', () => {
  it('report downloads need report.export on top of report.view', async () => {
    const own = async (userId: string) => (await h.admin.insertInto('reportRequests').values({ organizationId: f.orgId, reportType: 'late_report', format: 'csv', parameters: JSON.stringify({}), status: 'COMPLETED', requestedBy: userId, filePath: `${f.orgId}/x.csv`, completedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }).returning('id').executeTakeFirstOrThrow()).id;
    const managerReport = await own(lineManager); // role manager: report.view, no report.export
    const denied = await h.request('GET', `${base()}/reports/${managerReport}/download`, { token: lineManager });
    expect(denied.status).toBe(403);
    const ownerReport = await own(f.owner);
    const allowed = await h.request('GET', `${base()}/reports/${ownerReport}/download`, { token: f.owner });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.url).toContain('storage.test');
  });

  it('the employee export needs report.export on top of employee.export', async () => {
    const roleId = uuid('9');
    // a custom role is written in the organisation's system context (the no-escalation trigger checks the actor)
    await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
      await trx.insertInto('roles').values({ id: roleId, organizationId: f.orgId, key: 'exporter_no_report', name: 'Exporter', isSystem: false }).execute();
      await trx.insertInto('rolePermissions').values(['employee.view', 'employee.export', 'report.view'].map((permissionKey) => ({ roleId, permissionKey }))).execute();
    });
    const exporter = uuid('c'); await seedUser(h.admin, exporter, 'exporter-hrws@test.local', 'Exporter'); await seedMembership(h.admin, f.orgId, exporter, roleId);
    const denied = await h.request('POST', `${base()}/employees/bulk`, { token: exporter, body: { action: 'export', format: 'csv' } });
    expect(denied.status).toBe(403);
    const owner = await h.request('POST', `${base()}/employees/bulk`, { token: f.owner, body: { action: 'export', format: 'csv' } });
    expect([200, 202]).toContain(owner.status);
  });
});

describe('6a-D4 unmatched punches on a Flowza Finance connector', () => {
  let finance: string;
  beforeAll(async () => {
    finance = await seedDevice(h.admin, f.orgId, f.branchA, { providerKey: 'flowza_finance', code: 'HRWS-FIN' });
    // an employee whose device user id equals the Finance identity: never a suggestion on the connector
    await h.admin.updateTable('employees').set({ deviceUserId: 'FIN-777' }).where('id', '=', f.e2).execute();
    for (let i = 0; i < 2; i += 1) {
      await sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status)
        values (${f.orgId}::uuid, ${finance}::uuid, null, 'flowza_finance', 'FIN-777', ${`2026-08-06T05:0${i}:00Z`}, ${`fin-777-${i}`}, 'POLL', 'unmatched')`.execute(h.admin);
    }
    // a control group on an ordinary device: Assign stays available there
    await sql`insert into public.attendance_raw_transactions (organization_id, device_id, branch_id, provider_key, device_employee_id, punched_at, dedupe_hash, source, processing_status)
      values (${f.orgId}::uuid, ${device}::uuid, null, 'mock', '7777', '2026-08-06T06:00:00Z', 'um-7777-0', 'POLL', 'unmatched')`.execute(h.admin);
  });

  it('6a-D4 lists the group with the reason Assign cannot work and no suggestions', async () => {
    const res = await h.request('GET', `${base()}/attendance/unmatched?deviceId=${finance}`, { token: f.hrAdmin });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([expect.objectContaining({ deviceEmployeeId: 'FIN-777', providerKey: 'flowza_finance', count: 2, assignBlockedReason: 'CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER', suggestions: [] })]);
    const normal = await h.request('GET', `${base()}/attendance/unmatched?deviceId=${device}`, { token: f.hrAdmin });
    expect(normal.body.data.find((g: { deviceEmployeeId: string }) => g.deviceEmployeeId === '7777')).toMatchObject({ providerKey: 'mock', assignBlockedReason: null });
  });

  it('6a-D4 refuses Assign with 409 INVALID_STATE and writes no device mapping; Ignore / Restore still work', async () => {
    const res = await h.request('POST', `${base()}/attendance/unmatched/assign`, { token: f.hrAdmin, body: { deviceId: finance, deviceEmployeeId: 'FIN-777', employeeId: f.e2 } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER' } });
    expect(res.body.message).toMatch(/employee number/i);
    expect(await h.admin.selectFrom('deviceEmployeeStates').select('id').where('deviceId', '=', finance).execute()).toEqual([]);
    const statuses = (await h.admin.selectFrom('attendanceRawTransactions').select('processingStatus').where('deviceId', '=', finance).execute()).map((r) => r.processingStatus);
    expect(statuses).toEqual(['unmatched', 'unmatched']);
    const ignore = await h.request('POST', `${base()}/attendance/unmatched/ignore`, { token: f.hrAdmin, body: { deviceId: finance, deviceEmployeeId: 'FIN-777', reason: 'Not on FlowZa Time yet' } });
    expect(ignore.status).toBe(200);
    expect(ignore.body.data.rows).toBe(2);
    const restore = await h.request('POST', `${base()}/attendance/unmatched/restore`, { token: f.hrAdmin, body: { deviceId: finance, deviceEmployeeId: 'FIN-777' } });
    expect(restore.status).toBe(200);
    expect(restore.body.data.rows).toBe(2);
  });
});

describe('6a-D2 a day belongs to the branch that owned it (transfers)', () => {
  let e5: string; let hrA: string;
  const B_DAY = '2026-08-10'; const A_DAY = '2026-08-20';
  beforeAll(async () => {
    // e5 worked in branch B until 2026-08-15 and in branch A since; the 10th belongs to B, the 20th to A
    e5 = uuid('e');
    await h.admin.insertInto('employees').values({ id: e5, organizationId: f.orgId, branchId: f.branchA, employeeNumber: 'EMP5', firstName: 'First5', lastName: 'Last5', displayName: 'Employee 5', joiningDate: '2024-01-01', deviceUserId: '1005' }).execute();
    await h.admin.insertInto('employmentHistory').values([
      { organizationId: f.orgId, employeeId: e5, effectiveFrom: '2024-01-01', effectiveTo: '2026-08-15', branchId: f.branchB, departmentId: null, designationId: null, managerEmployeeId: null, employmentType: 'full_time', employmentStatus: 'active', reason: 'Joined' },
      { organizationId: f.orgId, employeeId: e5, effectiveFrom: '2026-08-15', effectiveTo: null, branchId: f.branchA, departmentId: null, designationId: null, managerEmployeeId: null, employmentType: 'full_time', employmentStatus: 'active', reason: 'Transfer' },
    ]).execute();
    await h.admin.insertInto('attendanceDailyRecords').values([rec(e5, f.branchB, B_DAY, 'PRESENT', [], 485), rec(e5, f.branchA, A_DAY, 'PRESENT', [], 480)]).execute();
    hrA = uuid('c'); await seedUser(h.admin, hrA, 'hr-branch-a-hrws@test.local', 'HR branch A'); await seedMembership(h.admin, f.orgId, hrA, ROLE.hr_admin, { branchIds: [f.branchA] });
  });

  it('6a-D2 a branch-A HR admin can neither preview nor edit the branch-B day of an employee who moved to A', async () => {
    const preview = await h.request('POST', `${base()}/attendance/preview`, { token: hrA, body: { employeeId: e5, date: B_DAY } });
    expect([403, 404]).toContain(preview.status);
    expect(preview.body.data).toBeUndefined();
    const edit = await h.request('POST', `${base()}/attendance/record-edits`, { token: hrA, body: { employeeId: e5, date: B_DAY, status: 'ABSENT', reason: 'Transfer probe' } });
    expect(edit.status).toBe(403);
    // the Corrections page's own door (createCorrection) refuses the same day
    const correction = await h.request('POST', `${base()}/attendance/corrections`, { token: hrA, body: { employeeId: e5, attendanceDate: B_DAY, type: 'SET_STATUS', proposedStatus: 'ABSENT', reason: 'Transfer probe' } });
    expect(correction.status).toBe(403);
    expect(await h.admin.selectFrom('attendanceCorrections').select('id').where('employeeId', '=', e5).where('attendanceDate', '=', sql<Date>`${B_DAY}::date`).execute()).toEqual([]);
  });

  it('6a-D2 bulk status refuses the branch-B item and applies the branch-A one', async () => {
    const res = await h.request('POST', `${base()}/attendance/bulk-status`, { token: hrA, body: { status: 'ABSENT', reason: 'Transfer probe', items: [{ employeeId: e5, date: B_DAY }, { employeeId: e5, date: A_DAY }] } });
    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(res.body.data.results[1]).toMatchObject({ ok: true, approval: 'AUTO_APPROVED' });
  });

  it('6a-D2 the same-branch day and an unrestricted HR admin still work', async () => {
    const own = await h.request('POST', `${base()}/attendance/preview`, { token: hrA, body: { employeeId: e5, date: A_DAY } });
    expect(own.status).toBe(200);
    const unrestricted = await h.request('POST', `${base()}/attendance/preview`, { token: f.hrAdmin, body: { employeeId: e5, date: B_DAY } });
    expect(unrestricted.status).toBe(200);
    expect(unrestricted.body.data.current.workedMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe('6a-D6 statuses and punches only inside today and the employment', () => {
  let leaver: string;
  const muscat = () => DateTime.now().setZone('Asia/Muscat');
  beforeAll(async () => {
    leaver = uuid('e');
    await h.admin.insertInto('employees').values({ id: leaver, organizationId: f.orgId, branchId: f.branchA, employeeNumber: 'EMP6', firstName: 'First6', lastName: 'Last6', displayName: 'Employee 6', joiningDate: '2024-01-01', exitDate: '2026-08-31', deviceUserId: '1006' }).execute();
  });

  it('6a-D6 bulk status: a future date, a date before joining and a date after exit are refused per item', async () => {
    const tomorrow = muscat().plus({ days: 1 }).toISODate()!;
    const today = muscat().toISODate()!;
    const res = await h.request('POST', `${base()}/attendance/bulk-status`, { token: f.hrAdmin, body: { status: 'PRESENT', reason: 'Date window probe', items: [
      { employeeId: f.e2, date: tomorrow }, { employeeId: f.e2, date: '2023-06-01' }, { employeeId: leaver, date: '2026-09-05' }, { employeeId: leaver, date: '2026-08-31' }, { employeeId: f.e2, date: today },
    ] } });
    expect(res.status).toBe(200);
    const r = res.body.data.results;
    expect(r[0]).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(r[0].error.message).toMatch(/future/i);
    expect(r[1]).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(r[1].error.message).toMatch(/before the employee joined/i);
    expect(r[2]).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    expect(r[2].error.message).toMatch(/after the employee left/i);
    expect(r[3]).toMatchObject({ ok: true });
    expect(r[4]).toMatchObject({ ok: true });
  });

  it('6a-D6 record edits and the Corrections page refuse a future date (organisation timezone)', async () => {
    const tomorrow = muscat().plus({ days: 1 }).toISODate()!;
    const edit = await h.request('POST', `${base()}/attendance/record-edits`, { token: f.hrAdmin, body: { employeeId: f.e2, date: tomorrow, status: 'PRESENT', reason: 'Future probe' } });
    expect(edit.status).toBe(400);
    const addPunch = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: tomorrow, type: 'ADD_PUNCH', proposedPunchedAt: `${tomorrow}T04:00:00Z`, proposedEventType: 'PUNCH_IN', reason: 'Future probe' } });
    expect(addPunch.status).toBe(400);
    const beforeJoin = await h.request('POST', `${base()}/attendance/corrections`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: '2023-12-31', type: 'SET_STATUS', proposedStatus: 'PRESENT', reason: 'Before joining' } });
    expect(beforeJoin.status).toBe(400);
    expect(await h.admin.selectFrom('attendanceCorrections').select('id').where('employeeId', '=', f.e2).where('attendanceDate', 'in', [sql<Date>`${tomorrow}::date`, sql<Date>`'2023-12-31'::date`]).execute()).toEqual([]);
  });
});

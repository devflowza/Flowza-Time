import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_ATTENDANCE_SETTINGS } from '@flowza/contracts';
import { auditRows, createApiHarness, domainEvents, queueJobs, seedMembership, seedOrg, seedUser, uuid, ROLE, type ApiHarness, type OrgFixture } from '../../../test/features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * Attendance day marks + the pay-effect charger + the attendance policy settings (HR portal Prompt 3).
 * Leave types: AL 1 day, CL 0.5 day (both paid, tracked), SL 5 days (paid but excluded by default), NP unpaid.
 */
let h: ApiHarness; let f: OrgFixture;
let lineManager: string; // role `manager`, linked to e3 (= e1's manager)
let e3Self: string;      // role hr_admin, linked to e3 (may not mark their own day)
const D1 = '2026-08-03'; const D2 = '2026-08-04'; const D3 = '2026-08-05';
const types: Record<string, string> = {};

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_marks_${process.pid}`); f = await seedOrg(h.admin, 'marks');
  lineManager = uuid('c'); await seedUser(h.admin, lineManager, `line-manager-marks@test.local`, 'Line Manager'); await seedMembership(h.admin, f.orgId, lineManager, ROLE.manager, { employeeId: f.e3 });
  e3Self = uuid('c'); await seedUser(h.admin, e3Self, `e3-self-marks@test.local`, 'E3 Self'); await seedMembership(h.admin, f.orgId, e3Self, ROLE.hr_admin, { employeeId: f.e3 });
  for (const [code, name, isPaid, allowance] of [['AL', 'Annual', true, 1], ['CL', 'Casual', true, 0.5], ['SL', 'Sick', true, 5], ['NP', 'No pay', false, 10]] as const) {
    types[code] = (await h.admin.insertInto('leaveTypes').values({ organizationId: f.orgId, code, name, isPaid, annualAllowanceDays: allowance }).returning('id').executeTakeFirstOrThrow()).id;
  }
  const rec = (employeeId: string, branchId: string, date: string, status: 'ABSENT' | 'PRESENT', flags: string[]) => ({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status, flags, workedMinutes: status === 'PRESENT' ? 480 : 0, lateMinutes: flags.includes('LATE') ? 45 : 0, trace: JSON.stringify({ punches: [] }) });
  await h.admin.insertInto('attendanceDailyRecords').values([
    rec(f.e1, f.branchA, D1, 'ABSENT', []), rec(f.e1, f.branchA, D2, 'PRESENT', ['LATE']), rec(f.e1, f.branchA, D3, 'PRESENT', ['MISSING_OUT']),
    rec(f.e2, f.branchB, D1, 'ABSENT', []), rec(f.e3, f.branchA, D1, 'ABSENT', []),
  ]).execute();
});
afterAll(async () => { await h?.close(); });
const base = () => `/api/v1/orgs/${f.orgId}`;
const leaveRows = (employeeId: string) => h.admin.selectFrom('leaveRecords').select(['id', 'leaveTypeId', 'status', 'externalRef', 'isHalfDay', 'halfDayPart', 'startDate']).where('organizationId', '=', f.orgId).where('employeeId', '=', employeeId).orderBy('createdAt').execute();
const marksOf = (employeeId: string, date: string) => h.admin.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', f.orgId).where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).orderBy('createdAt').execute();

describe('attendance settings (policy parity)', () => {
  it('round-trips the new groups through PUT / GET and fills defaults for what a client leaves out', async () => {
    const get0 = await h.request('GET', `${base()}/settings/attendance`, { token: f.owner });
    expect(get0.status).toBe(200);
    expect(get0.body.data.selfService).toEqual(DEFAULT_ATTENDANCE_SETTINGS.selfService);
    expect(get0.body.data.unexcused).toEqual(DEFAULT_ATTENDANCE_SETTINGS.unexcused);
    const put = await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: {
      processingDelaySeconds: 30, payrollPeriod: 'calendar_month', payrollCutoffDay: 25, allowSelfServiceCorrections: false,
      selfService: { webCheckIn: true, mobileCheckIn: true, requireGeofence: 'block', allowSelfieCheckIn: false, ipAllowList: ['10.0.0.0/8'], checkInWindow: { start: '06:00', end: '12:00' }, checkOutWindow: null, outOfWindowAction: 'reject', duplicatePunchSeconds: 90 },
      missedPunch: { detectionEnabled: true, dayCloseGraceDays: 1, singlePunchSplitTime: '13:00' },
      nonWorkingDay: { action: 'overtime' },
      unexcused: { autoDeductEnabled: true, graceDays: 2, payEffectAbsent: 1, payEffectLate: 0.5, payEffectMissingPunch: 0.5, leaveTypePriority: ['al', 'CL'], excludeLeaveTypeCodes: ['SL', 'ML', 'PTL', 'HJ'] },
      notes: { requireReasonForLate: true, requireReasonForAbsent: false },
      stats: { attendanceTargetPct: 92, fullDayHours: 8.5 },
    } });
    expect(put.status).toBe(200);
    expect(put.body.data.selfService).toMatchObject({ webCheckIn: true, requireGeofence: 'block', ipAllowList: ['10.0.0.0/8'], checkInWindow: { start: '06:00', end: '12:00' }, checkOutWindow: null, duplicatePunchSeconds: 90 });
    expect(put.body.data.unexcused).toMatchObject({ autoDeductEnabled: true, graceDays: 2, leaveTypePriority: ['AL', 'CL'] });
    expect(put.body.data.stats).toEqual({ attendanceTargetPct: 92, fullDayHours: 8.5 });
    const get1 = await h.request('GET', `${base()}/settings/attendance`, { token: f.owner });
    expect(get1.body.data).toEqual(put.body.data);
    // a client that only knows the pre-existing keys (or one nested key) does not wipe the rest: the server fills the defaults
    const legacy = await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: { processingDelaySeconds: 10, nonWorkingDay: { action: 'record' }, unexcused: { autoDeductEnabled: false } } });
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.processingDelaySeconds).toBe(10);
    expect(legacy.body.data.unexcused).toEqual({ ...DEFAULT_ATTENDANCE_SETTINGS.unexcused, autoDeductEnabled: false });
    expect(legacy.body.data.selfService).toEqual(DEFAULT_ATTENDANCE_SETTINGS.selfService);
    const bad = await h.request('PUT', `${base()}/settings/attendance`, { token: f.owner, body: { missedPunch: { dayCloseGraceDays: 9 } } });
    expect(bad.status).toBe(400);
    const notOwner = await h.request('PUT', `${base()}/settings/attendance`, { token: f.hrUser, body: {} });
    expect(notOwner.status).toBe(403);
  });
});

describe('day marks — authorization', () => {
  it('needs attendance.approve; a line manager marks direct reports only; nobody marks their own day', async () => {
    const employee = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.employeeUser, body: { employeeId: f.e1, attendanceDate: D1, kind: 'EXCUSED', reason: 'my own excuse' } });
    expect(employee.status).toBe(403);
    const outsider = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.outsider, body: { employeeId: f.e1, attendanceDate: D1, kind: 'EXCUSED', reason: 'not a member' } });
    expect(outsider.status).toBe(403);
    const notMyReport = await h.request('POST', `${base()}/attendance/day-marks`, { token: lineManager, body: { employeeId: f.e2, attendanceDate: D1, kind: 'EXCUSED', reason: 'not my report' } });
    expect(notMyReport.status).toBe(403);
    const ownDay = await h.request('POST', `${base()}/attendance/day-marks`, { token: e3Self, body: { employeeId: f.e3, attendanceDate: D1, kind: 'EXCUSED', reason: 'excusing myself' } });
    expect(ownDay.status).toBe(403);
    const invalid = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'PAY_EFFECT', reason: 'no pay effect given' } });
    expect(invalid.status).toBe(400);
    const lop = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'LOP', payEffectDays: 1, reason: 'LOP is written by the charger only' } });
    expect(lop.status).toBe(400);
  });

  it('a line manager excuses a direct report, the mark is visible per RLS scope and queues the day recompute', async () => {
    const before = (await queueJobs(h.admin, 'RECOMPUTE_DAILY')).length;
    const res = await h.request('POST', `${base()}/attendance/day-marks`, { token: lineManager, body: { employeeId: f.e1, attendanceDate: D2, kind: 'EXCUSED', reason: 'Client visit confirmed by the customer' } });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ employeeId: f.e1, attendanceDate: D2, kind: 'EXCUSED', payEffectDays: 0, source: 'HR', createdBy: lineManager, revokedAt: null, reversed: 0, charge: null, branchId: f.branchA });
    const jobs = await queueJobs(h.admin, 'RECOMPUTE_DAILY');
    expect(jobs.length).toBe(before + 1);
    expect(jobs.at(-1)).toMatchObject({ dedupeKey: `recompute:${f.e1}:${D2}:immediate`, payload: { organizationId: f.orgId, employeeId: f.e1, date: D2, reason: 'MANUAL_OVERRIDE', triggeredBy: lineManager } });
    // idempotent: the same mark again is the same row
    const again = await h.request('POST', `${base()}/attendance/day-marks`, { token: lineManager, body: { employeeId: f.e1, attendanceDate: D2, kind: 'EXCUSED', reason: 'again' } });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(res.body.data.id);
    expect((await marksOf(f.e1, D2)).length).toBe(1);
    expect((await auditRows(h.admin, 'attendance.day_mark_created')).length).toBeGreaterThanOrEqual(1);

    const range = `from=2026-08-01&to=2026-08-31`;
    const hr = await h.request('GET', `${base()}/attendance/day-marks?${range}`, { token: f.hrAdmin });
    expect(hr.status).toBe(200);
    expect(hr.body.data.map((m: { id: string }) => m.id)).toContain(res.body.data.id);
    const own = await h.request('GET', `${base()}/attendance/day-marks?${range}`, { token: f.employeeUser }); // employee role: attendance.view_own, linked to e1
    expect(own.status).toBe(200);
    expect(own.body.data.every((m: { employeeId: string }) => m.employeeId === f.e1)).toBe(true);
    expect(own.body.data.length).toBe(1);
    const other = await h.request('GET', `${base()}/attendance/day-marks?${range}&employeeId=${f.e2}`, { token: f.employeeUser });
    expect(other.status).toBe(403);
    const manager = await h.request('GET', `${base()}/attendance/day-marks?${range}`, { token: lineManager }); // attendance.view_team, no attendance.view
    expect(manager.status).toBe(200);
    expect(manager.body.data.map((m: { id: string }) => m.id)).toEqual([res.body.data.id]);
    const bmB = await h.request('GET', `${base()}/attendance/day-marks?${range}`, { token: f.branchManagerB }); // branch B only
    expect(bmB.body.data).toEqual([]);
    const tooLong = await h.request('GET', `${base()}/attendance/day-marks?from=2025-01-01&to=2026-08-31`, { token: f.hrAdmin });
    expect(tooLong.status).toBe(400);
    const detail = await h.admin.selectFrom('attendanceDailyRecords').select('id').where('employeeId', '=', f.e1).where('attendanceDate', '=', sql<Date>`${D2}::date`).executeTakeFirstOrThrow();
    const record = await h.request('GET', `${base()}/attendance/records/${detail.id}`, { token: f.hrAdmin });
    expect(record.status).toBe(200);
    expect(record.body.data.marks).toHaveLength(1);
    expect(record.body.data.marks[0]).toMatchObject({ kind: 'EXCUSED', reason: 'Client visit confirmed by the customer' });
    expect(record.body.data).toMatchObject({ lopDays: 0, unexcused: false }); // derived from the flags; the recompute has not run in this test process
  });
});

describe('pay-effect charger through HR marks', () => {
  it('charges AL first, then CL, then falls back to LOP; never double-charges; a reverse restores the balance', async () => {
    // D1 absent, full day → AL (1 day allowance)
    const first = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'Unexplained absence' } });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ kind: 'PAY_EFFECT', payEffectDays: 1, source: 'HR', charge: { outcome: 'charged_leave', leaveTypeCode: 'AL' } });
    let leaves = await leaveRows(f.e1);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]).toMatchObject({ leaveTypeId: types['AL'], status: 'APPROVED', externalRef: `mark:${first.body.data.id}`, isHalfDay: false });
    // the same day again: no second charge
    const again = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'again' } });
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ id: first.body.data.id, charge: { outcome: 'already_charged' } });
    expect((await leaveRows(f.e1)).length).toBe(1);
    // D2 was excused above: neither a pay effect nor an UNEXCUSED verdict may contradict the excuse (revoke it first)
    const excusedDay = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D2, kind: 'PAY_EFFECT', payEffectDays: 0.5, reason: 'late' } });
    expect(excusedDay.status).toBe(409);
    expect(excusedDay.body.details).toMatchObject({ outcome: 'excused' });
    const unexcuseExcused = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D2, kind: 'UNEXCUSED', reason: 'late after all' } });
    expect(unexcuseExcused.status).toBe(409);
    expect((await marksOf(f.e1, D2)).map((m) => m.kind)).toEqual(['EXCUSED']);
    // D3 (missing punch) half a day → AL is exhausted (0 left), CL has 0.5 → CL, as a half-day leave record
    const half = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D3, kind: 'UNEXCUSED', payEffectDays: 0.5, reason: 'No check-out and no explanation' } });
    expect(half.status).toBe(201);
    expect(half.body.data).toMatchObject({ kind: 'UNEXCUSED', payEffectDays: 0.5, charge: { outcome: 'charged_leave', leaveTypeCode: 'CL' } });
    leaves = await leaveRows(f.e1);
    expect(leaves).toHaveLength(2);
    expect(leaves[1]).toMatchObject({ leaveTypeId: types['CL'], status: 'APPROVED', isHalfDay: true });
    const d3Marks = await marksOf(f.e1, D3);
    expect(d3Marks.map((m) => m.kind).sort()).toEqual(['PAY_EFFECT', 'UNEXCUSED']);
    // e2: AL allowance 1 covers D1 → charged; nothing is left for a second full day → LOP (SL is excluded, NP unpaid)
    await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: f.e2, attendanceDate: D2, branchId: f.branchB, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'ABSENT', flags: [], trace: JSON.stringify({ punches: [] }) }).execute();
    const e2first = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: D1, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'absent' } });
    expect(e2first.body.data.charge).toEqual({ outcome: 'charged_leave', leaveTypeCode: 'AL' });
    const e2second = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: D2, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'absent again' } });
    expect(e2second.status).toBe(201);
    expect(e2second.body.data).toMatchObject({ kind: 'LOP', payEffectDays: 1, charge: { outcome: 'lop', leaveTypeCode: null } });
    expect((await leaveRows(f.e2)).length).toBe(1);
    // e2 works in branch B: the branch manager of B (attendance.view in branch scope + attendance.approve) may revoke the LOP mark
    const revokeByBm = await h.request('POST', `${base()}/attendance/day-marks/${e2second.body.data.id}/revoke`, { token: f.branchManagerB, body: { reason: 'Sick note arrived' } });
    expect(revokeByBm.status).toBe(200);
    expect(revokeByBm.body.data).toMatchObject({ id: e2second.body.data.id, revokedBy: f.branchManagerB, revokeReason: 'Sick note arrived' });
    // revoking the AL charge of e1 D1 restores the balance: the internal leave row is cancelled, the mark revoked, the recompute queued
    const revoke = await h.request('POST', `${base()}/attendance/day-marks/${first.body.data.id}/revoke`, { token: f.hrAdmin, body: { reason: 'Medical certificate provided' } });
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revokedAt).not.toBeNull();
    leaves = await leaveRows(f.e1);
    expect(leaves.find((l) => l.externalRef === `mark:${first.body.data.id}`)?.status).toBe('CANCELLED');
    // revoking twice is a no-op; a stranger cannot revoke; the revoked mark still lists with includeRevoked
    const twice = await h.request('POST', `${base()}/attendance/day-marks/${first.body.data.id}/revoke`, { token: f.hrAdmin, body: { reason: 'twice' } });
    expect(twice.status).toBe(200);
    expect(twice.body.data.revokeReason).toBe('Medical certificate provided');
    const stranger = await h.request('POST', `${base()}/attendance/day-marks/${half.body.data.id}/revoke`, { token: f.outsider, body: { reason: 'nope' } });
    expect(stranger.status).toBe(403);
    const employeeRevoke = await h.request('POST', `${base()}/attendance/day-marks/${half.body.data.id}/revoke`, { token: f.employeeUser, body: { reason: 'nope' } });
    expect(employeeRevoke.status).toBe(403);
    const listed = await h.request('GET', `${base()}/attendance/day-marks?from=${D1}&to=${D1}&employeeId=${f.e1}&includeRevoked=true`, { token: f.hrAdmin });
    expect(listed.body.data.map((m: { id: string; revokedAt: string | null }) => [m.id, m.revokedAt !== null])).toEqual([[first.body.data.id, true]]);
    const active = await h.request('GET', `${base()}/attendance/day-marks?from=${D1}&to=${D1}&employeeId=${f.e1}`, { token: f.hrAdmin });
    expect(active.body.data).toEqual([]);
    // the balance is free again: charging D1 once more picks AL again
    const recharge = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'certificate rejected after review' } });
    expect(recharge.body.data.charge).toEqual({ outcome: 'charged_leave', leaveTypeCode: 'AL' });
    // an EXCUSED mark on a charged day reverses the charge first
    const excuse = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: D1, kind: 'EXCUSED', reason: 'Approved after all' } });
    expect(excuse.status).toBe(201);
    expect(excuse.body.data).toMatchObject({ kind: 'EXCUSED', reversed: 1 });
    expect((await marksOf(f.e1, D1)).filter((m) => m.revokedAt === null).map((m) => m.kind)).toEqual(['EXCUSED']);
    expect((await leaveRows(f.e1)).filter((l) => l.status === 'APPROVED').map((l) => l.leaveTypeId)).toEqual([types['CL']]);
    expect(await domainEvents(h.admin, 'attendance.unexcused_marked')).toEqual([]); // HR marks are not the sweep
  });

  it('refuses marks inside a locked period and a day already covered by approved leave', async () => {
    await h.admin.insertInto('attendancePeriodLocks').values({ organizationId: f.orgId, branchId: f.branchA, periodStart: '2026-07-01', periodEnd: '2026-07-31', lockedBy: f.owner }).execute();
    const locked = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e1, attendanceDate: '2026-07-15', kind: 'UNEXCUSED', reason: 'too late' } });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('PERIOD_LOCKED');
    const lockedB = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e2, attendanceDate: '2026-07-15', kind: 'UNEXCUSED', reason: 'branch B is not locked' } });
    expect(lockedB.status).toBe(201);
    await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: f.e3, branchId: f.branchA, leaveTypeId: types['AL']!, startDate: D1, endDate: D1, status: 'APPROVED' }).execute();
    const covered = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e3, attendanceDate: D1, kind: 'PAY_EFFECT', payEffectDays: 1, reason: 'absent' } });
    expect(covered.status).toBe(409);
    expect(covered.body.details).toMatchObject({ outcome: 'covered_by_leave' });
    const coveredUnexcused = await h.request('POST', `${base()}/attendance/day-marks`, { token: f.hrAdmin, body: { employeeId: f.e3, attendanceDate: D1, kind: 'UNEXCUSED', reason: 'absent' } });
    expect(coveredUnexcused.status).toBe(409);
    expect((await marksOf(f.e3, D1)).length).toBe(0);
  });
});

describe('dashboard missing-punch counters', () => {
  it('counts the MISSING_IN / MISSING_OUT flags (the engine never emits a MISSING_PUNCH status)', async () => {
    const summary = await h.request('GET', `${base()}/dashboard/summary?date=${D3}`, { token: f.owner });
    expect(summary.status).toBe(200);
    expect(summary.body.data.missingPunch).toBe(1);
    const trends = await h.request('GET', `${base()}/dashboard/trends?from=${D1}&to=${D3}`, { token: f.owner });
    expect(trends.status).toBe(200);
    expect(trends.body.data.find((d: { date: string }) => d.date === D3)?.missingPunch).toBe(1);
    expect(trends.body.data.find((d: { date: string }) => d.date === D1)?.missingPunch).toBe(0);
    const branches = await h.request('GET', `${base()}/dashboard/branches?date=${D3}`, { token: f.owner });
    expect(branches.status).toBe(200);
    expect(branches.body.data.find((b: { branchId: string }) => b.branchId === f.branchA)?.missingPunch).toBe(1);
  });
});

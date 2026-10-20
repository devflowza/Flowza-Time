import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { DEFAULT_NOTIFICATION_SETTINGS } from '@flowza/contracts';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { recomputeDailyHandler } from '../attendance/recompute.js';
import { relayOutbox } from './outbox.js';
import { ATTENDANCE_ALERTS_JOB_TYPE, attendanceAlertsHandler, dueRecordAlerts, isRecentAttendanceDate, runAttendanceAlerts, type AlertRecord } from './attendance-alerts.js';
import { ATTENDANCE_APPRECIATION_JOB_TYPE, appreciationHandler, evaluateAppreciation, isAppreciationDue, runAppreciation } from './appreciation.js';
import { notificationTasks } from './tasks.js';

/**
 * Automatic attendance notices against a real database: the recompute hook (late arrival, early departure, absence — today and
 * yesterday only, once per employee-day), the 15-minute sweep (early-departure catch-up, the absence reminder the day before
 * the excuse deadline, the missing check-in reminder), the weekly appreciation (criteria, once per week, "Send now"), the
 * recipients (the employee, their direct manager per the settings; nobody for an employee without a login or terminated) and
 * the relay's texts and links.
 */
const MUSCAT = 'Asia/Muscat';
const ROLE = { employee: '10000000-0000-0000-0000-000000000008', manager: '10000000-0000-0000-0000-000000000009' };
const O = {
  alerts: { org: '0d000000-0000-4000-8000-000000000001', branch: '0d000000-0000-4000-8000-0000000000b1', shift: '0d000000-0000-4000-8000-0000000000c1' },
  missing: { org: '0d000000-0000-4000-8000-000000000002', branch: '0d000000-0000-4000-8000-0000000000b2', shift: '0d000000-0000-4000-8000-0000000000c2' },
  thanks: { org: '0d000000-0000-4000-8000-000000000003', branch: '0d000000-0000-4000-8000-0000000000b3', shift: '0d000000-0000-4000-8000-0000000000c3' },
};
const E = {
  boss: '0d000000-0000-4000-8000-0000000000e0', late: '0d000000-0000-4000-8000-0000000000e1', early: '0d000000-0000-4000-8000-0000000000e2', absent: '0d000000-0000-4000-8000-0000000000e3',
  noLogin: '0d000000-0000-4000-8000-0000000000e4', terminated: '0d000000-0000-4000-8000-0000000000e5', history: '0d000000-0000-4000-8000-0000000000e6', quiet: '0d000000-0000-4000-8000-0000000000e7',
  // missing check-in organisation
  mBoss: '0d000000-0000-4000-8000-0000000000f0', mNone: '0d000000-0000-4000-8000-0000000000f1', mPunched: '0d000000-0000-4000-8000-0000000000f2', mLeave: '0d000000-0000-4000-8000-0000000000f3',
  // appreciation organisation
  good: '0d000000-0000-4000-8000-0000000000a1', lateOnce: '0d000000-0000-4000-8000-0000000000a2', few: '0d000000-0000-4000-8000-0000000000a3', goodNoLogin: '0d000000-0000-4000-8000-0000000000a4', goodAr: '0d000000-0000-4000-8000-0000000000a5',
};
const U: Record<string, string> = {
  boss: 'd0000000-0000-4000-8000-0000000000e0', late: 'd0000000-0000-4000-8000-0000000000e1', early: 'd0000000-0000-4000-8000-0000000000e2', absent: 'd0000000-0000-4000-8000-0000000000e3',
  terminated: 'd0000000-0000-4000-8000-0000000000e5', history: 'd0000000-0000-4000-8000-0000000000e6', quiet: 'd0000000-0000-4000-8000-0000000000e7',
  mBoss: 'd0000000-0000-4000-8000-0000000000f0', mNone: 'd0000000-0000-4000-8000-0000000000f1', mPunched: 'd0000000-0000-4000-8000-0000000000f2', mLeave: 'd0000000-0000-4000-8000-0000000000f3',
  good: 'd0000000-0000-4000-8000-0000000000a1', lateOnce: 'd0000000-0000-4000-8000-0000000000a2', few: 'd0000000-0000-4000-8000-0000000000a3', goodAr: 'd0000000-0000-4000-8000-0000000000a5',
};
/** Monday 19 Oct 2026 in Muscat (UTC+4); Friday and Saturday are the weekly offs. */
const TODAY = '2026-10-19';
const YESTERDAY = '2026-10-18';
const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
let clock = at(TODAY, '09:00');
let h: TestHarness;
const a = () => h.tdb.adminDb;
const ctx = (jobType: string, payload: Record<string, unknown> = {}, orgId: string | null = null) => ({ job: fakeJob(jobType, payload, orgId), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const recompute = (orgId: string, employeeId: string, date: string) => recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: orgId, employeeId, date }, orgId));
const relay = () => relayOutbox(ctx('RELAY_OUTBOX'));
async function punch(orgId: string, branchId: string, employeeId: string, date: string, time: string, eventType: 'PUNCH_IN' | 'PUNCH_OUT') {
  await a().insertInto('attendanceEvents').values({ organizationId: orgId, employeeId, branchId, punchedAt: at(date, time), eventType, source: 'DEVICE' }).execute();
}
async function settings(orgId: string, s: { notifications?: Record<string, unknown>; attendance?: Record<string, unknown> }) {
  const values = { notifications: JSON.stringify(s.notifications ?? {}), attendance: JSON.stringify(s.attendance ?? {}) };
  await a().insertInto('organizationSettings').values({ organizationId: orgId, ...values }).onConflict((oc) => oc.column('organizationId').doUpdateSet(values)).execute();
}
async function events(type: string, orgId: string) {
  return (await a().selectFrom('domainEvents').select(['aggregateId', 'payload']).where('eventType', '=', type).where('organizationId', '=', orgId).orderBy('id').execute())
    .map((e) => ({ employeeId: e.aggregateId, ...(e.payload as Record<string, unknown>) }));
}
const sorted = (ids: string[]) => [...ids].sort();

async function seedOrg(o: { org: string; branch: string; shift: string }, code: string) {
  await a().insertInto('organizations').values({ id: o.org, companyCode: code, legalName: code, displayName: `Org ${code}`, timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a().insertInto('branches').values({ id: o.branch, organizationId: o.org, code: 'HQ', name: 'HQ', timezone: MUSCAT }).execute();
  await a().insertInto('shifts').values({ id: o.shift, organizationId: o.org, code: 'DAY', name: 'Day 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([]) }).execute();
  await a().insertInto('shiftAssignments').values({ organizationId: o.org, targetType: 'ORGANIZATION', targetId: o.org, shiftId: o.shift, effectiveFrom: '2026-01-01' }).execute();
}
async function seedEmployee(o: { org: string; branch: string }, id: string, n: string, extra: { manager?: string; user?: string; locale?: string; status?: 'active' | 'terminated'; role?: string } = {}) {
  await a().insertInto('employees').values({ id, organizationId: o.org, branchId: o.branch, employeeNumber: n, firstName: 'Emp', lastName: n, displayName: `Emp ${n}`, joiningDate: '2025-01-01', deviceUserId: n, managerEmployeeId: extra.manager ?? null, employmentStatus: extra.status ?? 'active' }).execute();
  if (extra.user) {
    await sql`insert into auth.users (id, email) values (${extra.user}::uuid, ${`${n}@alerts.local`})`.execute(a());
    await a().insertInto('userProfiles').values({ id: extra.user, email: `${n}@alerts.local`, fullName: `Emp ${n}`, locale: extra.locale ?? 'en' }).execute();
    await a().insertInto('orgMemberships').values({ organizationId: o.org, userId: extra.user, roleId: extra.role ?? ROLE.employee, status: 'active', allBranches: true, employeeId: id }).execute();
  }
}

beforeAll(async () => {
  h = await createHarness(`flowza_worker_alerts_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } }, () => clock);
  await seedOrg(O.alerts, 'ALR');
  await seedEmployee(O.alerts, E.boss, 'BOSS', { user: U.boss, role: ROLE.manager });
  await seedEmployee(O.alerts, E.late, 'LATE', { user: U.late, manager: E.boss, locale: 'ar' });
  await seedEmployee(O.alerts, E.early, 'EARLY', { user: U.early, manager: E.boss });
  await seedEmployee(O.alerts, E.absent, 'ABSENT', { user: U.absent, manager: E.boss });
  await seedEmployee(O.alerts, E.noLogin, 'NOLOGIN', { manager: E.boss });
  await seedEmployee(O.alerts, E.terminated, 'TERM', { user: U.terminated, manager: E.boss, status: 'terminated' });
  await seedEmployee(O.alerts, E.history, 'HIST', { user: U.history, manager: E.boss });
  await seedEmployee(O.alerts, E.quiet, 'QUIET', { user: U.quiet, manager: E.boss });
  await settings(O.alerts.org, { attendance: { unexcused: { excuseDeadlineDays: 3, autoDeductEnabled: true, payEffectAbsent: 1 } } });

  await seedOrg(O.missing, 'MIS');
  await seedEmployee(O.missing, E.mBoss, 'MBOSS', { user: U.mBoss, role: ROLE.manager });
  await seedEmployee(O.missing, E.mNone, 'MNONE', { user: U.mNone, manager: E.mBoss });
  await seedEmployee(O.missing, E.mPunched, 'MPUNCH', { user: U.mPunched, manager: E.mBoss });
  await seedEmployee(O.missing, E.mLeave, 'MLEAVE', { user: U.mLeave, manager: E.mBoss });

  await seedOrg(O.thanks, 'THX');
  await seedEmployee(O.thanks, E.good, 'GOOD', { user: U.good });
  await seedEmployee(O.thanks, E.lateOnce, 'LATEONCE', { user: U.lateOnce });
  await seedEmployee(O.thanks, E.few, 'FEW', { user: U.few });
  await seedEmployee(O.thanks, E.goodNoLogin, 'GOODNL');
  await seedEmployee(O.thanks, E.goodAr, 'GOODAR', { user: U.goodAr, locale: 'ar' });
});
afterAll(async () => { await h?.close(); });

describe('pure rules', () => {
  const rec = (o: Partial<AlertRecord>): AlertRecord => ({ employeeId: E.late, attendanceDate: TODAY, timezone: MUSCAT, status: 'PRESENT', flags: [], lateMinutes: 0, earlyDepartureMinutes: 0, firstInAt: null, lastOutAt: null, expectedStartAt: null, expectedEndAt: null, ...o });
  it('only today and yesterday of the record\'s own timezone are recent', () => {
    expect(isRecentAttendanceDate(TODAY, MUSCAT, at(TODAY, '00:30'))).toBe(true);
    expect(isRecentAttendanceDate(YESTERDAY, MUSCAT, at(TODAY, '23:59'))).toBe(true);
    expect(isRecentAttendanceDate('2026-10-17', MUSCAT, at(TODAY, '09:00'))).toBe(false);
    // 00:30 in Muscat is still the 18th in UTC: the record's zone decides
    expect(isRecentAttendanceDate('2026-10-17', 'UTC', at(TODAY, '00:30'))).toBe(true);
  });
  it('late from minMinutes; early only on a judged day whose scheduled end has passed; absence on ABSENT', () => {
    const s = DEFAULT_NOTIFICATION_SETTINGS;
    expect(dueRecordAlerts(rec({ flags: ['LATE'], lateMinutes: 1 }), s, clock)).toEqual(['LATE_ARRIVAL']);
    expect(dueRecordAlerts(rec({ flags: ['LATE'], lateMinutes: 4 }), { ...s, lateArrivalAlert: { ...s.lateArrivalAlert, minMinutes: 5 } }, clock)).toEqual([]);
    expect(dueRecordAlerts(rec({ flags: ['LATE'], lateMinutes: 9 }), { ...s, lateArrivalAlert: { ...s.lateArrivalAlert, notifyEmployee: false, notifyManager: false } }, clock)).toEqual([]);
    const early = rec({ flags: ['EARLY_DEPARTURE'], earlyDepartureMinutes: 30, expectedEndAt: at(TODAY, '17:00') });
    expect(dueRecordAlerts(early, s, at(TODAY, '16:59'))).toEqual([]);
    expect(dueRecordAlerts(early, s, at(TODAY, '17:00'))).toEqual(['EARLY_DEPARTURE']);
    expect(dueRecordAlerts({ ...early, status: 'PENDING' }, s, at(TODAY, '18:00'))).toEqual([]);
    expect(dueRecordAlerts(rec({ status: 'ABSENT', attendanceDate: YESTERDAY }), s, clock)).toEqual(['ABSENCE']);
    expect(dueRecordAlerts(rec({ status: 'ABSENT', attendanceDate: YESTERDAY }), { ...s, absenceAlert: { ...s.absenceAlert, enabled: false } }, clock)).toEqual([]);
    expect(dueRecordAlerts(rec({ status: 'ABSENT', attendanceDate: '2026-10-15' }), s, clock)).toEqual([]);
  });
  it('appreciation: leave, holidays and weekly offs are neutral; a selected kind of day disqualifies; worked days must reach the minimum', () => {
    const criteria = { noLate: true, noEarlyDeparture: true, noAbsence: true, noMissingPunch: true, noUnexcused: true };
    const week = [...Array.from({ length: 5 }, () => ({ status: 'PRESENT', flags: [] as string[] })), { status: 'WEEKLY_OFF', flags: [] }, { status: 'LEAVE', flags: [] }];
    expect(evaluateAppreciation(week, { criteria, minWorkedDays: 5 })).toEqual({ qualified: true, workedDays: 5, disqualifiedBy: null });
    expect(evaluateAppreciation(week.slice(1), { criteria, minWorkedDays: 5 })).toEqual({ qualified: false, workedDays: 4, disqualifiedBy: null });
    expect(evaluateAppreciation([...week, { status: 'PRESENT', flags: ['LATE'] }], { criteria, minWorkedDays: 5 }).disqualifiedBy).toBe('late');
    expect(evaluateAppreciation([...week, { status: 'PRESENT', flags: ['LATE'] }], { criteria: { ...criteria, noLate: false }, minWorkedDays: 5 })).toEqual({ qualified: true, workedDays: 6, disqualifiedBy: null });
    expect(evaluateAppreciation([...week, { status: 'ABSENT', flags: [] }], { criteria, minWorkedDays: 5 }).disqualifiedBy).toBe('absence');
    expect(evaluateAppreciation([...week, { status: 'PRESENT', flags: ['MISSING_OUT'] }], { criteria, minWorkedDays: 5 }).disqualifiedBy).toBe('missing_punch');
    expect(evaluateAppreciation([...week, { status: 'PRESENT', flags: ['UNEXCUSED'] }], { criteria, minWorkedDays: 5 }).disqualifiedBy).toBe('unexcused');
    expect(evaluateAppreciation([...week, { status: 'LEAVE', flags: ['UNEXCUSED'] }], { criteria, minWorkedDays: 5 }).qualified).toBe(true);
    expect(isAppreciationDue(DateTime.fromISO('2026-10-22T14:05', { zone: MUSCAT }), { weekday: 4, hour: 14 })).toBe(true); // Thursday
    expect(isAppreciationDue(DateTime.fromISO('2026-10-22T13:59', { zone: MUSCAT }), { weekday: 4, hour: 14 })).toBe(false);
    expect(isAppreciationDue(DateTime.fromISO('2026-10-25T14:05', { zone: MUSCAT }), { weekday: 0, hour: 14 })).toBe(true); // Sunday
  });
});

describe('late arrival, early departure and absence (the recompute hook + the sweep)', () => {
  const O1 = O.alerts;
  it('the first recompute that makes today LATE tells the employee and their direct manager — once', async () => {
    clock = at(TODAY, '08:40');
    await punch(O1.org, O1.branch, E.late, TODAY, '08:25', 'PUNCH_IN');
    await recompute(O1.org, E.late, TODAY);
    const late = await events('attendance.late_arrival', O1.org);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ employeeId: E.late, employeeName: 'Emp LATE', attendanceDate: TODAY, minutes: 15, firstInAt: at(TODAY, '08:25').toISOString(), expectedStartAt: at(TODAY, '08:00').toISOString() });
    expect(sorted(late[0]!['userIds'] as string[])).toEqual(sorted([U.late!, U.boss!]));
    // recomputes repeat (a repeated punch collapsed as a duplicate changes the record, the sweep): the day was told once
    clock = at(TODAY, '08:50');
    await punch(O1.org, O1.branch, E.late, TODAY, '08:25:30', 'PUNCH_IN');
    await recompute(O1.org, E.late, TODAY);
    const rec = await a().selectFrom('attendanceDailyRecords').select(['calculationVersion', 'flags']).where('employeeId', '=', E.late).executeTakeFirstOrThrow();
    expect(rec.calculationVersion).toBe(2);
    expect(rec.flags).toContain('LATE');
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.late_arrival', O1.org)).toHaveLength(1);
    const ledger = await a().selectFrom('attendanceAlerts').select(['kind', 'recipients']).where('employeeId', '=', E.late).execute();
    expect(ledger).toEqual([{ kind: 'LATE_ARRIVAL', recipients: 2 }]);
  });

  it('a historical recalculation never alerts (a late day of last week)', async () => {
    clock = at(TODAY, '09:00');
    await punch(O1.org, O1.branch, E.history, '2026-10-14', '09:30', 'PUNCH_IN');
    await punch(O1.org, O1.branch, E.history, '2026-10-14', '17:00', 'PUNCH_OUT');
    await recompute(O1.org, E.history, '2026-10-14');
    const rec = await a().selectFrom('attendanceDailyRecords').select(['flags']).where('employeeId', '=', E.history).executeTakeFirstOrThrow();
    expect(rec.flags).toContain('LATE');
    await runAttendanceAlerts(h.deps, O1.org);
    expect((await events('attendance.late_arrival', O1.org)).filter((e) => e.employeeId === E.history)).toEqual([]);
    expect(await a().selectFrom('attendanceAlerts').select('kind').where('employeeId', '=', E.history).execute()).toEqual([]);
  });

  it('nothing for an employee without a login or a terminated one (the day is settled, nobody is told)', async () => {
    clock = at(TODAY, '09:10');
    await punch(O1.org, O1.branch, E.noLogin, TODAY, '08:30', 'PUNCH_IN');
    await punch(O1.org, O1.branch, E.terminated, TODAY, '08:30', 'PUNCH_IN');
    await recompute(O1.org, E.noLogin, TODAY);
    await recompute(O1.org, E.terminated, TODAY);
    const late = await events('attendance.late_arrival', O1.org);
    expect(late.map((e) => e.employeeId)).toEqual([E.late]);
    const settled = await a().selectFrom('attendanceAlerts').select(['employeeId', 'recipients']).where('employeeId', 'in', [E.noLogin, E.terminated]).orderBy('employeeId').execute();
    expect(settled).toEqual(sorted([E.noLogin, E.terminated]).map((employeeId) => ({ employeeId, recipients: 0 })));
  });

  it('the settings decide who hears it and from how many minutes', async () => {
    await settings(O1.org, { notifications: { lateArrivalAlert: { notifyManager: false, minMinutes: 30 } }, attendance: { unexcused: { excuseDeadlineDays: 3, autoDeductEnabled: true } } });
    clock = at(TODAY, '09:20');
    await punch(O1.org, O1.branch, E.quiet, TODAY, '08:20', 'PUNCH_IN'); // 10 minutes late after the grace: below 30
    await recompute(O1.org, E.quiet, TODAY);
    expect((await events('attendance.late_arrival', O1.org)).filter((e) => e.employeeId === E.quiet)).toEqual([]);
    expect(await a().selectFrom('attendanceAlerts').select('kind').where('employeeId', '=', E.quiet).execute()).toEqual([]);
    await settings(O1.org, { notifications: { lateArrivalAlert: { notifyManager: false, minMinutes: 5 } }, attendance: { unexcused: { excuseDeadlineDays: 3, autoDeductEnabled: true } } });
    await runAttendanceAlerts(h.deps, O1.org); // the sweep catches up a day the switch now covers
    const quiet = (await events('attendance.late_arrival', O1.org)).filter((e) => e.employeeId === E.quiet);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!['userIds']).toEqual([U.quiet]);
  });

  it('an early departure is told once the day is judged and its scheduled end has passed — never for a lunch-break check-out', async () => {
    clock = at(TODAY, '15:30');
    await punch(O1.org, O1.branch, E.early, TODAY, '07:55', 'PUNCH_IN');
    await punch(O1.org, O1.branch, E.early, TODAY, '15:00', 'PUNCH_OUT');
    await recompute(O1.org, E.early, TODAY);
    const rec = await a().selectFrom('attendanceDailyRecords').select(['status', 'flags', 'earlyDepartureMinutes']).where('employeeId', '=', E.early).executeTakeFirstOrThrow();
    expect(rec.flags).toContain('EARLY_DEPARTURE');
    expect(rec.status).not.toBe('PENDING');
    expect(await events('attendance.early_departure', O1.org)).toEqual([]); // 17:00 has not come
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.early_departure', O1.org)).toEqual([]);
    clock = at(TODAY, '17:10');
    await runAttendanceAlerts(h.deps, O1.org);
    const early = await events('attendance.early_departure', O1.org);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ employeeId: E.early, attendanceDate: TODAY, minutes: rec.earlyDepartureMinutes, lastOutAt: at(TODAY, '15:00').toISOString(), expectedEndAt: at(TODAY, '17:00').toISOString() });
    expect(sorted(early[0]!['userIds'] as string[])).toEqual(sorted([U.early!, U.boss!]));
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.early_departure', O1.org)).toHaveLength(1);
  });

  it('a working day judged ABSENT tells the employee and the manager with the excuse deadline and the possible deduction', async () => {
    clock = at(TODAY, '00:45');
    await recompute(O1.org, E.absent, YESTERDAY);
    const absence = await events('attendance.absence_recorded', O1.org);
    expect(absence).toHaveLength(1);
    expect(absence[0]).toMatchObject({ employeeId: E.absent, attendanceDate: YESTERDAY, deadline: '2026-10-21', payEffectDays: 1 });
    expect(sorted(absence[0]!['userIds'] as string[])).toEqual(sorted([U.absent!, U.boss!]));
    await recompute(O1.org, E.absent, YESTERDAY);
    clock = at(TODAY, '09:30');
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.absence_recorded', O1.org)).toHaveLength(1);
    // an absence of last week (a backfill) is never announced
    await recompute(O1.org, E.absent, '2026-10-14');
    expect(await events('attendance.absence_recorded', O1.org)).toHaveLength(1);
  });

  it('the relay writes the employee\'s own notice in their language and the manager\'s with the employee\'s name and the register link', async () => {
    await relay();
    const rows = await a().selectFrom('notifications').select(['userId', 'type', 'title', 'body', 'link', 'category']).where('organizationId', '=', O1.org).orderBy('createdAt').execute();
    const own = rows.find((r) => r.type === 'attendance.late_arrival' && r.userId === U.late)!;
    expect(own.category).toBe('ATTENDANCE');
    expect(own.link).toBe(`/my/attendance?date=${TODAY}`);
    expect(own.title).toMatch(/[؀-ۿ]/);
    const boss = rows.find((r) => r.type === 'attendance.late_arrival' && r.userId === U.boss)!;
    expect(boss.title).toBe('Emp LATE arrived late (19 Oct 2026)');
    expect(boss.body).toBe('15 minutes late · Checked in at 08:25 · Shift started at 08:00');
    expect(boss.link).toBe(`/attendance?employeeId=${E.late}&date=${TODAY}`);
    const absent = rows.find((r) => r.type === 'attendance.absence_recorded' && r.userId === U.absent)!;
    expect(absent.title).toBe('You were absent on 18 Oct 2026');
    expect(absent.body).toBe('No attendance was recorded for the day · Give a reason by 21 Oct 2026 so that your manager can review it · One day may be deducted per the attendance policy if the day stays unexplained');
    const early = rows.find((r) => r.type === 'attendance.early_departure' && r.userId === U.early)!;
    expect(early.title).toBe('You left early (19 Oct 2026)');
  });

  it('the day before the deadline, an absence still unexplained is reminded once — not a day with a reason given', async () => {
    // deadline 2 days after the date: the reminder for yesterday's absence is due today (deadline tomorrow)
    await settings(O1.org, { attendance: { unexcused: { excuseDeadlineDays: 2 } } });
    await recompute(O1.org, E.quiet, YESTERDAY); // no punches: absent too
    await a().insertInto('attendanceNotes').values({ organizationId: O1.org, employeeId: E.quiet, branchId: O1.branch, attendanceDate: YESTERDAY, category: 'absence_reason', note: 'Clinic visit', status: 'pending', submittedBy: U.quiet }).execute();
    clock = at(TODAY, '08:59');
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.absence_reminder', O1.org)).toEqual([]); // not before 09:00
    clock = at(TODAY, '09:05');
    const res = await runAttendanceAlerts(h.deps, O1.org);
    expect(res.absenceReminders).toBe(1);
    const reminders = await events('attendance.absence_reminder', O1.org);
    expect(reminders).toEqual([expect.objectContaining({ employeeId: E.absent, attendanceDate: YESTERDAY, deadline: '2026-10-20', userIds: [U.absent] })]);
    await runAttendanceAlerts(h.deps, O1.org);
    expect(await events('attendance.absence_reminder', O1.org)).toHaveLength(1);
    // switched off: nothing
    await settings(O1.org, { notifications: { absenceReminder: false }, attendance: { unexcused: { excuseDeadlineDays: 1 } } });
    clock = at(TODAY, '10:00');
    expect((await runAttendanceAlerts(h.deps, O1.org)).absenceReminders).toBe(0);
  });
});

describe('missing check-in reminder', () => {
  const O2 = O.missing;
  const reminders = () => events('punch.missing_in', O2.org);
  beforeAll(async () => {
    await punch(O2.org, O2.branch, E.mPunched, TODAY, '07:55', 'PUNCH_IN');
    const lt = (await a().insertInto('leaveTypes').values({ organizationId: O2.org, code: 'AL', name: 'Annual' }).returning('id').executeTakeFirstOrThrow()).id;
    await a().insertInto('leaveRecords').values({ organizationId: O2.org, employeeId: E.mLeave, leaveTypeId: lt, startDate: TODAY, endDate: TODAY, status: 'APPROVED' }).execute();
  });

  it('is off by default', async () => {
    clock = at(TODAY, '08:45');
    const res = await runAttendanceAlerts(h.deps, O2.org);
    expect(res.missingCheckIn).toMatchObject({ candidates: 0, reminded: 0 });
    expect(await reminders()).toEqual([]);
  });

  it('reminds once, the configured minutes after the shift start, only who has not punched and is not on leave; the manager too when asked', async () => {
    await settings(O2.org, { notifications: { missingCheckInReminder: true, missingCheckInReminderMinutes: 30, missingCheckInNotifyManager: true } });
    clock = at(TODAY, '08:29');
    expect((await runAttendanceAlerts(h.deps, O2.org)).missingCheckIn.reminded).toBe(0);
    clock = at(TODAY, '08:31');
    const res = await runAttendanceAlerts(h.deps, O2.org);
    expect(res.missingCheckIn).toMatchObject({ reminded: 2, onLeave: 1, punched: 1 }); // mNone and the manager themselves (no punch either)
    const sent = await reminders();
    const none = sent.find((e) => e.employeeId === E.mNone)!;
    expect(none).toMatchObject({ attendanceDate: TODAY, expectedStartAt: at(TODAY, '08:00').toISOString(), minutes: 30 });
    expect(sorted(none['userIds'] as string[])).toEqual(sorted([U.mNone!, U.mBoss!]));
    expect(sent.map((e) => e.employeeId).sort()).toEqual(sorted([E.mNone, E.mBoss]));
    clock = at(TODAY, '08:46');
    expect((await runAttendanceAlerts(h.deps, O2.org)).missingCheckIn.reminded).toBe(0);
    expect(await reminders()).toHaveLength(2);
  });

  it('the relay links the employee to their check-in card and the manager to the register', async () => {
    await relay();
    const rows = await a().selectFrom('notifications').select(['userId', 'title', 'link']).where('organizationId', '=', O2.org).where('type', '=', 'punch.missing_in').execute();
    const own = rows.find((r) => r.userId === U.mNone)!;
    expect(own).toMatchObject({ title: 'You have not checked in yet (19 Oct 2026)', link: '/my' });
    expect(rows.find((r) => r.userId === U.mBoss && r.link !== '/my')).toMatchObject({ title: 'Emp MNONE has not checked in yet (19 Oct 2026)', link: `/attendance?employeeId=${E.mNone}&date=${TODAY}` });
  });

  it('a reminder that would come more than three hours late is not sent', async () => {
    await a().deleteFrom('attendanceAlerts').where('organizationId', '=', O2.org).execute();
    clock = at(TODAY, '11:31');
    const res = await runAttendanceAlerts(h.deps, O2.org);
    expect(res.missingCheckIn).toMatchObject({ reminded: 0 });
    expect(res.missingCheckIn.stale).toBeGreaterThan(0);
  });
});

describe('weekly appreciation', () => {
  const O3 = O.thanks;
  const day = async (employeeId: string, date: string, status: string, flags: string[] = []) =>
    a().insertInto('attendanceDailyRecords').values({ organizationId: O3.org, employeeId, attendanceDate: date, branchId: O3.branch, timezone: MUSCAT, engineVersion: 'test', status: status as never, flags, trace: JSON.stringify({}) }).execute();
  const thanks = () => events('attendance.appreciation', O3.org);
  // Thursday 22 Oct 2026 reviews Thu 15 … Wed 21 (Fri 16 and Sat 17 are weekly offs)
  const THURSDAY = '2026-10-22';
  const WEEK = ['2026-10-15', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'];
  beforeAll(async () => {
    for (const id of [E.good, E.goodNoLogin, E.goodAr, E.lateOnce]) for (const d of WEEK) await day(id, d, 'PRESENT', id === E.lateOnce && d === '2026-10-20' ? ['LATE'] : []);
    for (const id of [E.good, E.goodAr]) for (const d of ['2026-10-16', '2026-10-17']) await day(id, d, 'WEEKLY_OFF');
    for (const d of WEEK.slice(0, 3)) await day(E.few, d, 'PRESENT');
    for (const d of WEEK.slice(3)) await day(E.few, d, 'LEAVE');
  });

  it('is off by default; enabled, it waits for the configured weekday and hour', async () => {
    clock = at(THURSDAY, '14:05');
    expect(await runAppreciation(h.deps, O3.org)).toMatchObject({ skipped: 'disabled', sent: 0 });
    await settings(O3.org, { notifications: { appreciation: { enabled: true, weekday: 4, hour: 14, messageEn: 'Thank you, team!', messageAr: 'شكرًا يا فريق!' } } });
    clock = at(THURSDAY, '13:59');
    expect(await runAppreciation(h.deps, O3.org)).toMatchObject({ skipped: 'not_due' });
    clock = at('2026-10-21', '14:05'); // Wednesday
    expect(await runAppreciation(h.deps, O3.org)).toMatchObject({ skipped: 'not_due' });
    expect(await thanks()).toEqual([]);
  });

  it('thanks every committed employee with a login once — never one late once, one with too few days, one without a login', async () => {
    clock = at(THURSDAY, '14:05');
    const res = await runAppreciation(h.deps, O3.org);
    expect(res).toMatchObject({ periodStart: '2026-10-15', periodEnd: '2026-10-21', sent: 2, disqualified: 1, tooFewDays: 1 });
    const sent = await thanks();
    expect(sent.map((e) => e.employeeId).sort()).toEqual(sorted([E.good, E.goodAr]));
    expect(sent.find((e) => e.employeeId === E.good)).toMatchObject({ periodStart: '2026-10-15', periodEnd: '2026-10-21', workedDays: 5, message: 'Thank you, team!', messageAr: 'شكرًا يا فريق!', userIds: [U.good] });
    // a later hour the same day, the hourly job, and an admin's "Send now": nobody is thanked twice for the week
    clock = at(THURSDAY, '15:05');
    expect(await runAppreciation(h.deps, O3.org)).toMatchObject({ skipped: 'done' });
    await appreciationHandler(ctx(ATTENDANCE_APPRECIATION_JOB_TYPE, {}));
    const now = await appreciationHandler(ctx(ATTENDANCE_APPRECIATION_JOB_TYPE, { organizationId: O3.org, force: true, requestedBy: U.good }));
    expect(now).toMatchObject({ organizations: 1, sent: 0, errors: 0 });
    // "Send now" two days later reviews an overlapping week (Sat 17 … Fri 23, five days worked again): still once per week
    for (const id of [E.good, E.goodAr]) await day(id, THURSDAY, 'PRESENT');
    clock = at('2026-10-24', '10:00');
    expect(await runAppreciation(h.deps, O3.org, { force: true })).toMatchObject({ sent: 0, alreadyThanked: 2 });
    expect(await thanks()).toHaveLength(2);
    const audit = await a().selectFrom('audit.logs').select(['action', 'actorType']).where('organizationId', '=', O3.org).where('action', '=', 'attendance.appreciation_sent').execute();
    expect(audit).toEqual([{ action: 'attendance.appreciation_sent', actorType: 'SYSTEM' }]);
  });

  it('the relay writes the organisation\'s message in the recipient\'s language', async () => {
    await relay();
    const rows = await a().selectFrom('notifications').select(['userId', 'title', 'body', 'link']).where('organizationId', '=', O3.org).where('type', '=', 'attendance.appreciation').execute();
    expect(rows.find((r) => r.userId === U.good)).toMatchObject({ title: 'Thank you for a great week!', body: 'Thank you, team! · Days worked: 5 (15 Oct 2026 → 21 Oct 2026)', link: '/my/attendance' });
    const ar = rows.find((r) => r.userId === U.goodAr)!;
    expect(ar.body).toContain('شكرًا يا فريق!');
    expect(ar.body).not.toContain('Thank you, team!');
  });
});

describe('scheduler', () => {
  it('enqueues one deduped alerts job every quarter hour and one appreciation job every hour', async () => {
    const tasks = notificationTasks.filter((t) => t.name === 'attendance.alerts' || t.name === 'attendance.appreciation');
    expect(tasks.map((t) => [t.name, t.everyMs])).toEqual([['attendance.alerts', 15 * 60_000], ['attendance.appreciation', 3_600_000]]);
    for (const t of tasks) { await t.run(h.deps); await t.run(h.deps); }
    const jobs = await a().selectFrom('jobs.queue').select(['jobType', 'dedupeKey']).where('jobType', 'in', [ATTENDANCE_ALERTS_JOB_TYPE, ATTENDANCE_APPRECIATION_JOB_TYPE]).where('status', '=', 'pending').orderBy('jobType').execute();
    expect(jobs).toEqual([{ jobType: ATTENDANCE_ALERTS_JOB_TYPE, dedupeKey: 'attendance-alerts' }, { jobType: ATTENDANCE_APPRECIATION_JOB_TYPE, dedupeKey: 'attendance-appreciation' }]);
  });
  it('the alerts job walks every active organisation and isolates failures', async () => {
    clock = at(TODAY, '12:00');
    const res = await attendanceAlertsHandler(ctx(ATTENDANCE_ALERTS_JOB_TYPE, {}));
    expect(res).toMatchObject({ errors: 0 });
    expect(res.organizations).toBeGreaterThanOrEqual(3);
  });
});

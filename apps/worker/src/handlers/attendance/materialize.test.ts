import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { attendanceSummaryRows, withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { materializeHandler, MATERIALIZE_JOB_TYPE } from './materialize.js';
import { enqueueRecalculationForScope, recalculateRange } from './recalculate.js';
import { attendanceTasks } from './tasks.js';

/*
 * The 2026-10-02 field report, bug 3: "Attendance → 01 Oct → TEST016 shows Absent with No shift; the monthly summary for K Kumar
 * (joined 01 Sep, shift only from 29 Sep) shows 0 weekly off and 0.5 absent, so the other days are missing from every column."
 * Days nobody recomputed had no record. The materialisation sweep gives every employed day one, by the one rule for a day
 * without a shift (judged like any working day: no punches → ABSENT with NO_SHIFT), so the summary adds up.
 */
const ORG = '0b000000-0000-4000-a000-000000000001';
const BRANCH = '0b000000-0000-4000-a000-00000000000a';
const CAL = '0b000000-0000-4000-a000-0000000000c1';
const FLEX = '0b000000-0000-4000-a000-0000000000f1';
const EA = '0b000000-0000-4000-a000-0000000000a1'; // a flexible shift from Monday 7 Sep only, punched on the 7th
const EB = '0b000000-0000-4000-a000-0000000000b1'; // no shift at all (K Kumar before his assignment)
const EC = '0b000000-0000-4000-a000-0000000000c2'; // suspended: never given absences automatically
const ED = '0b000000-0000-4000-a000-0000000000d1'; // joined Tuesday 8 Sep
const EF = '0b000000-0000-4000-a000-0000000000f2'; // left on Saturday 5 Sep
const EG = '0b000000-0000-4000-a000-0000000000a7'; // a stale PENDING record on Sunday 6 Sep
const MUSCAT = 'Asia/Muscat';
/** Thursday 2026-09-10, 10:00 Muscat. The sweep covers the seven days before: Thu 3 … Wed 9 Sep. */
const NOW = new Date('2026-09-10T06:00:00Z');
const ASOF = '2026-09-10';

let h: TestHarness;
const at = (date: string, time: string): Date => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
const run = (payload: Record<string, unknown> = {}) => materializeHandler({ job: fakeJob(MATERIALIZE_JOB_TYPE, { organizationId: ORG, asOf: ASOF, lookbackDays: 7, ...payload }, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const days = async (employeeId: string) => (await h.tdb.adminDb.selectFrom('attendanceDailyRecords').select(['attendanceDate', 'status', 'flags', 'workedMinutes']).where('employeeId', '=', employeeId).orderBy('attendanceDate').execute())
  .map((r) => ({ date: DateTime.fromJSDate(r.attendanceDate).toISODate(), status: r.status, noShift: r.flags.includes('NO_SHIFT'), worked: r.workedMinutes }));

beforeAll(async () => {
  h = await createHarness(`flowza_worker_mat_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'MAT', legalName: 'Mat', displayName: 'Mat', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('holidayCalendars').values({ id: CAL, organizationId: ORG, name: 'Oman', countryCode: 'OM', isDefault: true }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT, holidayCalendarId: CAL }).execute();
  await a.insertInto('holidays').values({ organizationId: ORG, calendarId: CAL, name: 'Test Holiday', date: '2026-09-08', type: 'PUBLIC' }).execute();
  await a.insertInto('shifts').values({ id: FLEX, organizationId: ORG, code: 'FLEX8', name: 'Flexible 8h', type: 'FLEXIBLE', requiredMinutes: 480, dayBoundary: '00:00', breaks: JSON.stringify([]) }).execute();
  const emp = (id: string, n: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: n, customFields: JSON.stringify({}), ...extra });
  await a.insertInto('employees').values([
    emp(EA, '1'), emp(EB, '2'), emp(EC, '3', { employmentStatus: 'suspended' }), emp(ED, '4', { joiningDate: '2026-09-08' }),
    emp(EF, '5', { exitDate: '2026-09-05', employmentStatus: 'terminated' }), emp(EG, '6'),
  ]).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'EMPLOYEE', targetId: EA, branchId: BRANCH, shiftId: FLEX, effectiveFrom: '2026-09-07' }).execute();
  await a.insertInto('attendanceEvents').values([
    { organizationId: ORG, employeeId: EA, branchId: BRANCH, punchedAt: at('2026-09-07', '08:00'), eventType: 'PUNCH_IN', source: 'DEVICE' },
    { organizationId: ORG, employeeId: EA, branchId: BRANCH, punchedAt: at('2026-09-07', '16:00'), eventType: 'PUNCH_OUT', source: 'DEVICE' },
  ]).execute();
  await a.insertInto('attendanceDailyRecords').values({ organizationId: ORG, employeeId: EG, attendanceDate: '2026-09-06', branchId: BRANCH, timezone: MUSCAT, engineVersion: 'test', status: 'PENDING' }).execute();
});
afterAll(async () => { await h?.close(); });

describe('ATTENDANCE_MATERIALIZE_DAYS', () => {
  it('gives every employed day of the window a record, a day without a shift judged like any working day', async () => {
    const res = await run();
    expect(res).toMatchObject({ fromDate: '2026-09-03', toDate: '2026-09-09', errors: 0, capped: false });
    // no shift at all: absences carry NO_SHIFT; weekly offs and the holiday do not depend on the shift
    expect(await days(EB)).toEqual([
      { date: '2026-09-03', status: 'ABSENT', noShift: true, worked: 0 },
      { date: '2026-09-04', status: 'WEEKLY_OFF', noShift: true, worked: 0 },
      { date: '2026-09-05', status: 'WEEKLY_OFF', noShift: true, worked: 0 },
      { date: '2026-09-06', status: 'ABSENT', noShift: true, worked: 0 },
      { date: '2026-09-07', status: 'ABSENT', noShift: true, worked: 0 },
      { date: '2026-09-08', status: 'HOLIDAY', noShift: true, worked: 0 },
      { date: '2026-09-09', status: 'ABSENT', noShift: true, worked: 0 },
    ]);
    const ea = await days(EA);
    expect(ea.find((d) => d.date === '2026-09-03')).toMatchObject({ status: 'ABSENT', noShift: true });
    expect(ea.find((d) => d.date === '2026-09-07')).toMatchObject({ status: 'PRESENT', noShift: false, worked: 480 });
    expect(ea.find((d) => d.date === '2026-09-09')).toMatchObject({ status: 'ABSENT', noShift: false });
  });

  it('respects employment: joining and exit dates, and nobody suspended is given absences', async () => {
    expect((await days(ED)).map((d) => d.date)).toEqual(['2026-09-08', '2026-09-09']);
    expect((await days(EF)).map((d) => d.date)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
    expect(await days(EC)).toEqual([]);
  });

  it('judges a stale PENDING day and leaves calculated days alone on the next run', async () => {
    expect((await days(EG)).find((d) => d.date === '2026-09-06')).toMatchObject({ status: 'ABSENT' });
    const again = await run();
    expect(again).toMatchObject({ pairs: 0, created: 0, updated: 0 });
  });

  it('makes the monthly summary add up: every day of employment in exactly one column, the uncalculated ones shown', async () => {
    const rows = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => attendanceSummaryRows(trx, ORG, { from: '2026-09-01', to: '2026-09-30', asOf: ASOF }, { employeeBranchIds: null, recordBranchIds: null, departmentId: null, employeeIds: [EB, EA], search: null, includeFinalized: false }, null));
    const eb = rows.find((r) => r.employeeId === EB)!;
    // 1–9 Sep employed and expected (today, the 10th, is not): 7 calculated by the sweep, 1–2 Sep never calculated
    expect(eb).toMatchObject({ absentDays: 4, weeklyOffDays: 2, holidayDays: 1, presentDays: 0, missingPunchDays: 0, notCalculatedDays: 2 });
    const sum = (r: typeof eb) => r.presentDays + r.absentDays + r.leaveDays + r.missingPunchDays + r.holidayDays + r.weeklyOffDays + r.pendingDays + r.notCalculatedDays;
    expect(sum(eb)).toBe(9);
    const ea = rows.find((r) => r.employeeId === EA)!;
    expect(ea).toMatchObject({ presentDays: 1, daysWorked: 1, workedMinutes: 480 });
    expect(sum(ea)).toBe(9);
  });
});

describe('a joining date moved back (bug 1: TEST020 stayed "Not joined" for September)', () => {
  const EJ = '0b000000-0000-4000-a000-0000000000e9';
  const summaryOf = async () => (await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => attendanceSummaryRows(trx, ORG, { from: '2026-09-01', to: '2026-09-30', asOf: ASOF }, { employeeBranchIds: null, recordBranchIds: null, departmentId: null, employeeIds: [EJ], search: null, includeFinalized: false }, null)))[0]!;
  const recalc = async (fromDate: string, toDate: string) => {
    const { requestId } = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => enqueueRecalculationForScope(trx, h.deps.queue, { organizationId: ORG, fromDate, toDate, employeeIds: [EJ], reason: 'test' }));
    return recalculateRange({ job: fakeJob('RECALCULATE_RANGE', { organizationId: ORG, requestId }, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
  };

  beforeAll(async () => {
    await h.tdb.adminDb.insertInto('employees').values({ id: EJ, organizationId: ORG, employeeNumber: '9', firstName: 'F', lastName: '9', displayName: 'F 9', joiningDate: '2026-09-08', branchId: BRANCH, deviceUserId: '9', customFields: JSON.stringify({}) }).execute();
    await recalc('2026-09-01', '2026-09-09'); // calculated while the joining date was the 8th: 1–7 Sep are NOT_JOINED
  });

  it('recalculating the days between the old and the new date brings them into the monthly summary', async () => {
    expect(await summaryOf()).toMatchObject({ absentDays: 1, holidayDays: 1, weeklyOffDays: 0, notCalculatedDays: 0 });
    await h.tdb.adminDb.updateTable('employees').set({ joiningDate: '2026-09-01' }).where('id', '=', EJ).execute();
    // until they are recalculated, the "not joined" days are shown as not calculated rather than silently dropped
    expect(await summaryOf()).toMatchObject({ notCalculatedDays: 7 });
    // what PATCH /employees/:id now queues for a joining date moved from the 8th to the 1st (employmentDatesRecalcRange)
    await recalc('2026-09-01', '2026-09-08');
    const s = await summaryOf();
    expect(s).toMatchObject({ absentDays: 6, weeklyOffDays: 2, holidayDays: 1, notCalculatedDays: 0 });
    expect(s.presentDays + s.absentDays + s.leaveDays + s.missingPunchDays + s.holidayDays + s.weeklyOffDays + s.pendingDays + s.notCalculatedDays).toBe(9);
  });
});

describe('a reader who sees some branches only (a transfer during the month is not "not calculated")', () => {
  const ET = '0b000000-0000-4000-a000-0000000000e7';
  const BRANCH_2 = '0b000000-0000-4000-a000-00000000000b';
  const summaryOf = async (scope: { recordBranchIds: string[] | null; visibleBranchIds?: string[] | null }) => (await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => attendanceSummaryRows(trx, ORG, { from: '2026-09-01', to: '2026-09-30', asOf: ASOF }, { employeeBranchIds: null, departmentId: null, employeeIds: [ET], search: null, includeFinalized: false, ...scope }, null)))[0]!;

  beforeAll(async () => {
    const a = h.tdb.adminDb;
    await a.insertInto('branches').values({ id: BRANCH_2, organizationId: ORG, code: 'SLL', name: 'Salalah', timezone: MUSCAT, holidayCalendarId: CAL }).execute();
    await a.insertInto('employees').values({ id: ET, organizationId: ORG, employeeNumber: '7', firstName: 'F', lastName: '7', displayName: 'F 7', joiningDate: '2025-01-01', branchId: BRANCH_2, deviceUserId: '7', customFields: JSON.stringify({}) }).execute();
    // Muscat until Sunday 6 Sep, Salalah from Monday 7 Sep (half-open history, as a transfer writes it)
    await a.insertInto('employmentHistory').values([
      { organizationId: ORG, employeeId: ET, branchId: BRANCH, effectiveFrom: '2025-01-01', effectiveTo: '2026-09-07', employmentStatus: 'active', employmentType: 'full_time' },
      { organizationId: ORG, employeeId: ET, branchId: BRANCH_2, effectiveFrom: '2026-09-07', effectiveTo: null, employmentStatus: 'active', employmentType: 'full_time' },
    ]).execute();
    // every day of 1–9 Sep calculated, each in the branch the employee belonged to on that day — except Wednesday 2 Sep
    const dates = ['2026-09-01', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09'];
    await a.insertInto('attendanceDailyRecords').values(dates.map((d) => ({ organizationId: ORG, employeeId: ET, attendanceDate: d, branchId: d < '2026-09-07' ? BRANCH : BRANCH_2, timezone: MUSCAT, engineVersion: 'test', status: 'ABSENT' }))).execute();
  });

  it('expects only the days the reader can see, so only the real gap counts', async () => {
    // every branch: 9 days expected, 8 calculated → the 2nd
    expect(await summaryOf({ recordBranchIds: null })).toMatchObject({ absentDays: 8, notCalculatedDays: 1 });
    // a Salalah-only reader (the API passes the caller's RLS scope): the Muscat days are neither shown nor expected
    expect(await summaryOf({ recordBranchIds: null, visibleBranchIds: [BRANCH_2] })).toMatchObject({ notCalculatedDays: 0 });
    // the worker's report filters the days explicitly: same rule, the 2nd (Muscat) is not the Salalah reader's gap
    expect(await summaryOf({ recordBranchIds: [BRANCH_2] })).toMatchObject({ absentDays: 3, notCalculatedDays: 0 });
    // a Muscat-only reader sees the Muscat days, the 2nd among them
    expect(await summaryOf({ recordBranchIds: [BRANCH] })).toMatchObject({ absentDays: 5, notCalculatedDays: 1 });
  });
});

describe('scheduler', () => {
  it('enqueues one materialisation per active organisation, deduplicated while one is pending', async () => {
    const task = attendanceTasks.find((t) => t.name === 'attendance.materialize')!;
    await task.run(h.deps as never);
    await task.run(h.deps as never);
    const jobs = await sql<{ n: number }>`select count(*)::int as n from jobs.queue where job_type = ${MATERIALIZE_JOB_TYPE} and organization_id = ${ORG}::uuid and status = 'pending'`.execute(h.tdb.adminDb);
    expect(jobs.rows[0]?.n).toBe(1);
  });
});

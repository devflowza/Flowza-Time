import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { resolveAttendanceSettings } from '@flowza/contracts';
import { createTestDatabase, type TestDatabase } from '../testing/index.js';
import { withContext, type Trx } from '../context.js';
import { PgJobQueue } from '../queue.js';
import { effectiveBranchIdOn } from '../employees/effective-branch.js';
import { loadDailyInputs } from '../attendance/load-inputs.js';
import { loadEmployeeWorkingCalendars } from '../attendance/working-calendar.js';
import { chargeUnexcusedDay } from '../attendance/pay-effect.js';
import { loadLeaveBalances, loadWorkingCalendars } from './balances.js';
import { compOffCoverage, compOffLeaveDemand, consumeCompOffCredits } from './comp-off.js';

/**
 * Leave v2 review fixes in the database layer (docs/hr-portal/reviews/07-leave-v2-review.md): THE per-date working calendar
 * shared by the attendance input loader and leave (7-P1-1 rotation off days, 7-P1-2 transfers, stored days in balances),
 * the shared placement helper, comp-off credits matched against each leave date (7-P2-4) and the charger's applicability
 * (7-P1-3).
 */
const ORG = '0c000000-0000-0000-0000-000000000000';
const BX = '0c000000-0000-0000-0000-0000000000b1'; // Fri + Sat off
const BY = '0c000000-0000-0000-0000-0000000000b2'; // Thu + Fri off
const E = { mover: '0c000000-0000-0000-0000-0000000000e1', rota: '0c000000-0000-0000-0000-0000000000e2', woman: '0c000000-0000-0000-0000-0000000000e3' };
const TYPE = { al: '0c000000-0000-0000-0000-0000000000a1', mo: '0c000000-0000-0000-0000-0000000000a2', co: '0c000000-0000-0000-0000-0000000000a3' };
const HOLIDAY_CAL_Y = '0c000000-0000-0000-0000-0000000000c1';
let tdb: TestDatabase;
const sys = <T>(fn: (trx: Trx) => Promise<T>) => withContext(tdb.workerDb, { kind: 'system', organizationId: ORG }, fn);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const dates = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbpkg_leaverev_${process.pid}`);
  const a = tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DBT-LR', legalName: 'LR', displayName: 'LR', timezone: 'Asia/Muscat', weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('holidayCalendars').values({ id: HOLIDAY_CAL_Y, organizationId: ORG, name: 'Branch Y' }).execute();
  await a.insertInto('branches').values([
    { id: BX, organizationId: ORG, code: 'X', name: 'X', timezone: 'Asia/Muscat', weeklyOffDays: [5, 6] },
    { id: BY, organizationId: ORG, code: 'Y', name: 'Y', timezone: 'Asia/Muscat', weeklyOffDays: [4, 5], holidayCalendarId: HOLIDAY_CAL_Y },
  ]).execute();
  // a holiday of branch Y's calendar in May (when the mover was still in X: not theirs) and in August (theirs)
  await a.insertInto('holidays').values([
    { organizationId: ORG, calendarId: HOLIDAY_CAL_Y, name: 'Y May', date: '2026-05-05' },
    { organizationId: ORG, calendarId: HOLIDAY_CAL_Y, name: 'Y August', date: '2026-08-04' },
  ]).execute();
  const emp = (id: string, n: number, branchId: string, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, branchId, employeeNumber: `LR${n}`, firstName: `F${n}`, lastName: `L${n}`, displayName: `Employee ${n}`, joiningDate: '2024-01-01', deviceUserId: String(900 + n), ...extra });
  await a.insertInto('employees').values([emp(E.mover, 1, BY), emp(E.rota, 2, BX), emp(E.woman, 3, BX, { gender: 'female' })]).execute();
  const hist = (employeeId: string, branchId: string, from: string, to: string | null) => ({ organizationId: ORG, employeeId, branchId, effectiveFrom: from, effectiveTo: to, employmentType: 'full_time' as const, employmentStatus: 'active' as const });
  await a.insertInto('employmentHistory').values([hist(E.mover, BX, '2024-01-01', '2026-07-01'), hist(E.mover, BY, '2026-07-01', null), hist(E.rota, BX, '2024-01-01', null), hist(E.woman, BX, '2024-01-01', null)]).execute();
  // the rota: Sun–Wed on, Thu–Sat off (anchor Sunday 4 Jan 2026)
  const shift = await a.insertInto('shifts').values({ organizationId: ORG, code: 'ROT', name: 'Rota', type: 'FIXED', startTime: '08:00', endTime: '16:00' }).returning('id').executeTakeFirstOrThrow();
  const pattern = await a.insertInto('shiftPatterns').values({ organizationId: ORG, code: 'SWTS', name: 'Sun–Wed', cycleLengthDays: 7, anchorDate: '2026-01-04', sequence: JSON.stringify([0, 1, 2, 3].map((day) => ({ day, shift_id: shift.id })).concat([4, 5, 6].map((day) => ({ day, off: true }) as never))) }).returning('id').executeTakeFirstOrThrow();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'EMPLOYEE', targetId: E.rota, shiftPatternId: pattern.id, effectiveFrom: '2025-01-01' }).execute();
  await a.insertInto('leaveTypes').values([
    { id: TYPE.al, organizationId: ORG, code: 'AL', name: 'Annual', isPaid: true, annualAllowanceDays: 20 },
    { id: TYPE.mo, organizationId: ORG, code: 'MO', name: 'Male only', isPaid: true, annualAllowanceDays: 10, applicableGender: 'male' },
    { id: TYPE.co, organizationId: ORG, code: 'CO', name: 'Comp off', isPaid: true, isSpecial: true, portalVisible: false, systemKey: 'COMP_OFF' },
  ]).execute();
});
afterAll(async () => { await tdb?.close(); });

describe('7-P1-1 / 7-P1-2 one per-date working calendar for attendance and leave', () => {
  it('7-P1-2 the placement helper: the history row in force on the date, else the employee record', async () => {
    expect(await sys((t) => effectiveBranchIdOn(t, ORG, E.mover, '2026-05-07'))).toBe(BX);
    expect(await sys((t) => effectiveBranchIdOn(t, ORG, E.mover, '2026-07-01'))).toBe(BY);
    expect(await sys((t) => effectiveBranchIdOn(t, ORG, E.mover, '2023-12-31'))).toBe(BY); // before any history: the record
    expect(await sys((t) => effectiveBranchIdOn(t, ORG, '0c000000-0000-0000-0000-0000000000ff', '2026-05-07'))).toBeNull();
  });

  it('7-P1-1 / 7-P1-2 on every date the leave calendar and the attendance input loader agree (transfer, rotation, branch holidays)', async () => {
    const window = { from: '2026-04-26', to: '2026-08-15' };
    const cals = await sys((t) => loadWorkingCalendars(t, ORG, [E.mover, E.rota], window.from, window.to));
    for (const employeeId of [E.mover, E.rota]) {
      const cal = cals.get(employeeId)!;
      for (const d of dates(window.from, window.to)) {
        const inputs = (await sys((t) => loadDailyInputs(t, ORG, employeeId, d, new Date('2026-09-28T06:00:00Z'))))!;
        const attendanceOff = inputs.input.weeklyOffDays.includes(dow(d)) || inputs.input.holiday !== null;
        expect([employeeId, d, cal.isOff!(d)]).toEqual([employeeId, d, attendanceOff]);
      }
    }
    const mover = cals.get(E.mover)!;
    // CAL-2: the Thursday of 7 May is a working day in branch X; the 4th of August a holiday in branch Y; 2 July a Thursday off in Y
    expect(mover.isOff!('2026-05-07')).toBe(false);
    expect(mover.isOff!('2026-05-05')).toBe(false); // branch Y's May holiday is not the mover's (they were in X)
    expect(mover.isOff!('2026-08-04')).toBe(true);
    expect(mover.isOff!('2026-07-02')).toBe(true);
    // CAL-1: the rota's Thursdays are off
    expect(cals.get(E.rota)!.isOff!('2026-05-07')).toBe(true);
    const resolved = await sys((t) => loadEmployeeWorkingCalendars(t, ORG, [E.rota], { from: '2026-05-03', to: '2026-05-09' }));
    expect(resolved.calendars.get(E.rota)!.offDates()).toEqual(['2026-05-07', '2026-05-08', '2026-05-09']);
  });

  it('7-P1-2 balances: a leave stored with its days keeps them; one stored without is counted with the branch of each date', async () => {
    const leave = await tdb.adminDb.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.mover, branchId: BX, leaveTypeId: TYPE.al, startDate: '2026-05-03', endDate: '2026-05-07', status: 'APPROVED', days: 5 }).returning('id').executeTakeFirstOrThrow();
    const taken = async () => (await sys((t) => loadLeaveBalances(t, ORG, [E.mover], { year: 2026, asOf: '2026-09-28' }))).get(E.mover)!.find((b) => b.leaveTypeId === TYPE.al)!.takenDays;
    expect(await taken()).toBe(5);
    await tdb.adminDb.updateTable('leaveRecords').set({ days: null }).where('id', '=', leave.id).execute();
    expect(await taken()).toBe(5); // branch X on those dates: the Thursday is a working day (the current branch Y would say 4)
    // a stored figure that the calendar would no longer produce is the document: taken follows it
    await tdb.adminDb.updateTable('leaveRecords').set({ days: 4.5 }).where('id', '=', leave.id).execute();
    expect(await taken()).toBe(4.5);
    await tdb.adminDb.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('id', '=', leave.id).execute();
  });
});

describe('7-P2-4 comp-off credits against each leave date', () => {
  it('7-P2-4 a credit expiring before the leave date pays nothing; the coverage and the consumer agree', async () => {
    const credit = await tdb.adminDb.insertInto('compOffCredits').values({ organizationId: ORG, employeeId: E.woman, branchId: BX, workedOn: '2026-07-10', workedOnType: 'weekly_off', workedMinutes: 480, daysEarned: 1, location: 'HQ', summary: 'Stock count', status: 'approved', expiresOn: '2026-10-08' }).returning('id').executeTakeFirstOrThrow();
    // CO-1: a leave on 14 February 2027 (139 days after the worked day) is not paid by a credit expiring on 8 October
    const late = { startDate: '2027-02-14', endDate: '2027-02-14', isHalfDay: false, days: 1, countMode: 'working' as const };
    expect(await sys((t) => compOffCoverage(t, ORG, E.woman, late))).toEqual({ coverableDays: 0, shortfallDays: 1 });
    const lateLeave = await tdb.adminDb.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.woman, branchId: BX, leaveTypeId: TYPE.co, startDate: late.startDate, endDate: late.endDate, status: 'PENDING', days: 1 }).returning('id').executeTakeFirstOrThrow();
    const res = await sys(async (t) => consumeCompOffCredits(t, { organizationId: ORG, employeeId: E.woman, leaveRecordId: lateLeave.id, demand: await compOffLeaveDemand(t, ORG, { employeeId: E.woman, ...late }, 'working') }));
    expect(res).toMatchObject({ consumedDays: 0, shortfallDays: 1, usages: [] });
    await tdb.adminDb.updateTable('leaveRecords').set({ status: 'CANCELLED' }).where('id', '=', lateLeave.id).execute();
    // on or before the expiry: paid
    const inTime = { startDate: '2026-10-08', endDate: '2026-10-08', isHalfDay: false, days: 1, countMode: 'working' as const };
    expect(await sys((t) => compOffCoverage(t, ORG, E.woman, inTime))).toEqual({ coverableDays: 1, shortfallDays: 0 });
    const leave = await tdb.adminDb.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E.woman, branchId: BX, leaveTypeId: TYPE.co, startDate: inTime.startDate, endDate: inTime.endDate, status: 'PENDING', days: 1 }).returning('id').executeTakeFirstOrThrow();
    // the pending request reserves the credit: a second application for another date finds nothing left
    expect(await sys((t) => compOffCoverage(t, ORG, E.woman, { ...inTime, startDate: '2026-10-07', endDate: '2026-10-07' }))).toEqual({ coverableDays: 0, shortfallDays: 1 });
    const ok = await sys(async (t) => consumeCompOffCredits(t, { organizationId: ORG, employeeId: E.woman, leaveRecordId: leave.id, demand: await compOffLeaveDemand(t, ORG, { employeeId: E.woman, ...inTime }, 'working') }));
    expect(ok).toMatchObject({ consumedDays: 1, shortfallDays: 0, usages: [{ creditId: credit.id, days: 1 }] });
  });
});

describe('7-P1-3 the unexcused-day charger applies the one applicability rule', () => {
  it('7-P1-3 a male-only type is never charged for a woman (BAL-4)', async () => {
    // her only balance is the male-only type
    await tdb.adminDb.insertInto('leaveAllocations').values({ organizationId: ORG, employeeId: E.woman, leaveTypeId: TYPE.al, branchId: BX, year: 2026, allocatedDays: 0 }).execute();
    const settings = resolveAttendanceSettings({}).unexcused;
    const res = await sys((t) => chargeUnexcusedDay(t, new PgJobQueue(tdb.workerDb), { organizationId: ORG, employeeId: E.woman, date: '2026-09-15', payEffectDays: 1, sourceKind: 'HR', reason: 'probe' }, settings));
    expect(res.outcome).toBe('lop');
    expect(res.leaveTypeCode).toBeNull();
    expect(await tdb.adminDb.selectFrom('leaveRecords').select('id').where('employeeId', '=', E.woman).where('leaveTypeId', '=', TYPE.mo).execute()).toEqual([]);
    const rows = await sql<{ n: number }>`select count(*)::int as n from public.attendance_day_marks where employee_id = ${E.woman}::uuid and kind = 'LOP'`.execute(tdb.adminDb);
    expect(rows.rows[0]!.n).toBe(1);
  });
});

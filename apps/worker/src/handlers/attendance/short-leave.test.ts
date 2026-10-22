import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { localWindowInstant, withContext } from '@flowza/database';
import { createHarness, type TestHarness } from '../../test/harness.js';
import { loadDailyInputs } from './load-inputs.js';
import { recomputeDaily } from './recompute.js';

/*
 * Short leave in the recompute (engine 1.5.0, migration 20261019000310): the loader reads the approved windows around a date
 * (local times of the branch → UTC instants) and the reduced hours in force; the recompute persists excused / credited / lost
 * minutes and the new flags.
 */
const ORG = '0f000000-0000-4000-a000-000000000001';
const BRANCH = '0f000000-0000-4000-a000-00000000000a';
const E1 = '0f000000-0000-4000-a000-0000000000e1';
const E2 = '0f000000-0000-4000-a000-0000000000e2';
const SHIFT = '0f000000-0000-4000-a000-0000000000a1';
const PERSONAL = '0f000000-0000-4000-a000-0000000000b1';
const OFFICIAL = '0f000000-0000-4000-a000-0000000000b2';
const MUSCAT = 'Asia/Muscat';
const DAY = '2026-03-10'; // Tuesday
const NOW = new Date('2026-03-20T06:00:00Z');
const at = (date: string, time: string) => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();

let h: TestHarness;
const sys = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, fn);

beforeAll(async () => {
  h = await createHarness(`flowza_worker_short_leave_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'SLV', legalName: 'Short', displayName: 'Short', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'D', name: 'Day', type: 'FIXED', startTime: '08:00', endTime: '16:00', breaks: JSON.stringify([]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2026-01-01' }).execute();
  await a.insertInto('attendanceRuleSets').values({ organizationId: ORG, name: 'Paired', effectiveFrom: '2026-01-01', graceInMinutes: 0, punchInterpretation: 'PAIRED', outOfOfficeAllowanceMinutes: 20, ramadanMode: JSON.stringify({}) }).execute();
  const emp = (id: string, n: string) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: n, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values([emp(E1, '1'), emp(E2, '2')]).execute();
  await a.insertInto('timeOffTypes').values([
    { id: PERSONAL, organizationId: ORG, code: 'PERSONAL', name: 'Personal permission', category: 'PERSONAL', countsAsWork: false },
    { id: OFFICIAL, organizationId: ORG, code: 'OFFICIAL', name: 'Official assignment', category: 'OFFICIAL', countsAsWork: true },
  ]).execute();
  const request = (employeeId: string, typeId: string, start: string, end: string, minutes: number, status = 'APPROVED') => ({ organizationId: ORG, employeeId, branchId: BRANCH, timeOffTypeId: typeId, requestDate: DAY, startTime: start, endTime: end, minutes, reason: 'Test', status });
  await a.insertInto('timeOffRequests').values([
    request(E1, PERSONAL, '12:00', '12:30', 30),
    // a pending window never reaches the engine
    request(E1, OFFICIAL, '15:00', '16:00', 60, 'PENDING'),
    request(E2, OFFICIAL, '12:00', '16:00', 240),
  ]).execute();
  await a.insertInto('employeeHourAllowances').values({ organizationId: ORG, employeeId: E2, branchId: BRANCH, kind: 'NURSING', minutesPerDay: 60, position: 'START', validFrom: '2026-03-01', validTo: '2026-03-31' }).execute();
  // E1: out 12:00–13:00 (30 min covered by the approved permission, 20 tolerated → 10 lost); E2: 09:00–12:00 then the assignment
  await a.insertInto('attendanceEvents').values([
    ...['08:00', '12:00', '13:00', '16:00'].map((t) => ({ organizationId: ORG, employeeId: E1, branchId: BRANCH, punchedAt: at(DAY, t), eventType: 'PUNCH' as const, source: 'DEVICE' as const, verificationMethod: 'fingerprint' as const })),
    ...['09:00', '12:00'].map((t) => ({ organizationId: ORG, employeeId: E2, branchId: BRANCH, punchedAt: at(DAY, t), eventType: 'PUNCH' as const, source: 'DEVICE' as const, verificationMethod: 'fingerprint' as const })),
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('short leave in the recompute', () => {
  it('converts a local window to UTC with the branch zone (24:00 = the next midnight)', () => {
    expect(localWindowInstant(DAY, '12:00:00', MUSCAT)).toBe('2026-03-10T08:00:00Z');
    expect(localWindowInstant(DAY, '24:00', MUSCAT)).toBe('2026-03-10T20:00:00Z');
  });

  it('loads only APPROVED windows and the allowances in force', async () => {
    const loaded = (await sys((trx) => loadDailyInputs(trx, ORG, E1, DAY, NOW)))!;
    expect(loaded.input.timeOff).toEqual([expect.objectContaining({ typeCode: 'PERSONAL', category: 'PERSONAL', countsAsWork: false, date: DAY, start: '2026-03-10T08:00:00Z', end: '2026-03-10T08:30:00Z' })]);
    expect(loaded.input.hourAllowances).toBeUndefined();
    expect(loaded.input.rules.outOfOfficeAllowanceMinutes).toBe(20);
    const e2 = (await sys((trx) => loadDailyInputs(trx, ORG, E2, DAY, NOW)))!;
    expect(e2.input.hourAllowances).toEqual([expect.objectContaining({ kind: 'NURSING', minutesPerDay: 60, position: 'START' })]);
  });

  it('persists lost / excused minutes and the flags', async () => {
    const out = await sys((trx) => recomputeDaily(trx, { organizationId: ORG, employeeId: E1, date: DAY, now: NOW, reason: 'RECALCULATION' }));
    expect(out.outcome).toBe('created');
    const row = await h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', E1).where('attendanceDate', '=', DAY as never).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ lostMinutes: 10, excusedMinutes: 30, creditedMinutes: 0, workedMinutes: 420, engineVersion: 'attendance-engine/1.5.1' });
    expect(row.flags).toEqual(expect.arrayContaining(['SHORT_LEAVE', 'LOST_TIME']));
    // idempotent
    expect((await sys((trx) => recomputeDaily(trx, { organizationId: ORG, employeeId: E1, date: DAY, now: NOW, reason: 'RECALCULATION' }))).outcome).toBe('unchanged');
  });

  it('credits an official assignment and applies the nursing hour', async () => {
    await sys((trx) => recomputeDaily(trx, { organizationId: ORG, employeeId: E2, date: DAY, now: NOW, reason: 'RECALCULATION' }));
    const row = await h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', E2).where('attendanceDate', '=', DAY as never).executeTakeFirstOrThrow();
    // nursing hour at the start: expected 09:00–16:00 (420 min); worked 09:00–12:00 + 240 credited
    expect(row).toMatchObject({ status: 'PRESENT', scheduledMinutes: 420, lateMinutes: 0, earlyDepartureMinutes: 0, creditedMinutes: 240, workedMinutes: 420 });
    expect(row.flags).toEqual(expect.arrayContaining(['OFFICIAL_ASSIGNMENT', 'REDUCED_HOURS']));
    expect(row.flags).not.toContain('LATE');
  });
});

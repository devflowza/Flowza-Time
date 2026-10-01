import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { ensureSelfServiceDevice, withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { eventSourceForRaw, normalizeRaw } from './normalize.js';
import { recomputeDailyHandler } from './recompute.js';
import { applyApprovedCorrection } from './corrections.js';
import { dayCloseHandler, DAY_CLOSE_JOB_TYPE } from './day-close.js';
import { isoDate } from './common.js';

/**
 * The employee portal's self-service punches in the worker (HR portal Prompt 4): a SELF_SERVICE raw row on the virtual
 * self-service device normalises into a MOBILE event for the employee it names and the recompute flags the day
 * SELF_SERVICE_PUNCH (+ OUTSIDE_GEOFENCE from the stored verdict); rows that only pretend to be self-service stay unmatched;
 * a regularisation's correction keeps its device; the day-close sweep leaves a day with a pending reason alone.
 */
const ORG = '0c000000-0000-4000-a000-000000000001';
const OWNER = 'c0000000-0000-4000-a000-000000000001';
const BRANCH = '0c000000-0000-4000-a000-00000000000a';
const MOCK_DEVICE = '0c000000-0000-4000-a000-0000000000d1';
const E1 = '0c000000-0000-4000-a000-0000000000e1';
const E2 = '0c000000-0000-4000-a000-0000000000e2';
const SHIFT = '0c000000-0000-4000-a000-0000000000a1';
const MUSCAT = 'Asia/Muscat';
/** Thursday 2026-03-12 10:00 Muscat. */
const NOW = new Date('2026-03-12T06:00:00Z');
const DAY = '2026-03-10';

let h: TestHarness;
let deviceId: string;
let seq = 0;
const at = (date: string, time: string): Date => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: fakeJob(jobType, payload, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const record = (employeeId: string, date: string) => h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirstOrThrow();

async function raw(row: { device: string; providerKey: string; deviceEmployeeId: string; employeeId?: string | null; punchedAt: Date; direction: 'in' | 'out'; source: 'SELF_SERVICE' | 'POLL'; payload?: Record<string, unknown> }) {
  seq += 1;
  await h.tdb.adminDb.insertInto('attendanceRawTransactions').values({
    organizationId: ORG, deviceId: row.device, branchId: BRANCH, providerKey: row.providerKey, providerTransactionId: `self-test-${seq}`, deviceEmployeeId: row.deviceEmployeeId, employeeId: row.employeeId ?? null,
    punchedAt: row.punchedAt, verificationMethod: 'mobile', direction: row.direction, rawPayload: JSON.stringify(row.payload ?? {}), source: row.source, dedupeHash: `self-hash-${seq}`, processingStatus: 'pending',
  }).execute();
}

beforeAll(async () => {
  h = await createHarness(`flowza_worker_self_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@self.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'owner@self.local', fullName: 'Owner' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'SELF', legalName: 'Self', displayName: 'Self', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).onConflict((oc) => oc.doNothing()).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'DAY', name: 'Day 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2026-01-01' }).execute();
  const emp = (id: string, n: string, deviceUserId: string) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values([emp(E1, 'E1', '201'), emp(E2, 'E2', '202')]).execute();
  await a.insertInto('employmentHistory').values([
    { organizationId: ORG, employeeId: E1, effectiveFrom: '2025-01-01', branchId: BRANCH, employmentType: 'full_time', employmentStatus: 'active' },
    { organizationId: ORG, employeeId: E2, effectiveFrom: '2025-01-01', branchId: BRANCH, employmentType: 'full_time', employmentStatus: 'active' },
  ]).execute();
  await a.insertInto('devices').values({ id: MOCK_DEVICE, organizationId: ORG, branchId: BRANCH, code: 'GATE', name: 'Gate', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: MUSCAT }).execute();
  deviceId = (await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ensureSelfServiceDevice(trx, ORG))).id;
});
afterAll(async () => { await h?.close(); });

describe('the virtual self-service device', () => {
  it('is created once, disabled, never auto-synced, without a push token', async () => {
    const again = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ensureSelfServiceDevice(trx, ORG));
    expect(again).toMatchObject({ id: deviceId, created: false, providerKey: 'self_service', branchId: BRANCH, timezone: MUSCAT });
    const rows = await h.tdb.adminDb.selectFrom('devices').selectAll().where('organizationId', '=', ORG).where('providerKey', '=', 'self_service').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'disabled', autoSyncEnabled: false, pushTokenHash: null, serialNumber: null, integrationType: 'DEVICE_PUSH' });
  });
});

describe('normalising self-service punches', () => {
  it('maps SELF_SERVICE rows to MOBILE events of the employee they name; impostor rows stay unmatched', async () => {
    expect(eventSourceForRaw('SELF_SERVICE')).toBe('MOBILE');
    await raw({ device: deviceId, providerKey: 'self_service', deviceEmployeeId: E1, employeeId: E1, punchedAt: at(DAY, '08:05'), direction: 'in', source: 'SELF_SERVICE', payload: { channel: 'web', verdict: 'flagged', lat: 23.6, lng: 58.4 } });
    await raw({ device: deviceId, providerKey: 'self_service', deviceEmployeeId: E1, employeeId: E1, punchedAt: at(DAY, '17:02'), direction: 'out', source: 'SELF_SERVICE', payload: { channel: 'mobile', verdict: 'allowed' } });
    // a terminal row claiming the self-service provider, and a self-service row on a terminal: neither is trusted
    await raw({ device: MOCK_DEVICE, providerKey: 'self_service', deviceEmployeeId: E1, punchedAt: at(DAY, '09:00'), direction: 'in', source: 'POLL' });
    await raw({ device: MOCK_DEVICE, providerKey: 'mock', deviceEmployeeId: E1, employeeId: E1, punchedAt: at(DAY, '09:30'), direction: 'in', source: 'SELF_SERVICE' });
    const res = await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    expect(res).toMatchObject({ fetched: 4, normalized: 2, unmatched: 2, events: 2 });
    const events = await h.tdb.adminDb.selectFrom('attendanceEvents').select(['employeeId', 'eventType', 'source', 'deviceId', 'verificationMethod']).where('organizationId', '=', ORG).orderBy('punchedAt').execute();
    expect(events).toEqual([
      { employeeId: E1, eventType: 'PUNCH_IN', source: 'MOBILE', deviceId, verificationMethod: 'mobile' },
      { employeeId: E1, eventType: 'PUNCH_OUT', source: 'MOBILE', deviceId, verificationMethod: 'mobile' },
    ]);
    const unmatched = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select(['processingStatus', 'employeeId']).where('organizationId', '=', ORG).where('processingStatus', '=', 'unmatched').execute();
    expect(unmatched).toHaveLength(2);
  });

  it('the recompute flags the day as a self-service punch outside the geofence', async () => {
    await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E1, date: DAY }));
    const r = await record(E1, DAY);
    expect(r.status).toBe('PRESENT');
    expect(r.flags).toEqual(expect.arrayContaining(['SELF_SERVICE_PUNCH', 'OUTSIDE_GEOFENCE']));
    expect(r.punchCount).toBe(2);
  });
});

describe('a regularisation applied through a correction', () => {
  it('the CORRECTION event carries the self-service device of the correction', async () => {
    const c = await h.tdb.adminDb.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH, attendanceDate: '2026-03-09', type: 'ADD_PUNCH', proposedPunchedAt: at('2026-03-09', '08:00'), proposedEventType: 'PUNCH_IN', reason: 'Regularisation (missed punch): terminal offline', requestedBy: OWNER, status: 'APPROVED', deviceId }).returning('id').executeTakeFirstOrThrow();
    const res = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c.id, { queue: h.deps.queue, appliedBy: OWNER, now: NOW }));
    expect(res.status).toBe('APPLIED');
    const ev = await h.tdb.adminDb.selectFrom('attendanceEvents').select(['source', 'deviceId', 'note']).where('id', '=', res.appliedEventId!).executeTakeFirstOrThrow();
    expect(ev).toEqual({ source: 'CORRECTION', deviceId, note: 'Regularisation (missed punch): terminal offline' });
  });
});

describe('day close and the employee\'s reasons', () => {
  it('a day with a pending reason is left for the reviewer; a day without one is marked', async () => {
    const a = h.tdb.adminDb;
    for (const [employeeId, date] of [[E1, '2026-03-04'], [E2, '2026-03-04']] as const) {
      await a.insertInto('attendanceDailyRecords').values({ organizationId: ORG, employeeId, attendanceDate: date, branchId: BRANCH, timezone: MUSCAT, engineVersion: 'seed', status: 'ABSENT', flags: [], trace: JSON.stringify({}) }).execute();
    }
    await a.insertInto('attendanceNotes').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH, attendanceDate: '2026-03-04', category: 'absence_reason', note: 'Sick child', status: 'pending' }).execute();
    const res = await dayCloseHandler(ctx(DAY_CLOSE_JOB_TYPE, { organizationId: ORG }));
    expect(res).toMatchObject({ skippedNote: 1, marked: 1 });
    const marks = await a.selectFrom('attendanceDayMarks').select(['employeeId', 'attendanceDate', 'kind']).where('organizationId', '=', ORG).where('revokedAt', 'is', null).execute();
    expect(marks.map((m) => `${m.employeeId === E1 ? 'E1' : 'E2'}:${isoDate(m.attendanceDate)}:${m.kind}`)).toEqual(['E2:2026-03-04:UNEXCUSED']);
  });
});

describe('overtime after the shift end', () => {
  const date = '2026-03-11'; // Wednesday, a working day on the 08:00–17:00 shift every employee is assigned
  it('a self-service check-out after the shift end puts the additional time on the record as overtime', async () => {
    await raw({ device: deviceId, providerKey: 'self_service', deviceEmployeeId: E2, employeeId: E2, punchedAt: at(date, '08:30'), direction: 'in', source: 'SELF_SERVICE', payload: { channel: 'web', verdict: 'no_fence', withinGeofence: null } });
    await raw({ device: deviceId, providerKey: 'self_service', deviceEmployeeId: E2, employeeId: E2, punchedAt: at(date, '17:45'), direction: 'out', source: 'SELF_SERVICE', payload: { channel: 'web', verdict: 'no_fence', withinGeofence: null } });
    expect(await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }))).toMatchObject({ normalized: 2 });
    await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E2, date }));
    // no rule set: the defaults count every minute after 17:00 — the 30-minute late arrival does not cancel them
    const r = await record(E2, date);
    expect(r).toMatchObject({ status: 'PRESENT', shiftId: SHIFT, workedMinutes: 555, scheduledMinutes: 540, lateMinutes: 20, overtimeMinutes: 45, overtimeCategory: 'REGULAR' });
    expect(r.flags).toEqual(['LATE', 'OVERTIME', 'SELF_SERVICE_PUNCH']);
  });

  it('a rule set that requires the scheduled hours first keeps only the part beyond them', async () => {
    const rs = await h.tdb.adminDb.insertInto('attendanceRuleSets').values({ organizationId: ORG, name: 'Strict overtime', effectiveFrom: '2026-01-01', overtimeRequiresScheduledHours: true, ramadanMode: JSON.stringify({}) }).returning('id').executeTakeFirstOrThrow();
    try {
      await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E2, date }));
      expect(await record(E2, date)).toMatchObject({ workedMinutes: 555, overtimeMinutes: 15, ruleSetId: rs.id }); // 555 worked − 540 scheduled
    } finally {
      await h.tdb.adminDb.deleteFrom('attendanceRuleSets').where('id', '=', rs.id).execute();
    }
  });
});

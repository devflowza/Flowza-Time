import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { DEFAULT_POLICY_SECTIONS } from '@flowza/contracts';
import { defaultRegistry } from '@flowza/device-providers';
import { ensureSelfServiceDevice, withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { eventTypeForPunch, normalizeRaw } from './normalize.js';
import { recomputeDailyHandler } from './recompute.js';

/**
 * Time away and terminal punch roles in the worker (docs/time-away.md): an entry-only terminal's punches are arrivals and an
 * exit-only terminal's departures whatever key was pressed; an ACCESS reader's punches become room entries (access_events),
 * never attendance events; and a day with an out-and-back measured on those punches is classified against the approved
 * time-away window loaded from the database (official duty counts as worked, the rest unapproved).
 */
const ORG = '0d000000-0000-4000-a000-000000000001';
const BRANCH = '0d000000-0000-4000-a000-00000000000a';
const ENTRY = '0d000000-0000-4000-a000-0000000000d1';
const EXIT = '0d000000-0000-4000-a000-0000000000d2';
const READER = '0d000000-0000-4000-a000-0000000000d3';
const E1 = '0d000000-0000-4000-a000-0000000000e1';
const SHIFT = '0d000000-0000-4000-a000-0000000000a1';
const MUSCAT = 'Asia/Muscat';
const NOW = new Date('2026-03-12T16:00:00Z');
const DAY = '2026-03-10';
const DAY2 = '2026-03-11';

let h: TestHarness;
let selfDevice: string;
let seq = 0;
const at = (date: string, time: string): Date => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: fakeJob(jobType, payload, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const record = (date: string) => h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', E1).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirstOrThrow();

async function raw(device: string, providerKey: string, punchedAt: Date, direction: 'in' | 'out' | 'break_out' | 'unknown', self = false) {
  seq += 1;
  await h.tdb.adminDb.insertInto('attendanceRawTransactions').values({
    organizationId: ORG, deviceId: device, branchId: BRANCH, providerKey, providerTransactionId: `ta-${seq}`, deviceEmployeeId: self ? E1 : '301', employeeId: self ? E1 : null,
    punchedAt, verificationMethod: self ? 'mobile' : 'fingerprint', direction, rawPayload: JSON.stringify(self ? { channel: 'web' } : {}), source: self ? 'SELF_SERVICE' : 'DEVICE_PUSH', dedupeHash: `ta-hash-${seq}`, processingStatus: 'pending',
  }).execute();
}

beforeAll(async () => {
  h = await createHarness(`flowza_worker_time_away_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'TA', legalName: 'TA', displayName: 'TA', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).onConflict((oc) => oc.doNothing()).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT }).execute();
  await a.insertInto('shifts').values({ id: SHIFT, organizationId: ORG, code: 'OFF6', name: 'Office 08:00–14:00', type: 'FIXED', startTime: '08:00', endTime: '14:00', breaks: JSON.stringify([]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT, effectiveFrom: '2026-01-01' }).execute();
  await a.insertInto('attendanceRuleSets').values({ organizationId: ORG, name: 'Office', effectiveFrom: '2026-01-01', punchInterpretation: 'DIRECTIONAL', minFullDayMinutes: 330, halfDayThresholdMinutes: 180,
    policy: JSON.stringify({ ...DEFAULT_POLICY_SECTIONS, timeAway: { ...DEFAULT_POLICY_SECTIONS.timeAway, enabled: true } }) } as never).execute();
  await a.insertInto('employees').values({ id: E1, organizationId: ORG, employeeNumber: 'E1', firstName: 'Ahmed', lastName: 'A', displayName: 'Ahmed A', joiningDate: '2025-01-01', branchId: BRANCH, deviceUserId: '301', customFields: JSON.stringify({}) }).execute();
  await a.insertInto('employmentHistory').values({ organizationId: ORG, employeeId: E1, effectiveFrom: '2025-01-01', branchId: BRANCH, employmentType: 'full_time', employmentStatus: 'active' }).execute();
  const dev = (id: string, code: string, punchRole: string) => ({ id, organizationId: ORG, branchId: BRANCH, code, name: code, providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'DEVICE_PUSH' as const, timezone: MUSCAT, punchRole: punchRole as never });
  await a.insertInto('devices').values([dev(ENTRY, 'ENTRY', 'CHECK_IN'), dev(EXIT, 'EXIT', 'CHECK_OUT'), dev(READER, 'BRD', 'ACCESS')]).execute();
  selfDevice = (await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => ensureSelfServiceDevice(trx, ORG))).id;
});
afterAll(async () => { await h?.close(); });

describe('terminal punch roles', () => {
  it('maps a punch by the terminal\'s role first, then by its reported direction', () => {
    expect(eventTypeForPunch('out', 'CHECK_IN')).toBe('PUNCH_IN');
    expect(eventTypeForPunch('in', 'CHECK_OUT')).toBe('PUNCH_OUT');
    expect(eventTypeForPunch('unknown', 'CHECK_IN')).toBe('PUNCH_IN');
    expect(eventTypeForPunch('break_out', 'AUTO')).toBe('BREAK_START');
    expect(eventTypeForPunch('unknown', 'AUTO')).toBe('PUNCH');
  });

  it('normalises entry / exit terminals into IN / OUT events and an ACCESS reader into a room entry only', async () => {
    await raw(ENTRY, 'mock', at(DAY, '07:58'), 'unknown');
    await raw(EXIT, 'mock', at(DAY, '10:00'), 'unknown');
    await raw(READER, 'mock', at(DAY, '10:30'), 'in');
    await raw(ENTRY, 'mock', at(DAY, '12:05'), 'out');
    await raw(EXIT, 'mock', at(DAY, '14:02'), 'unknown');
    await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    const events = await h.tdb.adminDb.selectFrom('attendanceEvents').select(['eventType', 'deviceId']).where('organizationId', '=', ORG).orderBy('punchedAt').execute();
    expect(events.map((e) => e.eventType)).toEqual(['PUNCH_IN', 'PUNCH_OUT', 'PUNCH_IN', 'PUNCH_OUT']);
    expect(events.some((e) => e.deviceId === READER)).toBe(false);
    const access = await h.tdb.adminDb.selectFrom('accessEvents').selectAll().where('organizationId', '=', ORG).execute();
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ employeeId: E1, deviceId: READER, direction: 'in' });
    const rawStatuses = await h.tdb.adminDb.selectFrom('attendanceRawTransactions').select('processingStatus').where('organizationId', '=', ORG).execute();
    expect(rawStatuses.every((r) => r.processingStatus === 'normalized')).toBe(true);
  });

  it('classifies the measured gap against the approved window: two hours official, five minutes unapproved', async () => {
    // before the approval the whole gap is unapproved time away (deducted and flagged)
    await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E1, date: DAY, reason: 'NEW_EVENT' }));
    const before = await record(DAY);
    expect(before).toMatchObject({ awayMinutes: 125, unapprovedAwayMinutes: 125, officialDutyMinutes: 0, workedMinutes: 239 });
    expect(before.flags).toEqual(expect.arrayContaining(['TIME_AWAY', 'UNAPPROVED_AWAY', 'UNDER_HOURS']));
    await h.tdb.adminDb.insertInto('timeAwayRequests').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH, attendanceDate: DAY, kind: 'OFFICIAL', source: 'request', startsAt: at(DAY, '10:00'), endsAt: at(DAY, '11:50'), reason: 'Client visit', status: 'approved' }).execute();
    await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E1, date: DAY, reason: 'TIME_AWAY' }));
    const r = await record(DAY);
    // 10:00–12:05: 110 min in the window + 10 min return grace = 120 official, 5 unapproved (under the 15-min flag)
    expect(r).toMatchObject({ awayMinutes: 125, officialDutyMinutes: 120, permissionMinutes: 0, unapprovedAwayMinutes: 5, workedMinutes: 359, status: 'PRESENT', engineVersion: 'attendance-engine/1.5.0' });
    expect(r.flags).toContain('TIME_AWAY');
    expect(r.flags).not.toContain('UNAPPROVED_AWAY');
    const history = await h.tdb.adminDb.selectFrom('attendanceDailyRecordHistory').select('reason').where('employeeId', '=', E1).execute();
    expect(history.map((x) => x.reason)).toContain('TIME_AWAY');
  });

  it('a portal step-out on an entry-only site: break-out from the portal, back on the entry terminal', async () => {
    await raw(ENTRY, 'mock', at(DAY2, '08:00'), 'unknown');
    await raw(selfDevice, 'self_service', at(DAY2, '11:00'), 'break_out', true);
    await raw(ENTRY, 'mock', at(DAY2, '12:30'), 'unknown');
    await raw(EXIT, 'mock', at(DAY2, '14:00'), 'unknown');
    await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    await recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId: E1, date: DAY2, reason: 'NEW_EVENT' }));
    const r = await record(DAY2);
    expect(r).toMatchObject({ awayMinutes: 90, unapprovedAwayMinutes: 90, workedMinutes: 270 });
    expect(r.flags).toEqual(expect.arrayContaining(['TIME_AWAY', 'UNAPPROVED_AWAY', 'SELF_SERVICE_PUNCH']));
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { AppError } from '@flowza/shared';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { normalizeRaw, eventTypeForDirection, historyOn } from './normalize.js';
import { recomputeDailyHandler, recomputeDaily } from './recompute.js';
import { applyApprovedCorrection, applyCorrectionHandler } from './corrections.js';
import { enqueueRecalculationForScope, recalculateRange } from './recalculate.js';
import { buildPeriodSummaryHandler } from './period-summary.js';
import { normaliseRamadanMode, loadDailyInputs } from './load-inputs.js';
import { enqueueRecompute, recomputeDedupeKey } from './common.js';
import { attendanceTasks } from './tasks.js';
import { registerAttendanceHandlers } from './index.js';
import { HandlerRegistry } from '../types.js';

// ids are RFC-4122 shaped because job payloads are validated with z.uuid()
const ORG = '0a000000-0000-4000-a000-000000000001';
const OWNER = 'a0000000-0000-4000-a000-000000000001';
const BRANCH_A = '0a000000-0000-4000-a000-00000000000a'; // Asia/Muscat
const BRANCH_B = '0a000000-0000-4000-a000-00000000000b'; // Asia/Riyadh
const DEVICE = '0a000000-0000-4000-a000-0000000000d1';
const E1 = '0a000000-0000-4000-a000-0000000000e1'; // Morning shift (organisation default), resolved via employees.device_user_id
const E2 = '0a000000-0000-4000-a000-0000000000e2'; // Night shift, resolved via device_employee_states
const E3 = '0a000000-0000-4000-a000-0000000000e3'; // moves from branch A to B on 2026-03-16, resolved via employee_provider_identities
const SHIFT_M = '0a000000-0000-4000-a000-0000000000a1';
const SHIFT_N = '0a000000-0000-4000-a000-0000000000a2';
const CAL = '0a000000-0000-4000-a000-0000000000c1';
const RULES = '0a000000-0000-4000-a000-0000000000f1';
const LEAVE_TYPE = '0a000000-0000-4000-a000-00000000001a';
const MUSCAT = 'Asia/Muscat';
const RIYADH = 'Asia/Riyadh';
/** Thursday 2026-03-19 10:00 Muscat — "today" for every test. */
const NOW = new Date('2026-03-19T06:00:00Z');

const at = (date: string, time: string, zone = MUSCAT): Date => DateTime.fromISO(`${date}T${time}`, { zone }).toJSDate();
let h: TestHarness;
let rawSeq = 0;
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: fakeJob(jobType, payload, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const recompute = (employeeId: string, date: string, extra: Record<string, unknown> = {}) => recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId, date, ...extra }));
const record = (employeeId: string, date: string) => h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirstOrThrow();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function insertRaw(rows: Array<{ deviceUserId: string; punchedAt: Date; direction?: 'in' | 'out' | 'break_out' | 'break_in' | 'unknown'; status?: 'pending' | 'held' | 'quarantined'; source?: 'POLL' | 'IMPORT' | 'MANUAL' }>) {
  await h.tdb.adminDb.insertInto('attendanceRawTransactions').values(rows.map((r) => ({
    organizationId: ORG, deviceId: DEVICE, branchId: BRANCH_A, providerKey: 'mock', providerTransactionId: `tx-${++rawSeq}`, deviceEmployeeId: r.deviceUserId, punchedAt: r.punchedAt,
    verificationMethod: 'fingerprint', direction: r.direction ?? 'unknown', rawPayload: JSON.stringify({}), source: r.source ?? 'POLL', dedupeHash: `hash-${rawSeq}`, processingStatus: r.status ?? 'pending',
  }))).execute();
}
const pendingJobs = (dedupeKey: string) => sql<{ payload: Record<string, unknown>; runAt: Date }>`select payload, run_at as "runAt" from jobs.queue where dedupe_key = ${dedupeKey} and status = 'pending' order by id`.execute(h.tdb.adminDb).then((r) => r.rows);

beforeAll(async () => {
  h = await createHarness(`flowza_worker_att_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@att.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'owner@att.local', fullName: 'Owner' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'ATT', legalName: 'Att', displayName: 'Att', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('branches').values([
    { id: BRANCH_A, organizationId: ORG, code: 'MCT', name: 'Muscat', timezone: MUSCAT },
    { id: BRANCH_B, organizationId: ORG, code: 'RUH', name: 'Riyadh', timezone: RIYADH },
  ]).execute();
  await a.insertInto('holidayCalendars').values({ id: CAL, organizationId: ORG, name: 'Oman', countryCode: 'OM', isDefault: true }).execute();
  await a.updateTable('branches').set({ holidayCalendarId: CAL }).where('organizationId', '=', ORG).execute();
  await a.insertInto('holidays').values({ organizationId: ORG, calendarId: CAL, name: 'Test Holiday', date: '2026-03-11', type: 'PUBLIC' }).execute();
  await a.insertInto('shifts').values([
    { id: SHIFT_M, organizationId: ORG, code: 'MORNING', name: 'Morning 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([{ start: '13:00', end: '14:00', paid: false }]) },
    { id: SHIFT_N, organizationId: ORG, code: 'NIGHT', name: 'Night 22:00–06:00', type: 'FIXED', startTime: '22:00', endTime: '06:00', breaks: JSON.stringify([]) },
  ]).execute();
  await a.insertInto('shiftAssignments').values([
    { organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT_M, effectiveFrom: '2026-01-01' },
    { organizationId: ORG, targetType: 'EMPLOYEE', targetId: E2, shiftId: SHIFT_N, branchId: BRANCH_A, effectiveFrom: '2026-01-01' },
  ]).execute();
  await a.insertInto('attendanceRuleSets').values({ id: RULES, organizationId: ORG, name: 'Default', effectiveFrom: '2026-01-01', ramadanMode: JSON.stringify({}) }).execute();
  await a.insertInto('leaveTypes').values({ id: LEAVE_TYPE, organizationId: ORG, code: 'ANNUAL', name: 'Annual', isPaid: true }).execute();
  const emp = (id: string, n: string, deviceUserId: string) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId: BRANCH_A, deviceUserId, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values([emp(E1, 'E1', '101'), emp(E2, 'E2', '102'), emp(E3, 'E3', '103')]).execute();
  await a.insertInto('employmentHistory').values([
    { organizationId: ORG, employeeId: E1, effectiveFrom: '2025-01-01', branchId: BRANCH_A, employmentType: 'full_time', employmentStatus: 'active' },
    { organizationId: ORG, employeeId: E2, effectiveFrom: '2025-01-01', branchId: BRANCH_A, employmentType: 'full_time', employmentStatus: 'active' },
    { organizationId: ORG, employeeId: E3, effectiveFrom: '2025-01-01', effectiveTo: '2026-03-16', branchId: BRANCH_A, employmentType: 'full_time', employmentStatus: 'active' },
    { organizationId: ORG, employeeId: E3, effectiveFrom: '2026-03-16', branchId: BRANCH_B, employmentType: 'full_time', employmentStatus: 'active', reason: 'Transfer' },
  ]).execute();
  await a.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH_A, leaveTypeId: LEAVE_TYPE, startDate: '2026-03-09', endDate: '2026-03-09', status: 'APPROVED', approvedBy: OWNER, approvedAt: new Date() }).execute();
  await a.insertInto('devices').values({ id: DEVICE, organizationId: ORG, branchId: BRANCH_A, code: 'D1', name: 'Gate', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: MUSCAT }).execute();
  await a.insertInto('deviceEmployeeStates').values({ organizationId: ORG, deviceId: DEVICE, employeeId: E2, deviceUserId: 'X202', branchId: BRANCH_A }).execute();
  await a.insertInto('employeeProviderIdentities').values({ organizationId: ORG, employeeId: E3, providerKey: 'mock', deviceUserId: 'P303' }).execute();

  await insertRaw([
    { deviceUserId: '101', punchedAt: at('2026-03-10', '08:20'), direction: 'in' },
    { deviceUserId: '101', punchedAt: at('2026-03-10', '17:05'), direction: 'out' },
    { deviceUserId: 'X202', punchedAt: at('2026-03-10', '21:57') },
    { deviceUserId: 'X202', punchedAt: at('2026-03-11', '06:08') },
    { deviceUserId: '9999', punchedAt: at('2026-03-10', '09:00') },
    { deviceUserId: 'P303', punchedAt: at('2026-03-15', '08:00') },
    { deviceUserId: 'P303', punchedAt: at('2026-03-15', '17:00') },
    { deviceUserId: 'P303', punchedAt: at('2026-03-16', '08:00', RIYADH) },
    { deviceUserId: 'P303', punchedAt: at('2026-03-16', '17:00', RIYADH) },
    { deviceUserId: '101', punchedAt: at('2026-03-18', '07:58'), direction: 'in' },
    { deviceUserId: '101', punchedAt: at('2026-03-18', '19:00'), direction: 'out' },
    { deviceUserId: '101', punchedAt: at('2026-03-04', '08:00'), status: 'held' },
    { deviceUserId: '101', punchedAt: at('2026-03-04', '17:00'), status: 'quarantined' },
  ]);
});
afterAll(async () => { await h?.close(); });

describe('registration and pure helpers', () => {
  it('registers the five attendance job types', () => {
    const reg = new HandlerRegistry();
    registerAttendanceHandlers(reg);
    expect(reg.types().sort()).toEqual(['APPLY_CORRECTION', 'BUILD_PERIOD_SUMMARY', 'NORMALIZE_RAW', 'RECALCULATE_RANGE', 'RECOMPUTE_DAILY']);
  });
  it('maps device directions to event types and tolerates snake_case ramadan settings', () => {
    expect(['in', 'out', 'break_out', 'break_in', 'overtime_in', 'unknown'].map((d) => eventTypeForDirection(d as never))).toEqual(['PUNCH_IN', 'PUNCH_OUT', 'BREAK_START', 'BREAK_END', 'PUNCH', 'PUNCH']);
    expect(normaliseRamadanMode({ enabled: true, from: '2026-02-18', to: '2026-03-19', scheduled_minutes: 360, applies_to: 'muslim_employees' })).toEqual({ enabled: true, appliesTo: 'flagged_employees', scheduledMinutes: 360, from: '2026-02-18', to: '2026-03-19' });
    expect(normaliseRamadanMode('{}')).toEqual({ enabled: false, appliesTo: 'all' });
    const rows = [{ effectiveFrom: '2026-03-16', effectiveTo: null, b: 'B' }, { effectiveFrom: '2025-01-01', effectiveTo: '2026-03-16', b: 'A' }];
    expect(historyOn(rows, '2026-03-15')?.b).toBe('A');
    expect(historyOn(rows, '2026-03-16')?.b).toBe('B');
    expect(historyOn(rows, '2024-12-31')).toBeUndefined();
  });
});

describe('NORMALIZE_RAW', () => {
  it('creates events with the effective branch and direction-derived types, marks unmatched rows, leaves held/quarantined alone', async () => {
    const res = await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    expect(res).toMatchObject({ batches: 1, fetched: 11, normalized: 10, unmatched: 1, events: 10, requeued: false });
    const a = h.tdb.adminDb;
    const events = await a.selectFrom('attendanceEvents').select(['employeeId', 'branchId', 'eventType', 'punchedAt', 'source', 'rawTransactionId', 'deviceId']).where('organizationId', '=', ORG).orderBy('punchedAt').execute();
    expect(events).toHaveLength(10);
    expect(events.every((e) => e.source === 'DEVICE' && e.rawTransactionId !== null && e.deviceId === DEVICE)).toBe(true);
    const e1 = events.filter((e) => e.employeeId === E1);
    expect(e1.map((e) => e.eventType)).toEqual(['PUNCH_IN', 'PUNCH_OUT', 'PUNCH_IN', 'PUNCH_OUT']);
    expect(events.filter((e) => e.employeeId === E2).map((e) => e.eventType)).toEqual(['PUNCH', 'PUNCH']);
    // employment history: branch A until 2026-03-16 (exclusive), branch B from then on
    const e3 = events.filter((e) => e.employeeId === E3);
    expect(e3.map((e) => e.branchId)).toEqual([BRANCH_A, BRANCH_A, BRANCH_B, BRANCH_B]);
    const raw = await a.selectFrom('attendanceRawTransactions').select(['deviceEmployeeId', 'employeeId', 'processingStatus', 'processingError', 'processedAt']).where('organizationId', '=', ORG).execute();
    const unmatched = raw.find((r) => r.deviceEmployeeId === '9999')!;
    expect(unmatched).toMatchObject({ employeeId: null, processingStatus: 'unmatched', processingError: 'no employee for device user id' });
    expect(unmatched.processedAt).not.toBeNull();
    expect(raw.filter((r) => r.processingStatus === 'normalized')).toHaveLength(10);
    expect(raw.filter((r) => r.processingStatus === 'normalized').every((r) => r.employeeId !== null)).toBe(true);
    expect(raw.map((r) => r.processingStatus).filter((s) => s === 'held' || s === 'quarantined').sort()).toEqual(['held', 'quarantined']);
  });

  it('enqueues debounced, deduped RECOMPUTE_DAILY jobs incl. the previous local date for pre-noon punches', async () => {
    const jobs = await sql<{ dedupeKey: string; runAt: Date; payload: Record<string, unknown>; queueName: string; status: string }>`select dedupe_key as "dedupeKey", run_at as "runAt", payload, queue_name as "queueName", status from jobs.queue where job_type = 'RECOMPUTE_DAILY' order by dedupe_key`.execute(h.tdb.adminDb);
    const keys = jobs.rows.map((j) => j.dedupeKey);
    expect(keys).toEqual([
      `recompute:${E1}:2026-03-09`, `recompute:${E1}:2026-03-10`, `recompute:${E1}:2026-03-17`, `recompute:${E1}:2026-03-18`,
      `recompute:${E2}:2026-03-10`, `recompute:${E2}:2026-03-11`,
      `recompute:${E3}:2026-03-14`, `recompute:${E3}:2026-03-15`, `recompute:${E3}:2026-03-16`,
    ]);
    for (const j of jobs.rows) {
      expect(j.queueName).toBe('processing');
      expect(j.status).toBe('pending');
      expect(j.runAt.getTime() - NOW.getTime()).toBe(30_000); // org has no settings row → default processingDelaySeconds 30
      expect(j.payload).toMatchObject({ organizationId: ORG, reason: 'NEW_EVENT' });
    }
    // dedupe: the night employee's two punches touched 2026-03-10 twice → one job
    expect(keys.filter((k) => k === `recompute:${E2}:2026-03-10`)).toHaveLength(1);
  });

  it('is a no-op when nothing is pending', async () => {
    expect(await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }))).toMatchObject({ fetched: 0, normalized: 0, events: 0 });
    expect(await h.tdb.adminDb.selectFrom('attendanceEvents').select(sql<string>`count(*)`.as('n')).executeTakeFirstOrThrow()).toEqual({ n: '10' });
  });

  it('rejects a malformed payload without retrying', async () => {
    await expect(normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: 'nope' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });
});

describe('RECOMPUTE_DAILY', () => {
  it('PRESENT with late minutes for the morning shift', async () => {
    const out = await recompute(E1, '2026-03-10');
    expect(out).toMatchObject({ outcome: 'created', version: 1, status: 'PRESENT', branchId: BRANCH_A });
    const r = await record(E1, '2026-03-10');
    expect(r).toMatchObject({ status: 'PRESENT', lateMinutes: 10, workedMinutes: 465, breakMinutes: 60, scheduledMinutes: 480, overtimeMinutes: 0, punchCount: 2, shiftId: SHIFT_M, ruleSetId: RULES, timezone: MUSCAT, calculationVersion: 1, hasCorrection: false, departmentId: null });
    expect(r.flags).toEqual(['LATE']);
    expect(iso(r.firstInAt)).toBe('2026-03-10T04:20:00.000Z');
    expect(iso(r.lastOutAt)).toBe('2026-03-10T13:05:00.000Z');
    expect(iso(r.expectedStartAt)).toBe('2026-03-10T04:00:00.000Z');
    expect((r.trace as { steps: unknown[] }).steps.length).toBeGreaterThan(3);
    expect(r.engineVersion).toMatch(/^attendance-engine\//);
    const ev = await h.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'payload']).where('aggregateId', '=', r.id).execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: 'attendance.created', payload: { employeeId: E1, date: '2026-03-10', status: 'PRESENT', flags: ['LATE'] } });
  });

  it('attributes the cross-midnight night shift (21:57 D, 06:08 D+1) to date D with CROSS_MIDNIGHT', async () => {
    expect(await recompute(E2, '2026-03-10')).toMatchObject({ outcome: 'created', status: 'PRESENT' });
    const r = await record(E2, '2026-03-10');
    expect(r).toMatchObject({ status: 'PRESENT', shiftId: SHIFT_N, punchCount: 2, workedMinutes: 491, lateMinutes: 0, earlyDepartureMinutes: 0, overtimeMinutes: 0 });
    expect(r.flags).toContain('CROSS_MIDNIGHT');
    expect(iso(r.firstInAt)).toBe('2026-03-10T17:57:00.000Z');
    expect(iso(r.lastOutAt)).toBe('2026-03-11T02:08:00.000Z');
    // D+1 gets nothing from those punches (it is the holiday anyway)
    await recompute(E2, '2026-03-11');
    expect(await record(E2, '2026-03-11')).toMatchObject({ status: 'HOLIDAY', punchCount: 0 });
  });

  it('HOLIDAY from the branch calendar, LEAVE from approved leave, WEEKLY_OFF on Friday', async () => {
    await recompute(E1, '2026-03-11');
    await recompute(E1, '2026-03-09');
    await recompute(E1, '2026-03-13');
    expect(await record(E1, '2026-03-11')).toMatchObject({ status: 'HOLIDAY', scheduledMinutes: 0 });
    expect(await record(E1, '2026-03-09')).toMatchObject({ status: 'LEAVE' });
    expect(await record(E1, '2026-03-13')).toMatchObject({ status: 'WEEKLY_OFF' });
    const trace = (await record(E1, '2026-03-11')).trace as { inputs: { holiday: string | null } };
    expect(trace.inputs.holiday).toBe('Test Holiday');
  });

  it('ABSENT for a past working day without punches, PENDING for today (window still open)', async () => {
    await recompute(E1, '2026-03-17');
    await recompute(E1, '2026-03-16');
    await recompute(E1, '2026-03-19');
    expect(await record(E1, '2026-03-17')).toMatchObject({ status: 'ABSENT', punchCount: 0 });
    expect(await record(E1, '2026-03-16')).toMatchObject({ status: 'ABSENT' });
    expect(await record(E1, '2026-03-19')).toMatchObject({ status: 'PENDING' });
  });

  it('computes regular overtime beyond the shift end in whole blocks', async () => {
    await recompute(E1, '2026-03-18');
    const r = await record(E1, '2026-03-18');
    expect(r).toMatchObject({ status: 'PRESENT', workedMinutes: 602, overtimeMinutes: 90, overtimeCategory: 'REGULAR', lateMinutes: 0 });
    expect(r.flags).toEqual(['OVERTIME']);
  });

  it('is idempotent: identical inputs → no version bump, no history, no new domain event', async () => {
    expect(await recompute(E1, '2026-03-10')).toMatchObject({ outcome: 'unchanged', version: 1 });
    const r = await record(E1, '2026-03-10');
    expect(r.calculationVersion).toBe(1);
    expect(await h.tdb.adminDb.selectFrom('attendanceDailyRecordHistory').select('id').where('recordId', '=', r.id).execute()).toHaveLength(0);
    expect(await h.tdb.adminDb.selectFrom('domainEvents').select('id').where('aggregateId', '=', r.id).execute()).toHaveLength(1);
  });

  it('loads engine inputs with adjacent shifts, rule set and employment placement', async () => {
    const loaded = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadDailyInputs(trx, ORG, E2, '2026-03-10', NOW));
    expect(loaded).not.toBeNull();
    expect(loaded!.input).toMatchObject({ timezone: MUSCAT, ruleSetId: RULES, weeklyOffDays: [5, 6], holiday: null, leave: null, employment: { joiningDate: '2025-01-01', exitDate: null, status: 'active' }, ramadanEligible: false, now: NOW.toISOString() });
    expect(loaded!.input.shift?.id).toBe(SHIFT_N);
    expect(loaded!.input.adjacentShifts?.previous?.id).toBe(SHIFT_N);
    expect(loaded!.input.events).toHaveLength(2);
    expect(loaded!.input.rules.graceInMinutes).toBe(10);
    expect(await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadDailyInputs(trx, ORG, '0a000000-0000-4000-a000-0000000000ee', '2026-03-10', NOW))).toBeNull();
  });
});

describe('corrections', () => {
  it('ADD_PUNCH inserts a CORRECTION event, marks the correction APPLIED and enqueues an immediate recompute', async () => {
    const a = h.tdb.adminDb;
    const c = await a.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH_A, attendanceDate: '2026-03-17', type: 'ADD_PUNCH', proposedPunchedAt: at('2026-03-17', '08:00'), proposedEventType: 'PUNCH_IN', reason: 'Forgot to punch in', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    // a debounced NEW_EVENT recompute is already waiting for the same (employee, date) — it must not swallow the immediate correction recompute
    await enqueueRecompute(h.deps.queue, { organizationId: ORG, employeeId: E1, date: '2026-03-17', reason: 'NEW_EVENT', runAt: new Date(NOW.getTime() + 30_000) });
    const res = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c.id, { queue: h.deps.queue, appliedBy: OWNER, now: NOW }));
    expect(res).toMatchObject({ status: 'APPLIED', voidedEventId: null, recomputeDates: ['2026-03-17'] });
    const ev = await a.selectFrom('attendanceEvents').selectAll().where('id', '=', res.appliedEventId!).executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ employeeId: E1, branchId: BRANCH_A, source: 'CORRECTION', eventType: 'PUNCH_IN', correctionId: c.id, verificationMethod: 'manual', createdBy: OWNER });
    const corr = await a.selectFrom('attendanceCorrections').selectAll().where('id', '=', c.id).executeTakeFirstOrThrow();
    expect(corr).toMatchObject({ status: 'APPLIED', appliedEventId: res.appliedEventId, appliedBy: OWNER });
    expect(corr.appliedAt).not.toBeNull();
    // the debounced job keeps waiting; the correction gets its own immediate job with the CORRECTION reason
    const debounced = await pendingJobs(recomputeDedupeKey(E1, '2026-03-17'));
    expect(debounced).toHaveLength(1);
    expect(debounced[0]).toMatchObject({ payload: { reason: 'NEW_EVENT' }, runAt: new Date(NOW.getTime() + 30_000) });
    const immediate = await pendingJobs(recomputeDedupeKey(E1, '2026-03-17', true));
    expect(immediate).toHaveLength(1);
    expect(immediate[0]).toMatchObject({ payload: { reason: 'CORRECTION', triggeredBy: OWNER }, runAt: NOW });
    // applying a correction is audited (who applied what, which events were created/voided)
    const audit = await a.selectFrom('audit.logs').selectAll().where('action', '=', 'attendance.correction_applied').where('entityId', '=', c.id).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: ORG, actorUserId: OWNER, actorType: 'USER', entityType: 'attendance_correction', branchId: BRANCH_A, reason: 'Forgot to punch in' });
    expect(audit[0]!.newValue).toMatchObject({ type: 'ADD_PUNCH', status: 'APPLIED', appliedEventId: res.appliedEventId, voidedEventId: null, employeeId: E1, attendanceDate: '2026-03-17' });
    // applying twice is idempotent
    expect((await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c.id, { queue: h.deps.queue, now: NOW }))).status).toBe('ALREADY_APPLIED');
  });

  it('recompute after the correction bumps the version, writes a CORRECTION history snapshot and flags MANUAL_CORRECTION', async () => {
    const before = await record(E1, '2026-03-17');
    expect(await recompute(E1, '2026-03-17', { reason: 'CORRECTION', triggeredBy: OWNER })).toMatchObject({ outcome: 'updated', version: 2, status: 'PRESENT' });
    const r = await record(E1, '2026-03-17');
    expect(r).toMatchObject({ status: 'PRESENT', calculationVersion: 2, hasCorrection: true, punchCount: 1, workedMinutes: 0 });
    expect(r.flags).toEqual(['MISSING_OUT', 'MANUAL_CORRECTION']);
    const hist = await h.tdb.adminDb.selectFrom('attendanceDailyRecordHistory').selectAll().where('recordId', '=', r.id).execute();
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ reason: 'CORRECTION', calculationVersion: 1, employeeId: E1, branchId: BRANCH_A, triggeredBy: OWNER, jobId: '1' });
    expect((hist[0]!.snapshot as { status: string; id: string }).status).toBe('ABSENT');
    expect((hist[0]!.snapshot as { id: string }).id).toBe(before.id);
    const ev = await h.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'payload']).where('aggregateId', '=', r.id).orderBy('id').execute();
    expect(ev.map((e) => e.eventType)).toEqual(['attendance.created', 'attendance.updated']);
    expect(ev[1]!.payload).toMatchObject({ status: 'PRESENT', previousStatus: 'ABSENT', version: 2, reason: 'CORRECTION' });
  });

  it('SET_STATUS overrides the computed status on recompute with a MANUAL_OVERRIDE history reason and stays sticky', async () => {
    await recompute(E2, '2026-03-12');
    expect(await record(E2, '2026-03-12')).toMatchObject({ status: 'ABSENT' });
    const c = await h.tdb.adminDb.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E2, branchId: BRANCH_A, attendanceDate: '2026-03-12', type: 'SET_STATUS', proposedStatus: 'PRESENT', reason: 'Worked off-site', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    const res = await applyCorrectionHandler(ctx('APPLY_CORRECTION', { organizationId: ORG, correctionId: c.id, appliedBy: OWNER }));
    expect(res).toMatchObject({ status: 'APPLIED', appliedEventId: null });
    const job = await pendingJobs(recomputeDedupeKey(E2, '2026-03-12', true));
    expect(job[0]!.payload).toMatchObject({ reason: 'MANUAL_OVERRIDE' });
    expect(await recompute(E2, '2026-03-12', { reason: 'MANUAL_OVERRIDE' })).toMatchObject({ outcome: 'updated', version: 2, status: 'PRESENT' });
    const r = await record(E2, '2026-03-12');
    expect(r).toMatchObject({ status: 'PRESENT', hasCorrection: true, punchCount: 0 });
    expect(r.flags).toContain('MANUAL_CORRECTION');
    const hist = await h.tdb.adminDb.selectFrom('attendanceDailyRecordHistory').select('reason').where('recordId', '=', r.id).execute();
    expect(hist.map((x) => x.reason)).toEqual(['MANUAL_OVERRIDE']);
    expect(await recompute(E2, '2026-03-12')).toMatchObject({ outcome: 'unchanged', version: 2 });
  });

  it('REMOVE_PUNCH voids the original event (never deletes) and EDIT_PUNCH voids + re-adds', async () => {
    const a = h.tdb.adminDb;
    await recompute(E3, '2026-03-15');
    expect(await record(E3, '2026-03-15')).toMatchObject({ status: 'PRESENT', punchCount: 2 });
    const out15 = await a.selectFrom('attendanceEvents').select(['id']).where('employeeId', '=', E3).where('punchedAt', '=', at('2026-03-15', '17:00')).executeTakeFirstOrThrow();
    const c1 = await a.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E3, branchId: BRANCH_A, attendanceDate: '2026-03-15', type: 'REMOVE_PUNCH', originalEventId: out15.id, reason: 'Duplicate badge', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    const r1 = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c1.id, { queue: h.deps.queue, appliedBy: OWNER, now: NOW }));
    expect(r1).toMatchObject({ status: 'APPLIED', appliedEventId: null, voidedEventId: out15.id });
    const voided = await a.selectFrom('attendanceEvents').select(['voidedAt', 'voidedByCorrectionId']).where('id', '=', out15.id).executeTakeFirstOrThrow();
    expect(voided.voidedByCorrectionId).toBe(c1.id);
    expect(voided.voidedAt).not.toBeNull();
    expect(await recompute(E3, '2026-03-15', { reason: 'CORRECTION' })).toMatchObject({ outcome: 'updated', version: 2 });
    const rec = await record(E3, '2026-03-15');
    expect(rec).toMatchObject({ punchCount: 1, lastOutAt: null });
    expect(rec.flags).toContain('MISSING_OUT');
    // a voided punch is still a correction of this day: has_correction + MANUAL_CORRECTION come from the applied correction, not only from added events
    expect(rec.hasCorrection).toBe(true);
    expect(rec.flags).toContain('MANUAL_CORRECTION');
    expect((rec.trace as { steps: Array<{ step: string }> }).steps.some((s) => s.step === 'corrections')).toBe(true);
    // voiding again through another correction is rejected
    const c1b = await a.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E3, branchId: BRANCH_A, attendanceDate: '2026-03-15', type: 'REMOVE_PUNCH', originalEventId: out15.id, reason: 'Again', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    await expect(withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c1b.id, { queue: h.deps.queue, now: NOW }))).rejects.toMatchObject({ code: 'INVALID_STATE' });

    await recompute(E3, '2026-03-16');
    const out16 = await a.selectFrom('attendanceEvents').select(['id']).where('employeeId', '=', E3).where('punchedAt', '=', at('2026-03-16', '17:00', RIYADH)).executeTakeFirstOrThrow();
    const c2 = await a.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E3, branchId: BRANCH_B, attendanceDate: '2026-03-16', type: 'EDIT_PUNCH', originalEventId: out16.id, proposedPunchedAt: at('2026-03-16', '18:00', RIYADH), reason: 'Left at 18:00', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    const r2 = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c2.id, { queue: h.deps.queue, appliedBy: OWNER, now: NOW }));
    expect(r2.voidedEventId).toBe(out16.id);
    expect(r2.appliedEventId).not.toBeNull();
    const added = await a.selectFrom('attendanceEvents').selectAll().where('id', '=', r2.appliedEventId!).executeTakeFirstOrThrow();
    expect(added).toMatchObject({ source: 'CORRECTION', eventType: 'PUNCH', branchId: BRANCH_B });
    expect(iso(added.punchedAt)).toBe('2026-03-16T15:00:00.000Z');
    expect(await recompute(E3, '2026-03-16', { reason: 'CORRECTION' })).toMatchObject({ outcome: 'updated', version: 2 });
    expect(iso((await record(E3, '2026-03-16')).lastOutAt)).toBe('2026-03-16T15:00:00.000Z');
    // pending corrections cannot be applied
    const c3 = await a.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E3, branchId: BRANCH_B, attendanceDate: '2026-03-16', type: 'SET_STATUS', proposedStatus: 'LEAVE', reason: 'Not yet approved', requestedBy: OWNER, status: 'PENDING' }).returning('id').executeTakeFirstOrThrow();
    await expect(withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c3.id, { queue: h.deps.queue, now: NOW }))).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('employment history', () => {
  it('puts records under the new branch (and its timezone) from the effective date', async () => {
    const r15 = await record(E3, '2026-03-15');
    const r16 = await record(E3, '2026-03-16');
    expect(r15).toMatchObject({ branchId: BRANCH_A, timezone: MUSCAT, status: 'PRESENT' });
    expect(r16).toMatchObject({ branchId: BRANCH_B, timezone: RIYADH, status: 'PRESENT', lateMinutes: 0 });
    expect(iso(r16.expectedStartAt)).toBe('2026-03-16T05:00:00.000Z'); // 08:00 Riyadh
    expect(iso(r15.expectedStartAt)).toBe('2026-03-15T04:00:00.000Z'); // 08:00 Muscat
  });
});

describe('period locks and RECALCULATE_RANGE', () => {
  it('skips recompute inside a locked period unless bypassed', async () => {
    await h.tdb.adminDb.insertInto('attendancePeriodLocks').values({ organizationId: ORG, branchId: BRANCH_A, periodStart: '2026-03-01', periodEnd: '2026-03-07', lockedBy: OWNER, reason: 'Payroll run' }).execute();
    expect(await recompute(E1, '2026-03-05')).toMatchObject({ outcome: 'skipped_locked', branchId: BRANCH_A });
    expect(await h.tdb.adminDb.selectFrom('attendanceDailyRecords').select('id').where('employeeId', '=', E1).where('attendanceDate', '=', sql<Date>`'2026-03-05'::date`).execute()).toHaveLength(0);
    // unlock/recalc flows may bypass explicitly
    expect(await recompute(E1, '2026-03-05', { bypassLock: true, reason: 'UNLOCK' })).toMatchObject({ outcome: 'created', status: 'ABSENT' });
    // the lock also blocks corrections
    const c = await h.tdb.adminDb.insertInto('attendanceCorrections').values({ organizationId: ORG, employeeId: E1, branchId: BRANCH_A, attendanceDate: '2026-03-05', type: 'ADD_PUNCH', proposedPunchedAt: at('2026-03-05', '08:00'), reason: 'Locked period', requestedBy: OWNER, status: 'APPROVED' }).returning('id').executeTakeFirstOrThrow();
    await expect(withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => applyApprovedCorrection(trx, c.id, { queue: h.deps.queue, now: NOW }))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
  });

  it('scopes the period-lock bypass to the record write, not to the rest of the transaction', async () => {
    await expect(withContext(h.deps.db, { kind: 'system', organizationId: ORG }, async (trx) => {
      expect(await recomputeDaily(trx, { organizationId: ORG, employeeId: E1, date: '2026-03-05', now: NOW, reason: 'UNLOCK', bypassLock: true })).toMatchObject({ outcome: 'unchanged' });
      // the same transaction must not be able to touch another locked record afterwards
      await sql`update public.attendance_daily_records set punch_count = punch_count where employee_id = ${E1}::uuid and attendance_date = '2026-03-05'::date`.execute(trx);
    })).rejects.toMatchObject({ code: 'P0002' });
  });

  it('enqueueRecalculationForScope creates the request + job; the handler counts skippedLocked, completes and audits', async () => {
    const { requestId, jobId } = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) =>
      enqueueRecalculationForScope(trx, h.deps.queue, { organizationId: ORG, fromDate: '2026-03-05', toDate: '2026-03-07', employeeIds: [E1], reason: 'Rule set review', requestedBy: OWNER }));
    const q = await sql<{ jobType: string; payload: Record<string, unknown>; dedupeKey: string }>`select job_type as "jobType", payload, dedupe_key as "dedupeKey" from jobs.queue where id = ${jobId}::bigint`.execute(h.tdb.adminDb);
    expect(q.rows[0]).toMatchObject({ jobType: 'RECALCULATE_RANGE', payload: { organizationId: ORG, requestId }, dedupeKey: `recalculate:${requestId}` });
    let req = await h.tdb.adminDb.selectFrom('attendanceRecalculationRequests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ status: 'QUEUED', queueJobId: jobId, employeeIds: [E1] });

    const summary = await recalculateRange(ctx('RECALCULATE_RANGE', { organizationId: ORG, requestId }));
    expect(summary).toMatchObject({ employees: 1, dates: 3, recomputed: 0, changed: 0, skippedLocked: 3, errorCount: 0, errors: [] });
    req = await h.tdb.adminDb.selectFrom('attendanceRecalculationRequests').selectAll().where('id', '=', requestId).executeTakeFirstOrThrow();
    expect(req.status).toBe('COMPLETED');
    expect(req.finishedAt).not.toBeNull();
    expect(req.startedAt).not.toBeNull();
    expect(req.summary).toMatchObject({ skippedLocked: 3 });
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').selectAll().where('action', '=', 'attendance.recalculated').where('entityId', '=', requestId).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: ORG, actorUserId: OWNER, actorType: 'USER', reason: 'Rule set review' });
    // running the same request again is a no-op
    expect(await recalculateRange(ctx('RECALCULATE_RANGE', { organizationId: ORG, requestId }))).toEqual({ skipped: 'COMPLETED' });
  });

  it('recalculates an unlocked range (idempotent: unchanged records keep their version) and scopes by branch via employment history', async () => {
    const { requestId } = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) =>
      enqueueRecalculationForScope(trx, h.deps.queue, { organizationId: ORG, fromDate: '2026-03-09', toDate: '2026-03-11', employeeIds: [E1], reason: 'Idempotency check' }));
    const s1 = await recalculateRange(ctx('RECALCULATE_RANGE', { organizationId: ORG, requestId }));
    expect(s1).toMatchObject({ recomputed: 3, unchanged: 3, changed: 0, skippedLocked: 0 });
    expect((await record(E1, '2026-03-10')).calculationVersion).toBe(1);
    // branch B scope: E3 is included only through the employment history row effective 2026-03-16
    const { requestId: r2 } = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) =>
      enqueueRecalculationForScope(trx, h.deps.queue, { organizationId: ORG, fromDate: '2026-03-16', toDate: '2026-03-16', branchId: BRANCH_B, reason: 'Branch scope' }));
    const s2 = await recalculateRange(ctx('RECALCULATE_RANGE', { organizationId: ORG, requestId: r2 }));
    expect(s2).toMatchObject({ employees: 1, dates: 1, recomputed: 1, unchanged: 1 });
    const { requestId: r3 } = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) =>
      enqueueRecalculationForScope(trx, h.deps.queue, { organizationId: ORG, fromDate: '2026-03-14', toDate: '2026-03-14', reason: 'Everyone' }));
    expect(await recalculateRange(ctx('RECALCULATE_RANGE', { organizationId: ORG, requestId: r3 }))).toMatchObject({ employees: 3, dates: 1, recomputed: 3, created: 3 });
    expect((await record(E2, '2026-03-14')).status).toBe('WEEKLY_OFF');
  });
});

describe('BUILD_PERIOD_SUMMARY', () => {
  it('aggregates daily records into payroll totals and versions only on change', async () => {
    const res = await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-31', employeeIds: [E1] }));
    expect(res).toMatchObject({ employees: 1, built: 1, changed: 1, finalized: 0, pendingDays: 1 });
    const s = await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').selectAll().where('employeeId', '=', E1).executeTakeFirstOrThrow();
    // 03-05 ABSENT (bypass), 03-09 LEAVE, 03-10 PRESENT late 10, 03-11 HOLIDAY, 03-13 + 03-14 WEEKLY_OFF, 03-16 ABSENT, 03-17 PRESENT (missing out), 03-18 PRESENT OT 90, 03-19 PENDING
    expect(s).toMatchObject({ branchId: BRANCH_A, status: 'draft', version: 1, workingDays: 7, presentDays: '3.00', absentDays: '2.00', leaveDays: '1.00', paidLeaveDays: '1.00', holidayDays: 1, weeklyOffDays: 2, halfDays: 0, missingPunchDays: 1, lateDays: 1, lateMinutes: 10, overtimeMinutes: 90, overtimeWeeklyOffMinutes: 0, overtimeHolidayMinutes: 0, regularMinutes: 465 + 512, earlyDepartureMinutes: 0 });
    const versions = s.recordVersions as Record<string, number>;
    expect(Object.keys(versions)).toHaveLength(10);
    expect(versions[(await record(E1, '2026-03-17')).id]).toBe(2);
    // unchanged rebuild keeps the version
    expect(await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-31', employeeIds: [E1] }))).toMatchObject({ built: 0, unchanged: 1, changed: 0 });
    expect((await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').select('version').where('id', '=', s.id).executeTakeFirstOrThrow()).version).toBe(1);
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').select(['action', 'actorType']).where('action', '=', 'payroll.summary_built').execute();
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit[0]!.actorType).toBe('SYSTEM');
  });

  it('scopes a branch build by employee, aggregating all of a transferred employee\'s records in the period', async () => {
    // E3 moved A → B on 03-16: 03-14 WEEKLY_OFF (A), 03-15 PRESENT with a voided OUT (A), 03-16 PRESENT (B). A branch-B build must not overwrite the
    // employee's single (employee, period) summary with a partial one built from the branch-B records only.
    const res = await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-31', branchId: BRANCH_B }));
    expect(res).toMatchObject({ employees: 1, built: 1 });
    const s = await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').selectAll().where('employeeId', '=', E3).where('periodStart', '=', sql<Date>`'2026-03-01'::date`).executeTakeFirstOrThrow();
    expect(s).toMatchObject({ branchId: BRANCH_B, workingDays: 2, presentDays: '2.00', weeklyOffDays: 1, missingPunchDays: 1 });
    expect(Object.keys(s.recordVersions as Record<string, number>)).toHaveLength(3);
    // E1/E2 have no branch-B records → untouched
    expect(await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').select('employeeId').where('employeeId', '=', E2).execute()).toHaveLength(0);
  });

  it('finalize requires an active period lock covering the whole period and no PENDING days, then stamps finalized_by/at', async () => {
    const march = { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-31', employeeIds: [E1], finalize: true, requestedBy: OWNER };
    // only 03-01..03-07 is locked for branch A → not enough
    await expect(buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', march))).rejects.toSatisfy((e: unknown) => AppError.is(e) && e.code === 'INVALID_STATE' && e.retryable === false);
    await h.tdb.adminDb.insertInto('attendancePeriodLocks').values({ organizationId: ORG, branchId: null, periodStart: '2026-03-01', periodEnd: '2026-03-31', lockedBy: OWNER, reason: 'March payroll' }).execute();
    // 03-19 (today) is still PENDING → payroll cannot be finalised over an unknown day; nothing is written
    await expect(buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', march))).rejects.toSatisfy((e: unknown) => AppError.is(e) && e.code === 'INVALID_STATE' && (e.details as { pending: unknown[] }).pending.length === 1);
    expect((await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').selectAll().where('employeeId', '=', E1).where('periodStart', '=', sql<Date>`'2026-03-01'::date`).executeTakeFirstOrThrow()).status).toBe('draft');
    // a period without pending days finalises under the (wider) lock
    const payload = { ...march, periodEnd: '2026-03-18' };
    expect(await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', payload))).toMatchObject({ built: 1, finalized: 1, changed: 1, pendingDays: 0 });
    const s = await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').selectAll().where('employeeId', '=', E1).where('periodEnd', '=', sql<Date>`'2026-03-18'::date`).executeTakeFirstOrThrow();
    expect(s).toMatchObject({ status: 'finalized', finalizedBy: OWNER, version: 1, presentDays: '3.00' });
    expect(s.finalizedAt).not.toBeNull();
    // a finalized summary is not silently rebuilt
    expect(await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-18', employeeIds: [E1] }))).toMatchObject({ skippedFinalized: 1, built: 0 });
    // and the month-wide lock now blocks recomputes
    expect(await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => recomputeDaily(trx, { organizationId: ORG, employeeId: E1, date: '2026-03-18', now: NOW, reason: 'RECALCULATION' }))).toMatchObject({ outcome: 'skipped_locked' });
  });
});

describe('normalize-sweep task', () => {
  it('enqueues one deduped NORMALIZE_RAW per organisation with pending raw rows', async () => {
    const task = attendanceTasks.find((t) => t.name === 'normalize-sweep')!;
    expect(task.everyMs).toBe(60_000);
    expect(await task.run(h.deps)).toEqual({ organizations: 0 });
    await insertRaw([{ deviceUserId: '102', punchedAt: at('2026-04-01', '08:00'), direction: 'in' }]);
    expect(await task.run(h.deps)).toEqual({ organizations: 1 });
    expect(await task.run(h.deps)).toEqual({ organizations: 1 }); // still pending → same job (dedupe)
    const jobs = await sql<{ n: string }>`select count(*) as n from jobs.queue where job_type = 'NORMALIZE_RAW' and dedupe_key = ${`normalize:${ORG}`}`.execute(h.tdb.adminDb);
    expect(jobs.rows[0]!.n).toBe('1');
    // the queued job resolves the new punch through employees.device_user_id ('102' → E2)
    expect(await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }))).toMatchObject({ fetched: 1, normalized: 1, events: 1 });
    expect(await task.run(h.deps)).toEqual({ organizations: 0 });
  });
});

describe('normaliser neighbour dates and sources', () => {
  it('derives the D−1 / D+1 recompute reach from the organisation\'s shifts (punch windows), not from a fixed noon rule', async () => {
    const a = h.tdb.adminDb;
    // a 20:00–08:00 shift whose punch-out window reaches 18:00 on D+1, and a 01:00 shift whose punch-in window starts 21:00 on D−1
    await a.insertInto('shifts').values([
      { organizationId: ORG, code: 'LATE', name: 'Late night 20:00–08:00', type: 'FIXED', startTime: '20:00', endTime: '08:00', punchOutWindowAfterMinutes: 600, breaks: JSON.stringify([]) },
      { organizationId: ORG, code: 'EARLY', name: 'Early 01:00–09:00', type: 'FIXED', startTime: '01:00', endTime: '09:00', punchInWindowBeforeMinutes: 240, breaks: JSON.stringify([]) },
    ]).execute();
    await insertRaw([
      { deviceUserId: 'X202', punchedAt: at('2026-04-03', '13:00') }, // may close the 20:00–08:00 shift of 04-02 → recompute 04-02 too
      { deviceUserId: 'X202', punchedAt: at('2026-04-03', '22:00') }, // may open the 01:00 shift of 04-04 → recompute 04-04 too
      { deviceUserId: 'X202', punchedAt: at('2026-04-03', '19:00') }, // inside neither neighbouring window → 04-03 only
    ]);
    const res = await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    expect(res).toMatchObject({ fetched: 3, normalized: 3, events: 3, recomputeJobs: 3 });
    // (the sweep test above already queued 04-01 for the 04-01 08:00 punch)
    const keys = (await sql<{ k: string }>`select dedupe_key as k from jobs.queue where job_type = 'RECOMPUTE_DAILY' and status = 'pending' and dedupe_key like ${`recompute:${E2}:2026-04-%`} and dedupe_key <> ${recomputeDedupeKey(E2, '2026-04-01')} order by 1`.execute(a)).rows.map((r) => r.k);
    expect(keys).toEqual([recomputeDedupeKey(E2, '2026-04-02'), recomputeDedupeKey(E2, '2026-04-03'), recomputeDedupeKey(E2, '2026-04-04')]);
  });

  it('keeps the raw source on the event (IMPORT/MANUAL are not device punches)', async () => {
    await insertRaw([{ deviceUserId: '101', punchedAt: at('2026-04-06', '08:00'), direction: 'in', source: 'IMPORT' }]);
    expect(await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }))).toMatchObject({ fetched: 1, events: 1 });
    const ev = await h.tdb.adminDb.selectFrom('attendanceEvents').select(['source', 'eventType']).where('employeeId', '=', E1).where('punchedAt', '=', at('2026-04-06', '08:00')).executeTakeFirstOrThrow();
    expect(ev).toEqual({ source: 'IMPORT', eventType: 'PUNCH_IN' });
  });
});

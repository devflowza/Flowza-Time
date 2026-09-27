import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { defaultRegistry } from '@flowza/device-providers';
import { DEFAULT_ATTENDANCE_SETTINGS } from '@flowza/contracts';
import { AUTO_CHARGE_NOTE, markDay, withContext } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { relayOutbox } from '../notifications/outbox.js';
import { normalizeRaw } from './normalize.js';
import { recomputeDailyHandler } from './recompute.js';
import { buildPeriodSummaryHandler } from './period-summary.js';
import { loadDailyInputs, punchPayloadOf } from './load-inputs.js';
import { assessDay, dayCloseHandler, dayCloseRecipients, DAY_CLOSE_JOB_TYPE } from './day-close.js';
import { attendanceTasks } from './tasks.js';
import { isoDate } from './common.js';

/**
 * Attendance policy parity (HR portal Prompt 3), worker side: the day-close sweep (grace, idempotency, leave / lock /
 * excuse skips, auto-deduction through the pay-effect charger, targeted notifications), the recompute folding day marks
 * into the record, the period-summary columns, the default-shift fallback and the self-service punch facts.
 */
const ORG = '0b000000-0000-4000-a000-000000000001';
const OWNER = 'b0000000-0000-4000-a000-000000000001';
const HR = 'b0000000-0000-4000-a000-000000000002';
const UM = 'b0000000-0000-4000-a000-000000000003'; // line manager (role `manager`) linked to EM
const U1 = 'b0000000-0000-4000-a000-000000000004'; // E1's own login (role `employee`)
const BM_B = 'b0000000-0000-4000-a000-000000000005'; // branch manager of branch B only
const BRANCH_A = '0b000000-0000-4000-a000-00000000000a';
const BRANCH_B = '0b000000-0000-4000-a000-00000000000b';
const DEVICE = '0b000000-0000-4000-a000-0000000000d1';
const EM = '0b000000-0000-4000-a000-0000000000e0'; // manager of E1 and E2
const E1 = '0b000000-0000-4000-a000-0000000000e1';
const E2 = '0b000000-0000-4000-a000-0000000000e2';
const E3 = '0b000000-0000-4000-a000-0000000000e3'; // branch B, no manager
const E4 = '0b000000-0000-4000-a000-0000000000e4'; // branch A, no manager, no login — auto-deduction
const E5 = '0b000000-0000-4000-a000-0000000000e5'; // engine inputs
const SHIFT_M = '0b000000-0000-4000-a000-0000000000a1';
const RULES = '0b000000-0000-4000-a000-0000000000f1';
const AL = '0b000000-0000-4000-a000-00000000001a';
const CL = '0b000000-0000-4000-a000-00000000001b';
const SL = '0b000000-0000-4000-a000-00000000001c';
const MUSCAT = 'Asia/Muscat';
/** Thursday 2026-03-12 10:00 Muscat. Weekly off Fri/Sat: 03-02 Mon … 03-05 Thu, 03-06 Fri, 03-08 Sun … 03-11 Wed. */
const NOW = new Date('2026-03-12T06:00:00Z');

let h: TestHarness;
let rawSeq = 0;
const at = (date: string, time: string): Date => DateTime.fromISO(`${date}T${time}`, { zone: MUSCAT }).toJSDate();
const ctx = (jobType: string, payload: Record<string, unknown>) => ({ job: fakeJob(jobType, payload, ORG), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const sweep = (extra: Record<string, unknown> = {}) => dayCloseHandler(ctx(DAY_CLOSE_JOB_TYPE, { organizationId: ORG, ...extra }));
const recompute = (employeeId: string, date: string) => recomputeDailyHandler(ctx('RECOMPUTE_DAILY', { organizationId: ORG, employeeId, date }));
const setAttendanceSettings = (value: Record<string, unknown>) => h.tdb.adminDb.updateTable('organizationSettings').set({ attendance: JSON.stringify(value) }).where('organizationId', '=', ORG).execute();
const record = (employeeId: string, date: string) => h.tdb.adminDb.selectFrom('attendanceDailyRecords').selectAll().where('employeeId', '=', employeeId).where('attendanceDate', '=', sql<Date>`${date}::date`).executeTakeFirstOrThrow();
const seedRecord = (employeeId: string, date: string, status: 'ABSENT' | 'PRESENT', flags: string[], branchId = BRANCH_A) => h.tdb.adminDb.insertInto('attendanceDailyRecords')
  .values({ organizationId: ORG, employeeId, attendanceDate: date, branchId, timezone: MUSCAT, engineVersion: 'seed', status, flags, workedMinutes: status === 'PRESENT' ? 480 : 0, trace: JSON.stringify({}) }).execute();
const marksOf = (employeeId: string) => h.tdb.adminDb.selectFrom('attendanceDayMarks').selectAll().where('organizationId', '=', ORG).where('employeeId', '=', employeeId).where('revokedAt', 'is', null)
  .orderBy('attendanceDate').orderBy('kind').execute().then((rows) => rows.map((m) => ({ id: m.id, date: isoDate(m.attendanceDate), kind: m.kind, payEffectDays: Number(m.payEffectDays), source: m.source, createdBy: m.createdBy, reason: m.reason })));
const leavesOf = (employeeId: string) => h.tdb.adminDb.selectFrom('leaveRecords').selectAll().where('organizationId', '=', ORG).where('employeeId', '=', employeeId).orderBy('startDate').execute();
const events = () => h.tdb.adminDb.selectFrom('domainEvents').select(['aggregateId', 'payload']).where('eventType', '=', 'attendance.unexcused_marked').orderBy('id').execute();

async function insertRaw(rows: Array<{ deviceUserId: string; punchedAt: Date; direction: 'in' | 'out'; payload?: Record<string, unknown> }>) {
  await h.tdb.adminDb.insertInto('attendanceRawTransactions').values(rows.map((r) => ({
    organizationId: ORG, deviceId: DEVICE, branchId: BRANCH_A, providerKey: 'mock', providerTransactionId: `pp-${++rawSeq}`, deviceEmployeeId: r.deviceUserId, punchedAt: r.punchedAt,
    verificationMethod: 'face', direction: r.direction, rawPayload: JSON.stringify(r.payload ?? {}), source: 'MANUAL' as const, dedupeHash: `pp-hash-${rawSeq}`, processingStatus: 'pending' as const,
  }))).execute();
}

beforeAll(async () => {
  h = await createHarness(`flowza_worker_parity_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  const users: Array<[string, string]> = [[OWNER, 'owner'], [HR, 'hr'], [UM, 'manager'], [U1, 'e1'], [BM_B, 'bm-b']];
  for (const [id, n] of users) {
    await sql`insert into auth.users (id, email) values (${id}, ${`${n}@parity.local`})`.execute(a);
    await a.insertInto('userProfiles').values({ id, email: `${n}@parity.local`, fullName: n }).execute();
  }
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'PAR', legalName: 'Parity', displayName: 'Parity', timezone: MUSCAT, weeklyOffDays: [5, 6] }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).onConflict((oc) => oc.doNothing()).execute();
  await a.insertInto('branches').values([
    { id: BRANCH_A, organizationId: ORG, code: 'A', name: 'Branch A', timezone: MUSCAT },
    { id: BRANCH_B, organizationId: ORG, code: 'B', name: 'Branch B', timezone: MUSCAT },
  ]).execute();
  await a.insertInto('shifts').values({ id: SHIFT_M, organizationId: ORG, code: 'MORNING', name: 'Morning 08:00–17:00', type: 'FIXED', startTime: '08:00', endTime: '17:00', breaks: JSON.stringify([{ start: '13:00', end: '14:00', paid: false }]) }).execute();
  await a.insertInto('shiftAssignments').values({ organizationId: ORG, targetType: 'ORGANIZATION', targetId: ORG, shiftId: SHIFT_M, effectiveFrom: '2026-01-01' }).execute();
  await a.insertInto('attendanceRuleSets').values({ id: RULES, organizationId: ORG, name: 'Default', effectiveFrom: '2025-01-01', ramadanMode: JSON.stringify({}) }).execute();
  await a.insertInto('leaveTypes').values([
    { id: AL, organizationId: ORG, code: 'AL', name: 'Annual', isPaid: true, annualAllowanceDays: 1 },
    { id: CL, organizationId: ORG, code: 'CL', name: 'Casual', isPaid: true, annualAllowanceDays: 0.5 },
    { id: SL, organizationId: ORG, code: 'SL', name: 'Sick', isPaid: true, annualAllowanceDays: 10 },
  ]).execute();
  const emp = (id: string, n: string, branchId: string, managerEmployeeId: string | null = null) => ({ id, organizationId: ORG, employeeNumber: n, firstName: 'F', lastName: n, displayName: `F ${n}`, joiningDate: '2025-01-01', branchId, deviceUserId: `20${n.slice(-1)}`, managerEmployeeId, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values(emp(EM, 'EM0', BRANCH_A)).execute();
  await a.insertInto('employees').values([emp(E1, 'E1', BRANCH_A, EM), emp(E2, 'E2', BRANCH_A, EM), emp(E3, 'E3', BRANCH_B), emp(E4, 'E4', BRANCH_A), emp(E5, 'E5', BRANCH_A)]).execute();
  await a.insertInto('employmentHistory').values([EM, E1, E2, E4, E5].map((employeeId) => ({ organizationId: ORG, employeeId, effectiveFrom: '2025-01-01', branchId: BRANCH_A, employmentType: 'full_time' as const, employmentStatus: 'active' as const }))
    .concat([{ organizationId: ORG, employeeId: E3, effectiveFrom: '2025-01-01', branchId: BRANCH_B, employmentType: 'full_time' as const, employmentStatus: 'active' as const }])).execute();
  await a.insertInto('orgMemberships').values([
    { organizationId: ORG, userId: OWNER, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true },
    { organizationId: ORG, userId: HR, roleId: '10000000-0000-0000-0000-000000000003', status: 'active', allBranches: true },
    { organizationId: ORG, userId: UM, roleId: '10000000-0000-0000-0000-000000000009', status: 'active', allBranches: true, employeeId: EM },
    { organizationId: ORG, userId: U1, roleId: '10000000-0000-0000-0000-000000000008', status: 'active', allBranches: true, employeeId: E1 },
  ]).execute();
  const bm = await a.insertInto('orgMemberships').values({ organizationId: ORG, userId: BM_B, roleId: '10000000-0000-0000-0000-000000000005', status: 'active', allBranches: false }).returning('id').executeTakeFirstOrThrow();
  await a.insertInto('membershipBranches').values({ membershipId: bm.id, branchId: BRANCH_B }).execute();
  await a.insertInto('devices').values({ id: DEVICE, organizationId: ORG, branchId: BRANCH_A, code: 'D1', name: 'Gate', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'VENDOR_CLOUD_PULL', timezone: MUSCAT }).execute();

  // the sweep's first scenario (see the first test)
  await seedRecord(E1, '2026-03-02', 'ABSENT', []);
  await seedRecord(E1, '2026-03-03', 'PRESENT', ['LATE']);
  await seedRecord(E1, '2026-03-04', 'PRESENT', []);
  await seedRecord(E1, '2026-03-10', 'ABSENT', []); // inside the grace period on 03-12
  await seedRecord(E2, '2026-03-02', 'PRESENT', ['MISSING_OUT']);
  await seedRecord(E2, '2026-03-03', 'ABSENT', []);
  await a.insertInto('leaveRecords').values({ organizationId: ORG, employeeId: E2, branchId: BRANCH_A, leaveTypeId: SL, startDate: '2026-03-03', endDate: '2026-03-03', status: 'APPROVED', approvedBy: HR, approvedAt: NOW }).execute();
  await seedRecord(E3, '2026-03-02', 'ABSENT', [], BRANCH_B);
  await seedRecord(E3, '2026-03-03', 'ABSENT', [], BRANCH_B);
  await a.insertInto('attendancePeriodLocks').values({ organizationId: ORG, branchId: BRANCH_B, periodStart: '2026-03-02', periodEnd: '2026-03-02', lockedBy: OWNER }).execute();
  await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => markDay(trx, h.deps.queue, { organizationId: ORG, employeeId: E3, attendanceDate: '2026-03-03', kind: 'EXCUSED', source: 'HR', reason: 'Client visit', createdBy: HR }, { now: NOW }));
});
afterAll(async () => { await h?.close(); });

describe('assessDay', () => {
  it('weighs absent / late / missing punch by the policy and lets the largest weight win', () => {
    const s = DEFAULT_ATTENDANCE_SETTINGS;
    expect(assessDay('ABSENT', [], s)).toEqual({ cause: 'ABSENT', payEffectDays: 1 });
    expect(assessDay('PRESENT', ['LATE'], s)).toEqual({ cause: 'LATE', payEffectDays: 0.5 });
    expect(assessDay('PRESENT', ['MISSING_OUT'], s)).toEqual({ cause: 'MISSING_PUNCH', payEffectDays: 0.5 });
    expect(assessDay('PRESENT', ['LATE', 'MISSING_OUT'], { ...s, unexcused: { ...s.unexcused, payEffectMissingPunch: 1 } })).toEqual({ cause: 'MISSING_PUNCH', payEffectDays: 1 });
    expect(assessDay('PRESENT', ['MISSING_IN'], { ...s, missedPunch: { ...s.missedPunch, detectionEnabled: false } })).toBeNull();
    expect(assessDay('PRESENT', [], s)).toBeNull();
  });
});

describe('day-close sweep', () => {
  it('marks unexplained days past the grace period, skips leave / locked / excused / recent days and notifies the employee and the line manager', async () => {
    const summary = await sweep();
    expect(summary).toEqual({ asOf: '2026-03-12', cutoff: '2026-03-09', fromDate: '2026-02-06', candidates: 6, marked: 3, chargedLeave: 0, lop: 0, alreadyMarked: 1, skippedLocked: 1, skippedLeave: 1, skippedDisabled: 0, errors: 0, employees: 2, capped: false });
    const e1 = await marksOf(E1);
    expect(e1.map((m) => [m.date, m.kind, m.payEffectDays, m.source, m.createdBy])).toEqual([['2026-03-02', 'UNEXCUSED', 1, 'SWEEP', null], ['2026-03-03', 'UNEXCUSED', 0.5, 'SWEEP', null]]);
    expect(e1[0]!.reason).toMatch(/^Day close: absent on 2026-03-02 left unexplained after 3 day\(s\)$/);
    expect((await marksOf(E2)).map((m) => [m.date, m.kind, m.payEffectDays])).toEqual([['2026-03-02', 'UNEXCUSED', 0.5]]);
    expect((await marksOf(E3)).map((m) => [m.date, m.kind])).toEqual([['2026-03-03', 'EXCUSED']]); // locked 03-02 untouched, excused 03-03 not re-judged
    expect(await leavesOf(E1)).toEqual([]); // auto-deduction is off by default: marking only
    // each marked day's recompute is queued in the same transaction
    const jobs = await sql<{ dedupeKey: string; reason: string }>`select dedupe_key as "dedupeKey", payload->>'reason' as reason from jobs.queue where job_type = 'RECOMPUTE_DAILY' and organization_id = ${ORG} and dedupe_key not like ${`recompute:${E3}%`} order by dedupe_key`.execute(h.tdb.adminDb);
    expect(jobs.rows).toEqual([
      { dedupeKey: `recompute:${E1}:2026-03-02`, reason: 'RECALCULATION' }, { dedupeKey: `recompute:${E1}:2026-03-03`, reason: 'RECALCULATION' }, { dedupeKey: `recompute:${E2}:2026-03-02`, reason: 'RECALCULATION' },
    ]);
    // one event per employee, targeted: the employee's login + the line manager holding attendance.approve
    const evs = await events();
    expect(evs.map((e) => [e.aggregateId, e.payload])).toEqual([
      [E1, { employeeId: E1, dates: ['2026-03-02', '2026-03-03'], count: 2, autoDeduct: false, userIds: [UM, U1].sort() }],
      [E2, { employeeId: E2, dates: ['2026-03-02'], count: 1, autoDeduct: false, userIds: [UM] }],
    ]);
    expect(await h.tdb.adminDb.selectFrom('audit.logs').select('action').where('action', '=', 'attendance.day_close_swept').execute()).toHaveLength(1);
    // the outbox relay turns them into in-app notifications for exactly those users
    await relayOutbox({ job: fakeJob('RELAY_OUTBOX'), log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
    const notes = await h.tdb.adminDb.selectFrom('notifications').select(['userId', 'type', 'title']).where('type', '=', 'attendance.unexcused_marked').orderBy('userId').orderBy('createdAt').execute();
    expect(notes.map((n) => n.userId).sort()).toEqual([UM, UM, U1].sort());
    expect(notes.find((n) => n.userId === U1)?.title).toBe('2 attendance days marked unexcused');
  });

  it('is idempotent: a second run marks nothing and emits nothing', async () => {
    const summary = await sweep();
    expect(summary).toMatchObject({ candidates: 6, marked: 0, alreadyMarked: 4, skippedLocked: 1, skippedLeave: 1, employees: 0, errors: 0 });
    expect((await marksOf(E1)).length + (await marksOf(E2)).length).toBe(3);
    expect(await events()).toHaveLength(2);
  });

  it('routes a manager-less employee to the approvers who can open their records (branch scope), never to other teams\' line managers', async () => {
    const recipients = (employeeId: string) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => dayCloseRecipients(trx, ORG, employeeId));
    expect(await recipients(E3)).toEqual([OWNER, HR, BM_B].sort()); // branch B: the branch manager of B joins, the line manager UM does not
    expect(await recipients(E4)).toEqual([OWNER, HR].sort());
    expect(await recipients(E1)).toEqual([UM, U1].sort());
  });

  it('auto-deducts when enabled — paid leave in priority order, then LOP — and the recompute folds the marks into the records and the period summary', async () => {
    await setAttendanceSettings({ unexcused: { autoDeductEnabled: true } });
    await seedRecord(E4, '2026-03-02', 'ABSENT', []);
    await seedRecord(E4, '2026-03-03', 'ABSENT', []);
    await seedRecord(E4, '2026-03-04', 'PRESENT', ['LATE']);
    const summary = await sweep();
    expect(summary).toMatchObject({ marked: 3, chargedLeave: 2, lop: 1, errors: 0, employees: 1 });
    const marks = await marksOf(E4);
    expect(marks.map((m) => [m.date, m.kind, m.payEffectDays, m.source])).toEqual([
      ['2026-03-02', 'PAY_EFFECT', 1, 'SWEEP'], ['2026-03-02', 'UNEXCUSED', 1, 'SWEEP'], // AL (priority 1) had one day
      ['2026-03-03', 'LOP', 1, 'SWEEP'], ['2026-03-03', 'UNEXCUSED', 1, 'SWEEP'], // AL used up, CL's half day is not enough → loss of pay
      ['2026-03-04', 'PAY_EFFECT', 0.5, 'SWEEP'], ['2026-03-04', 'UNEXCUSED', 0.5, 'SWEEP'], // late → half a day of CL
    ]);
    const leaves = await leavesOf(E4);
    expect(leaves.map((l) => [l.leaveTypeId, l.status, l.source, l.isHalfDay, l.halfDayPart, l.approvedBy, l.decisionNote])).toEqual([
      [AL, 'APPROVED', 'INTERNAL', false, null, null, AUTO_CHARGE_NOTE], [CL, 'APPROVED', 'INTERNAL', true, 'FIRST_HALF', null, AUTO_CHARGE_NOTE],
    ]);
    expect(leaves.map((l) => l.externalRef)).toEqual([`mark:${marks[0]!.id}`, `mark:${marks[4]!.id}`]);
    expect((await events()).at(-1)?.payload).toMatchObject({ employeeId: E4, count: 3, autoDeduct: true, userIds: [OWNER, HR].sort() });

    // HR excuses Thursday; Friday (weekly off) was worked 09:00–13:00
    await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => markDay(trx, h.deps.queue, { organizationId: ORG, employeeId: E4, attendanceDate: '2026-03-05', kind: 'EXCUSED', source: 'HR', reason: 'Approved absence', createdBy: HR }, { now: NOW }));
    await insertRaw([{ deviceUserId: '204', punchedAt: at('2026-03-06', '09:00'), direction: 'in' }, { deviceUserId: '204', punchedAt: at('2026-03-06', '13:00'), direction: 'out' }]);
    expect(await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }))).toMatchObject({ normalized: 2 });
    for (const d of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']) await recompute(E4, d);

    const r2 = await record(E4, '2026-03-02');
    expect(r2.status).toBe('LEAVE');
    expect(r2.flags).toEqual(expect.arrayContaining(['UNEXCUSED', 'PAY_EFFECT_FULL']));
    expect(r2.flags).not.toContain('LOP');
    const r3 = await record(E4, '2026-03-03');
    expect(r3.status).toBe('ABSENT');
    expect(r3.flags).toEqual(expect.arrayContaining(['UNEXCUSED', 'LOP', 'PAY_EFFECT_FULL']));
    const r4 = await record(E4, '2026-03-04');
    expect(r4.flags).toEqual(expect.arrayContaining(['UNEXCUSED', 'PAY_EFFECT_HALF']));
    expect(r4.flags).not.toContain('LOP');
    const r5 = await record(E4, '2026-03-05');
    expect(r5.status).toBe('ABSENT'); // the excuse keeps the fact on the record…
    expect(r5.flags).toContain('EXCUSED'); // …and waives its consequence
    expect(r5.flags).not.toContain('UNEXCUSED');
    const r6 = await record(E4, '2026-03-06');
    expect(r6.status).toBe('WEEKLY_OFF');
    expect(r6.flags).toEqual(expect.arrayContaining(['WORKED_ON_WEEKLY_OFF', 'NON_WORKING_DAY_WORK']));
    expect([r6.workedMinutes, r6.overtimeMinutes]).toEqual([240, 0]); // nonWorkingDay.action = record (default): minutes kept, no overtime

    // the sweep no longer sees the recomputed days (their flags carry the marks)
    expect(await sweep()).toMatchObject({ marked: 0, candidates: 6 });

    await buildPeriodSummaryHandler(ctx('BUILD_PERIOD_SUMMARY', { organizationId: ORG, periodStart: '2026-03-01', periodEnd: '2026-03-31', employeeIds: [E4] }));
    const s = await h.tdb.adminDb.selectFrom('attendancePeriodSummaries').selectAll().where('organizationId', '=', ORG).where('employeeId', '=', E4).executeTakeFirstOrThrow();
    expect([Number(s.lopDays), s.unexcusedDays, s.excusedDays, s.nonWorkingDayWorkMinutes]).toEqual([1, 3, 1, 240]);
  });

  it('honours the grace settings and the missed-punch switch', async () => {
    await setAttendanceSettings({ missedPunch: { detectionEnabled: false, dayCloseGraceDays: 0 }, unexcused: { graceDays: 1 } });
    await seedRecord(E2, '2026-03-09', 'PRESENT', ['MISSING_IN']);
    await seedRecord(E2, '2026-03-11', 'ABSENT', []);
    const summary = await sweep();
    expect(summary).toMatchObject({ cutoff: '2026-03-11', marked: 2, skippedDisabled: 1, errors: 0 });
    expect((await marksOf(E1)).map((m) => m.date)).toContain('2026-03-10');
    expect((await marksOf(E2)).map((m) => m.date)).toEqual(['2026-03-02', '2026-03-11']); // the missing punch of 03-09 is not judged while detection is off
    await setAttendanceSettings({});
  });

  it('the scheduler enqueues one deduplicated day-close job per organisation, in the hour after local midnight', async () => {
    const task = attendanceTasks.find((t) => t.name === 'attendance.day-close')!;
    expect(task.everyMs).toBe(3_600_000);
    const at = (iso: string) => ({ ...h.deps, now: () => new Date(iso) });
    expect(await task.run(at('2026-03-12T06:00:00Z'))).toEqual({ organizations: 1, enqueued: 0 }); // 10:00 in Muscat: not the day-close hour
    expect(await task.run(at('2026-03-11T21:10:00Z'))).toEqual({ organizations: 1, enqueued: 1 }); // 01:10 on 03-12 in Muscat
    expect(await task.run(at('2026-03-11T21:50:00Z'))).toEqual({ organizations: 1, enqueued: 1 }); // a second tick in the hour: same pending job
    const jobs = await sql<{ n: string; payload: Record<string, unknown> }>`select count(*) over () as n, payload from jobs.queue where job_type = ${DAY_CLOSE_JOB_TYPE} and organization_id = ${ORG}`.execute(h.tdb.adminDb);
    expect(jobs.rows.map((r) => [r.n, r.payload])).toEqual([['1', { organizationId: ORG, asOf: '2026-03-12' }]]);
  });
});

describe('engine inputs', () => {
  it('falls back to settings.attendance.defaultShiftId where no assignment resolves', async () => {
    const load = (date: string) => withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadDailyInputs(trx, ORG, E5, date, NOW));
    const before = await load('2025-12-15'); // the organisation assignment starts 2026-01-01
    expect(before?.input.shift).toBeNull();
    await setAttendanceSettings({ defaultShiftId: SHIFT_M });
    const after = await load('2025-12-15');
    expect(after?.input.shift?.id).toBe(SHIFT_M);
    expect(after?.input.shiftAssignmentId).toBeNull(); // a fallback, not an assignment
    expect([after?.input.adjacentShifts?.previous?.id, after?.input.adjacentShifts?.next?.id]).toEqual([SHIFT_M, SHIFT_M]);
    await setAttendanceSettings({ defaultShiftId: '0b000000-0000-4000-a000-0000000000ff' }); // a deleted / unknown shift degrades to "no shift", never a failure
    expect((await load('2025-12-15'))?.input.shift).toBeNull();
    await setAttendanceSettings({});
  });

  it('turns the self-service facts of a punch payload into flags', async () => {
    await insertRaw([
      { deviceUserId: '205', punchedAt: at('2026-03-08', '08:05'), direction: 'in', payload: { channel: 'web', geofenceVerdict: 'flagged', outOfWindow: true, vendor: { channel: 'nope' } } },
      { deviceUserId: '205', punchedAt: at('2026-03-08', '17:00'), direction: 'out', payload: { channel: 'web' } },
    ]);
    await normalizeRaw(ctx('NORMALIZE_RAW', { organizationId: ORG }));
    const loaded = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadDailyInputs(trx, ORG, E5, '2026-03-08', NOW));
    expect(loaded?.input.events.map((e) => e.payload)).toEqual([{ channel: 'web', geofenceVerdict: 'flagged', outOfWindow: true }, { channel: 'web' }]);
    await recompute(E5, '2026-03-08');
    expect((await record(E5, '2026-03-08')).flags).toEqual(expect.arrayContaining(['SELF_SERVICE_PUNCH', 'OUTSIDE_GEOFENCE', 'OUT_OF_WINDOW']));
  });

  it('reads only the known payload keys with the expected shapes', () => {
    expect(punchPayloadOf({})).toBeNull();
    expect(punchPayloadOf(null)).toBeNull();
    expect(punchPayloadOf({ channel: 'kiosk', verify: 1 })).toBeNull(); // a vendor's own "channel" value is not a self-service channel
    expect(punchPayloadOf({ channel: 'mobile', geofence_verdict: 'denied_outside', is_mock: true, out_of_window: true })).toEqual({ channel: 'mobile', geofenceVerdict: 'denied_outside', isMock: true, outOfWindow: true });
    expect(punchPayloadOf({ verdict: 'x'.repeat(41), isMock: 'yes' })).toBeNull();
  });
});

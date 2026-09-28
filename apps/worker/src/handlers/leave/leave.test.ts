import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { compOffExpiryHandler, leaveTasks, leaveYearCloseHandler } from './index.js';

/**
 * Leave v2 worker jobs: the year close (carry-forward into next year's allocation rows — capped, floored to half days,
 * pending requests counted, leavers skipped, idempotent, a stale carry-forward cleared) and the comp-off expiry sweep, plus
 * their scheduler ticks (1 January / daily, in the organisation's local time, deduped).
 */
const ORG = '0f000000-0000-0000-0000-000000000000';
const BRANCH = '0f000000-0000-0000-0000-00000000000b';
const E = { a: '0f000000-0000-0000-0000-0000000000e1', b: '0f000000-0000-0000-0000-0000000000e2', leaver: '0f000000-0000-0000-0000-0000000000e3', c: '0f000000-0000-0000-0000-0000000000e4' };
const U = { a: 'f0000000-0000-0000-0000-000000000001' };
const TYPE = { al: '0f000000-0000-0000-0000-0000000000a1', sl: '0f000000-0000-0000-0000-0000000000a2', co: '0f000000-0000-0000-0000-0000000000a3' };
let clock = new Date('2026-09-28T06:00:00Z');
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_leave_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } }, () => clock);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${U.a}::uuid, 'a@t.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: U.a, email: 'a@t.local', fullName: 'Employee A' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'LVW', legalName: 'L', displayName: 'L', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }).execute();
  const emp = (id: string, n: number, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, branchId: BRANCH, employeeNumber: `E${n}`, firstName: `F${n}`, lastName: `L${n}`, displayName: `Employee ${n}`, joiningDate: '2024-01-01', deviceUserId: String(n), ...extra });
  await a.insertInto('employees').values([emp(E.a, 1), emp(E.b, 2), emp(E.leaver, 3, { exitDate: '2025-06-30', employmentStatus: 'resigned' }), emp(E.c, 4)]).execute();
  await a.insertInto('orgMemberships').values({ organizationId: ORG, userId: U.a, roleId: '10000000-0000-0000-0000-000000000008', status: 'active', allBranches: true, employeeId: E.a }).execute();
  await a.insertInto('leaveTypes').values([
    { id: TYPE.al, organizationId: ORG, code: 'AL', name: 'Annual', isPaid: true, annualAllowanceDays: 20, carryForwardMaxDays: 5, carryForwardExpiryMonths: 3 },
    { id: TYPE.sl, organizationId: ORG, code: 'SL', name: 'Sick', isPaid: true },
    { id: TYPE.co, organizationId: ORG, code: 'CO', name: 'Comp off', isPaid: true, isSpecial: true, portalVisible: false, systemKey: 'COMP_OFF' },
  ]).execute();
  // 2025: A took 12 of 20 (8 left → capped at 5); B has 18 pending (2 left); the leaver is gone; C used everything
  const leave = (employeeId: string, start: string, end: string, status: 'APPROVED' | 'PENDING') => ({ organizationId: ORG, employeeId, branchId: BRANCH, leaveTypeId: TYPE.al, startDate: start, endDate: end, status });
  await a.insertInto('leaveRecords').values([
    leave(E.a, '2025-03-02', '2025-03-13', 'APPROVED'), // Sun 2 – Thu 13 March: 10 working days
    leave(E.a, '2025-04-06', '2025-04-07', 'APPROVED'), // 2 more
    leave(E.b, '2025-11-02', '2025-11-26', 'PENDING'), // 19 working days … minus a Friday-Saturday count below
    leave(E.c, '2025-05-04', '2025-05-29', 'APPROVED'),
  ]).execute();
  await a.insertInto('leaveAllocations').values([
    { organizationId: ORG, employeeId: E.a, leaveTypeId: TYPE.al, branchId: BRANCH, year: 2025, allocatedDays: 20 },
    // C was carried 3 days by an earlier run that no longer holds (they used the rest since)
    { organizationId: ORG, employeeId: E.c, leaveTypeId: TYPE.al, branchId: BRANCH, year: 2026, allocatedDays: 20, carriedForwardDays: 3, carriedForwardExpiresOn: '2026-03-31' },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

const job = (type: string, payload: Record<string, unknown>) => ({ job: fakeJob(type, payload, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const alloc = (employeeId: string, year: number) => h.tdb.adminDb.selectFrom('leaveAllocations').selectAll().where('organizationId', '=', ORG).where('employeeId', '=', employeeId).where('leaveTypeId', '=', TYPE.al).where('year', '=', year).executeTakeFirst();
const day = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString().slice(0, 10));

describe('LEAVE_YEAR_CLOSE', () => {
  it('carries the unused balance into next year, capped and with the expiry, and skips leavers', async () => {
    const res = await leaveYearCloseHandler(job('LEAVE_YEAR_CLOSE', { organizationId: ORG, fromYear: 2025 }));
    expect(res).toMatchObject({ fromYear: 2025, toYear: 2026, leaveTypes: 1, employees: 3, cleared: 1 });
    const a = await alloc(E.a, 2026);
    expect(a && [Number(a.allocatedDays), Number(a.carriedForwardDays), day(a.carriedForwardExpiresOn)]).toEqual([20, 5, '2026-03-31']);
    const b = await alloc(E.b, 2026);
    expect(b).toBeDefined();
    expect(Number(b!.carriedForwardDays)).toBeGreaterThan(0);
    expect(Number(b!.carriedForwardDays)).toBeLessThanOrEqual(5);
    expect(await alloc(E.leaver, 2026)).toBeUndefined();
    const c = await alloc(E.c, 2026);
    expect(c && [Number(c.carriedForwardDays), c.carriedForwardExpiresOn]).toEqual([0, null]);
    const audit = await h.tdb.adminDb.selectFrom('audit.logs').select(['action', 'newValue']).where('organizationId', '=', ORG).where('action', '=', 'leave.year_closed').execute();
    expect(audit).toHaveLength(1);
    const ev = await h.tdb.adminDb.selectFrom('domainEvents').select(['eventType', 'payload']).where('organizationId', '=', ORG).where('eventType', '=', 'leave.year_closed').execute();
    expect(ev).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await h.tdb.adminDb.selectFrom('leaveAllocations').select(['employeeId', 'carriedForwardDays', 'carriedForwardExpiresOn']).where('organizationId', '=', ORG).where('year', '=', 2026).orderBy('employeeId').execute();
    const res = await leaveYearCloseHandler(job('LEAVE_YEAR_CLOSE', { organizationId: ORG, fromYear: 2025 }));
    expect(res).toMatchObject({ created: 0, updated: 0, cleared: 0 });
    const after = await h.tdb.adminDb.selectFrom('leaveAllocations').select(['employeeId', 'carriedForwardDays', 'carriedForwardExpiresOn']).where('organizationId', '=', ORG).where('year', '=', 2026).orderBy('employeeId').execute();
    expect(after).toEqual(before);
  });
});

describe('LEAVE_COMP_OFF_EXPIRY', () => {
  it('expires usable credits past their date, once, and tells the employee', async () => {
    const credit = (workedOn: string, status: string, used: number, expiresOn: string) => ({ organizationId: ORG, employeeId: E.a, branchId: BRANCH, workedOn, workedOnType: 'weekly_off', workedMinutes: 480, daysEarned: 1, location: 'HQ', summary: 'Worked', status, usedDays: used, expiresOn });
    const ids = await h.tdb.adminDb.insertInto('compOffCredits').values([
      credit('2026-05-01', 'approved', 0, '2026-07-30'),
      credit('2026-05-08', 'partially_used', 0.5, '2026-08-06'),
      credit('2026-09-04', 'approved', 0, '2026-12-03'),
      credit('2026-04-03', 'used', 1, '2026-07-02'),
    ]).returning(['id', 'workedOn']).execute();
    const res = await compOffExpiryHandler(job('LEAVE_COMP_OFF_EXPIRY', { organizationId: ORG, asOf: '2026-09-28' }));
    expect(res).toEqual({ asOf: '2026-09-28', expired: 2, employees: 1, days: 1.5 });
    const rows = await h.tdb.adminDb.selectFrom('compOffCredits').select(['id', 'status']).where('id', 'in', ids.map((r) => r.id)).execute();
    expect(rows.map((r) => r.status).sort()).toEqual(['approved', 'expired', 'expired', 'used']);
    const ev = await h.tdb.adminDb.selectFrom('domainEvents').select('payload').where('organizationId', '=', ORG).where('eventType', '=', 'leave.comp_off_expired').execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ employeeId: E.a, userId: U.a, days: 1.5, credits: 2 });
    expect(await compOffExpiryHandler(job('LEAVE_COMP_OFF_EXPIRY', { organizationId: ORG, asOf: '2026-09-28' }))).toMatchObject({ expired: 0 });
  });
});

describe('leave scheduler ticks', () => {
  it('enqueues the year close on 1 January in the organisation\'s local time only, deduped', async () => {
    clock = new Date('2026-12-31T22:30:00Z'); // 02:30 on 1 January 2027 in Muscat
    const first = await leaveTasks[0]!.run(h.deps);
    await leaveTasks[0]!.run(h.deps);
    expect(first).toMatchObject({ enqueued: 1 });
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['jobType', 'organizationId', 'dedupeKey', 'payload']).where('jobType', '=', 'LEAVE_YEAR_CLOSE').execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ organizationId: ORG, dedupeKey: `leave-year-close:${ORG}:2026` });
    expect(jobs[0]!.payload).toMatchObject({ fromYear: 2026 });
    clock = new Date('2027-01-01T10:00:00Z'); // 14:00 local: nothing
    expect(await leaveTasks[0]!.run(h.deps)).toMatchObject({ enqueued: 0 });
  });

  it('enqueues the comp-off expiry once per local day', async () => {
    clock = new Date('2026-10-04T23:15:00Z'); // 03:15 on 5 October in Muscat
    expect(await leaveTasks[1]!.run(h.deps)).toMatchObject({ enqueued: 1 });
    await leaveTasks[1]!.run(h.deps);
    const jobs = await h.tdb.adminDb.selectFrom('jobs.queue').select(['dedupeKey', 'payload']).where('jobType', '=', 'LEAVE_COMP_OFF_EXPIRY').execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupeKey: `leave-comp-off-expiry:${ORG}:2026-10-05` });
  });
});

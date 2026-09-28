import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { leaveTasks, leaveYearCloseHandler, yearCloseDue } from './index.js';

/**
 * Leave v2 review fixes in the worker (docs/hr-portal/reviews/07-leave-v2-review.md):
 *  - 7-P2-1 / 7-P1-3: the year close carries only the types that apply to the employee (gender and employment type — the
 *    one rule) and skips resigned / terminated employees even without an exit date, like allocation generation;
 *  - 7-P2-2: the year close is caught up from 1 January 02:00 local until its ledger row says it ran after the year ended.
 */
const ORG = '0e000000-0000-0000-0000-000000000000';
const BRANCH = '0e000000-0000-0000-0000-00000000000b';
const E = { man: '0e000000-0000-0000-0000-0000000000e1', woman: '0e000000-0000-0000-0000-0000000000e2', terminated: '0e000000-0000-0000-0000-0000000000e3', contractor: '0e000000-0000-0000-0000-0000000000e4' };
const TYPE = { al: '0e000000-0000-0000-0000-0000000000a1', mo: '0e000000-0000-0000-0000-0000000000a2', ct: '0e000000-0000-0000-0000-0000000000a3' };
let clock = new Date('2026-09-28T06:00:00Z');
let h: TestHarness;

beforeAll(async () => {
  h = await createHarness(`flowza_worker_leave_review_${process.pid}`, { get() { throw new Error('n/a'); }, tryGet() { return undefined; }, list() { return []; }, pushProtocols() { return []; }, pushProtocol() { return undefined; } }, () => clock);
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'LVR', legalName: 'L', displayName: 'L', timezone: 'Asia/Muscat', createdAt: new Date('2024-06-01T00:00:00Z') }).execute();
  await a.insertInto('branches').values({ id: BRANCH, organizationId: ORG, code: 'HQ', name: 'HQ' }).execute();
  const emp = (id: string, n: number, extra: Record<string, unknown> = {}) => ({ id, organizationId: ORG, branchId: BRANCH, employeeNumber: `R${n}`, firstName: `F${n}`, lastName: `L${n}`, displayName: `Employee ${n}`, joiningDate: '2024-01-01', deviceUserId: String(700 + n), ...extra });
  await a.insertInto('employees').values([
    emp(E.man, 1, { gender: 'male' }),
    emp(E.woman, 2, { gender: 'female' }),
    // terminated in the register, but nobody entered an exit date
    emp(E.terminated, 3, { gender: 'male', employmentStatus: 'terminated' }),
    emp(E.contractor, 4, { gender: 'male', employmentType: 'contract' }),
  ]).execute();
  await a.insertInto('leaveTypes').values([
    { id: TYPE.al, organizationId: ORG, code: 'AL', name: 'Annual', isPaid: true, annualAllowanceDays: 20, carryForwardMaxDays: 5 },
    { id: TYPE.mo, organizationId: ORG, code: 'MO', name: 'Male only', isPaid: true, annualAllowanceDays: 10, carryForwardMaxDays: 5, applicableGender: 'male' },
    { id: TYPE.ct, organizationId: ORG, code: 'CT', name: 'Contract only', isPaid: true, annualAllowanceDays: 10, carryForwardMaxDays: 5, applicableEmploymentTypes: ['contract'] },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

const job = (type: string, payload: Record<string, unknown>) => ({ job: fakeJob(type, payload, ORG), deps: h.deps, log: h.deps.log, signal: new AbortController().signal });
const rows2026 = async () => (await h.tdb.adminDb.selectFrom('leaveAllocations').select(['employeeId', 'leaveTypeId', 'carriedForwardDays']).where('organizationId', '=', ORG).where('year', '=', 2026).execute())
  .map((r) => `${Object.entries(E).find(([, id]) => id === r.employeeId)![0]}/${Object.entries(TYPE).find(([, id]) => id === r.leaveTypeId)![0]}=${Number(r.carriedForwardDays)}`).sort();
const orgJobs = () => h.tdb.adminDb.selectFrom('jobs.queue').select(['id', 'payload', 'status']).where('jobType', '=', 'LEAVE_YEAR_CLOSE').where('organizationId', '=', ORG).execute();

describe('7-P2-1 the year close carries only applicable types to employees still employed', () => {
  it('7-P2-1 skips a terminated employee without an exit date and the types that do not apply (W3)', async () => {
    const res = await leaveYearCloseHandler(job('LEAVE_YEAR_CLOSE', { organizationId: ORG, fromYear: 2025 }));
    expect(res).toMatchObject({ fromYear: 2025, toYear: 2026, employees: 3, leaveTypes: 3 });
    expect(await rows2026()).toEqual(['contractor/al=5', 'contractor/ct=5', 'contractor/mo=5', 'man/al=5', 'man/mo=5', 'woman/al=5']);
  });

  it('7-P2-2 every run writes its ledger row (the org-local date it ran on, the summary)', async () => {
    const ledger = await h.tdb.adminDb.selectFrom('leaveYearCloses').selectAll().where('organizationId', '=', ORG).execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.fromYear).toBe(2025);
    expect(DateTime.fromJSDate(ledger[0]!.ranOn as Date).toISODate()).toBe('2026-09-28');
    expect(ledger[0]!.summary).toMatchObject({ fromYear: 2025, employees: 3 });
    // clients read it (RLS: leave.view), never write it
    const policies = await sql<{ cmd: string; roles: string[] }>`select cmd, roles::text[] as roles from pg_policies where tablename = 'leave_year_closes'`.execute(h.tdb.adminDb);
    expect(policies.rows.filter((p) => p.roles.includes('authenticated')).map((p) => p.cmd)).toEqual(['SELECT']);
  });
});

describe('7-P2-2 the year close is caught up until it ran', () => {
  it('7-P2-2 yearCloseDue: from 1 January 02:00 local, until a run after the year ended; not for organisations created after it', () => {
    const at = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Muscat' });
    expect(yearCloseDue(at('2027-01-01T01:59:59'), '2024-06-01', null)).toEqual({ due: false, fromYear: 2026 });
    expect(yearCloseDue(at('2027-01-01T02:00:00'), '2024-06-01', null)).toEqual({ due: true, fromYear: 2026 });
    expect(yearCloseDue(at('2027-01-01T03:00:05'), '2024-06-01', null).due).toBe(true);
    expect(yearCloseDue(at('2027-03-15T10:00:00'), '2024-06-01', null).due).toBe(true);
    // a close queued before the year ended is stale: caught up again
    expect(yearCloseDue(at('2027-01-02T10:00:00'), '2024-06-01', '2026-12-15').due).toBe(true);
    expect(yearCloseDue(at('2027-01-02T10:00:00'), '2024-06-01', '2027-01-01').due).toBe(false);
    // created in 2027: nothing to close for 2026
    expect(yearCloseDue(at('2027-02-01T10:00:00'), '2027-01-20', null).due).toBe(false);
    expect(yearCloseDue(at('2027-02-01T10:00:00'), '2026-12-31', null).due).toBe(true);
  });

  it('7-P2-2 ticks at 01:59:59, 03:00:05 and the next day: the missed 02:00 hour is caught up, once, and stops after the run (W2)', async () => {
    clock = new Date('2026-12-31T21:59:59Z'); // 01:59:59 on 1 January 2027 in Muscat
    await leaveTasks[0]!.run(h.deps);
    expect(await orgJobs()).toHaveLength(0);
    clock = new Date('2026-12-31T23:00:05Z'); // 03:00:05 local: the 02:00 hour was missed (a restart) — caught up
    await leaveTasks[0]!.run(h.deps);
    const jobs = await orgJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ organizationId: ORG, fromYear: 2026 });
    clock = new Date('2027-01-02T08:00:00Z'); // the next day: still pending, still one job
    await leaveTasks[0]!.run(h.deps);
    expect(await orgJobs()).toHaveLength(1);
    // the close runs (its ledger row says 2027-01-02); the job is done — later ticks enqueue nothing
    await leaveYearCloseHandler(job('LEAVE_YEAR_CLOSE', { organizationId: ORG, fromYear: 2026 }));
    await h.tdb.adminDb.deleteFrom('jobs.queue').where('jobType', '=', 'LEAVE_YEAR_CLOSE').where('organizationId', '=', ORG).execute();
    clock = new Date('2027-01-03T08:00:00Z');
    await leaveTasks[0]!.run(h.deps);
    expect(await orgJobs()).toHaveLength(0);
  });
});

/**
 * Org chart (GET /orgs/:orgId/org-chart, …/org-chart/path/:employeeId) and the bulk `assign_manager` action of
 * POST /orgs/:orgId/employees/bulk: the chart's set (scope, filters, leavers), heads / children / unassigned and their counts,
 * the path of one employee; the solid and dotted reporting lines set in bulk with history, cycle and scope guards.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, domainEvents, isoTodayIn, ROLE, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness;

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const sorted = (xs: string[]) => [...xs].sort();

// ----- org chart ------------------------------------------------------------------------------------------------------------
// Branch A: ceo ← vpA ← leadA ← devA1, devA2 (+ leaver, terminated); loner (nobody, no reports). Seeded e3 ← e1 (deptA).
// Branch B: vpB → ceo (manager in A) ← staffB1, staffB2 (dotted line to vpA); lonerB. Seeded e2 alone.
// Department A (Operations): e3, e1, vpA, leadA, devA1, devA2.
let c: OrgFixture;
let ceo: string; let vpA: string; let leadA: string; let devA1: string; let devA2: string; let leaver: string; let loner: string;
let vpB: string; let staffB1: string; let staffB2: string; let lonerB: string;
const lineManager = uuid('c');

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_orgchart_${process.pid}`);
  c = await seedOrg(h.admin, 'chart');
  const A = c.branchA; const B = c.branchB; const dept = c.departmentA;
  ceo = await seedEmployee(h.admin, c.orgId, A, 10);
  vpA = await seedEmployee(h.admin, c.orgId, A, 11, { managerEmployeeId: ceo, departmentId: dept });
  leadA = await seedEmployee(h.admin, c.orgId, A, 12, { managerEmployeeId: vpA, departmentId: dept });
  devA1 = await seedEmployee(h.admin, c.orgId, A, 13, { managerEmployeeId: leadA, departmentId: dept });
  devA2 = await seedEmployee(h.admin, c.orgId, A, 14, { managerEmployeeId: leadA, departmentId: dept });
  leaver = await seedEmployee(h.admin, c.orgId, A, 15, { managerEmployeeId: leadA, departmentId: dept, employmentStatus: 'terminated' });
  loner = await seedEmployee(h.admin, c.orgId, A, 16);
  await h.admin.updateTable('employees').set({ displayNameAr: 'محمد البلوشي' }).where('id', '=', loner).execute();
  vpB = await seedEmployee(h.admin, c.orgId, B, 20, { managerEmployeeId: ceo });
  staffB1 = await seedEmployee(h.admin, c.orgId, B, 21, { managerEmployeeId: vpB });
  staffB2 = await seedEmployee(h.admin, c.orgId, B, 22, { managerEmployeeId: vpB });
  await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: vpA }).where('id', '=', staffB2).execute();
  lonerB = await seedEmployee(h.admin, c.orgId, B, 23);
  await seedUser(h.admin, lineManager, 'line-manager-orgchart@test.local', 'Line Manager');
  await seedMembership(h.admin, c.orgId, lineManager, ROLE.manager, { employeeId: leadA });
});
afterAll(async () => { await h?.close(); });

const chart = (qs = '', token = c.owner) => h.request('GET', `/api/v1/orgs/${c.orgId}/org-chart${qs}`, { token });
const path = (employeeId: string, qs = '', token = c.owner) => h.request('GET', `/api/v1/orgs/${c.orgId}/org-chart/path/${employeeId}${qs}`, { token });

describe('org chart: heads, children, unassigned', () => {
  it('top: the heads of the chart, biggest team first, with direct-report counts (primary line, leavers left out)', async () => {
    const top = await chart();
    expect(top.status).toBe(200);
    expect(ids(top.body.data)).toEqual([ceo, c.e3]);
    expect(top.body.meta).toMatchObject({ page: 1, pageSize: 100, total: 2 });
    expect(top.body.data[0]).toMatchObject({ id: ceo, employeeNumber: 'EMP10', displayName: 'Employee 10', displayNameAr: null, photoUrl: null, branchId: c.branchA, branchName: 'Branch A', employmentStatus: 'active', managerEmployeeId: null, directReportCount: 2 });
    expect(top.body.data[1]).toMatchObject({ id: c.e3, departmentName: 'Operations', directReportCount: 1 });
  });

  it('children: the direct reports of a manager in display-name order; the leaver is no report and counts for nobody', async () => {
    const level1 = await chart(`?managerId=${ceo}`);
    expect(level1.status).toBe(200);
    expect(ids(level1.body.data)).toEqual([vpA, vpB]);
    expect(level1.body.data.map((n: { directReportCount: number }) => n.directReportCount)).toEqual([1, 2]);
    // the dotted line shows on the card; it is no report of vpA (vpA counts leadA only)
    const level2 = await chart(`?managerId=${vpB}`);
    expect(level2.body.data.find((n: { id: string }) => n.id === staffB2)).toMatchObject({ managerEmployeeId: vpB, secondaryManagerEmployeeId: vpA, secondaryManagerName: 'Employee 11', directReportCount: 0 });
    const team = await chart(`?managerId=${leadA}`);
    expect(ids(team.body.data)).toEqual([devA1, devA2]);
    expect(team.body.meta.total).toBe(2);
    expect((await chart(`?managerId=${devA1}`)).body).toMatchObject({ data: [], meta: { total: 0 } });
  });

  it('unassigned: nobody above and nobody below in the set; search narrows by number or name; pagination counts them all', async () => {
    const un = await chart('?view=unassigned');
    expect(un.status).toBe(200);
    expect(sorted(ids(un.body.data))).toEqual(sorted([loner, lonerB, c.e2]));
    expect(un.body.meta.total).toBe(3);
    const p1 = await chart('?view=unassigned&pageSize=2');
    const p2 = await chart('?view=unassigned&pageSize=2&page=2');
    expect(p1.body.meta).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
    expect(p1.body.data).toHaveLength(2);
    expect(p2.body.data).toHaveLength(1);
    expect(sorted([...ids(p1.body.data), ...ids(p2.body.data)])).toEqual(sorted([loner, lonerB, c.e2]));
    expect(ids((await chart('?view=unassigned&search=EMP23')).body.data)).toEqual([lonerB]);
    expect(ids((await chart('?view=unassigned&search=employee%2016')).body.data)).toEqual([loner]);
    // the Arabic name the Arabic UI shows in the list matches too
    const arabic = await chart(`?view=unassigned&search=${encodeURIComponent('محمد')}`);
    expect(ids(arabic.body.data)).toEqual([loner]);
    expect(arabic.body.data[0]).toMatchObject({ displayName: 'Employee 16', displayNameAr: 'محمد البلوشي' });
    expect(ids((await chart(`?view=unassigned&search=${encodeURIComponent('البلوشي')}`)).body.data)).toEqual([loner]);
    // LIKE wildcards are literal
    expect((await chart('?view=unassigned&search=%25')).body.data).toEqual([]);
  });

  it('a branch filter drops the manager in the other branch out of the set, so their report becomes a head', async () => {
    const topB = await chart(`?branchId=${c.branchB}`);
    expect(ids(topB.body.data)).toEqual([vpB]);
    expect(topB.body.data[0]).toMatchObject({ managerEmployeeId: ceo, directReportCount: 2 });
    expect(sorted(ids((await chart(`?branchId=${c.branchB}&view=unassigned`)).body.data))).toEqual(sorted([lonerB, c.e2]));
    // the ceo is not on the branch B chart
    expect((await chart(`?branchId=${c.branchB}&managerId=${ceo}`)).status).toBe(404);
  });

  it('a department filter: vpA heads the Operations chart (the ceo has no department); ties read by name', async () => {
    const top = await chart(`?departmentId=${c.departmentA}`);
    expect(ids(top.body.data)).toEqual([vpA, c.e3]);
    expect(top.body.data.map((n: { directReportCount: number }) => n.directReportCount)).toEqual([1, 1]);
    expect((await chart(`?departmentId=${c.departmentA}&view=unassigned`)).body.data).toEqual([]);
  });

  it('a branch-scoped viewer sees their branches only; a dotted-line manager they cannot see has no name', async () => {
    const top = await chart('', c.branchManagerB);
    expect(top.status).toBe(200);
    expect(ids(top.body.data)).toEqual([vpB]);
    const kids = await chart(`?managerId=${vpB}`, c.branchManagerB);
    expect(kids.body.data.find((n: { id: string }) => n.id === staffB2)).toMatchObject({ secondaryManagerEmployeeId: vpA, secondaryManagerName: null });
    // a manager outside the scope is answered like an unknown one; another branch explicitly is refused
    expect((await chart(`?managerId=${ceo}`, c.branchManagerB)).status).toBe(404);
    expect((await chart(`?branchId=${c.branchA}`, c.branchManagerB)).status).toBe(403);
  });

  it('employee.view reads it (payroll); a line manager (employee.view_team only), an employee and a non-member are refused', async () => {
    expect((await chart('', c.payrollUser)).status).toBe(200);
    const mgr = await chart('', lineManager);
    expect(mgr.status).toBe(403);
    expect(mgr.body.code).toBe('FORBIDDEN');
    expect((await chart('', c.employeeUser)).status).toBe(403);
    expect((await chart('', c.outsider)).status).toBe(403);
    expect((await path(devA1, '', lineManager)).status).toBe(403);
    expect((await path(devA1, '', c.employeeUser)).status).toBe(403);
  });

  it('managerId: unknown, a leaver or malformed → 404 / 404 / 400', async () => {
    expect((await chart(`?managerId=${randomUUID()}`)).status).toBe(404);
    expect((await chart(`?managerId=${leaver}`)).status).toBe(404);
    expect((await chart('?managerId=not-a-uuid')).status).toBe(400);
    expect((await chart('?view=sideways')).status).toBe(400);
  });
});

describe('org chart: path', () => {
  it('a deep employee: managers from the head of the chart down to the direct manager', async () => {
    const p = await path(devA1);
    expect(p.status).toBe(200);
    expect(p.body.data).toEqual({ employeeId: devA1, placement: 'tree', ancestorIds: [ceo, vpA, leadA] });
    expect((await path(staffB1)).body.data).toEqual({ employeeId: staffB1, placement: 'tree', ancestorIds: [ceo, vpB] });
    // the filter cuts the walk at the first manager outside the set
    expect((await path(staffB1, `?branchId=${c.branchB}`)).body.data.ancestorIds).toEqual([vpB]);
    expect((await path(devA1, `?departmentId=${c.departmentA}`)).body.data.ancestorIds).toEqual([vpA, leadA]);
  });

  it('a head: no ancestors, on the tree; an unassigned employee: no ancestors, unassigned', async () => {
    expect((await path(ceo)).body.data).toEqual({ employeeId: ceo, placement: 'tree', ancestorIds: [] });
    expect((await path(loner)).body.data).toEqual({ employeeId: loner, placement: 'unassigned', ancestorIds: [] });
    // vpB heads the branch B chart
    expect((await path(vpB, `?branchId=${c.branchB}`)).body.data).toEqual({ employeeId: vpB, placement: 'tree', ancestorIds: [] });
  });

  it('unknown, leaver, outside the scope or malformed → 404 (never a 500)', async () => {
    expect((await path(randomUUID())).status).toBe(404);
    expect((await path(leaver)).status).toBe(404);
    expect((await path(devA1, '', c.branchManagerB)).status).toBe(404);
    const bad = await path('not-a-uuid');
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('NOT_FOUND');
    expect((await path(devA1, '?branchId=nope')).status).toBe(400);
  });
});

// ----- bulk assign_manager ----------------------------------------------------------------------------------------------------
describe('bulk assign_manager', () => {
  let f: OrgFixture;
  let m: string; let a1: string; let a2: string; let a3: string; let b1: string; let left: string; let gone: string;
  const bulk = (body: Record<string, unknown>, token = f.owner) => h.request('POST', `/api/v1/orgs/${f.orgId}/employees/bulk`, { token, body: { action: 'assign_manager', ...body } });
  const emp = (id: string) => h.admin.selectFrom('employees').select(['managerEmployeeId', 'secondaryManagerEmployeeId', 'updatedAt']).where('id', '=', id).executeTakeFirstOrThrow();
  const history = (id: string) => h.admin.selectFrom('employmentHistory').select(['effectiveFrom', 'effectiveTo', 'managerEmployeeId', 'reason']).where('employeeId', '=', id).orderBy('effectiveFrom').execute();
  const lastAudit = async () => (await auditRows(h.admin, 'employee.bulk_updated')).find((r) => r.organizationId === f.orgId);
  const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

  beforeAll(async () => {
    f = await seedOrg(h.admin, 'bulkmgr');
    m = await seedEmployee(h.admin, f.orgId, f.branchA, 30);
    a1 = await seedEmployee(h.admin, f.orgId, f.branchA, 31);
    a2 = await seedEmployee(h.admin, f.orgId, f.branchA, 32);
    a3 = await seedEmployee(h.admin, f.orgId, f.branchA, 33);
    b1 = await seedEmployee(h.admin, f.orgId, f.branchB, 34);
    left = await seedEmployee(h.admin, f.orgId, f.branchA, 35, { employmentStatus: 'terminated' });
    gone = await seedEmployee(h.admin, f.orgId, f.branchA, 36);
    await h.admin.updateTable('employees').set({ deletedAt: new Date() }).where('id', '=', gone).execute();
  });

  it('primary: sets the manager and opens an employment record at effectiveFrom; event + one audit row with the changed ids', async () => {
    const r = await bulk({ employeeIds: [a1, a2, a1], managerEmployeeId: m, effectiveFrom: '2026-01-15' });
    expect(r.status).toBe(200);
    expect(r.body.data.updated).toBe(2);
    expect(sorted(r.body.data.employeeIds)).toEqual(sorted([a1, a2]));
    expect((await emp(a1)).managerEmployeeId).toBe(m);
    expect((await emp(a2)).managerEmployeeId).toBe(m);
    const hist = (await history(a1)).map((x) => ({ ...x, effectiveFrom: day(x.effectiveFrom), effectiveTo: day(x.effectiveTo) }));
    expect(hist).toEqual([
      { effectiveFrom: '2024-01-01', effectiveTo: '2026-01-15', managerEmployeeId: null, reason: 'Joined' },
      { effectiveFrom: '2026-01-15', effectiveTo: null, managerEmployeeId: m, reason: 'Bulk assign_manager' },
    ]);
    const a = await lastAudit();
    expect(a?.newValue).toMatchObject({ action: 'assign_manager', line: 'primary', managerEmployeeId: m, effectiveFrom: '2026-01-15' });
    expect(sorted((a?.newValue as { employeeIds: string[] }).employeeIds)).toEqual(sorted([a1, a2]));
    const events = (await domainEvents(h.admin, 'employee.updated')).filter((e) => e.aggregateId === a1).map((e) => e.payload);
    expect(events).toEqual([{ bulk: 'assign_manager', line: 'primary', transition: true, branchId: f.branchA }]);
    // not device-relevant: nothing is pushed, nothing recalculated
    const jobs = await h.admin.selectFrom('jobs.queue').select('jobType').where('organizationId', '=', f.orgId).execute();
    expect(jobs.filter((j) => ['PUSH_EMPLOYEES', 'RECALCULATE_RANGE'].includes(j.jobType))).toEqual([]);
  });

  it('unchanged employees are skipped and not counted', async () => {
    const r = await bulk({ employeeIds: [a1, a3], managerEmployeeId: m });
    expect(r.body.data).toEqual({ updated: 1, employeeIds: [a3] });
    expect((await history(a1))).toHaveLength(2);
  });

  it('secondary: sets the dotted line only (no employment record); effectiveFrom is ignored', async () => {
    const before = (await history(a2)).length;
    const r = await bulk({ employeeIds: [a2], managerEmployeeId: f.e3, line: 'secondary', effectiveFrom: '2020-01-01' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ updated: 1, employeeIds: [a2] });
    expect(await emp(a2)).toMatchObject({ managerEmployeeId: m, secondaryManagerEmployeeId: f.e3 });
    expect((await history(a2)).length).toBe(before);
    const a = await lastAudit();
    expect(a?.newValue).toMatchObject({ action: 'assign_manager', line: 'secondary', managerEmployeeId: f.e3, employeeIds: [a2] });
    expect(a?.newValue).not.toHaveProperty('effectiveFrom');
    const ev = (await domainEvents(h.admin, 'employee.updated')).filter((e) => e.aggregateId === a2).map((e) => e.payload);
    expect(ev).toContainEqual(expect.objectContaining({ bulk: 'assign_manager', line: 'secondary', transition: false, branchId: f.branchA }));
  });

  it('secondary: skipped (no error) where the primary manager already is that person', async () => {
    const r = await bulk({ employeeIds: [a1, b1], managerEmployeeId: m, line: 'secondary' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ updated: 1, employeeIds: [b1] });
    expect((await emp(a1)).secondaryManagerEmployeeId).toBeNull();
    expect((await emp(b1)).secondaryManagerEmployeeId).toBe(m);
    expect((await lastAudit())?.newValue).toMatchObject({ employeeIds: [b1], skipped: [a1] });
  });

  it('primary: the dotted-line manager promoted to the solid line leaves the dotted line', async () => {
    const r = await bulk({ employeeIds: [b1], managerEmployeeId: m });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ updated: 1, employeeIds: [b1] });
    expect(await emp(b1)).toMatchObject({ managerEmployeeId: m, secondaryManagerEmployeeId: null });
    expect((await lastAudit())?.newValue).toMatchObject({ line: 'primary', employeeIds: [b1], secondaryCleared: [b1] });
    const open = (await history(b1)).at(-1);
    expect(open).toMatchObject({ managerEmployeeId: m, effectiveTo: null });
    expect(day(open?.effectiveFrom)).toBe(isoTodayIn('Asia/Muscat'));
  });

  it('null removes the link on either line', async () => {
    const primary = await bulk({ employeeIds: [a3], managerEmployeeId: null });
    expect(primary.body.data).toEqual({ updated: 1, employeeIds: [a3] });
    expect((await emp(a3)).managerEmployeeId).toBeNull();
    expect((await history(a3)).at(-1)).toMatchObject({ managerEmployeeId: null, effectiveTo: null, reason: 'Bulk assign_manager' });
    const secondary = await bulk({ employeeIds: [a2, a3], managerEmployeeId: null, line: 'secondary' });
    expect(secondary.body.data).toEqual({ updated: 1, employeeIds: [a2] });
    expect(await emp(a2)).toMatchObject({ managerEmployeeId: m, secondaryManagerEmployeeId: null });
  });

  it('refuses the manager among the employees (self reference)', async () => {
    const r = await bulk({ employeeIds: [a3, m], managerEmployeeId: m });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.message).toMatch(/own manager/);
    expect(r.body.details.issues[0].path).toBe('employeeIds');
    expect((await emp(a3)).managerEmployeeId).toBeNull();
  });

  it('refuses a direct or indirect cycle (primary and dotted links followed), naming the employees; nothing changes', async () => {
    // a1 reports to m: m cannot report to a1
    const direct = await bulk({ employeeIds: [a3, m], managerEmployeeId: a1 });
    expect(direct.status).toBe(400);
    expect(direct.body.details.issues[0].path).toBe('managerEmployeeId');
    expect(direct.body.details.employeeIds).toEqual([m]);
    expect((await emp(a3)).managerEmployeeId).toBeNull();
    expect((await emp(m)).managerEmployeeId).toBeNull();
    // a3 → a1 → m (solid lines): m cannot report to a3; nor can the whole selection when m is in it
    await bulk({ employeeIds: [a3], managerEmployeeId: a1 });
    const indirect = await bulk({ employeeIds: [b1, m, f.e2], managerEmployeeId: a3, line: 'secondary' });
    expect(indirect.status).toBe(400);
    expect(indirect.body.details.employeeIds).toEqual([m]);
    expect((await emp(f.e2)).secondaryManagerEmployeeId).toBeNull();
    // the walk follows dotted lines too: a2 → (dotted) a3 → a1 → m, so a1 cannot report to a2
    await bulk({ employeeIds: [a2], managerEmployeeId: a3, line: 'secondary' });
    const dotted = await bulk({ employeeIds: [a1, f.e2], managerEmployeeId: a2 });
    expect(dotted.status).toBe(400);
    expect(sorted(dotted.body.details.employeeIds)).toEqual([a1]);
    expect((await emp(a1)).managerEmployeeId).toBe(m);
    expect((await emp(f.e2)).managerEmployeeId).toBeNull();
  });

  it('refuses an unknown, archived or departed manager', async () => {
    for (const managerEmployeeId of [randomUUID(), gone, left]) {
      const r = await bulk({ employeeIds: [f.e2], managerEmployeeId });
      expect(r.status).toBe(400);
      expect(r.body.details.issues[0].path).toBe('managerEmployeeId');
    }
    expect((await bulk({ employeeIds: [f.e2], managerEmployeeId: left })).body.message).toMatch(/left the organisation/);
    expect((await emp(f.e2)).managerEmployeeId).toBeNull();
  });

  it('a branch-scoped caller touches only employees of their branches, with a manager they can see', async () => {
    // a1 sits in branch A: not visible to the branch B manager
    const outside = await bulk({ employeeIds: [f.e2, a1], managerEmployeeId: b1 }, f.branchManagerB);
    expect(outside.status).toBe(400);
    expect(outside.body.details.missing).toEqual([a1]);
    // a manager in branch A is invisible to them too
    const hidden = await bulk({ employeeIds: [f.e2], managerEmployeeId: m }, f.branchManagerB);
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0].path).toBe('managerEmployeeId');
    expect((await emp(f.e2)).managerEmployeeId).toBeNull();
    const inside = await bulk({ employeeIds: [f.e2], managerEmployeeId: b1 }, f.branchManagerB);
    expect(inside.status).toBe(200);
    expect(inside.body.data).toEqual({ updated: 1, employeeIds: [f.e2] });
  });

  it('needs employee.update', async () => {
    const r = await bulk({ employeeIds: [a3], managerEmployeeId: null }, f.payrollUser);
    expect(r.status).toBe(403);
    expect((await bulk({ employeeIds: [a3], managerEmployeeId: null }, f.employeeUser)).status).toBe(403);
    expect((await bulk({ employeeIds: [a3], managerEmployeeId: 'nope' })).status).toBe(400);
  });
});

// ----- bulk assign_manager: upper-case ids, dates some employees cannot take, a concurrent PATCH ----------------------------
describe('bulk assign_manager: input, dates and concurrency', () => {
  let g: OrgFixture;
  let m: string; let p1: string; let p2: string; let s1: string; let x1: string; let x2: string;
  const bulk = (body: Record<string, unknown>, token = g.owner) => h.request('POST', `/api/v1/orgs/${g.orgId}/employees/bulk`, { token, body: { action: 'assign_manager', ...body } });
  const emp = (id: string) => h.admin.selectFrom('employees').select(['managerEmployeeId', 'secondaryManagerEmployeeId', 'departmentId']).where('id', '=', id).executeTakeFirstOrThrow();
  const history = (id: string) => h.admin.selectFrom('employmentHistory').select(['effectiveFrom', 'effectiveTo', 'managerEmployeeId', 'departmentId', 'reason']).where('employeeId', '=', id).orderBy('effectiveFrom').execute();
  const events = async (id: string) => (await domainEvents(h.admin, 'employee.updated')).filter((e) => e.aggregateId === id).length;
  const day = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  const today = () => isoTodayIn('Asia/Muscat');
  /** Polls `cond` (25 ms steps, bounded): the concurrency test waits for backends to block on a lock. */
  const until = async (cond: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out');
  };
  const apiLockWaiters = async () => (await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name = 'flowza-test-api' and wait_event_type = 'Lock'`.execute(h.admin)).rows[0]?.n ?? 0;

  beforeAll(async () => {
    g = await seedOrg(h.admin, 'bulkmgr-input');
    m = await seedEmployee(h.admin, g.orgId, g.branchA, 40);
    p1 = await seedEmployee(h.admin, g.orgId, g.branchA, 41, { managerEmployeeId: m }); // primary already m
    p2 = await seedEmployee(h.admin, g.orgId, g.branchA, 42);
    await h.admin.updateTable('employees').set({ secondaryManagerEmployeeId: m }).where('id', '=', p2).execute(); // dotted line to m
    s1 = await seedEmployee(h.admin, g.orgId, g.branchA, 43);
    x1 = await seedEmployee(h.admin, g.orgId, g.branchA, 44);
    x2 = await seedEmployee(h.admin, g.orgId, g.branchA, 45);
  });

  it('upper-case ids are the same ids: unchanged is skipped, the dotted line skips the solid-line manager, promotion clears it', async () => {
    const M = m.toUpperCase();
    // primary, already reporting to m: nothing changes — no history row, no event, no error
    const [h1, ev1] = [(await history(p1)).length, await events(p1)];
    const same = await bulk({ employeeIds: [p1.toUpperCase()], managerEmployeeId: M });
    expect(same.status).toBe(200);
    expect(same.body.data).toEqual({ updated: 0, employeeIds: [] });
    expect((await history(p1)).length).toBe(h1);
    expect(await events(p1)).toBe(ev1);
    // secondary to the solid-line manager: skipped, not a check violation
    const dotted = await bulk({ employeeIds: [p1], managerEmployeeId: M, line: 'secondary' });
    expect(dotted.status).toBe(200);
    expect(dotted.body.data).toEqual({ updated: 0, employeeIds: [] });
    expect(await emp(p1)).toMatchObject({ managerEmployeeId: m, secondaryManagerEmployeeId: null });
    // primary to the dotted-line manager: promoted, the dotted line cleared; the same id twice in two cases counts once
    const promoted = await bulk({ employeeIds: [p2, p2.toUpperCase()], managerEmployeeId: M });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data).toEqual({ updated: 1, employeeIds: [p2] });
    expect(await emp(p2)).toMatchObject({ managerEmployeeId: m, secondaryManagerEmployeeId: null });
    const a = (await auditRows(h.admin, 'employee.bulk_updated')).find((r) => r.organizationId === g.orgId);
    expect(a?.newValue).toMatchObject({ managerEmployeeId: m, employeeIds: [p2], secondaryCleared: [p2] });
    // the manager among the employees, in upper case: the self-reference error (path employeeIds), not the cycle one
    const self = await bulk({ employeeIds: [s1, M], managerEmployeeId: m });
    expect(self.status).toBe(400);
    expect(self.body.details.issues[0].path).toBe('employeeIds');
    expect((await emp(s1)).managerEmployeeId).toBeNull();
  });

  it('a date some employees cannot take (future joiner, record dated later) is refused once, naming them all; nothing changes', async () => {
    const t = today();
    const joins = isoTodayIn('Asia/Muscat', 20);
    const recordFrom = isoTodayIn('Asia/Muscat', 10);
    const fj = await seedEmployee(h.admin, g.orgId, g.branchA, 46);
    await h.admin.updateTable('employees').set({ joiningDate: joins }).where('id', '=', fj).execute();
    await h.admin.updateTable('employmentHistory').set({ effectiveFrom: joins }).where('employeeId', '=', fj).execute();
    const later = await seedEmployee(h.admin, g.orgId, g.branchA, 47);
    await h.admin.updateTable('employmentHistory').set({ effectiveTo: recordFrom }).where('employeeId', '=', later).execute();
    await h.admin.insertInto('employmentHistory').values({ organizationId: g.orgId, employeeId: later, effectiveFrom: recordFrom, effectiveTo: null, branchId: g.branchA, departmentId: null, designationId: null, managerEmployeeId: null, employmentType: 'full_time', employmentStatus: 'active', reason: 'Planned' }).execute();

    const r = await bulk({ employeeIds: [s1, fj, later], managerEmployeeId: m });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.details.issues[0]).toEqual({ path: 'effectiveFrom', message: `Must be on/after ${joins}` });
    expect(sorted(r.body.details.employeeIds)).toEqual(sorted([fj, later]));
    expect(r.body.details.earliestEffectiveFrom).toEqual({ [fj]: joins, [later]: recordFrom });
    expect(r.body.message).toContain(`EMP46 (from ${joins})`);
    expect(r.body.message).toContain(`EMP47 (from ${recordFrom})`);
    expect(r.body.message).toContain(t);
    expect(r.body.message).not.toContain('effectiveFrom');
    for (const id of [s1, fj, later]) expect((await emp(id)).managerEmployeeId).toBeNull();

    // the date that suits them all goes through
    const ok = await bulk({ employeeIds: [s1, fj, later], managerEmployeeId: m, effectiveFrom: joins });
    expect(ok.status).toBe(200);
    expect(ok.body.data.updated).toBe(3);
    // employees whose solid line does not change are not checked (nothing to date)
    expect((await bulk({ employeeIds: [s1, fj, later], managerEmployeeId: m })).body.data).toEqual({ updated: 0, employeeIds: [] });
    // the dotted line has no date at all
    expect((await bulk({ employeeIds: [fj], managerEmployeeId: s1, line: 'secondary' })).status).toBe(200);
    // the other effective-dated bulk actions name them the same way
    const d1 = await seedEmployee(h.admin, g.orgId, g.branchA, 48);
    const dept = await h.request('POST', `/api/v1/orgs/${g.orgId}/employees/bulk`, { token: g.owner, body: { action: 'assign_department', employeeIds: [d1, fj], departmentId: g.departmentA } });
    expect(dept.status).toBe(400);
    expect(dept.body.details.employeeIds).toEqual([fj]);
    expect(dept.body.details.issues[0].path).toBe('effectiveFrom');
    expect((await emp(d1)).departmentId).toBeNull();
  });

  it('a PATCH racing the bulk change waits for it and keeps its own change in the employment record (no stale snapshot)', async () => {
    // hold x1's open employment record so the bulk change stops inside its loop, after it has read the employees
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let lockedNow!: () => void;
    const locked = new Promise<void>((resolve) => { lockedNow = resolve; });
    const blocker = h.admin.transaction().execute(async (t) => {
      await t.selectFrom('employmentHistory').select('id').where('employeeId', '=', x1).where('effectiveTo', 'is', null).forUpdate().execute();
      lockedNow();
      await held;
    });
    await locked;
    try {
      const bulkDone = bulk({ employeeIds: [x1, x2], managerEmployeeId: m });
      await until(async () => (await apiLockWaiters()) >= 1);
      let patchSettled = false;
      const patchDone = h.request('PATCH', `/api/v1/orgs/${g.orgId}/employees/${x2}`, { token: g.owner, body: { departmentId: g.departmentA } }).finally(() => { patchSettled = true; });
      // the PATCH queues behind the bulk change's row lock (before the fix it ran straight through)
      await until(async () => patchSettled || (await apiLockWaiters()) >= 2);
      expect(patchSettled).toBe(false);
      release();
      await blocker;
      const [b, p] = await Promise.all([bulkDone, patchDone]);
      expect(b.status).toBe(200);
      expect(b.body.data).toEqual({ updated: 2, employeeIds: expect.arrayContaining([x1, x2]) });
      expect(p.status).toBe(200);
    } finally {
      release();
      await blocker.catch(() => undefined);
    }
    // the employee row and its open employment record agree: the bulk's manager AND the PATCH's department
    expect(await emp(x2)).toMatchObject({ managerEmployeeId: m, departmentId: g.departmentA });
    const open = (await history(x2)).filter((r) => r.effectiveTo === null);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ managerEmployeeId: m, departmentId: g.departmentA });
    expect(day(open[0]?.effectiveFrom)).toBe(today());
    expect((await history(x1)).at(-1)).toMatchObject({ managerEmployeeId: m, effectiveTo: null, reason: 'Bulk assign_manager' });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext, type LocationFilter } from '@flowza/database';
import { createHarness, fakeJob, type TestHarness } from '../../test/harness.js';
import { loadReportContext, narrowScopeToLocation, type ReportScope } from './context.js';
import { generateReportHandler } from './generate.js';

/**
 * The `locationId` report parameter (docs/locations.md §2) resolved in the organisation's system context: a group / branch
 * location → its branches; a place → its branch and the employees working in it or below — always INSIDE the scope the API
 * injected (branch scope, explicit or team employees). An empty intersection is an empty report, never everyone.
 */

const sorted = (ids: readonly string[] | null) => (ids ? [...ids].sort() : ids);

describe('narrowScopeToLocation', () => {
  const scope = (branchIds: string[] | null, employeeIds: string[] | null = null): ReportScope => ({ branchIds, departmentId: null, employeeIds });
  const group: LocationFilter = { kind: 'branches', locationId: 'g', branchIds: ['b1', 'b2'] };
  const place: LocationFilter = { kind: 'places', locationId: 'p', branchId: 'b1', placeIds: ['p', 'p-child'] };

  it('a group / branch location keeps its branches that the scope allows', () => {
    expect(narrowScopeToLocation(scope(null), group, [])).toEqual(scope(['b1', 'b2']));
    expect(narrowScopeToLocation(scope(['b2', 'b3']), group, [])).toEqual(scope(['b2']));
    expect(narrowScopeToLocation(scope(['b3']), group, [])).toEqual(scope([]));
    expect(narrowScopeToLocation(scope(null, ['e1']), group, [])).toEqual(scope(['b1', 'b2'], ['e1']));
  });

  it('a place keeps its branch and the employees working there, inside the scope and any explicit employees', () => {
    expect(narrowScopeToLocation(scope(null), place, ['e1', 'e2'])).toEqual(scope(['b1'], ['e1', 'e2']));
    expect(narrowScopeToLocation(scope(null, ['e2', 'e3']), place, ['e1', 'e2'])).toEqual(scope(['b1'], ['e2']));
    expect(narrowScopeToLocation(scope(['b2']), place, ['e1'])).toEqual(scope([], ['e1']));
    expect(narrowScopeToLocation(scope(null, ['e3']), place, ['e1'])).toEqual(scope(['b1'], []));
    expect(narrowScopeToLocation(scope(null), place, [])).toEqual(scope(['b1'], []));
  });
});

const ORG = '0c000000-0000-4000-a000-000000000001';
const OWNER = 'c0000000-0000-4000-a000-000000000001';
const HQ = '0c000000-0000-4000-a000-00000000000a';
const B2 = '0c000000-0000-4000-a000-00000000000b';
const LEVEL = { region: '0c000000-0000-4000-a000-000000000101', site: '0c000000-0000-4000-a000-000000000103', floor: '0c000000-0000-4000-a000-000000000104' };
// Region (group) ─┬─ HQ ─┬─ Site 1 ── Floor 1
//                 │      ├─ Site 2
//                 │      └─ Site 4 (nobody works there)
//                 └─ B2 ── Site 3
const REGION = '0c000000-0000-4000-a000-000000000201';
const SITE1 = '0c000000-0000-4000-a000-000000000211';
const FLOOR1 = '0c000000-0000-4000-a000-000000000212';
const SITE2 = '0c000000-0000-4000-a000-000000000213';
const SITE4 = '0c000000-0000-4000-a000-000000000214';
const SITE3 = '0c000000-0000-4000-a000-000000000221';
const E = {
  site1: '0c000000-0000-4000-a000-0000000000e1', floor1: '0c000000-0000-4000-a000-0000000000e2', hqOnly: '0c000000-0000-4000-a000-0000000000e3',
  site2: '0c000000-0000-4000-a000-0000000000e4', site3: '0c000000-0000-4000-a000-0000000000e5',
};
const DATE = '2026-09-14';
const NOW = new Date('2026-09-15T08:00:00Z');

let h: TestHarness;
let nodeHQ: string;
const jobCtx = (payload: Record<string, unknown>) => ({ job: { ...fakeJob('GENERATE_REPORT', payload, ORG), attempts: 1, maxAttempts: 3 }, log: h.deps.log, deps: h.deps, signal: new AbortController().signal });
const scopeOf = (parameters: Record<string, unknown>) => withContext(h.deps.db, { kind: 'system', organizationId: ORG, jobId: 'location-scope-test' }, async (trx) => (await loadReportContext(trx, ORG, { parameters, format: 'csv' }, NOW)).scope);
const generate = async (reportType: string, parameters: Record<string, unknown>) => {
  const id = (await h.tdb.adminDb.insertInto('reportRequests').values({ organizationId: ORG, reportType, format: 'csv', parameters: JSON.stringify(parameters), status: 'QUEUED', requestedBy: OWNER }).returning('id').executeTakeFirstOrThrow()).id;
  const res = await generateReportHandler(jobCtx({ organizationId: ORG, reportRequestId: id }));
  const file = h.files.get(`reports/${ORG}/${id}.csv`);
  return { res, text: file ? file.toString('utf8') : '' };
};

beforeAll(async () => {
  h = await createHarness(`flowza_worker_locscope_${process.pid}`, defaultRegistry(), () => NOW);
  const a = h.tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner@locscope.local')`.execute(a);
  await a.insertInto('userProfiles').values({ id: OWNER, email: 'owner@locscope.local', fullName: 'Owner' }).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'LOCSCOPE', legalName: 'Location Scope LLC', displayName: 'LOCATION SCOPE', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('organizationSettings').values({ organizationId: ORG }).execute();
  await a.insertInto('branches').values([{ id: HQ, organizationId: ORG, code: 'HQ', name: 'Head Office', timezone: 'Asia/Muscat' }, { id: B2, organizationId: ORG, code: 'B2', name: 'Second', timezone: 'Asia/Muscat' }]).execute();
  // levels: Region (group) 1, Branch 2, Site 3, Floor 4 — one transaction, the level list is checked at commit
  await a.transaction().execute(async (t) => {
    await t.updateTable('locationLevels').set({ position: 2 }).where('organizationId', '=', ORG).where('role', '=', 'branch').execute();
    await t.insertInto('locationLevels').values([
      { id: LEVEL.region, organizationId: ORG, position: 1, role: 'group', name: 'Region', icon: 'region' },
      { id: LEVEL.site, organizationId: ORG, position: 3, role: 'place', name: 'Site', icon: 'site' },
      { id: LEVEL.floor, organizationId: ORG, position: 4, role: 'place', name: 'Floor', icon: 'floor' },
    ]).execute();
  });
  const branchNode = async (branchId: string) => (await a.selectFrom('locations').select('id').where('branchId', '=', branchId).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
  nodeHQ = await branchNode(HQ);
  const nodeB2 = await branchNode(B2);
  const node = (id: string, levelId: string, role: 'group' | 'place', parentId: string | null, code: string, name: string) => ({ id, organizationId: ORG, levelId, role, parentId, code, name, path: [] as string[] });
  await a.insertInto('locations').values(node(REGION, LEVEL.region, 'group', null, 'R', 'Region')).execute();
  await a.updateTable('locations').set({ parentId: REGION }).where('id', 'in', [nodeHQ, nodeB2]).execute();
  await a.insertInto('locations').values([
    node(SITE1, LEVEL.site, 'place', nodeHQ, 'S1', 'Site 1'), node(SITE2, LEVEL.site, 'place', nodeHQ, 'S2', 'Site 2'), node(SITE4, LEVEL.site, 'place', nodeHQ, 'S4', 'Site 4'),
    node(SITE3, LEVEL.site, 'place', nodeB2, 'S3', 'Site 3'),
  ]).execute();
  await a.insertInto('locations').values(node(FLOOR1, LEVEL.floor, 'place', SITE1, 'F1', 'Floor 1')).execute();
  const emp = (id: string, n: string, name: string, branchId: string, workLocationId: string | null) => ({ id, organizationId: ORG, employeeNumber: n, firstName: name, lastName: '.', displayName: name, joiningDate: '2025-01-01', branchId, workLocationId, deviceUserId: n, customFields: JSON.stringify({}) });
  await a.insertInto('employees').values([
    emp(E.site1, '101', 'SITE ONE WORKER', HQ, SITE1), emp(E.floor1, '102', 'FLOOR ONE WORKER', HQ, FLOOR1), emp(E.hqOnly, '103', 'HEAD OFFICE WORKER', HQ, null),
    emp(E.site2, '104', 'SITE TWO WORKER', HQ, SITE2), emp(E.site3, '105', 'SITE THREE WORKER', B2, SITE3),
  ]).execute();
  const rec = (employeeId: string, branchId: string) => ({ organizationId: ORG, employeeId, attendanceDate: DATE, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'ABSENT' as const, trace: JSON.stringify({ punches: [] }) });
  await a.insertInto('attendanceDailyRecords').values([rec(E.site1, HQ), rec(E.floor1, HQ), rec(E.hqOnly, HQ), rec(E.site2, HQ), rec(E.site3, B2)]).execute();
});
afterAll(async () => { await h?.close(); });

describe('loadReportContext: the locationId parameter', () => {
  it('resolves a group, a branch and a place (with the places below it) in the organisation\'s system context', async () => {
    const region = await scopeOf({ locationId: REGION });
    expect(sorted(region.branchIds)).toEqual(sorted([HQ, B2]));
    expect(region.employeeIds).toBeNull();
    expect(await scopeOf({ locationId: nodeHQ })).toMatchObject({ branchIds: [HQ], employeeIds: null });
    const site = await scopeOf({ locationId: SITE1 });
    expect(site.branchIds).toEqual([HQ]);
    expect(sorted(site.employeeIds)).toEqual(sorted([E.site1, E.floor1]));
    expect(await scopeOf({ locationId: FLOOR1 })).toMatchObject({ branchIds: [HQ], employeeIds: [E.floor1] });
    expect(await scopeOf({})).toMatchObject({ branchIds: null, employeeIds: null });
  });

  it('only ever narrows the injected scope — an empty intersection selects nobody', async () => {
    // a requester limited to B2 (the API injects branchIds + branchScope) asking for the whole region gets B2
    expect((await scopeOf({ locationId: REGION, branchIds: [B2], branchScope: [B2] })).branchIds).toEqual([B2]);
    // a place of HQ for that requester: no branch at all
    expect((await scopeOf({ locationId: SITE1, branchId: B2, branchScope: [B2] })).branchIds).toEqual([]);
    // explicit (or a line manager's team) employees ∩ the employees working there
    expect((await scopeOf({ locationId: SITE1, employeeIds: [E.floor1, E.site3] })).employeeIds).toEqual([E.floor1]);
    expect((await scopeOf({ locationId: SITE1, employeeIds: [E.site3] })).employeeIds).toEqual([]);
    expect((await scopeOf({ locationId: SITE4 })).employeeIds).toEqual([]);
  });

  it('a location that does not exist fails the report instead of widening it', async () => {
    await expect(scopeOf({ locationId: '0c000000-0000-4000-a000-0000000002ff' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const { res } = await generate('employee_directory', { locationId: '0c000000-0000-4000-a000-0000000002ff' });
    expect(res).toMatchObject({ status: 'FAILED', reason: 'The report location no longer exists.' });
  });
});

describe('generated reports narrowed by location', () => {
  it('the employee directory of a place lists the people working in it or below; of a region, everyone in its branches', async () => {
    const site = await generate('employee_directory', { locationId: SITE1 });
    expect(site.res).toMatchObject({ status: 'COMPLETED', rowCount: 2 });
    expect(site.text).toContain('SITE ONE WORKER');
    expect(site.text).toContain('FLOOR ONE WORKER');
    expect(site.text).not.toContain('HEAD OFFICE WORKER');
    expect((await generate('employee_directory', { locationId: REGION })).res).toMatchObject({ status: 'COMPLETED', rowCount: 5 });
    expect((await generate('employee_directory', { locationId: nodeHQ })).res).toMatchObject({ status: 'COMPLETED', rowCount: 4 });
  });

  it('the daily report of a place prints only its people\'s days', async () => {
    const daily = await generate('daily_attendance', { from: DATE, locationId: SITE1 });
    expect(daily.res.status).toBe('COMPLETED');
    expect(daily.text).toContain('SITE ONE WORKER');
    expect(daily.text).toContain('FLOOR ONE WORKER');
    expect(daily.text).not.toContain('HEAD OFFICE WORKER');
    expect(daily.text).not.toContain('SITE THREE WORKER');
  });

  it('an empty intersection is an empty report, never everyone', async () => {
    const outside = await generate('employee_directory', { locationId: SITE1, branchId: B2, branchScope: [B2] });
    expect(outside.res).toMatchObject({ status: 'COMPLETED', rowCount: 0 });
    expect(outside.text).not.toContain('WORKER');
    const nobody = await generate('employee_directory', { locationId: SITE1, employeeIds: [E.site3] });
    expect(nobody.res).toMatchObject({ status: 'COMPLETED', rowCount: 0 });
    const empty = await generate('daily_attendance', { from: DATE, locationId: SITE4 });
    expect(empty.res.status).toBe('COMPLETED');
    expect(empty.text).not.toContain('WORKER');
  });
});

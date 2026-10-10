import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '../testing/index.js';
import { withContext } from '../context.js';
import { loadPolicyRows, loadPolicyScope, toPolicyCandidate } from '../attendance/policy.js';
import { loadLocationTree, locationLabels, resolveLocationFilter } from './index.js';

/*
 * The location loaders against the real schema (migration 20261010000100): Muscat HQ (group) → B1, B2 (branches) → Site A
 * (B1) → Floor 2 → Zone C; Site X (B2). Owner (every branch) and a branch-scoped admin of B2.
 */
const ORG = '0c000000-0000-0000-0000-000000000000';
const OWNER = 'c1000000-0000-0000-0000-000000000001';
const SCOPED = 'c1000000-0000-0000-0000-000000000002';
const B1 = '0c000000-0000-0000-0000-0000000000b1';
const B2 = '0c000000-0000-0000-0000-0000000000b2';
const L = { hq: '0c000000-0000-0000-0000-00000000a001', site: '0c000000-0000-0000-0000-00000000a003', floor: '0c000000-0000-0000-0000-00000000a004', zone: '0c000000-0000-0000-0000-00000000a005' };
const N = { hq: '0c000000-0000-0000-0000-00000000c001', sa: '0c000000-0000-0000-0000-00000000c011', f2: '0c000000-0000-0000-0000-00000000c012', zc: '0c000000-0000-0000-0000-00000000c013', sx: '0c000000-0000-0000-0000-00000000c021' };
const E1 = '0c000000-0000-0000-0000-0000000000e1';

let tdb: TestDatabase;
const asUser = <T>(userId: string, fn: Parameters<typeof withContext<T>>[2]) => withContext(tdb.db, { kind: 'user', userId, requestId: 'test' }, fn);

beforeAll(async () => {
  tdb = await createTestDatabase(`flowza_dbloc_${process.pid}`);
  const a = tdb.adminDb;
  await sql`insert into auth.users (id, email) values (${OWNER}, 'owner-c@test.local'), (${SCOPED}, 'scoped-c@test.local')`.execute(a);
  await a.insertInto('userProfiles').values([{ id: OWNER, email: 'owner-c@test.local', fullName: 'Owner C' }, { id: SCOPED, email: 'scoped-c@test.local', fullName: 'Scoped C' }]).execute();
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'DBL-C', legalName: 'C', displayName: 'C' }).execute();
  await a.insertInto('branches').values([{ id: B1, organizationId: ORG, code: 'B1', name: 'Branch 1' }, { id: B2, organizationId: ORG, code: 'B2', name: 'Branch 2' }]).execute();
  const scoped = await a.insertInto('orgMemberships').values({ organizationId: ORG, userId: SCOPED, roleId: '10000000-0000-0000-0000-000000000002', status: 'active', allBranches: false }).returning('id').executeTakeFirstOrThrow();
  await a.insertInto('orgMemberships').values({ organizationId: ORG, userId: OWNER, roleId: '10000000-0000-0000-0000-000000000001', status: 'active', allBranches: true }).execute();
  await a.insertInto('membershipBranches').values({ membershipId: scoped.id, branchId: B2 }).execute();
  // levels and tree, in one transaction (the level list is checked at commit)
  await a.transaction().execute(async (t) => {
    await t.updateTable('locationLevels').set({ position: 2 }).where('organizationId', '=', ORG).where('role', '=', 'branch').execute();
    await t.insertInto('locationLevels').values([
      { id: L.hq, organizationId: ORG, position: 1, role: 'group', name: 'Headquarters' },
      { id: L.site, organizationId: ORG, position: 3, role: 'place', name: 'Site' },
      { id: L.floor, organizationId: ORG, position: 4, role: 'place', name: 'Floor' },
      { id: L.zone, organizationId: ORG, position: 5, role: 'place', name: 'Zone' },
    ]).execute();
  });
  const node = async (branchId: string) => (await a.selectFrom('locations').select('id').where('branchId', '=', branchId).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
  await a.insertInto('locations').values({ id: N.hq, organizationId: ORG, levelId: L.hq, role: 'group', code: 'HQ', name: 'Muscat HQ', path: [] }).execute();
  await a.updateTable('locations').set({ parentId: N.hq }).where('organizationId', '=', ORG).where('role', '=', 'branch').execute();
  await a.insertInto('locations').values([
    { id: N.sa, organizationId: ORG, levelId: L.site, role: 'place', parentId: await node(B1), code: 'SA', name: 'Site A', path: [] },
    { id: N.sx, organizationId: ORG, levelId: L.site, role: 'place', parentId: await node(B2), code: 'SX', name: 'Site X', path: [] },
  ]).execute();
  await a.insertInto('locations').values({ id: N.f2, organizationId: ORG, levelId: L.floor, role: 'place', parentId: N.sa, code: 'F2', name: 'Floor 2', path: [] }).execute();
  await a.insertInto('locations').values({ id: N.zc, organizationId: ORG, levelId: L.zone, role: 'place', parentId: N.f2, code: 'ZC', name: 'Zone C', path: [] }).execute();
  await a.insertInto('employees').values({ id: E1, organizationId: ORG, employeeNumber: 'C-001', firstName: 'Ali', lastName: 'Said', displayName: 'Ali Said', joiningDate: '2026-01-01', branchId: B1, deviceUserId: '1', workLocationId: N.f2 }).execute();
  await a.insertInto('attendanceRuleSets').values([
    { organizationId: ORG, name: 'HQ', locationId: N.hq, effectiveFrom: '2026-01-01', ramadanMode: '{}' },
    { organizationId: ORG, name: 'Site A', branchId: B1, locationId: N.sa, effectiveFrom: '2026-01-01', ramadanMode: '{}' },
    { organizationId: ORG, name: 'Branch 1', branchId: B1, effectiveFrom: '2026-01-01', ramadanMode: '{}' },
  ]).execute();
});
afterAll(async () => { await tdb?.close(); });

describe('location loaders', () => {
  it('loads the tree with branch names and paths, parents first', async () => {
    const tree = await asUser(OWNER, (trx) => loadLocationTree(trx, ORG));
    expect(tree).toHaveLength(7);
    const byId = new Map(tree.map((n) => [n.id, n]));
    expect(byId.get(N.zc)).toMatchObject({ role: 'place', branchId: B1, depth: 5, path: [N.hq, expect.any(String), N.sa, N.f2, N.zc] });
    const b1 = tree.find((n) => n.branchId === B1 && n.role === 'branch');
    expect(b1).toMatchObject({ code: 'B1', name: 'Branch 1', status: 'active', parentId: N.hq });
    expect(tree.findIndex((n) => n.id === N.sa)).toBeLessThan(tree.findIndex((n) => n.id === N.f2));
  });

  it('shows a branch-scoped member the group nodes and their own branch only', async () => {
    const tree = await asUser(SCOPED, (trx) => loadLocationTree(trx, ORG));
    expect(tree.map((n) => n.id).sort()).toEqual([N.hq, N.sx, tree.find((n) => n.branchId === B2 && n.role === 'branch')!.id].sort());
  });

  it('leaves archived subtrees out unless asked', async () => {
    await tdb.adminDb.updateTable('locations').set({ status: 'archived' }).where('id', '=', N.f2).execute();
    try {
      const tree = await asUser(OWNER, (trx) => loadLocationTree(trx, ORG));
      expect(tree.map((n) => n.id)).not.toContain(N.zc);
      expect((await asUser(OWNER, (trx) => loadLocationTree(trx, ORG, { includeArchived: true }))).map((n) => n.id)).toContain(N.zc);
    } finally {
      await tdb.adminDb.updateTable('locations').set({ status: 'active' }).where('id', '=', N.f2).execute();
    }
  });

  it('resolves a filter: a group node to the branches the caller sees, a place to its subtree', async () => {
    expect(await asUser(OWNER, (trx) => resolveLocationFilter(trx, ORG, N.hq))).toMatchObject({ kind: 'branches', branchIds: expect.arrayContaining([B1, B2]) });
    expect((await asUser(SCOPED, (trx) => resolveLocationFilter(trx, ORG, N.hq)))).toMatchObject({ kind: 'branches', branchIds: [B2] });
    const place = await asUser(OWNER, (trx) => resolveLocationFilter(trx, ORG, N.sa));
    expect(place).toMatchObject({ kind: 'places', branchId: B1 });
    expect(place.kind === 'places' ? [...place.placeIds].sort() : []).toEqual([N.sa, N.f2, N.zc].sort());
    await expect(asUser(SCOPED, (trx) => resolveLocationFilter(trx, ORG, N.sa))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('labels places by their path below the branch', async () => {
    const labels = await asUser(OWNER, (trx) => locationLabels(trx, ORG, [N.zc, N.sa, null, N.hq]));
    expect(labels.get(N.zc)).toBe('Site A › Floor 2 › Zone C');
    expect(labels.get(N.sa)).toBe('Site A');
    expect(labels.get(N.hq)).toBe('Muscat HQ');
  });

  it('gives the policy scope the work-location chain, and the candidates their depths', async () => {
    const scope = await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG, jobId: 'test' }, (trx) => loadPolicyScope(trx, ORG, E1, '2026-03-01', { branchId: B1, departmentId: null, shiftId: null }));
    expect(scope.locationIds).toEqual([N.hq, expect.any(String), N.sa, N.f2]);
    // deployed to B2 that day: the B1 work location does not count, the B2 node's chain does
    const deployed = await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG, jobId: 'test' }, (trx) => loadPolicyScope(trx, ORG, E1, '2026-03-01', { branchId: B2, departmentId: null, shiftId: null }));
    expect(deployed.locationIds).toHaveLength(2);
    expect(deployed.locationIds?.[0]).toBe(N.hq);
    const rows = await withContext(tdb.workerDb, { kind: 'system', organizationId: ORG, jobId: 'test' }, (trx) => loadPolicyRows(trx, ORG, '2026-03-01'));
    const byName = Object.fromEntries(rows.map((r) => [r.name, toPolicyCandidate(r)]));
    expect(byName['HQ']).toMatchObject({ locationId: N.hq, locationDepth: 1 });
    expect(byName['Site A']).toMatchObject({ locationId: N.sa, locationDepth: 3, branchId: B1, branchDepth: 2 });
    expect(byName['Branch 1']).toMatchObject({ locationId: null, branchDepth: 2 });
  });
});

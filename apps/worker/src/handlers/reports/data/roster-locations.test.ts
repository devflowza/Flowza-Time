import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRegistry } from '@flowza/device-providers';
import { withContext } from '@flowza/database';
import { createHarness, type TestHarness } from '../../../test/harness.js';
import type { ReportContext } from '../context.js';
import { loadShiftAndPolicy, type RosterEmployee } from './roster.js';

/*
 * The "Policy" column of the roster reports resolves like the engine (docs/locations.md §3): a policy for a place applies to
 * the people working there, a policy for a group location (a region) to the branches below it — and neither is mistaken for
 * a branch policy or the organisation default. Tree: North (group) → Branch A → Site A; Branch B at the top.
 */
const ORG = '0f000000-0000-4000-a000-000000000001';
const BRANCH_A = '0f000000-0000-4000-a000-00000000000a';
const BRANCH_B = '0f000000-0000-4000-a000-00000000000b';
const LEVEL_REGION = '0f000000-0000-4000-a000-0000000000b1';
const LEVEL_SITE = '0f000000-0000-4000-a000-0000000000b3';
const NORTH = '0f000000-0000-4000-a000-0000000000c1';
const SITE_A = '0f000000-0000-4000-a000-0000000000c3';
const E1 = '0f000000-0000-4000-a000-0000000000e1'; // branch A, works on Site A
const E2 = '0f000000-0000-4000-a000-0000000000e2'; // branch A, no work location
const E3 = '0f000000-0000-4000-a000-0000000000e3'; // branch B

let h: TestHarness;
const ctx = { organizationId: ORG, locale: 'en' } as unknown as ReportContext;
const roster = (id: string, branchId: string, n: string): RosterEmployee => ({
  id, employeeNumber: n, displayName: `Employee ${n}`, branchId, branchName: null, departmentId: null, departmentName: null, designationName: null, cardNumber: null, joiningDate: '2024-01-01', exitDate: null, employmentStatus: 'active',
});
const policies = async (date: string) => {
  const out = await withContext(h.deps.db, { kind: 'system', organizationId: ORG }, (trx) => loadShiftAndPolicy(trx, ctx, [roster(E1, BRANCH_A, '1'), roster(E2, BRANCH_A, '2'), roster(E3, BRANCH_B, '3')], date));
  return Object.fromEntries([...out].map(([id, v]) => [id, v.policy]));
};

beforeAll(async () => {
  h = await createHarness(`flowza_worker_rosterloc_${process.pid}`, defaultRegistry());
  const a = h.tdb.adminDb;
  await a.insertInto('organizations').values({ id: ORG, companyCode: 'RLOC', legalName: 'Roster locations', displayName: 'Roster locations', timezone: 'Asia/Muscat' }).execute();
  await a.insertInto('branches').values([{ id: BRANCH_A, organizationId: ORG, code: 'A', name: 'Branch A', timezone: 'Asia/Muscat' }, { id: BRANCH_B, organizationId: ORG, code: 'B', name: 'Branch B', timezone: 'Asia/Muscat' }]).execute();
  // Region (group) → Branch → Site (place); the level list is checked at commit
  await a.transaction().execute(async (trx) => {
    await trx.updateTable('locationLevels').set({ position: 2 }).where('organizationId', '=', ORG).where('role', '=', 'branch').execute();
    await trx.insertInto('locationLevels').values([
      { id: LEVEL_REGION, organizationId: ORG, position: 1, role: 'group', name: 'Region', icon: 'region' },
      { id: LEVEL_SITE, organizationId: ORG, position: 3, role: 'place', name: 'Site', icon: 'site' },
    ]).execute();
  });
  await a.insertInto('locations').values({ id: NORTH, organizationId: ORG, levelId: LEVEL_REGION, role: 'group', code: 'NORTH', name: 'North', path: [] }).execute();
  await a.updateTable('locations').set({ parentId: NORTH }).where('branchId', '=', BRANCH_A).where('role', '=', 'branch').execute();
  const nodeA = (await a.selectFrom('locations').select('id').where('branchId', '=', BRANCH_A).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
  await a.insertInto('locations').values({ id: SITE_A, organizationId: ORG, levelId: LEVEL_SITE, role: 'place', parentId: nodeA, code: 'SA', name: 'Site A', path: [] }).execute();
  const emp = (id: string, branchId: string, n: string, workLocationId: string | null) => ({ id, organizationId: ORG, branchId, employeeNumber: n, firstName: 'E', lastName: n, displayName: `Employee ${n}`, joiningDate: '2024-01-01', deviceUserId: n, workLocationId });
  await a.insertInto('employees').values([emp(E1, BRANCH_A, '1', SITE_A), emp(E2, BRANCH_A, '2', null), emp(E3, BRANCH_B, '3', null)]).execute();
  await a.insertInto('attendanceRuleSets').values([
    { organizationId: ORG, name: 'Organisation', effectiveFrom: '2026-01-01' },
    { organizationId: ORG, name: 'North', locationId: NORTH, effectiveFrom: '2026-01-01' },
    { organizationId: ORG, name: 'Site A', locationId: SITE_A, branchId: BRANCH_A, effectiveFrom: '2026-01-01' },
    { organizationId: ORG, name: 'Branch A', branchId: BRANCH_A, effectiveFrom: '2026-03-01' },
  ]).execute();
});
afterAll(async () => { await h?.close(); });

describe('loadShiftAndPolicy with location policies', () => {
  it('a place policy for the people working there, a region policy for its branches, the organisation default elsewhere', async () => {
    expect(await policies('2026-02-10')).toEqual({ [E1]: 'Site A', [E2]: 'North', [E3]: 'Organisation' });
  });

  it('a branch policy beats the region, a place policy beats the branch', async () => {
    expect(await policies('2026-03-10')).toEqual({ [E1]: 'Site A', [E2]: 'Branch A', [E3]: 'Organisation' });
  });
});

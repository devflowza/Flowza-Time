import type { Database } from '@flowza/database';
import { ROLE, seedEmployee, seedMembership, seedUser, uuid, type OrgFixture } from './features-harness.js';

/*
 * The location tree of the Enterprise location tests (docs/locations.md §2–§4), inserted with the admin handle — the
 * locations API itself is not under test there:
 *
 *   Muscat HQ ─┬─ North ── Branch A ─┬─ Site A ── Floor 2 ── Zone C
 *              │                     ├─ Annex
 *              │                     └─ Old store (archived)
 *              └─ South ── Branch B ─── Site B                       (branch B runs on Asia/Kolkata time)
 *
 * Employees beside the organisation fixture's (e1, e3 in branch A, e2 in branch B): branch A — e5 works on Floor 2, e6 in
 * Zone C, e7 in the Annex, e8, e9 and e11 have no work location; branch B — e10. Members: an hr_admin of branch B only and
 * hr_users of branch A only and of branch B only.
 */
export interface LocationFixture {
  node: { hq: string; north: string; south: string; branchA: string; branchB: string; siteA: string; floor2: string; zoneC: string; annex: string; oldStore: string; siteB: string };
  e5: string; e6: string; e7: string; e8: string; e9: string; e10: string; e11: string;
  scopedAdminB: string; scopedHrA: string; scopedHrB: string;
}

export async function seedLocationFixture(admin: Database, f: OrgFixture, tag: string): Promise<LocationFixture> {
  const orgId = f.orgId;
  await admin.updateTable('branches').set({ timezone: 'Asia/Kolkata' }).where('id', '=', f.branchB).execute();
  const level = { hq: uuid('7'), region: uuid('7'), site: uuid('7'), floor: uuid('7'), zone: uuid('7') };
  // REGIONAL-like levels: Headquarters, Region (groups) → Branch → Site, Floor, Zone (places); the list is checked at commit
  await admin.transaction().execute(async (trx) => {
    await trx.updateTable('locationLevels').set({ position: 3 }).where('organizationId', '=', orgId).where('role', '=', 'branch').execute();
    await trx.insertInto('locationLevels').values([
      { id: level.hq, organizationId: orgId, position: 1, role: 'group', name: 'Headquarters', icon: 'headquarters' },
      { id: level.region, organizationId: orgId, position: 2, role: 'group', name: 'Region', icon: 'region' },
      { id: level.site, organizationId: orgId, position: 4, role: 'place', name: 'Site', icon: 'site' },
      { id: level.floor, organizationId: orgId, position: 5, role: 'place', name: 'Floor', icon: 'floor' },
      { id: level.zone, organizationId: orgId, position: 6, role: 'place', name: 'Zone', icon: 'zone' },
    ]).execute();
  });
  const branchNode = async (branchId: string) => (await admin.selectFrom('locations').select('id').where('branchId', '=', branchId).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
  const n = {
    hq: uuid('8'), north: uuid('8'), south: uuid('8'), branchA: await branchNode(f.branchA), branchB: await branchNode(f.branchB),
    siteA: uuid('8'), floor2: uuid('8'), zoneC: uuid('8'), annex: uuid('8'), oldStore: uuid('8'), siteB: uuid('8'),
  };
  const node = (id: string, levelId: string, role: 'group' | 'place', parentId: string | null, code: string, name: string, status: 'active' | 'archived' = 'active') =>
    ({ id, organizationId: orgId, levelId, role, parentId, code, name, status, path: [] as string[] });
  // parents before children (the shape trigger reads the parent; role, branch and path are derived there)
  await admin.insertInto('locations').values(node(n.hq, level.hq, 'group', null, 'HQ', 'Muscat HQ')).execute();
  await admin.insertInto('locations').values([node(n.north, level.region, 'group', n.hq, 'NORTH', 'North'), node(n.south, level.region, 'group', n.hq, 'SOUTH', 'South')]).execute();
  await admin.updateTable('locations').set({ parentId: n.north }).where('id', '=', n.branchA).execute();
  await admin.updateTable('locations').set({ parentId: n.south }).where('id', '=', n.branchB).execute();
  await admin.insertInto('locations').values([
    node(n.siteA, level.site, 'place', n.branchA, 'SA', 'Site A'), node(n.annex, level.site, 'place', n.branchA, 'ANX', 'Annex'),
    node(n.oldStore, level.site, 'place', n.branchA, 'OLD', 'Old store', 'archived'), node(n.siteB, level.site, 'place', n.branchB, 'SB', 'Site B'),
  ]).execute();
  await admin.insertInto('locations').values(node(n.floor2, level.floor, 'place', n.siteA, 'F2', 'Floor 2')).execute();
  await admin.insertInto('locations').values(node(n.zoneC, level.zone, 'place', n.floor2, 'ZC', 'Zone C')).execute();

  const employee = (branchId: string, k: number) => seedEmployee(admin, orgId, branchId, k);
  const e5 = await employee(f.branchA, 5); const e6 = await employee(f.branchA, 6); const e7 = await employee(f.branchA, 7);
  const e8 = await employee(f.branchA, 8); const e9 = await employee(f.branchA, 9); const e10 = await employee(f.branchB, 10); const e11 = await employee(f.branchA, 11);
  for (const [id, place] of [[e5, n.floor2], [e6, n.zoneC], [e7, n.annex]] as const) await admin.updateTable('employees').set({ workLocationId: place }).where('id', '=', id).execute();

  const scopedAdminB = uuid('c'); const scopedHrA = uuid('c'); const scopedHrB = uuid('c');
  await seedUser(admin, scopedAdminB, `scoped-admin-b-${tag}@test.local`, 'Scoped admin B');
  await seedUser(admin, scopedHrA, `scoped-hr-a-${tag}@test.local`, 'Scoped HR A');
  await seedUser(admin, scopedHrB, `scoped-hr-b-${tag}@test.local`, 'Scoped HR B');
  await seedMembership(admin, orgId, scopedAdminB, ROLE.hr_admin, { branchIds: [f.branchB] });
  await seedMembership(admin, orgId, scopedHrA, ROLE.hr_user, { branchIds: [f.branchA] });
  await seedMembership(admin, orgId, scopedHrB, ROLE.hr_user, { branchIds: [f.branchB] });
  return { node: n, e5, e6, e7, e8, e9, e10, e11, scopedAdminB, scopedHrA, scopedHrB };
}

/** The first validation issue's path of an error response. */
export const issuePath = (r: { body: { details?: { issues?: Array<{ path: string }> } } }): string | undefined => r.body.details?.issues?.[0]?.path;

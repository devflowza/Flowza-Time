import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import { AppError } from '@flowza/shared';
import { mapLocationError } from '../services/locations.service.js';
import { auditRows, createApiHarness, isoToday, ROLE, seedDevice, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

/*
 * Location hierarchy API (docs/locations.md §5–§6, ADR-009): customer-named levels (insert above / below the branch level,
 * rename, delete, templates), the location tree (groups, branch nodes, places) with its placement, move, archive and code
 * rules, roll-up counts, branch placement through /branches, the branch-scoped administrator's limits and tenant isolation.
 * The scenario builds one organisation step by step: the tests of this file run in order and share its state.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let other: OrgFixture;
/** org_admin limited to branch B: branch.manage without every branch. */
const scopedAdmin = uuid('c');
const call = (method: string, path: string, token: string, body?: unknown, orgId?: string) =>
  h.request(method, `/api/v1/orgs/${orgId ?? f.orgId}${path}`, { token, ...(body === undefined ? {} : { body }) });
const branchNodeOf = async (branchId: string) =>
  (await h.admin.selectFrom('locations').select('id').where('branchId', '=', branchId).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;

// ids collected along the scenario
const L = { hq: '', region: '', branch: '', site: '', floor: '', zone: '' }; // levels of f
let nodeA = ''; let nodeB = ''; let hq = ''; let siteA = ''; let floor1 = ''; let zoneC = ''; let siteA2 = ''; let siteOfB = '';
let deviceZone = '';

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_locations_${process.pid}`);
  f = await seedOrg(h.admin, 'loc');
  other = await seedOrg(h.admin, 'locother');
  await seedUser(h.admin, scopedAdmin, 'scoped-admin-loc@test.local', 'Scoped admin');
  await seedMembership(h.admin, f.orgId, scopedAdmin, ROLE.org_admin, { branchIds: [f.branchB] });
  nodeA = await branchNodeOf(f.branchA);
  nodeB = await branchNodeOf(f.branchB);
});
afterAll(async () => { await h?.close(); });

describe('location levels', () => {
  it('lists the default branch level with its branch count (branch.view); a member without branch.view is refused', async () => {
    const r = await call('GET', '/location-levels', f.owner);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({ position: 1, role: 'branch', name: 'Branch', nameAr: 'فرع', icon: 'branch', locationCount: 2, organizationId: f.orgId });
    L.branch = r.body.data[0].id;
    expect((await call('GET', '/location-levels', f.hrUser)).status).toBe(200);
    expect((await call('GET', '/location-levels', f.employeeUser)).status).toBe(403);
  });

  it('inserts levels above (group) and below (place) the branch level, moving the levels at and below the position', async () => {
    let r = await call('POST', '/location-levels', f.owner, { name: 'Headquarters', nameAr: 'المقر', icon: 'headquarters', position: 1 });
    expect(r.status).toBe(201);
    expect(r.body.data.map((l: any) => [l.position, l.role, l.name])).toEqual([[1, 'group', 'Headquarters'], [2, 'branch', 'Branch']]);
    expect((await call('POST', '/location-levels', f.owner, { name: 'Site', icon: 'site', position: 3 })).status).toBe(201);
    expect((await call('POST', '/location-levels', f.owner, { name: 'Zone', icon: 'zone', position: 4 })).status).toBe(201);
    // between Site and Zone: Zone moves down
    r = await call('POST', '/location-levels', f.owner, { name: 'Floor', icon: 'floor', position: 4 });
    expect(r.body.data.map((l: any) => [l.position, l.role, l.name])).toEqual([[1, 'group', 'Headquarters'], [2, 'branch', 'Branch'], [3, 'place', 'Site'], [4, 'place', 'Floor'], [5, 'place', 'Zone']]);
    // at the branch level's position: a group level, the branch level and everything below move down
    r = await call('POST', '/location-levels', f.owner, { name: 'Region', position: 2 });
    expect(r.status).toBe(201);
    expect(r.body.data.map((l: any) => [l.position, l.role, l.name, l.icon])).toEqual([
      [1, 'group', 'Headquarters', 'headquarters'], [2, 'group', 'Region', 'other'], [3, 'branch', 'Branch', 'branch'], [4, 'place', 'Site', 'site'], [5, 'place', 'Floor', 'floor'], [6, 'place', 'Zone', 'zone'],
    ]);
    const byName = new Map<string, string>(r.body.data.map((l: any) => [l.name, l.id]));
    Object.assign(L, { hq: byName.get('Headquarters'), region: byName.get('Region'), site: byName.get('Site'), floor: byName.get('Floor'), zone: byName.get('Zone') });
    expect(byName.get('Branch')).toBe(L.branch); // the branch level keeps its id
    // a position past the end of the list
    const gap = await call('POST', '/location-levels', f.owner, { name: 'Desk', position: 8 });
    expect([gap.status, gap.body.code]).toEqual([400, 'VALIDATION_ERROR']);
    expect(gap.body.details.issues[0].path).toBe('position');
    const audits = (await auditRows(h.admin, 'location_level.created')).filter((a) => a.organizationId === f.orgId);
    expect(audits).toHaveLength(5);
  });

  it('refuses level writes to a member without every branch, and to a member without branch.manage', async () => {
    for (const [method, path, body] of [
      ['POST', '/location-levels', { name: 'Desk', position: 7 }], ['PATCH', `/location-levels/${L.site}`, { name: 'Campus' }], ['DELETE', `/location-levels/${L.region}`, undefined],
      ['POST', '/location-levels/apply-template', { template: 'CORPORATE' }],
    ] as const) {
      const r = await call(method, path, scopedAdmin, body);
      expect([method, path, r.status, r.body.code]).toEqual([method, path, 403, 'FORBIDDEN']);
    }
    expect((await call('POST', '/location-levels', f.hrUser, { name: 'Desk', position: 7 })).status).toBe(403);
    expect((await call('GET', '/location-levels', f.owner)).body.data).toHaveLength(6);
  });

  it('renames a level in English / Arabic; a one-field PATCH keeps the other fields', async () => {
    let r = await call('PATCH', `/location-levels/${L.hq}`, f.owner, { nameAr: 'المكتب الرئيسي' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: L.hq, name: 'Headquarters', nameAr: 'المكتب الرئيسي', icon: 'headquarters', position: 1, role: 'group' });
    r = await call('PATCH', `/location-levels/${L.hq}`, f.owner, { name: 'Head office' });
    expect(r.body.data).toMatchObject({ name: 'Head office', nameAr: 'المكتب الرئيسي', icon: 'headquarters' });
    r = await call('PATCH', `/location-levels/${L.branch}`, f.owner, { name: 'Operating unit', icon: 'store' });
    expect(r.body.data).toMatchObject({ name: 'Operating unit', nameAr: 'فرع', icon: 'store', role: 'branch' });
    expect((await call('PATCH', `/location-levels/${uuid('9')}`, f.owner, { name: 'X' })).status).toBe(404);
    const audit = (await auditRows(h.admin, 'location_level.updated')).find((a) => a.entityId === L.hq && (a.newValue as any)?.name === 'Head office');
    expect(audit?.oldValue).toEqual({ name: 'Headquarters' });
  });

  it('deletes an unused level (the levels below move up) but never the branch level', async () => {
    const branch = await call('DELETE', `/location-levels/${L.branch}`, f.owner);
    expect([branch.status, branch.body.code, branch.body.details.reason]).toEqual([409, 'CONFLICT', 'BRANCH_LEVEL']);
    const r = await call('DELETE', `/location-levels/${L.region}`, f.owner);
    expect(r.status).toBe(200);
    expect(r.body.data.map((l: any) => [l.position, l.role, l.id])).toEqual([[1, 'group', L.hq], [2, 'branch', L.branch], [3, 'place', L.site], [4, 'place', L.floor], [5, 'place', L.zone]]);
    expect((await call('DELETE', `/location-levels/${L.region}`, f.owner)).status).toBe(404);
  });
});

describe('location templates', () => {
  let otherBranchLevel = '';

  it('replace the levels while there is no group / place location; the branch level keeps its id', async () => {
    otherBranchLevel = (await call('GET', '/location-levels', other.owner, undefined, other.orgId)).body.data[0].id;
    let r = await call('POST', '/location-levels/apply-template', other.owner, { template: 'REGIONAL' }, other.orgId);
    expect(r.status).toBe(200);
    expect(r.body.data.map((l: any) => [l.position, l.role, l.name])).toEqual([
      [1, 'group', 'Headquarters'], [2, 'group', 'Region'], [3, 'branch', 'Branch'], [4, 'place', 'Site'], [5, 'place', 'Floor'], [6, 'place', 'Zone'],
    ]);
    expect(r.body.data[2]).toMatchObject({ id: otherBranchLevel, locationCount: 2 });
    // up to 8 levels
    expect((await call('POST', '/location-levels', other.owner, { name: 'Building', icon: 'building', position: 5 }, other.orgId)).status).toBe(201);
    r = await call('POST', '/location-levels', other.owner, { name: 'Desk', position: 8 }, other.orgId);
    expect(r.body.data).toHaveLength(8);
    const full = await call('POST', '/location-levels', other.owner, { name: 'Shelf', position: 8 }, other.orgId);
    expect([full.status, full.body.details.reason]).toEqual([409, 'LEVELS_MAX']);
    r = await call('POST', '/location-levels/apply-template', other.owner, { template: 'RETAIL' }, other.orgId);
    expect(r.body.data.map((l: any) => [l.position, l.role, l.name, l.nameAr, l.icon])).toEqual([
      [1, 'group', 'Region', 'إقليم', 'region'], [2, 'branch', 'Store', 'متجر', 'store'], [3, 'place', 'Section', 'قسم', 'section'],
    ]);
    expect(r.body.data[1].id).toBe(otherBranchLevel);
    const nodes = (await call('GET', '/locations', other.owner, undefined, other.orgId)).body.data;
    expect(nodes.filter((n: any) => n.role === 'branch').map((n: any) => n.levelId)).toEqual([otherBranchLevel, otherBranchLevel]);
    expect((await auditRows(h.admin, 'location_level.template_applied')).filter((a) => a.organizationId === other.orgId)).toHaveLength(2);
  });

  it('refuse a template once a group or place location exists, archived ones included', async () => {
    const region = (await call('GET', '/location-levels', other.owner, undefined, other.orgId)).body.data[0].id;
    const gulf = await call('POST', '/locations', other.owner, { levelId: region, name: 'Gulf' }, other.orgId);
    expect(gulf.status).toBe(201);
    let r = await call('POST', '/location-levels/apply-template', other.owner, { template: 'SIMPLE' }, other.orgId);
    expect([r.status, r.body.details.reason, r.body.details.locations]).toEqual([409, 'LOCATIONS_EXIST', 1]);
    expect((await call('DELETE', `/locations/${gulf.body.data.id}`, other.owner, undefined, other.orgId)).body.data.status).toBe('archived');
    r = await call('POST', '/location-levels/apply-template', other.owner, { template: 'SIMPLE' }, other.orgId);
    expect(r.status).toBe(409);
  });
});

describe('the location tree', () => {
  it('an unrestricted administrator builds Headquarters → branch → Site → Floor → Zone', async () => {
    let r = await call('POST', '/locations', f.owner, { levelId: L.hq, name: 'Muscat HQ', nameAr: 'مسقط' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ role: 'group', code: 'MUSCAT-HQ', parentId: null, branchId: null, depth: 1, status: 'active', childCount: 0 });
    hq = r.body.data.id;
    expect(r.body.data.path).toEqual([hq]);
    // the branch moves under the group node through the branches API
    const placed = await call('PATCH', `/branches/${f.branchA}`, f.owner, { parentLocationId: hq });
    expect(placed.status).toBe(200);
    expect(placed.body.data).toMatchObject({ id: f.branchA, locationId: nodeA, parentLocationId: hq });
    r = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeA, name: 'Site A' });
    expect(r.body.data).toMatchObject({ role: 'place', code: 'SITE-A', branchId: f.branchA, parentId: nodeA, depth: 3 });
    siteA = r.body.data.id;
    expect(r.body.data.path).toEqual([hq, nodeA, siteA]);
    floor1 = (await call('POST', '/locations', f.owner, { levelId: L.floor, parentId: siteA, name: 'Floor 1' })).body.data.id;
    r = await call('POST', '/locations', f.owner, { levelId: L.zone, parentId: floor1, code: 'ZC', name: 'Zone C', nameAr: 'المنطقة ج', latitude: 23.588, longitude: 58.3829 });
    expect(r.status).toBe(201);
    zoneC = r.body.data.id;
    expect(r.body.data).toMatchObject({ code: 'ZC', name: 'Zone C', nameAr: 'المنطقة ج', latitude: 23.588, longitude: 58.3829, branchId: f.branchA, depth: 5, path: [hq, nodeA, siteA, floor1, zoneC] });
    // node + breadcrumb
    const detail = await call('GET', `/locations/${zoneC}`, f.owner);
    expect(detail.status).toBe(200);
    expect(detail.body.data.ancestors.map((a: any) => [a.id, a.role, a.code, a.name])).toEqual([
      [hq, 'group', 'MUSCAT-HQ', 'Muscat HQ'], [nodeA, 'branch', 'A', 'Branch A'], [siteA, 'place', 'SITE-A', 'Site A'], [floor1, 'place', 'FLOOR-1', 'Floor 1'],
    ]);
    const created = (await auditRows(h.admin, 'location.created')).find((a) => a.entityId === zoneC);
    expect(created).toMatchObject({ organizationId: f.orgId, branchId: f.branchA, actorUserId: f.owner });
    expect(await h.admin.selectFrom('locations').select('createdBy').where('id', '=', zoneC).executeTakeFirst()).toEqual({ createdBy: f.owner });
    // the tree: parents before children, branch nodes carrying their branch
    const tree = (await call('GET', '/locations', f.owner)).body.data;
    expect(tree.map((n: any) => n.id).indexOf(hq)).toBeLessThan(tree.map((n: any) => n.id).indexOf(nodeA));
    expect(tree.find((n: any) => n.id === nodeB)).toMatchObject({ role: 'branch', code: 'B', name: 'Branch B', branchId: f.branchB, parentId: null, levelId: L.branch });
    // the level list counts the locations on each level
    const levels = (await call('GET', '/location-levels', f.owner)).body.data;
    expect(levels.map((l: any) => l.locationCount)).toEqual([1, 2, 1, 1, 1]);
    // read with branch.view (an HR user reads it all); writes need branch.manage
    expect((await call('GET', '/locations', f.hrUser)).body.data).toHaveLength(tree.length);
    expect((await call('GET', '/locations', f.employeeUser)).status).toBe(403);
    expect((await call('GET', `/locations/${zoneC}`, f.employeeUser)).status).toBe(403);
    expect((await call('POST', '/locations', f.hrUser, { levelId: L.site, parentId: nodeA, name: 'HR site' })).status).toBe(403);
    expect((await call('PATCH', `/locations/${siteA}`, f.hrAdmin, { name: 'HR rename' })).status).toBe(403);
  });

  it('rolls active employees and devices up the tree', async () => {
    await h.admin.updateTable('employees').set({ workLocationId: floor1 }).where('id', '=', f.e1).execute();
    // e3 works in branch A without a place; e2 in branch B; a terminated / a deleted employee of A do not count
    const gone = await seedEmployee(h.admin, f.orgId, f.branchA, 20, { employmentStatus: 'terminated' });
    await h.admin.updateTable('employees').set({ workLocationId: floor1 }).where('id', '=', gone).execute();
    const deleted = await seedEmployee(h.admin, f.orgId, f.branchA, 21);
    await h.admin.updateTable('employees').set({ workLocationId: zoneC, deletedAt: new Date() }).where('id', '=', deleted).execute();
    deviceZone = await seedDevice(h.admin, f.orgId, f.branchA);
    await h.admin.updateTable('devices').set({ locationId: zoneC }).where('id', '=', deviceZone).execute();
    await seedDevice(h.admin, f.orgId, f.branchA); // the branch, no place
    const retired = await seedDevice(h.admin, f.orgId, f.branchA);
    await h.admin.updateTable('devices').set({ locationId: zoneC, status: 'decommissioned' }).where('id', '=', retired).execute();
    await seedDevice(h.admin, f.orgId, f.branchB);

    const tree = new Map<string, any>((await call('GET', '/locations', f.owner)).body.data.map((n: any) => [n.id, n]));
    const counts = (id: string) => { const n = tree.get(id); return [n.employeeCount, n.deviceCount, n.childCount]; };
    expect(counts(zoneC)).toEqual([0, 1, 0]);
    expect(counts(floor1)).toEqual([1, 1, 1]);
    expect(counts(siteA)).toEqual([1, 1, 1]);
    expect(counts(nodeA)).toEqual([2, 2, 1]); // e1 (Floor 1) + e3; the Zone C terminal + the branch's own
    expect(counts(hq)).toEqual([2, 2, 1]); // the sum of its branches
    expect(counts(nodeB)).toEqual([1, 1, 0]);
    // the detail counts the node's subtree
    const site = await call('GET', `/locations/${siteA}`, f.owner);
    expect([site.body.data.employeeCount, site.body.data.deviceCount, site.body.data.childCount]).toEqual([1, 1, 1]);
  });

  it('derives codes from the name, unique among siblings; an explicit sibling clash is a 409', async () => {
    let r = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeA, name: 'Site A' });
    expect(r.body.data.code).toBe('SITE-A-2');
    siteA2 = r.body.data.id;
    r = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeA, code: 'site-a', name: 'Site B' });
    expect([r.status, r.body.code, r.body.details.reason]).toEqual([409, 'CONFLICT', 'CODE_TAKEN']);
    r = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeB, code: 'SITE-A', name: 'Site A of B' });
    expect(r.status).toBe(201); // the same code under another parent
    siteOfB = r.body.data.id;
    r = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeB, name: 'الموقع' });
    expect(r.body.data.code).toBe('LOC'); // no Latin letters or digits
    // a group node's code also avoids the codes of the branches beside it
    r = await call('POST', '/locations', f.owner, { levelId: L.hq, name: 'B' });
    expect(r.body.data.code).toBe('B-2');
  });

  it('validates the placement: kinds, depth, parents and levels', async () => {
    const problem = async (body: Record<string, unknown>) => { const r = await call('POST', '/locations', f.owner, body); return [r.status, r.body.code, r.body.details?.problem ?? r.body.details?.reason, r.body.details?.issues?.[0]?.path]; };
    expect(await problem({ levelId: L.site, name: 'Top site' })).toEqual([400, 'VALIDATION_ERROR', 'PLACE_AT_TOP', 'parentId']);
    expect(await problem({ levelId: L.site, parentId: hq, name: 'Site under HQ' })).toEqual([400, 'VALIDATION_ERROR', 'PLACE_UNDER_GROUP', 'parentId']);
    expect(await problem({ levelId: L.hq, parentId: nodeA, name: 'Group under a branch' })).toEqual([400, 'VALIDATION_ERROR', 'GROUP_UNDER_NON_GROUP', 'parentId']);
    expect(await problem({ levelId: L.site, parentId: floor1, name: 'Site under a floor' })).toEqual([400, 'VALIDATION_ERROR', 'NOT_DEEPER', 'levelId']);
    expect(await problem({ levelId: L.branch, name: 'Branch node' })).toEqual([400, 'VALIDATION_ERROR', 'BRANCH_LEVEL', 'levelId']);
    const foreignLevel = (await call('GET', '/location-levels', other.owner, undefined, other.orgId)).body.data[0].id;
    expect(await problem({ levelId: foreignLevel, name: 'Foreign level' })).toEqual([400, 'VALIDATION_ERROR', 'UNKNOWN_LEVEL', 'levelId']);
    const unknownParent = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: uuid('9'), name: 'Orphan' });
    expect([unknownParent.status, unknownParent.body.code]).toEqual([404, 'NOT_FOUND']);
    // levels may be skipped: a zone straight under the branch
    const skip = await call('POST', '/locations', f.owner, { levelId: L.zone, parentId: nodeA, name: 'Loading bay' });
    expect(skip.body.data).toMatchObject({ depth: 3, branchId: f.branchA });
    // a level in use cannot be deleted
    const inUse = await call('DELETE', `/location-levels/${L.zone}`, f.owner);
    expect([inUse.status, inUse.body.details.reason, inUse.body.details.locations]).toEqual([409, 'LEVEL_IN_USE', 2]);
  });

  it('lets a branch-scoped administrator manage the places of their branch only', async () => {
    const seen = (await call('GET', '/locations', scopedAdmin)).body.data.map((n: any) => n.id);
    expect(seen).toContain(hq); // group nodes are visible to every reader
    expect(seen).toContain(nodeB);
    expect(seen).not.toContain(nodeA);
    expect(seen).not.toContain(siteA);
    // their branch's places: add, rename, archive
    const added = await call('POST', '/locations', scopedAdmin, { levelId: L.site, parentId: nodeB, name: 'Warehouse' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ branchId: f.branchB, code: 'WAREHOUSE' });
    const renamed = await call('PATCH', `/locations/${added.body.data.id}`, scopedAdmin, { name: 'Main warehouse', nameAr: 'المستودع' });
    expect(renamed.body.data).toMatchObject({ name: 'Main warehouse', nameAr: 'المستودع', code: 'WAREHOUSE' });
    const archived = await call('DELETE', `/locations/${added.body.data.id}`, scopedAdmin);
    expect(archived.body.data.status).toBe('archived');
    // never group nodes, other branches' places or the placement of their branch
    expect((await call('POST', '/locations', scopedAdmin, { levelId: L.hq, name: 'Southern region' })).status).toBe(403);
    expect((await call('PATCH', `/locations/${hq}`, scopedAdmin, { name: 'Renamed HQ' })).status).toBe(403);
    expect((await call('DELETE', `/locations/${hq}`, scopedAdmin)).status).toBe(403);
    expect((await call('POST', '/locations', scopedAdmin, { levelId: L.floor, parentId: siteA, name: 'Floor in A' })).status).toBe(404);
    expect((await call('PATCH', `/locations/${siteA}`, scopedAdmin, { name: 'Hijack' })).status).toBe(404);
    expect((await call('DELETE', `/locations/${siteA}`, scopedAdmin)).status).toBe(404);
    expect((await call('GET', `/locations/${siteA}`, scopedAdmin)).status).toBe(404);
    expect((await call('PATCH', `/locations/${nodeB}`, scopedAdmin, { parentId: hq })).status).toBe(403);
    expect((await call('PATCH', `/branches/${f.branchB}`, scopedAdmin, { parentLocationId: hq })).status).toBe(403);
    // the branch's own fields stay theirs; naming the current placement is no move
    const own = await call('PATCH', `/branches/${f.branchB}`, scopedAdmin, { city: 'Sohar', parentLocationId: null });
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ city: 'Sohar', locationId: nodeB, parentLocationId: null });
    expect(await h.admin.selectFrom('locations').select('name').where('id', '=', hq).executeTakeFirst()).toEqual({ name: 'Muscat HQ' });
  });

  it('refuses cycles, wrong levels and kinds when moving or re-levelling; a branch node only moves', async () => {
    const problem = async (id: string, body: Record<string, unknown>) => { const r = await call('PATCH', `/locations/${id}`, f.owner, body); return [r.status, r.body.details?.problem ?? r.body.details?.reason, r.body.details?.issues?.[0]?.path]; };
    expect(await problem(siteA, { parentId: zoneC })).toEqual([400, 'CYCLE', 'parentId']);
    expect(await problem(siteA, { parentId: siteA })).toEqual([400, 'CYCLE', 'parentId']);
    expect(await problem(siteA, { parentId: null })).toEqual([400, 'PLACE_AT_TOP', 'parentId']);
    expect(await problem(hq, { parentId: nodeA })).toEqual([400, 'CYCLE', 'parentId']); // branch A sits under it
    expect(await problem(hq, { parentId: nodeB })).toEqual([400, 'GROUP_UNDER_NON_GROUP', 'parentId']);
    expect(await problem(floor1, { parentId: siteA2 })).toEqual([200, undefined, undefined]); // Floor 1 under the other site of the branch
    expect(await problem(floor1, { parentId: siteA })).toEqual([200, undefined, undefined]); // and back
    expect(await problem(siteA, { levelId: L.floor })).toEqual([400, 'NOT_ABOVE_CHILDREN', 'levelId']); // Floor 1 below it
    expect(await problem(siteA, { levelId: L.hq })).toEqual([400, 'KIND_CHANGE', 'levelId']);
    expect(await problem(zoneC, { levelId: L.floor })).toEqual([400, 'NOT_DEEPER', 'levelId']); // its parent is a floor
    expect(await problem(nodeA, { name: 'Renamed branch' })).toEqual([400, 'BRANCH_NODE', 'name']);
    expect(await problem(nodeA, { parentId: siteOfB })).toEqual([400, 'BRANCH_UNDER_NON_GROUP', 'parentId']);
    // a valid re-level skips a level; a branch node moves to the top and back
    const relevel = await call('PATCH', `/locations/${siteA2}`, f.owner, { levelId: L.floor });
    expect(relevel.body.data).toMatchObject({ levelId: L.floor, depth: 3, parentId: nodeA });
    const top = await call('PATCH', `/locations/${nodeA}`, f.owner, { parentId: null });
    expect(top.body.data).toMatchObject({ parentId: null, path: [nodeA], depth: 1 });
    expect((await call('GET', `/locations/${zoneC}`, f.owner)).body.data.path).toEqual([nodeA, siteA, floor1, zoneC]); // the subtree followed
    expect((await call('PATCH', `/locations/${nodeA}`, f.owner, { parentId: hq })).body.data.path).toEqual([hq, nodeA]);
    expect((await call('GET', `/branches/${f.branchA}`, f.owner)).body.data.parentLocationId).toBe(hq);
    expect((await auditRows(h.admin, 'location.moved')).filter((a) => a.entityId === nodeA)).toHaveLength(3); // + the branch placement
  });

  it('moves a place to another branch only when nothing refers to it or below it; its subtree follows', async () => {
    // the code it keeps is taken under its new parent ("Site A of B"): the move names a new one
    let r = await call('PATCH', `/locations/${siteA}`, f.owner, { parentId: nodeB });
    expect([r.status, r.body.details.reason]).toEqual([409, 'CODE_TAKEN']);
    const move = { parentId: nodeB, code: 'SITE-A-EAST' };
    // e1 and the terminated (not deleted) employee work on Floor 1, the Zone C terminal is installed there; the decommissioned
    // terminal and the deleted employee record do not count
    r = await call('PATCH', `/locations/${siteA}`, f.owner, move);
    expect([r.status, r.body.code, r.body.details]).toEqual([409, 'CONFLICT', { reason: 'PLACE_IN_USE', devices: 1, employees: 2, geofences: 0, coverageTargets: 0, policies: 0 }]);
    // a terminated employee still refers to the place (only deleted records let go of it)
    await h.admin.updateTable('employees').set({ workLocationId: null }).where('id', '=', f.e1).execute();
    await h.admin.updateTable('devices').set({ status: 'decommissioned' }).where('id', '=', deviceZone).execute();
    r = await call('PATCH', `/locations/${siteA}`, f.owner, move);
    expect([r.status, r.body.details.employees, r.body.details.devices]).toEqual([409, 1, 0]);
    await h.admin.updateTable('employees').set({ deletedAt: new Date() }).where('organizationId', '=', f.orgId).where('employmentStatus', '=', 'terminated').where('workLocationId', '=', floor1).execute();
    // a branch-scoped administrator cannot move it into a branch they do not hold (nor see)
    expect([403, 404]).toContain((await call('PATCH', `/locations/${siteA}`, scopedAdmin, move)).status);
    r = await call('PATCH', `/locations/${siteA}`, f.owner, move);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ branchId: f.branchB, parentId: nodeB, path: [nodeB, siteA], depth: 2, code: 'SITE-A-EAST' });
    const zone = (await call('GET', `/locations/${zoneC}`, f.owner)).body.data;
    expect(zone).toMatchObject({ branchId: f.branchB, path: [nodeB, siteA, floor1, zoneC] });
    // the retired references let go of the place
    expect(await h.admin.selectFrom('devices').select('locationId').where('organizationId', '=', f.orgId).where('status', '=', 'decommissioned').where('locationId', 'is not', null).execute()).toEqual([]);
    expect(await h.admin.selectFrom('employees').select('id').where('organizationId', '=', f.orgId).where('workLocationId', 'in', [floor1, zoneC]).execute()).toEqual([]);
    const moved = (await auditRows(h.admin, 'location.moved')).find((a) => a.entityId === siteA);
    expect(moved?.oldValue).toEqual({ parentId: nodeA, branchId: f.branchA });
    expect(moved?.newValue).toMatchObject({ parentId: nodeB, branchId: f.branchB, releasedRetiredReferences: { devices: 2, employees: 2 } });
    // now in branch B: the branch-scoped administrator sees and manages it, but cannot move it back to A
    expect((await call('GET', `/locations/${siteA}`, scopedAdmin)).status).toBe(200);
    expect([403, 404]).toContain((await call('PATCH', `/locations/${siteA}`, scopedAdmin, { parentId: nodeA })).status);
    r = await call('PATCH', `/locations/${siteA}`, f.owner, { parentId: nodeA, code: 'SITE-A' });
    expect(r.body.data).toMatchObject({ branchId: f.branchA, path: [hq, nodeA, siteA], code: 'SITE-A' });
  });

  it('answers 409 when the composite key still refuses a move (a retired reference the caller\'s role cannot release)', async () => {
    // every branch and branch.manage, but no device.update: the decommissioned terminal keeps its place
    const roleId = uuid('9');
    await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
      await trx.insertInto('roles').values({ id: roleId, organizationId: f.orgId, key: 'locations_only', name: 'Locations only', isSystem: false }).execute();
      await trx.insertInto('rolePermissions').values(['branch.view', 'branch.manage'].map((permissionKey) => ({ roleId, permissionKey }))).execute();
    });
    const structureAdmin = uuid('c');
    await seedUser(h.admin, structureAdmin, 'locations-only@test.local', 'Locations only');
    await seedMembership(h.admin, f.orgId, structureAdmin, roleId);
    const kiosk = (await call('POST', '/locations', structureAdmin, { levelId: L.site, parentId: nodeA, name: 'Kiosk' })).body.data.id;
    const retired = await seedDevice(h.admin, f.orgId, f.branchA);
    await h.admin.updateTable('devices').set({ locationId: kiosk, status: 'decommissioned' }).where('id', '=', retired).execute();
    const refused = await call('PATCH', `/locations/${kiosk}`, structureAdmin, { parentId: nodeB });
    expect([refused.status, refused.body.code, refused.body.details]).toEqual([409, 'CONFLICT', { reason: 'PLACE_IN_USE', referencedBy: 'devices' }]);
    expect(refused.body.message).not.toMatch(/constraint|relation|table/i);
    expect(await h.admin.selectFrom('locations').select('branchId').where('id', '=', kiosk).executeTakeFirst()).toEqual({ branchId: f.branchA });
    // the owner's role releases it
    const moved = await call('PATCH', `/locations/${kiosk}`, f.owner, { parentId: nodeB });
    expect(moved.body.data).toMatchObject({ branchId: f.branchB, parentId: nodeB });
    expect(await h.admin.selectFrom('devices').select('locationId').where('id', '=', retired).executeTakeFirst()).toEqual({ locationId: null });
  });

  it('archives only what nothing active uses; restores under an active parent', async () => {
    const refusal = async (id: string) => { const r = await call('DELETE', `/locations/${id}`, f.owner); return [r.status, r.body.details?.reason, r.body.details]; };
    let [status, reason, details] = await refusal(siteA);
    expect([status, reason, details.children]).toEqual([409, 'LOCATION_IN_USE', 1]);
    // an active employee, a terminal, an active fence, a coverage target and a policy in force each hold Zone C
    const worker = await seedEmployee(h.admin, f.orgId, f.branchA, 30);
    await h.admin.updateTable('employees').set({ workLocationId: zoneC }).where('id', '=', worker).execute();
    const terminal = await seedDevice(h.admin, f.orgId, f.branchA);
    await h.admin.updateTable('devices').set({ locationId: zoneC }).where('id', '=', terminal).execute();
    const fence = await h.admin.insertInto('geofences').values({ organizationId: f.orgId, branchId: f.branchA, locationId: zoneC, name: 'Zone C fence', latitude: 23.588, longitude: 58.3829, radiusM: 100 }).returning('id').executeTakeFirstOrThrow();
    const shift = await h.admin.insertInto('shifts').values({ organizationId: f.orgId, code: 'LOC-M', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00', breaks: JSON.stringify([]) }).returning('id').executeTakeFirstOrThrow();
    const coverage = await h.admin.insertInto('shiftCoverageRequirements').values({ organizationId: f.orgId, branchId: f.branchA, shiftId: shift.id, locationId: zoneC, minHeadcount: 2 }).returning('id').executeTakeFirstOrThrow();
    // a policy that ended does not hold it (`effective_to` is exclusive)
    await h.admin.insertInto('attendanceRuleSets').values({ organizationId: f.orgId, name: 'Zone C (past)', branchId: f.branchA, locationId: zoneC, effectiveFrom: isoToday(-400), effectiveTo: isoToday(-200), ramadanMode: JSON.stringify({}) }).execute();
    const policy = await h.admin.insertInto('attendanceRuleSets').values({ organizationId: f.orgId, name: 'Zone C', branchId: f.branchA, locationId: zoneC, effectiveFrom: isoToday(-30), ramadanMode: JSON.stringify({}) }).returning('id').executeTakeFirstOrThrow();
    [status, reason, details] = await refusal(zoneC);
    expect([status, reason]).toEqual([409, 'LOCATION_IN_USE']);
    expect(details).toMatchObject({ children: 0, devices: 1, employees: 1, geofences: 1, coverageTargets: 1, policies: 1 });
    // PATCH status archived follows the same rules
    expect((await call('PATCH', `/locations/${zoneC}`, f.owner, { status: 'archived' })).status).toBe(409);
    await h.admin.updateTable('employees').set({ employmentStatus: 'resigned' }).where('id', '=', worker).execute();
    await h.admin.updateTable('devices').set({ status: 'decommissioned' }).where('id', '=', terminal).execute();
    await h.admin.updateTable('geofences').set({ isActive: false }).where('id', '=', fence.id).execute();
    await h.admin.deleteFrom('shiftCoverageRequirements').where('id', '=', coverage.id).execute();
    await h.admin.updateTable('attendanceRuleSets').set({ effectiveTo: isoToday(-1) }).where('id', '=', policy.id).execute();
    const archived = await call('DELETE', `/locations/${zoneC}`, f.owner);
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ id: zoneC, status: 'archived' });
    expect((await auditRows(h.admin, 'location.archived')).find((a) => a.entityId === zoneC)?.newValue).toEqual({ status: 'archived' });
    expect((await call('DELETE', `/locations/${zoneC}`, f.owner)).status).toBe(200); // already archived
    // the tree leaves it out unless asked
    const visible = (await call('GET', '/locations', f.owner)).body.data;
    expect(visible.map((n: any) => n.id)).not.toContain(zoneC);
    expect(visible.find((n: any) => n.id === floor1).childCount).toBe(0);
    const all = (await call('GET', '/locations?includeArchived=true', f.owner)).body.data;
    expect(all.find((n: any) => n.id === zoneC).status).toBe('archived');
    expect(all.find((n: any) => n.id === floor1).childCount).toBe(1);
    // nothing new under an archived node, nothing restored under one
    const under = await call('POST', '/locations', f.owner, { levelId: L.zone, parentId: zoneC, name: 'Nook' });
    expect([under.status, under.body.details.problem]).toEqual([400, 'PARENT_ARCHIVED']);
    expect((await call('DELETE', `/locations/${floor1}`, f.owner)).body.data.status).toBe('archived'); // its only child is archived
    const blocked = await call('PATCH', `/locations/${zoneC}`, f.owner, { status: 'active' });
    expect([blocked.status, blocked.body.details.problem]).toEqual([400, 'PARENT_ARCHIVED']);
    const newUnder = await call('POST', '/locations', f.owner, { levelId: L.zone, parentId: floor1, name: 'Nook' });
    expect([newUnder.status, newUnder.body.details.problem]).toEqual([400, 'PARENT_ARCHIVED']);
    expect((await call('PATCH', `/locations/${floor1}`, f.owner, { status: 'active' })).body.data.status).toBe('active');
    expect((await call('PATCH', `/locations/${zoneC}`, f.owner, { status: 'active' })).body.data.status).toBe('active');
    // a branch node follows its branch; a group node waits for its branches
    [status, reason] = await refusal(nodeA);
    expect([status, reason]).toEqual([409, 'BRANCH_NODE']);
    [status, reason, details] = await refusal(hq);
    expect([status, reason, details.children]).toEqual([409, 'LOCATION_IN_USE', 1]);
  });

  it('a PATCH of one field keeps every other field', async () => {
    const created = await call('POST', '/locations', f.owner, { levelId: L.site, parentId: nodeA, code: 'S-NORTH', name: 'North site', nameAr: 'الموقع الشمالي', latitude: 23.6, longitude: 58.5 });
    const id = created.body.data.id;
    const keep = { levelId: L.site, parentId: nodeA, branchId: f.branchA, code: 'S-NORTH', nameAr: 'الموقع الشمالي', latitude: 23.6, longitude: 58.5, status: 'active' };
    let r = await call('PATCH', `/locations/${id}`, f.owner, { name: 'North site (east)' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ...keep, name: 'North site (east)' });
    r = await call('PATCH', `/locations/${id}`, f.owner, { code: 'S-NORTH-E' });
    expect(r.body.data).toMatchObject({ ...keep, code: 'S-NORTH-E', name: 'North site (east)' });
    r = await call('PATCH', `/locations/${id}`, f.owner, { nameAr: null });
    expect(r.body.data).toMatchObject({ ...keep, code: 'S-NORTH-E', nameAr: null });
    r = await call('PATCH', `/locations/${id}`, f.owner, { latitude: 23.7 });
    expect(r.status).toBe(400); // the point changes as a pair
    r = await call('PATCH', `/locations/${id}`, f.owner, { code: 'site-a' });
    expect([r.status, r.body.details.reason]).toEqual([409, 'CODE_TAKEN']);
    const diff = (await auditRows(h.admin, 'location.updated')).find((a) => a.entityId === id && (a.newValue as any)?.code === 'S-NORTH-E');
    expect(diff?.oldValue).toEqual({ code: 'S-NORTH' });
  });

  it('places branches through POST / PATCH /branches (parentLocationId) and shows their node', async () => {
    let r = await call('POST', '/branches', f.owner, { code: 'C', name: 'Branch C', timezone: 'Asia/Muscat', parentLocationId: hq });
    expect(r.status).toBe(201);
    const branchC = r.body.data.id;
    const nodeC = await branchNodeOf(branchC);
    expect(r.body.data).toMatchObject({ locationId: nodeC, parentLocationId: hq });
    const list = (await call('GET', '/branches', f.owner)).body.data;
    expect(list.map((b: any) => [b.code, b.locationId, b.parentLocationId])).toEqual([['A', nodeA, hq], ['B', nodeB, null], ['C', nodeC, hq]]);
    r = await call('PATCH', `/branches/${branchC}`, f.owner, { parentLocationId: null });
    expect(r.body.data).toMatchObject({ locationId: nodeC, parentLocationId: null });
    const updated = (await auditRows(h.admin, 'branch.updated')).find((a) => a.entityId === branchC);
    expect(updated).toMatchObject({ oldValue: { parentLocationId: hq }, newValue: { parentLocationId: null } });
    r = await call('PATCH', `/branches/${branchC}`, f.owner, { parentLocationId: siteA });
    expect([r.status, r.body.details.problem]).toEqual([400, 'BRANCH_UNDER_NON_GROUP']);
    r = await call('POST', '/branches', f.owner, { code: 'D', name: 'Branch D', timezone: 'Asia/Muscat', parentLocationId: siteA });
    expect(r.status).toBe(400);
    expect(await h.admin.selectFrom('branches').select('id').where('organizationId', '=', f.orgId).where('code', '=', 'D').execute()).toEqual([]); // rolled back
    r = await call('POST', '/branches', f.owner, { code: 'D', name: 'Branch D', timezone: 'Asia/Muscat', parentLocationId: uuid('9') });
    expect(r.status).toBe(404);
  });

  it('isolates organisations: the locations of another organisation are not found', async () => {
    const foreign = (await call('GET', '/locations?includeArchived=true', other.owner, undefined, other.orgId)).body.data;
    expect(foreign.map((n: any) => n.id)).not.toContain(hq);
    const gulf = foreign.find((n: any) => n.role === 'group').id;
    expect((await call('GET', `/locations/${gulf}`, f.owner)).status).toBe(404);
    expect((await call('PATCH', `/locations/${gulf}`, f.owner, { name: 'Hijack' })).status).toBe(404);
    expect((await call('DELETE', `/locations/${gulf}`, f.owner)).status).toBe(404);
    expect((await call('POST', '/locations', f.owner, { levelId: L.hq, parentId: gulf, name: 'Under a foreign node' })).status).toBe(404);
    expect((await call('PATCH', `/branches/${f.branchA}`, f.owner, { parentLocationId: gulf })).status).toBe(404);
    const foreignLevel = (await call('GET', '/location-levels', other.owner, undefined, other.orgId)).body.data[0].id;
    expect((await call('PATCH', `/location-levels/${foreignLevel}`, f.owner, { name: 'Hijack' })).status).toBe(404);
    expect((await call('DELETE', `/location-levels/${foreignLevel}`, f.owner)).status).toBe(404);
    expect((await call('GET', '/locations', f.owner, undefined, other.orgId)).status).toBe(403);
    expect((await call('GET', '/locations/not-a-uuid', f.owner)).status).toBe(404);
    expect(await h.admin.selectFrom('locations').select('name').where('id', '=', gulf).executeTakeFirst()).toEqual({ name: 'Gulf' });
  });

  it('caps an organisation at 10 000 group and place locations, counted organisation-wide', async () => {
    const cap = await seedOrg(h.admin, 'loccap');
    const levels = (await call('POST', '/location-levels', cap.owner, { name: 'Region', position: 1 }, cap.orgId)).body.data;
    const group = levels[0].id;
    await sql`insert into public.locations (organization_id, level_id, code, name, path)
      select ${cap.orgId}::uuid, ${group}::uuid, 'G' || g, 'Group ' || g, '{}' from generate_series(1, 9999) g`.execute(h.admin);
    expect((await call('POST', '/locations', cap.owner, { levelId: group, name: 'Last one' }, cap.orgId)).status).toBe(201);
    const full = await call('POST', '/locations', cap.owner, { levelId: group, name: 'One too many' }, cap.orgId);
    expect([full.status, full.body.details]).toEqual([409, { reason: 'LOCATIONS_MAX', max: 10_000 }]);
  });
});

describe('database errors of the location rules', () => {
  it('the deferred level-list check fails inside the transaction once made immediate, with an error the service maps to a 400', async () => {
    // RETAIL levels of `other`: Region 1, Store 2, Section 3 — a group level at 8 leaves gaps and sits below the branch level
    const err = await h.admin.transaction().execute(async (trx) => {
      await trx.insertInto('locationLevels').values({ organizationId: other.orgId, position: 8, role: 'group', name: 'Stray group' }).execute();
      await sql`set constraints public.location_levels_check immediate`.execute(trx);
    }).then(() => null, (e: unknown) => e);
    expect((err as { code?: string } | null)?.code).toBe('23514');
    const mapped = mapLocationError(err);
    expect([mapped?.code, mapped?.status, mapped?.details]).toEqual(['VALIDATION_ERROR', 400, { reason: 'LEVEL_LIST' }]);
    expect(mapped?.message).toBe('Location levels are numbered 1..4 without gaps.');
    expect((await call('GET', '/location-levels', other.owner, undefined, other.orgId)).body.data).toHaveLength(3); // rolled back
  });

  it('map to clean application errors, never SQL text', () => {
    const shape = mapLocationError({ code: '22023', message: 'a place sits under a branch or another place' });
    expect([shape?.code, shape?.status, shape?.message]).toEqual(['VALIDATION_ERROR', 400, 'A place sits under a branch or another place.']);
    const list = mapLocationError({ code: '23514', message: 'location levels are numbered 1..3 without gaps' });
    expect([list?.code, list?.details]).toEqual(['VALIDATION_ERROR', { reason: 'LEVEL_LIST' }]);
    expect(mapLocationError({ code: '23514', constraint: 'location_levels_position_check', message: 'new row for relation "location_levels" violates check constraint' })).toBeNull();
    const sibling = mapLocationError({ code: '23505', constraint: 'locations_sibling_code_key', message: 'duplicate key value violates unique constraint "locations_sibling_code_key"' });
    expect([sibling?.code, sibling?.status, sibling?.message]).toEqual(['CONFLICT', 409, 'Another location under the same parent already uses this code.']);
    const ref = mapLocationError({ code: '23503', constraint: 'devices_location_fkey', message: 'update or delete on table "locations" violates foreign key constraint "devices_location_fkey" on table "devices"' });
    expect([ref?.code, ref?.details]).toEqual(['CONFLICT', { reason: 'PLACE_IN_USE', referencedBy: 'devices' }]);
    expect(ref?.message).not.toMatch(/table|constraint/);
    expect(mapLocationError({ code: '23505', constraint: 'branches_org_code_key' })).toBeNull();
    expect(mapLocationError(new AppError('CONFLICT', 'x'))).toBeNull();
    expect(mapLocationError('boom')).toBeNull();
  });
});

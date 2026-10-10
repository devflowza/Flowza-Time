import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@flowza/database';
import { auditRows, createApiHarness, ROLE, seedDevice, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

/**
 * Place references and `locationId` filters (docs/locations.md §2): devices (`location_id`), employees (`work_location_id`),
 * geofences (`location_id`), the dashboard and reports. The tree is written with the superuser handle (the locations API is
 * built separately); the triggers derive role, branch and path:
 *
 *   Muscat HQ (group) ─┬─ Branch A ─┬─ Site A1 ── Floor 1
 *                      │            └─ Site A2
 *                      └─ Branch B ─── Site B1
 *   Northern Region (group, no branch)
 */

const BUSINESS_PLAN = '20000000-0000-0000-0000-000000000003'; // every module, 50 devices

interface Tree { hq: string; emptyGroup: string; nodeA: string; nodeB: string; siteA1: string; floorA11: string; siteA2: string; siteB1: string }

async function branchNode(admin: Database, branchId: string): Promise<string> {
  return (await admin.selectFrom('locations').select('id').where('branchId', '=', branchId).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
}

async function seedTree(admin: Database, f: OrgFixture): Promise<Tree> {
  const level = { group: uuid('a'), site: uuid('a'), floor: uuid('a') };
  // one transaction: the level list is checked at commit (contiguous, groups above the branch level, places below)
  await admin.transaction().execute(async (t) => {
    await t.updateTable('locationLevels').set({ position: 2 }).where('organizationId', '=', f.orgId).where('role', '=', 'branch').execute();
    await t.insertInto('locationLevels').values([
      { id: level.group, organizationId: f.orgId, position: 1, role: 'group', name: 'Headquarters', icon: 'headquarters' },
      { id: level.site, organizationId: f.orgId, position: 3, role: 'place', name: 'Site', icon: 'site' },
      { id: level.floor, organizationId: f.orgId, position: 4, role: 'place', name: 'Floor', icon: 'floor' },
    ]).execute();
  });
  const tree: Tree = { hq: uuid('a'), emptyGroup: uuid('a'), nodeA: await branchNode(admin, f.branchA), nodeB: await branchNode(admin, f.branchB), siteA1: uuid('a'), floorA11: uuid('a'), siteA2: uuid('a'), siteB1: uuid('a') };
  const node = (id: string, levelId: string, role: 'group' | 'place', parentId: string | null, code: string, name: string) => ({ id, organizationId: f.orgId, levelId, role, parentId, code, name, path: [] as string[] });
  await admin.insertInto('locations').values([node(tree.hq, level.group, 'group', null, 'HQ', 'Muscat HQ'), node(tree.emptyGroup, level.group, 'group', null, 'NR', 'Northern Region')]).execute();
  await admin.updateTable('locations').set({ parentId: tree.hq }).where('id', 'in', [tree.nodeA, tree.nodeB]).execute();
  await admin.insertInto('locations').values([
    node(tree.siteA1, level.site, 'place', tree.nodeA, 'SA1', 'Site A1'),
    node(tree.siteA2, level.site, 'place', tree.nodeA, 'SA2', 'Site A2'),
    node(tree.siteB1, level.site, 'place', tree.nodeB, 'SB1', 'Site B1'),
  ]).execute();
  await admin.insertInto('locations').values(node(tree.floorA11, level.floor, 'place', tree.siteA1, 'F1', 'Floor 1')).execute();
  return tree;
}

let h: ApiHarness; let f: OrgFixture; let t: Tree;
let otherPlace: string;    // a place of another organisation
let deviceAdminB: string;  // attendance admin limited to branch B (device.create / device.update)
let fenceAdminB: string;   // HR admin limited to branch B (attendance.manage_geofences)
let schedulerB: string;    // payroll limited to branch B (report.schedule)

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_locrefs_${process.pid}`);
  f = await seedOrg(h.admin, 'locrefs', { plan: BUSINESS_PLAN });
  t = await seedTree(h.admin, f);
  const other = await seedOrg(h.admin, 'locrefs-other');
  const otherLevel = uuid('a');
  await h.admin.insertInto('locationLevels').values({ id: otherLevel, organizationId: other.orgId, position: 2, role: 'place', name: 'Site', icon: 'site' }).execute();
  otherPlace = uuid('a');
  await h.admin.insertInto('locations').values({ id: otherPlace, organizationId: other.orgId, levelId: otherLevel, role: 'place', parentId: await branchNode(h.admin, other.branchA), code: 'OS', name: 'Other site', path: [] }).execute();
  deviceAdminB = uuid('c'); fenceAdminB = uuid('c'); schedulerB = uuid('c');
  await seedUser(h.admin, deviceAdminB, 'device-admin-b@locrefs.test', 'Device admin B');
  await seedUser(h.admin, fenceAdminB, 'fence-admin-b@locrefs.test', 'Fence admin B');
  await seedUser(h.admin, schedulerB, 'scheduler-b@locrefs.test', 'Scheduler B');
  await seedMembership(h.admin, f.orgId, deviceAdminB, ROLE.attendance_admin, { branchIds: [f.branchB] });
  await seedMembership(h.admin, f.orgId, fenceAdminB, ROLE.hr_admin, { branchIds: [f.branchB] });
  await seedMembership(h.admin, f.orgId, schedulerB, ROLE.payroll, { branchIds: [f.branchB] });
});
afterAll(async () => { await h?.close(); });

const base = () => `/api/v1/orgs/${f.orgId}`;
const sorted = (ids: readonly string[]) => [...ids].sort();
/** The refusals every place reference shares: a group node, a branch node, a place of the other branch, another organisation's place. */
const refusals = (): Array<[string, string]> => [[t.hq, 'Not a place'], [t.nodeA, 'Not a place'], [t.siteB1, 'Another branch'], [otherPlace, 'Unknown location']];
const placeIn = (...places: string[]) => (row: { locationId: string | null }) => row.locationId !== null && places.includes(row.locationId);

// ----- devices -----------------------------------------------------------------------------------------------------------------

describe('devices: location_id', () => {
  const mockDevice = (code: string, branchId: string, extra: Record<string, unknown> = {}) => ({ code, name: `Mock ${code}`, branchId, providerKey: 'mock', manufacturer: 'FlowZa', endpointUrl: 'https://mock.example.com/api', config: { scenario: 'healthy', apiKey: 'valid' }, ...extra });
  let deviceId: string;
  const patch = (body: Record<string, unknown>) => h.request('PATCH', `${base()}/devices/${deviceId}`, { token: f.owner, body });

  it('creates a device on a place of its branch and refuses group / branch nodes, other branches, other organisations and places the caller cannot see', async () => {
    const ok = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice('LOC-D1', f.branchA, { locationId: t.floorA11 }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data.device).toMatchObject({ branchId: f.branchA, locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
    deviceId = ok.body.data.device.id;
    const created = (await auditRows(h.admin, 'device.created')).find((a) => a.entityId === deviceId);
    expect(created?.newValue).toMatchObject({ locationId: t.floorA11 });
    for (const [i, [locationId, message]] of refusals().entries()) {
      const r = await h.request('POST', `${base()}/devices`, { token: f.owner, body: mockDevice(`LOC-X${i}`, f.branchA, { locationId }) });
      expect(r.status, message).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
      expect(r.body.details.issues[0]).toEqual({ path: 'locationId', message });
    }
    // a device admin limited to branch B does not see branch A's places at all
    const hidden = await h.request('POST', `${base()}/devices`, { token: deviceAdminB, body: mockDevice('LOC-BX', f.branchB, { locationId: t.siteA1 }) });
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Unknown location' });
    const scoped = await h.request('POST', `${base()}/devices`, { token: deviceAdminB, body: mockDevice('LOC-B1', f.branchB, { locationId: t.siteB1 }) });
    expect(scoped.status).toBe(201);
    expect(scoped.body.data.device).toMatchObject({ locationId: t.siteB1, locationName: 'Site B1' });
    expect((await h.request('GET', `${base()}/devices/${deviceId}`, { token: f.owner })).body.data).toMatchObject({ locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
  });

  it('a PATCH keeps the place unless it names one; a move to another branch drops it, or takes a place of the new branch; null clears it', async () => {
    const rename = await patch({ name: 'Renamed terminal' });
    expect(rename.status).toBe(200);
    expect(rename.body.data).toMatchObject({ name: 'Renamed terminal', locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
    const moved = await patch({ locationId: t.siteA2 });
    expect(moved.body.data).toMatchObject({ locationId: t.siteA2, locationName: 'Site A2' });
    const audit = (await auditRows(h.admin, 'device.updated')).find((a) => a.entityId === deviceId);
    expect(audit?.oldValue).toMatchObject({ locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
    expect(audit?.newValue).toMatchObject({ locationId: t.siteA2, locationName: 'Site A2' });
    // the stored place sent along with a move to another branch names the field instead of being dropped silently
    const stale = await patch({ branchId: f.branchB, locationId: t.siteA2 });
    expect(stale.status).toBe(400);
    expect(stale.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Another branch' });
    // a move without a place: the database drops the place of the old branch and the response shows it
    const transfer = await patch({ branchId: f.branchB });
    expect(transfer.status).toBe(200);
    expect(transfer.body.data).toMatchObject({ branchId: f.branchB, locationId: null, locationName: null });
    expect((await auditRows(h.admin, 'device.updated')).find((a) => a.entityId === deviceId)?.newValue).toMatchObject({ branchId: f.branchB, locationId: null });
    const back = await patch({ branchId: f.branchA, locationId: t.siteA1 });
    expect(back.body.data).toMatchObject({ branchId: f.branchA, locationId: t.siteA1, locationName: 'Site A1' });
    expect((await patch({ locationId: t.hq })).status).toBe(400);
    const cleared = await patch({ locationId: null });
    expect(cleared.body.data).toMatchObject({ locationId: null, locationName: null });
  });

  it('lists and counts devices by location — a group, a branch, a place with the places below it — inside the caller\'s scope', async () => {
    for (const [branchId, locationId] of [[f.branchA, t.siteA1], [f.branchA, t.floorA11], [f.branchA, t.siteA2], [f.branchA, null], [f.branchB, t.siteB1], [f.branchB, null]] as const) {
      const id = await seedDevice(h.admin, f.orgId, branchId);
      if (locationId) await h.admin.updateTable('devices').set({ locationId }).where('id', '=', id).execute();
    }
    const all = await h.admin.selectFrom('devices').select(['id', 'branchId', 'locationId']).where('organizationId', '=', f.orgId).where('providerKey', '!=', 'self_service').where('status', '!=', 'decommissioned').execute();
    const want = (pred: (d: (typeof all)[number]) => boolean) => sorted(all.filter(pred).map((d) => d.id));
    const list = async (token: string, query: string) => {
      const r = await h.request('GET', `${base()}/devices?pageSize=200&${query}`, { token });
      return { status: r.status, ids: sorted((r.body.data ?? []).map((d: { id: string }) => d.id)), data: (r.body.data ?? []) as Array<{ id: string; locationId: string | null; locationName: string | null }> };
    };
    expect((await list(f.owner, `locationId=${t.hq}`)).ids).toEqual(want(() => true));
    expect((await list(f.owner, `locationId=${t.emptyGroup}`)).ids).toEqual([]);
    expect((await list(f.owner, `locationId=${t.nodeA}`)).ids).toEqual(want((d) => d.branchId === f.branchA));
    const site = await list(f.owner, `locationId=${t.siteA1}`);
    expect(site.ids).toEqual(want(placeIn(t.siteA1, t.floorA11)));
    expect(site.ids.length).toBeGreaterThanOrEqual(2);
    expect(site.data.find((d) => d.locationId === t.floorA11)?.locationName).toBe('Site A1 › Floor 1');
    expect((await list(f.owner, `locationId=${t.floorA11}`)).ids).toEqual(want(placeIn(t.floorA11)));
    // an explicit branch and a location of another branch: nothing (never everything)
    expect((await list(f.owner, `locationId=${t.siteA1}&branchId=${f.branchB}`)).ids).toEqual([]);
    // a member limited to branch B gets only branch B out of the group, and cannot use branch A's places
    expect((await list(deviceAdminB, `locationId=${t.hq}`)).ids).toEqual(want((d) => d.branchId === f.branchB));
    expect((await list(deviceAdminB, `locationId=${t.siteA1}`)).status).toBe(404);
    expect((await list(f.owner, `locationId=${otherPlace}`)).status).toBe(404);
    const summary = await h.request('GET', `${base()}/devices/summary?locationId=${t.siteA1}`, { token: f.owner });
    expect(summary.body.data.total).toBe(site.ids.length);
    const scopedSummary = await h.request('GET', `${base()}/devices/summary?locationId=${t.hq}`, { token: deviceAdminB });
    expect(scopedSummary.body.data.total).toBe(want((d) => d.branchId === f.branchB).length);
  });
});

// ----- employees ---------------------------------------------------------------------------------------------------------------

describe('employees: work_location_id', () => {
  const newEmployee = (n: string, branchId: string, extra: Record<string, unknown> = {}) => ({ employeeNumber: `LOC-${n}`, firstName: 'Loc', lastName: `Person ${n}`, joiningDate: '2026-01-01', branchId, ...extra });
  const patch = (id: string, body: Record<string, unknown>, token = f.owner) => h.request('PATCH', `${base()}/employees/${id}`, { token, body });

  it('creates and updates employees with a work location of their branch; the list, the detail and the audit carry it', async () => {
    const ok = await h.request('POST', `${base()}/employees`, { token: f.owner, body: newEmployee('1', f.branchA, { workLocationId: t.floorA11 }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ branchId: f.branchA, workLocationId: t.floorA11, workLocationName: 'Site A1 › Floor 1' });
    expect((await auditRows(h.admin, 'employee.created')).find((a) => a.entityId === ok.body.data.id)?.newValue).toMatchObject({ workLocationId: t.floorA11 });
    for (const [i, [workLocationId, message]] of refusals().entries()) {
      const r = await h.request('POST', `${base()}/employees`, { token: f.owner, body: newEmployee(`X${i}`, f.branchA, { workLocationId }) });
      expect(r.status, message).toBe(400);
      expect(r.body.details.issues[0]).toEqual({ path: 'workLocationId', message });
    }
    // the branch manager of B (employee.update, branch B only) cannot see — let alone use — a place of branch A
    const hidden = await patch(f.e2, { workLocationId: t.siteA1 }, f.branchManagerB);
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0]).toEqual({ path: 'workLocationId', message: 'Unknown location' });
    const set = await patch(f.e2, { workLocationId: t.siteB1 }, f.branchManagerB);
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ workLocationId: t.siteB1, workLocationName: 'Site B1' });
    const audit = (await auditRows(h.admin, 'employee.updated')).find((a) => a.entityId === f.e2);
    expect(audit?.oldValue).toMatchObject({ workLocationId: null });
    expect(audit?.newValue).toMatchObject({ workLocationId: t.siteB1, workLocationName: 'Site B1' });
    // a PATCH of one other field keeps the work location (and an unchanged one never shows up in the audit diff)
    const rename = await patch(f.e2, { firstName: 'Renamed' }, f.branchManagerB);
    expect(rename.body.data).toMatchObject({ firstName: 'Renamed', workLocationId: t.siteB1, workLocationName: 'Site B1' });
    const renameAudit = (await auditRows(h.admin, 'employee.updated')).find((a) => a.entityId === f.e2);
    expect(Object.keys(renameAudit?.newValue as Record<string, unknown>)).not.toContain('workLocationId');
    expect(Object.keys(renameAudit?.newValue as Record<string, unknown>)).not.toContain('workLocationName');
    const detail = await h.request('GET', `${base()}/employees/${f.e2}`, { token: f.owner });
    expect(detail.body.data).toMatchObject({ workLocationId: t.siteB1, workLocationName: 'Site B1' });
  });

  it('a transfer drops a work location of the old branch — by update and by the bulk assign_branch — or takes a place of the new branch', async () => {
    const e = await seedEmployee(h.admin, f.orgId, f.branchA, 901);
    expect((await patch(e, { workLocationId: t.siteA1 })).body.data.workLocationId).toBe(t.siteA1);
    const moved = await patch(e, { branchId: f.branchB });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ branchId: f.branchB, workLocationId: null, workLocationName: null });
    const audit = (await auditRows(h.admin, 'employee.updated')).find((a) => a.entityId === e);
    expect(audit?.oldValue).toMatchObject({ branchId: f.branchA, workLocationId: t.siteA1 });
    expect(audit?.newValue).toMatchObject({ branchId: f.branchB, workLocationId: null });
    const stale = await patch(e, { branchId: f.branchA, workLocationId: t.siteB1 });
    expect(stale.status).toBe(400);
    expect(stale.body.details.issues[0]).toEqual({ path: 'workLocationId', message: 'Another branch' });
    const back = await patch(e, { branchId: f.branchA, workLocationId: t.siteA2 });
    expect(back.body.data).toMatchObject({ branchId: f.branchA, workLocationId: t.siteA2, workLocationName: 'Site A2' });

    const other = await seedEmployee(h.admin, f.orgId, f.branchA, 902);
    await h.admin.updateTable('employees').set({ workLocationId: t.floorA11 }).where('id', '=', other).execute();
    const bulk = await h.request('POST', `${base()}/employees/bulk`, { token: f.owner, body: { action: 'assign_branch', employeeIds: [e, other], branchId: f.branchB } });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.updated).toBe(2);
    const rows = await h.admin.selectFrom('employees').select(['id', 'branchId', 'workLocationId']).where('id', 'in', [e, other]).execute();
    expect(rows.map((r) => [r.branchId, r.workLocationId])).toEqual([[f.branchB, null], [f.branchB, null]]);
    const bulkAudit = (await auditRows(h.admin, 'employee.bulk_updated'))[0];
    expect((bulkAudit?.newValue as { workLocationsCleared: unknown[] }).workLocationsCleared).toEqual(expect.arrayContaining([{ employeeId: e, workLocationId: t.siteA2 }, { employeeId: other, workLocationId: t.floorA11 }]));
  });

  it('lists employees by location — a group, a branch, a place with the places below it — inside the caller\'s scope', async () => {
    for (const [n, branchId, workLocationId] of [[903, f.branchA, t.siteA1], [904, f.branchA, t.floorA11], [905, f.branchA, t.siteA2], [906, f.branchB, t.siteB1]] as const) {
      const id = await seedEmployee(h.admin, f.orgId, branchId, n);
      await h.admin.updateTable('employees').set({ workLocationId }).where('id', '=', id).execute();
    }
    const all = await h.admin.selectFrom('employees').select(['id', 'branchId', 'workLocationId']).where('organizationId', '=', f.orgId).where('deletedAt', 'is', null).execute();
    const want = (pred: (e: { branchId: string; locationId: string | null }) => boolean) => sorted(all.filter((e) => pred({ branchId: e.branchId, locationId: e.workLocationId })).map((e) => e.id));
    const list = async (token: string, query: string) => {
      const r = await h.request('GET', `${base()}/employees?pageSize=200&${query}`, { token });
      return { status: r.status, ids: sorted((r.body.data ?? []).map((e: { id: string }) => e.id)), data: (r.body.data ?? []) as Array<{ id: string; workLocationId: string | null; workLocationName: string | null }> };
    };
    expect((await list(f.owner, `locationId=${t.hq}`)).ids).toEqual(want(() => true));
    expect((await list(f.owner, `locationId=${t.emptyGroup}`)).ids).toEqual([]);
    expect((await list(f.owner, `locationId=${t.nodeB}`)).ids).toEqual(want((e) => e.branchId === f.branchB));
    const site = await list(f.owner, `locationId=${t.siteA1}`);
    expect(site.ids).toEqual(want(placeIn(t.siteA1, t.floorA11)));
    expect(site.ids.length).toBeGreaterThanOrEqual(2);
    expect(site.data.find((e) => e.workLocationId === t.floorA11)?.workLocationName).toBe('Site A1 › Floor 1');
    expect((await list(f.owner, `locationId=${t.hq}&branchId=${f.branchA}`)).ids).toEqual(want((e) => e.branchId === f.branchA));
    expect((await list(f.owner, `locationId=${t.siteB1}&branchId=${f.branchA}`)).ids).toEqual([]);
    // the branch manager of B: only branch B out of the group; branch A's places do not exist for them
    expect((await list(f.branchManagerB, `locationId=${t.hq}`)).ids).toEqual(want((e) => e.branchId === f.branchB));
    expect((await list(f.branchManagerB, `locationId=${t.floorA11}`)).status).toBe(404);
    expect((await list(f.owner, `locationId=${otherPlace}`)).status).toBe(404);
  });
});

// ----- geofences ---------------------------------------------------------------------------------------------------------------

describe('geofences: location_id', () => {
  const fence = (name: string, extra: Record<string, unknown> = {}) => ({ name, latitude: 23.588, longitude: 58.3829, radiusM: 150, ...extra });
  let fenceId: string;
  const patch = (body: Record<string, unknown>) => h.request('PATCH', `${base()}/geofences/${fenceId}`, { token: f.owner, body });

  it('a fence outlines a place of its branch: validation, DTO, PATCH of another field keeps it, a move drops it', async () => {
    const ok = await h.request('POST', `${base()}/geofences`, { token: f.owner, body: fence('Site A1 gate', { branchId: f.branchA, locationId: t.siteA1 }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ branchId: f.branchA, locationId: t.siteA1, locationName: 'Site A1' });
    fenceId = ok.body.data.id;
    for (const [locationId, message] of refusals()) {
      const r = await h.request('POST', `${base()}/geofences`, { token: f.owner, body: fence('Refused', { branchId: f.branchA, locationId }) });
      expect(r.status, message).toBe(400);
      expect(r.body.details.issues[0]).toEqual({ path: 'locationId', message });
    }
    const noBranch = await h.request('POST', `${base()}/geofences`, { token: f.owner, body: fence('Organisation fence', { locationId: t.siteA1 }) });
    expect(noBranch.status).toBe(400);
    expect(noBranch.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Needs a branch' });
    const hidden = await h.request('POST', `${base()}/geofences`, { token: fenceAdminB, body: fence('Hidden', { branchId: f.branchB, locationId: t.siteA1 }) });
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Unknown location' });
    const scoped = await h.request('POST', `${base()}/geofences`, { token: fenceAdminB, body: fence('Site B1 yard', { branchId: f.branchB, locationId: t.siteB1 }) });
    expect(scoped.status).toBe(201);
    expect(scoped.body.data).toMatchObject({ locationId: t.siteB1, locationName: 'Site B1' });

    const rename = await patch({ name: 'Site A1 main gate' });
    expect(rename.body.data).toMatchObject({ name: 'Site A1 main gate', locationId: t.siteA1, locationName: 'Site A1' });
    const floor = await patch({ locationId: t.floorA11 });
    expect(floor.body.data).toMatchObject({ locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
    const audit = (await auditRows(h.admin, 'geofence.updated')).find((a) => a.entityId === fenceId);
    expect(audit?.oldValue).toMatchObject({ locationId: t.siteA1, locationName: 'Site A1' });
    expect(audit?.newValue).toMatchObject({ locationId: t.floorA11, locationName: 'Site A1 › Floor 1' });
    const stale = await patch({ branchId: f.branchB, locationId: t.floorA11 });
    expect(stale.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Another branch' });
    const moved = await patch({ branchId: f.branchB });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({ branchId: f.branchB, locationId: null, locationName: null });
    const back = await patch({ branchId: f.branchA, locationId: t.siteA2 });
    expect(back.body.data).toMatchObject({ branchId: f.branchA, locationId: t.siteA2, locationName: 'Site A2' });
    // the whole organisation: the place goes with the branch
    const orgWide = await patch({ branchId: null });
    expect(orgWide.body.data).toMatchObject({ branchId: null, locationId: null });
    const needsBranch = await patch({ locationId: t.siteA1 });
    expect(needsBranch.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Needs a branch' });
    const restored = await patch({ branchId: f.branchA, locationId: t.siteA1 });
    expect(restored.body.data.locationId).toBe(t.siteA1);
    expect((await patch({ locationId: null })).body.data.locationId).toBeNull();
  });

  it('lists fences by location — a group, a branch, a place with the places below it; never the organisation-wide ones', async () => {
    const values = (name: string, branchId: string | null, locationId: string | null) => ({ organizationId: f.orgId, name, branchId, locationId, latitude: 23.6, longitude: 58.5, radiusM: 100 });
    await h.admin.insertInto('geofences').values([
      values('A1 fence', f.branchA, t.siteA1), values('Floor fence', f.branchA, t.floorA11), values('A fence', f.branchA, null), values('B1 fence', f.branchB, t.siteB1), values('Everywhere', null, null),
    ]).execute();
    const all = await h.admin.selectFrom('geofences').select(['id', 'branchId', 'locationId']).where('organizationId', '=', f.orgId).where('isActive', '=', true).execute();
    const want = (pred: (g: (typeof all)[number]) => boolean) => sorted(all.filter(pred).map((g) => g.id));
    const list = async (token: string, query: string) => {
      const r = await h.request('GET', `${base()}/geofences?${query}`, { token });
      return { status: r.status, ids: sorted((r.body.data ?? []).map((g: { id: string }) => g.id)), data: (r.body.data ?? []) as Array<{ locationId: string | null; locationName: string | null }> };
    };
    const site = await list(f.owner, `locationId=${t.siteA1}`);
    expect(site.ids).toEqual(want(placeIn(t.siteA1, t.floorA11)));
    expect(site.data.find((g) => g.locationId === t.floorA11)?.locationName).toBe('Site A1 › Floor 1');
    expect((await list(f.owner, `locationId=${t.nodeA}`)).ids).toEqual(want((g) => g.branchId === f.branchA));
    expect((await list(f.owner, `locationId=${t.hq}`)).ids).toEqual(want((g) => g.branchId !== null));
    expect((await list(f.owner, '')).ids).toEqual(want(() => true));
    expect((await list(fenceAdminB, `locationId=${t.hq}`)).ids).toEqual(want((g) => g.branchId === f.branchB));
    expect((await list(fenceAdminB, `locationId=${t.siteA1}`)).status).toBe(404);
  });
});

// ----- dashboard -----------------------------------------------------------------------------------------------------------------

describe('dashboard: locationId', () => {
  const DAY = '2026-09-15';
  const summary = async (token: string, query: string) => h.request('GET', `${base()}/dashboard/summary?date=${DAY}&${query}`, { token });

  it('a group / branch location restricts to its branches; a place to the employees working there and the terminals installed there', async () => {
    const people: Array<[number, string, string | null, 'PRESENT' | 'ABSENT', string[]]> = [
      [911, f.branchA, t.siteA1, 'PRESENT', ['LATE']], [912, f.branchA, t.floorA11, 'ABSENT', []], [913, f.branchA, null, 'PRESENT', []], [914, f.branchB, t.siteB1, 'PRESENT', []],
    ];
    for (const [n, branchId, workLocationId, status, flags] of people) {
      const id = await seedEmployee(h.admin, f.orgId, branchId, n);
      if (workLocationId) await h.admin.updateTable('employees').set({ workLocationId }).where('id', '=', id).execute();
      await h.admin.insertInto('attendanceDailyRecords').values({ organizationId: f.orgId, employeeId: id, attendanceDate: DAY, branchId, timezone: 'Asia/Muscat', engineVersion: 'test', status, flags }).execute();
    }
    // a failed sync item on a terminal of Site A1 and one of Site B1
    const terminalA1 = await seedDevice(h.admin, f.orgId, f.branchA); const terminalB1 = await seedDevice(h.admin, f.orgId, f.branchB);
    await h.admin.updateTable('devices').set({ locationId: t.siteA1 }).where('id', '=', terminalA1).execute();
    await h.admin.updateTable('devices').set({ locationId: t.siteB1 }).where('id', '=', terminalB1).execute();
    const job = await h.admin.insertInto('syncJobs').values({ organizationId: f.orgId, jobType: 'PULL_ATTENDANCE', trigger: 'SCHEDULED', correlationId: 'cor_locrefs', status: 'FAILED' }).returning('id').executeTakeFirstOrThrow();
    await h.admin.insertInto('syncJobItems').values([terminalA1, terminalB1].map((deviceId, i) => ({ organizationId: f.orgId, syncJobId: job.id, deviceId, branchId: i === 0 ? f.branchA : f.branchB, operation: 'PULL_ATTENDANCE' as const, status: 'FAILED' as const, lastErrorCode: 'TIMEOUT', finishedAt: new Date() }))).execute();

    const site = await summary(f.owner, `locationId=${t.siteA1}`);
    expect(site.status).toBe(200);
    expect(site.body.data).toMatchObject({ presentToday: 1, absent: 1, late: 1, syncFailures24h: 1 });
    const headcount = await h.admin.selectFrom('employees').select((eb) => eb.fn.countAll<string>().as('n')).where('organizationId', '=', f.orgId).where('deletedAt', 'is', null).where('employmentStatus', '=', 'active').where('workLocationId', 'in', [t.siteA1, t.floorA11]).executeTakeFirstOrThrow();
    expect(site.body.data.employees).toBe(Number(headcount.n));
    const terminals = await h.admin.selectFrom('devices').select((eb) => eb.fn.countAll<string>().as('n')).where('organizationId', '=', f.orgId).where('status', '=', 'active').where('locationId', 'in', [t.siteA1, t.floorA11]).executeTakeFirstOrThrow();
    expect(site.body.data.devicesOnline + site.body.data.devicesOffline + site.body.data.devicesUnknown).toBe(Number(terminals.n));
    expect(Number(terminals.n)).toBeGreaterThanOrEqual(1);
    expect((await summary(f.owner, `locationId=${t.floorA11}`)).body.data).toMatchObject({ presentToday: 0, absent: 1, late: 0, syncFailures24h: 0 });
    expect((await summary(f.owner, `locationId=${t.nodeA}`)).body.data).toMatchObject({ presentToday: 2, absent: 1, syncFailures24h: 1 });
    expect((await summary(f.owner, `locationId=${t.hq}`)).body.data).toMatchObject({ presentToday: 3, absent: 1, syncFailures24h: 2 });
    expect((await summary(f.owner, `locationId=${t.emptyGroup}`)).body.data).toMatchObject({ presentToday: 0, absent: 0, employees: 0, devicesOnline: 0, devicesOffline: 0, devicesUnknown: 0, syncFailures24h: 0 });
    expect((await summary(f.owner, `locationId=${t.siteA1}&branchId=${f.branchB}`)).body.data).toMatchObject({ presentToday: 0, absent: 0, employees: 0, syncFailures24h: 0 });
    // the branch manager of B: branch B out of the group; branch A's places are not theirs to filter by
    expect((await summary(f.branchManagerB, `locationId=${t.hq}`)).body.data).toMatchObject({ presentToday: 1, absent: 0, syncFailures24h: 1 });
    expect((await summary(f.branchManagerB, `locationId=${t.siteA1}`)).status).toBe(404);

    const trends = await h.request('GET', `${base()}/dashboard/trends?from=${DAY}&to=${DAY}&locationId=${t.siteA1}`, { token: f.owner });
    expect(trends.body.data).toEqual([expect.objectContaining({ date: DAY, present: 1, absent: 1, late: 1 })]);
    const branchTrend = await h.request('GET', `${base()}/dashboard/trends?from=${DAY}&to=${DAY}&locationId=${t.nodeA}`, { token: f.owner });
    expect(branchTrend.body.data).toEqual([expect.objectContaining({ present: 2, absent: 1 })]);
    const scopedTrend = await h.request('GET', `${base()}/dashboard/trends?from=${DAY}&to=${DAY}&locationId=${t.hq}`, { token: f.branchManagerB });
    expect(scopedTrend.body.data).toEqual([expect.objectContaining({ present: 1, absent: 0 })]);
    expect((await h.request('GET', `${base()}/dashboard/trends?from=${DAY}&to=${DAY}&locationId=${otherPlace}`, { token: f.owner })).status).toBe(404);
  });
});

// ----- reports -------------------------------------------------------------------------------------------------------------------

describe('reports: locationId', () => {
  it('a report request takes a location the requester can see; the worker narrows the injected scope with it', async () => {
    const ok = await h.request('POST', `${base()}/reports`, { token: f.owner, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-09-15', locationId: t.siteA1 } } });
    expect(ok.status).toBe(202);
    expect(ok.body.data.parameters).toMatchObject({ locationId: t.siteA1 });
    const hidden = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-09-15', locationId: t.siteA1 } } });
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0]).toEqual({ path: 'parameters.locationId', message: 'Unknown location' });
    // a group node is visible to a scoped requester: their branch scope is injected as before, the worker intersects
    const group = await h.request('POST', `${base()}/reports`, { token: f.branchManagerB, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-09-15', locationId: t.hq } } });
    expect(group.status).toBe(202);
    expect(group.body.data.parameters).toMatchObject({ locationId: t.hq, branchId: f.branchB, branchScope: [f.branchB] });
    const foreign = await h.request('POST', `${base()}/reports`, { token: f.owner, body: { reportType: 'daily_attendance', format: 'csv', parameters: { from: '2026-09-15', locationId: otherPlace } } });
    expect(foreign.status).toBe(400);
  });

  it('schedules and Send now take a location the author can see', async () => {
    const schedule = (extra: Record<string, unknown>) => ({
      name: 'Site late report', reportType: 'late_report', format: 'csv', cadence: 'monthly', runDay: 1, runTime: '07:00', periodRule: 'previous_month',
      recipients: { userIds: [] as string[], roleKeys: ['hr_admin'] }, channels: ['in_app'], ...extra,
    });
    const ok = await h.request('POST', `${base()}/report-schedules`, { token: f.owner, body: schedule({ filters: { locationId: t.siteA1 } }) });
    expect(ok.status).toBe(201);
    expect(ok.body.data.filters).toMatchObject({ locationId: t.siteA1 });
    const hidden = await h.request('POST', `${base()}/report-schedules`, { token: schedulerB, body: schedule({ filters: { branchId: f.branchB, locationId: t.siteA1 } }) });
    expect(hidden.status).toBe(400);
    expect(hidden.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Unknown location' });
    const scoped = await h.request('POST', `${base()}/report-schedules`, { token: schedulerB, body: schedule({ filters: { branchId: f.branchB, locationId: t.siteB1 } }) });
    expect(scoped.status).toBe(201);
    const share = await h.request('POST', `${base()}/reports/share`, { token: f.owner, body: { reportType: 'late_report', format: 'csv', parameters: { from: '2026-09-01', to: '2026-09-30', locationId: otherPlace }, recipients: { userIds: [f.owner], roleKeys: [] } } });
    expect(share.status).toBe(400);
    expect(share.body.details.issues[0]).toEqual({ path: 'locationId', message: 'Unknown location' });
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, seedOrg, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';
import { issuePath, seedLocationFixture, type LocationFixture } from './location-fixture.js';

/*
 * Coverage targets per place (Enterprise, module advanced_scheduling — docs/locations.md §2): a target for the whole branch or
 * for a place of it, one per (branch, shift, location); the list's location filter; the report's cell per (shift, target
 * location) whose scheduled head count is the people working in the place or below it. Tree and people: location-fixture.ts.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let off: OrgFixture; let N: LocationFixture['node'];
let e6: string; let scopedHrB: string;
const base = (o: OrgFixture = f) => `/api/v1/orgs/${o.orgId}`;
const MORNING = uuid('5');

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_loccov_${process.pid}`);
  f = await seedOrg(h.admin, 'loccov', { modules: ['advanced_scheduling'] });
  off = await seedOrg(h.admin, 'loccovoff');
  ({ node: N, e6, scopedHrB } = await seedLocationFixture(h.admin, f, 'loccov'));
  await h.admin.insertInto('shifts').values({ id: MORNING, organizationId: f.orgId, code: 'MOR', name: 'Morning', type: 'FIXED', startTime: '06:00', endTime: '14:00', breaks: JSON.stringify([]) }).execute();
  // everyone of branch A works the morning
  await h.admin.insertInto('shiftAssignments').values({ organizationId: f.orgId, targetType: 'BRANCH', targetId: f.branchA, branchId: f.branchA, shiftId: MORNING, effectiveFrom: '2026-09-01' }).execute();
});
afterAll(async () => { await h?.close(); });

describe('coverage targets per place', () => {
  let wholeBranch: string; let siteTarget: string; let floorTarget: string;
  const post = (body: Record<string, unknown>, token = f.hrAdmin) => h.request('POST', `${base()}/shift-coverage`, { token, body: { branchId: f.branchA, shiftId: MORNING, minHeadcount: 1, ...body } });
  const listIds = async (query: string, token = f.hrUser) => {
    const r = await h.request('GET', `${base()}/shift-coverage?${query}`, { token });
    expect(r.status, query).toBe(200);
    return r.body.data.map((c: { id: string }) => c.id) as string[];
  };

  it('needs advanced_scheduling', async () => {
    const r = await h.request('POST', `${base(off)}/shift-coverage`, { token: off.hrAdmin, body: { branchId: off.branchA, shiftId: uuid('9'), locationId: uuid('9'), minHeadcount: 1 } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED', details: { module: 'advanced_scheduling' } });
  });

  it('a target for the whole branch and one per place of it; one per (branch, shift, location)', async () => {
    const whole = await post({ minHeadcount: 3 });
    expect(whole.status).toBe(201);
    expect(whole.body.data).toMatchObject({ branchId: f.branchA, shiftId: MORNING, locationId: null, locationName: null, minHeadcount: 3 });
    wholeBranch = whole.body.data.id;
    const site = await post({ locationId: N.siteA, minHeadcount: 3 });
    expect(site.status).toBe(201);
    expect(site.body.data).toMatchObject({ branchId: f.branchA, shiftId: MORNING, shiftName: 'Morning', locationId: N.siteA, locationName: 'Site A', minHeadcount: 3, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    siteTarget = site.body.data.id;
    const floor = await post({ locationId: N.floor2, weekdays: [0] });
    expect(floor.status).toBe(201);
    expect(floor.body.data).toMatchObject({ locationId: N.floor2, locationName: 'Site A › Floor 2', weekdays: [0], minHeadcount: 1 });
    floorTarget = floor.body.data.id;
    // one per (branch, shift, location) — the whole-branch one included
    const dup = await post({ locationId: N.siteA, minHeadcount: 5 });
    expect(dup.status).toBe(409);
    expect(dup.body.details).toMatchObject({ id: siteTarget });
    expect((await post({ minHeadcount: 4 })).body.details).toMatchObject({ id: wholeBranch });
    // a place of the target's branch, visible and not archived
    const refused: Array<[string, string]> = [[N.siteB, 'a place of another branch'], [N.branchA, 'the branch node'], [N.north, 'a group location'], [uuid('9'), 'unknown'], [N.oldStore, 'archived']];
    for (const [locationId, label] of refused) {
      const r = await post({ locationId });
      expect(r.status, label).toBe(400);
      expect(issuePath(r), label).toBe('locationId');
    }
    // PATCH changes one field; the location stays
    const patched = await h.request('PATCH', `${base()}/shift-coverage/${floorTarget}`, { token: f.hrAdmin, body: { minHeadcount: 2 } });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ locationId: N.floor2, locationName: 'Site A › Floor 2', weekdays: [0], minHeadcount: 2 });
  });

  it('lists by location: a place → its targets and those below it; a group or branch location → the targets of its branches', async () => {
    expect(await listIds(`locationId=${N.floor2}`)).toEqual([floorTarget]);
    expect((await listIds(`locationId=${N.siteA}`)).sort()).toEqual([siteTarget, floorTarget].sort());
    const branch = await listIds(`locationId=${N.branchA}`);
    expect(branch[0]).toBe(wholeBranch); // per branch and shift: the whole-branch target first
    expect([...branch].sort()).toEqual([wholeBranch, siteTarget, floorTarget].sort());
    expect((await listIds(`locationId=${N.north}`)).sort()).toEqual([wholeBranch, siteTarget, floorTarget].sort());
    expect(await listIds(`locationId=${N.south}`)).toEqual([]);
    expect(await listIds(`locationId=${N.annex}`)).toEqual([]);
    // the location must be visible to the caller
    expect((await h.request('GET', `${base()}/shift-coverage?locationId=${N.siteA}`, { token: scopedHrB })).status).toBe(404);
  });

  it('reports one cell per (shift, target location) and day: scheduled counts the people working in the place or below it', async () => {
    // e6 (Zone C) is on leave on the Monday
    const leaveType = await h.admin.insertInto('leaveTypes').values({ organizationId: f.orgId, code: 'AL', name: 'Annual', isPaid: true }).returning('id').executeTakeFirstOrThrow();
    await h.admin.insertInto('leaveRecords').values({ organizationId: f.orgId, employeeId: e6, branchId: f.branchA, leaveTypeId: leaveType.id, startDate: '2026-09-07', endDate: '2026-09-07', status: 'APPROVED' }).execute();
    const r = await h.request('GET', `${base()}/shift-coverage/report?branchId=${f.branchA}&from=2026-09-06&to=2026-09-07`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.shifts.map((s: { id: string }) => s.id)).toEqual([MORNING]);
    const cells = (date: string) => r.body.data.days.find((d: { date: string }) => d.date === date).cells;
    // branch A: e1, e3, e5–e9, e11 on the morning; Site A holds e5 (Floor 2) and e6 (Zone C, below Floor 2)
    expect(cells('2026-09-06')).toEqual([
      { shiftId: MORNING, required: 3, scheduled: 8, gap: 0 },
      { shiftId: MORNING, locationId: N.siteA, required: 3, scheduled: 2, gap: 1 },
      { shiftId: MORNING, locationId: N.floor2, required: 2, scheduled: 2, gap: 0 },
    ]);
    expect(cells('2026-09-07')).toEqual([
      { shiftId: MORNING, required: 3, scheduled: 7, gap: 0 },
      { shiftId: MORNING, locationId: N.siteA, required: 3, scheduled: 1, gap: 2 },
      { shiftId: MORNING, locationId: N.floor2, required: 0, scheduled: 1, gap: 0 }, // Sunday-only target
    ]);
    // the whole-branch cell keeps the report's shape (no location key)
    expect(Object.keys(cells('2026-09-06')[0])).toEqual(['shiftId', 'required', 'scheduled', 'gap']);
  });
});

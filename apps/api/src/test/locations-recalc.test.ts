import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createApiHarness, seedOrg, type ApiHarness, type OrgFixture } from './features-harness.js';
import { seedLocationFixture, type LocationFixture } from './location-fixture.js';

/*
 * A location change can change which attendance policy applies (docs/locations.md §3): a work location changed inside the
 * branch, a branch placed under another region, a place moved. When the organisation has a location-scoped policy, today is
 * recomputed for the people concerned (past days keep their values: the work location is not effective-dated); without one,
 * nothing is recomputed. Tree and people: location-fixture.ts.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let plain: OrgFixture; let L: LocationFixture; let P: LocationFixture;
const base = (o: OrgFixture) => `/api/v1/orgs/${o.orgId}`;
const requests = (o: OrgFixture) => h.admin.selectFrom('attendanceRecalculationRequests').select(['fromDate', 'toDate', 'branchId', 'employeeIds', 'reason']).where('organizationId', '=', o.orgId).orderBy('createdAt').execute();
const iso = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
const today = async (o: OrgFixture) => (await sql<{ d: string }>`select (now() at time zone timezone)::date::text as d from public.organizations where id = ${o.orgId}::uuid`.execute(h.admin)).rows[0]!.d;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_locrc_${process.pid}`);
  f = await seedOrg(h.admin, 'locrc', { modules: ['attendance_policies'] });
  L = await seedLocationFixture(h.admin, f, 'locrc');
  await h.admin.insertInto('attendanceRuleSets').values({ organizationId: f.orgId, name: 'Site A', branchId: f.branchA, locationId: L.node.siteA, effectiveFrom: '2026-01-01', ramadanMode: '{}' }).execute();
  plain = await seedOrg(h.admin, 'locrcplain');
  P = await seedLocationFixture(h.admin, plain, 'locrcplain');
});
afterAll(async () => { await h?.close(); });

describe('recalculation after a location change', () => {
  it('a work location changed inside the branch recomputes today for that employee', async () => {
    const before = (await requests(f)).length;
    const r = await h.request('PATCH', `${base(f)}/employees/${L.e8}`, { token: f.hrAdmin, body: { workLocationId: L.node.annex } });
    expect(r.status).toBe(200);
    const added = (await requests(f)).slice(before);
    const d = await today(f);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ branchId: null, employeeIds: [L.e8] });
    expect([iso(added[0]!.fromDate), iso(added[0]!.toDate)]).toEqual([d, d]);
    expect(added[0]!.reason).toMatch(/work location/);
  });

  it('a branch placed under another region recomputes that branch today', async () => {
    const before = (await requests(f)).length;
    const r = await h.request('PATCH', `${base(f)}/branches/${f.branchB}`, { token: f.owner, body: { parentLocationId: L.node.north } });
    expect(r.status).toBe(200);
    const added = (await requests(f)).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ branchId: f.branchB, employeeIds: null });
    // sending the placement it already has changes nothing and recomputes nothing
    expect((await h.request('PATCH', `${base(f)}/branches/${f.branchB}`, { token: f.owner, body: { parentLocationId: L.node.north } })).status).toBe(200);
    expect((await requests(f)).length).toBe(before + 1);
  });

  it('a place moved recomputes the people working in it and below it', async () => {
    const before = (await requests(f)).length;
    // Floor 2 (with Zone C) moves under the Annex: e5 works on Floor 2, e6 in Zone C
    const r = await h.request('PATCH', `${base(f)}/locations/${L.node.floor2}`, { token: f.owner, body: { parentId: L.node.annex } });
    expect(r.status).toBe(200);
    const added = (await requests(f)).slice(before);
    expect(added).toHaveLength(1);
    expect([...(added[0]!.employeeIds ?? [])].sort()).toEqual([L.e5, L.e6].sort());
  });

  it('without a location-scoped policy nothing is recomputed', async () => {
    const before = (await requests(plain)).length;
    expect((await h.request('PATCH', `${base(plain)}/employees/${P.e8}`, { token: plain.hrAdmin, body: { workLocationId: P.node.annex } })).status).toBe(200);
    expect((await h.request('PATCH', `${base(plain)}/branches/${plain.branchB}`, { token: plain.owner, body: { parentLocationId: P.node.north } })).status).toBe(200);
    expect((await h.request('PATCH', `${base(plain)}/locations/${P.node.floor2}`, { token: plain.owner, body: { parentId: P.node.annex } })).status).toBe(200);
    expect((await requests(plain)).length).toBe(before);
  });
});

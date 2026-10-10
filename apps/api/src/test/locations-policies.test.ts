import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { auditRows, createApiHarness, seedOrg, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';
import { issuePath, seedLocationFixture, type LocationFixture } from './location-fixture.js';

/*
 * Attendance policies scoped by location (Enterprise, module attendance_policies — docs/locations.md §3): a group location
 * (no branch) or a place (with its branch), never a branch node; the place beats the branch for the people working there, the
 * branch beats the region, the region covers its branches — in the resolve card, the engine's resolver and the points /
 * overtime reports. Tree and people: location-fixture.ts.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let off: OrgFixture; let N: LocationFixture['node'];
let e5: string; let e6: string; let e7: string; let scopedAdminB: string; let scopedHrB: string;
const base = (o: OrgFixture = f) => `/api/v1/orgs/${o.orgId}`;

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_locpol_${process.pid}`);
  f = await seedOrg(h.admin, 'locpol', { modules: ['attendance_policies'] });
  off = await seedOrg(h.admin, 'locpoloff');
  ({ node: N, e5, e6, e7, scopedAdminB, scopedHrB } = await seedLocationFixture(h.admin, f, 'locpol'));
});
afterAll(async () => { await h?.close(); });

describe('module gate', () => {
  it('a policy for a location needs attendance_policies', async () => {
    const r = await h.request('POST', `${base(off)}/attendance-rule-sets`, { token: off.hrAdmin, body: { name: 'A place', locationId: uuid('9'), effectiveFrom: '2026-01-01' } });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED', details: { module: 'attendance_policies' } });
    expect(await h.admin.selectFrom('attendanceRuleSets').select('id').where('organizationId', '=', off.orgId).execute()).toEqual([]);
  });
});

describe('attendance policies scoped by location', () => {
  let orgDefault: string; let north: string; let branchA: string; let siteA: string;
  const post = (body: Record<string, unknown>, token = f.hrAdmin) => h.request('POST', `${base()}/attendance-rule-sets`, { token, body: { effectiveFrom: '2026-01-01', ...body } });
  const listIds = async (query: string, token = f.hrUser) => {
    const r = await h.request('GET', `${base()}/attendance-rule-sets?${query}`, { token });
    expect(r.status, query).toBe(200);
    return r.body.data.map((p: { id: string }) => p.id) as string[];
  };

  it('validates the location: visible, a group location (no branch) or a place (its own branch), never a branch node', async () => {
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ name: 'Unknown', locationId: uuid('9') }, 'unknown'],
      [{ name: 'Branch node', locationId: N.branchA }, 'a branch node'],
      [{ name: 'North with a branch', locationId: N.north, branchId: f.branchA }, 'a group location with a branch'],
      [{ name: 'Site A in branch B', locationId: N.siteA, branchId: f.branchB }, 'a place with another branch'],
      [{ name: 'Old store', locationId: N.oldStore }, 'an archived place'],
    ];
    for (const [body, label] of refused) {
      const r = await post(body);
      expect(r.status, label).toBe(400);
      expect(r.body.code, label).toBe('VALIDATION_ERROR');
      expect(issuePath(r), label).toBe('locationId');
    }
    // a branch-scoped administrator: the places of their branches; never a group location (it spans branches)
    const region = await post({ name: 'South', locationId: N.south }, scopedAdminB);
    expect(region.status).toBe(403);
    expect(region.body.code).toBe('FORBIDDEN');
    const hidden = await post({ name: 'Site A', locationId: N.siteA }, scopedAdminB);
    expect(hidden.status).toBe(400); // branch A's places are not theirs to see
    expect(issuePath(hidden)).toBe('locationId');
    expect(await h.admin.selectFrom('attendanceRuleSets').select('id').where('organizationId', '=', f.orgId).execute()).toEqual([]);
    const own = await post({ name: 'Site B', locationId: N.siteB }, scopedAdminB);
    expect(own.status).toBe(201);
    expect(own.body.data).toMatchObject({ name: 'Site B', branchId: f.branchB, locationId: N.siteB, specificity: 4 });
    expect((await auditRows(h.admin, 'attendance.rule_set_created'))[0]).toMatchObject({ entityId: own.body.data.id, branchId: f.branchB });
    expect((await h.request('DELETE', `${base()}/attendance-rule-sets/${own.body.data.id}`, { token: scopedAdminB })).status).toBe(200);
  });

  it('creates policies for a region and for a place (which names its branch); the list filters by the policy\'s own location', async () => {
    const org = await post({ name: 'Organisation default' });
    expect(org.status).toBe(201);
    orgDefault = org.body.data.id;
    const n = await post({ name: 'North', locationId: N.north });
    expect(n.status).toBe(201);
    expect(n.body.data).toMatchObject({ branchId: null, locationId: N.north, specificity: 4 });
    north = n.body.data.id;
    const b = await post({ name: 'Branch A', branchId: f.branchA, effectiveFrom: '2026-03-01' });
    expect(b.body.data).toMatchObject({ branchId: f.branchA, locationId: null, specificity: 4 });
    branchA = b.body.data.id;
    const s = await post({ name: 'Site A', locationId: N.siteA, policy: { points: { enabled: true, expiryDays: 30, escalation: [{ points: 1, action: 'NOTIFY_MANAGER' }] } } });
    expect(s.status).toBe(201);
    // the place's branch is filled in; the location counts once with it (published weight 4)
    expect(s.body.data).toMatchObject({ branchId: f.branchA, locationId: N.siteA, specificity: 4, policy: { points: { enabled: true } } });
    siteA = s.body.data.id;
    // the same place again overlaps it (the exclusion includes the location) — naming the branch changes nothing
    expect((await post({ name: 'Site A again', locationId: N.siteA, branchId: f.branchA, effectiveFrom: '2026-06-01' })).status).toBe(409);
    // the list: by location (a group location / a place by locationId, a branch's node by the branch)
    expect(await listIds(`locationId=${N.siteA}`)).toEqual([siteA]);
    expect(await listIds(`locationId=${N.north}`)).toEqual([north]);
    expect(await listIds(`locationId=${N.branchA}`)).toEqual([branchA]);
    expect(await listIds(`locationId=${N.floor2}`)).toEqual([]);
    expect((await h.request('GET', `${base()}/attendance-rule-sets?locationId=${uuid('9')}`, { token: f.hrUser })).status).toBe(404);
    // a branch-B reader: the policies without a branch (organisation, region), not branch A's; branch A's node is not theirs
    expect((await listIds('', scopedHrB)).sort()).toEqual([orgDefault, north].sort());
    expect((await h.request('GET', `${base()}/attendance-rule-sets?locationId=${N.branchA}`, { token: scopedHrB })).status).toBe(404);
  });

  it('the location is part of the immutable scope: changing it is refused, sending it back is fine', async () => {
    for (const locationId of [N.floor2, null]) {
      const r = await h.request('PATCH', `${base()}/attendance-rule-sets/${siteA}`, { token: f.hrAdmin, body: { locationId } });
      expect(r.status, String(locationId)).toBe(400);
      expect(r.body.details.issues[0]).toMatchObject({ path: 'locationId', message: 'Immutable' });
    }
    const same = await h.request('PATCH', `${base()}/attendance-rule-sets/${siteA}`, { token: f.hrAdmin, body: { locationId: N.siteA, branchId: f.branchA, graceInMinutes: 9 } });
    expect(same.status).toBe(200);
    expect(same.body.data).toMatchObject({ locationId: N.siteA, branchId: f.branchA, graceInMinutes: 9, policy: { points: { enabled: true } } });
    // a group location's policy is for members with every branch, like the organisation's
    expect((await h.request('PATCH', `${base()}/attendance-rule-sets/${north}`, { token: scopedAdminB, body: { graceInMinutes: 3 } })).status).toBe(403);
  });

  it('resolves: the place beats the branch for the people working there, the branch beats the region, the region covers its branches', async () => {
    const resolve = (employeeId: string, date: string) => h.request('GET', `${base()}/attendance-policies/resolve?employeeId=${employeeId}&date=${date}`, { token: f.hrUser });
    // e5 works on Floor 2 of Site A: the chain is the work location's path
    const onFloor = await resolve(e5, '2026-03-10');
    expect(onFloor.status).toBe(200);
    expect(onFloor.body.data.scope).toMatchObject({ branchId: f.branchA, locationId: N.floor2, locationIds: [N.hq, N.north, N.branchA, N.siteA, N.floor2] });
    expect(onFloor.body.data.policy).toEqual({ id: siteA, name: 'Site A', specificity: 4 });
    // e3, same branch, no work location: the branch's node — the branch policy, the place ruled out by its LOCATION
    const colleague = await resolve(f.e3, '2026-03-10');
    expect(colleague.body.data.scope).toMatchObject({ locationId: N.branchA, locationIds: [N.hq, N.north, N.branchA] });
    expect(colleague.body.data.policy.id).toBe(branchA);
    const byId = Object.fromEntries(colleague.body.data.candidates.map((c: { id: string }) => [c.id, c]));
    expect(byId[siteA]).toMatchObject({ matches: false, mismatch: 'LOCATION', scope: { branchId: f.branchA, locationId: N.siteA } });
    expect(byId[north]).toMatchObject({ matches: true, mismatch: null, specificity: 4, scope: { branchId: null, locationId: N.north } });
    // before the branch policy starts, the region's applies to its branches
    expect((await resolve(f.e3, '2026-02-10')).body.data.policy.id).toBe(north);
    // branch B sits in the South: neither the North's nor branch A's place policy is theirs
    const south = await resolve(f.e2, '2026-03-10');
    expect(south.body.data.policy.id).toBe(orgDefault);
    expect(south.body.data.candidates.find((c: { id: string }) => c.id === north)).toMatchObject({ matches: false, mismatch: 'LOCATION' });
    // the engine's resolver says the same (GET /shifts/resolve reads loadPolicyScope)
    expect((await h.request('GET', `${base()}/shifts/resolve?employeeId=${e5}&date=2026-03-10`, { token: f.hrUser })).body.data.ruleSet.id).toBe(siteA);
  });

  it('the points and overtime reports apply the place policy to the people working there', async () => {
    const seedRecord = (employeeId: string, date: string, flags: string[]) => h.admin.insertInto('attendanceDailyRecords')
      .values({ organizationId: f.orgId, employeeId, attendanceDate: date, branchId: f.branchA, timezone: 'Asia/Muscat', engineVersion: 'test', status: 'PRESENT', flags, workedMinutes: 480, trace: JSON.stringify({}) } as never).execute();
    await seedRecord(e5, '2026-03-10', ['LATE']);
    await seedRecord(f.e3, '2026-03-10', ['LATE']);
    const points = await h.request('GET', `${base()}/attendance-policies/points?asOf=2026-03-31&branchId=${f.branchA}`, { token: f.hrUser });
    expect(points.status).toBe(200);
    const byEmployee = Object.fromEntries(points.body.data.map((row: { employeeId: string }) => [row.employeeId, row]));
    expect(byEmployee[e5]).toMatchObject({ policyId: siteA, policyName: 'Site A', pointsEnabled: true, points: 1 });
    expect(byEmployee[f.e3]).toMatchObject({ policyId: branchA, policyName: 'Branch A', pointsEnabled: false, points: 0 });
    const overtime = await h.request('GET', `${base()}/attendance-policies/overtime-summary?month=2026-03&branchId=${f.branchA}`, { token: f.hrUser });
    expect(overtime.status).toBe(200);
    const byEmployeeOt = Object.fromEntries(overtime.body.data.map((row: { employeeId: string }) => [row.employeeId, row]));
    expect(byEmployeeOt[e5]).toMatchObject({ policyId: siteA, policyName: 'Site A' });
    expect(byEmployeeOt[e6]).toMatchObject({ policyId: siteA, policyName: 'Site A' }); // Zone C is below Site A
    expect(byEmployeeOt[e7]).toMatchObject({ policyId: branchA, policyName: 'Branch A' }); // the Annex is not
  });
});

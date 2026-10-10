import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { ensureSelfServiceDevice } from '@flowza/database';
import { createApiHarness, isoTodayIn, seedDevice, seedOrg, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';
import { seedLocationFixture, type LocationFixture } from './location-fixture.js';

/*
 * The muster list of a location (Enterprise, module advanced_scheduling — docs/locations.md §4): who was last seen on the
 * terminals of a location's subtree on a day (the branch's local date), their state from the latest event, the totals per
 * direct child; RLS and the branch scope; the module gate. Tree and people: location-fixture.ts.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let h: ApiHarness; let f: OrgFixture; let off: OrgFixture; let N: LocationFixture['node'];
let e5: string; let e6: string; let e7: string; let e8: string; let e9: string; let e10: string; let e11: string; let scopedHrA: string; let scopedHrB: string;
const base = (o: OrgFixture = f) => `/api/v1/orgs/${o.orgId}`;
const DAY = '2026-09-15';
const D = { gate: '', floor: '', zone: '', lobby: '', old: '', siteB: '', portal: '' };
const at = (date: string, time: string, zone = 'Asia/Muscat') => DateTime.fromISO(`${date}T${time}`, { zone }).toJSDate();
const punch = (employeeId: string, branchId: string, deviceId: string, eventType: 'PUNCH_IN' | 'PUNCH_OUT' | 'BREAK_START' | 'BREAK_END' | 'PUNCH', punchedAt: Date, voided = false) =>
  h.admin.insertInto('attendanceEvents').values({ organizationId: f.orgId, employeeId, branchId, deviceId, source: 'DEVICE', eventType, punchedAt, voidedAt: voided ? new Date() : null }).execute();
const muster = (locationId: string, opts: { date?: string | null; token?: string } = {}) =>
  h.request('GET', `${base()}/locations/${locationId}/muster${opts.date === null ? '' : `?date=${opts.date ?? DAY}`}`, { token: opts.token ?? f.hrUser });
const who = (body: { data: { entries: Array<{ employeeId: string; state: string }> } }) => body.data.entries.map((e) => `${e.employeeId}:${e.state}`);
const zero = { on_site: 0, on_break: 0, left: 0, seen: 0 };

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_locmus_${process.pid}`);
  f = await seedOrg(h.admin, 'locmus', { modules: ['advanced_scheduling'] });
  off = await seedOrg(h.admin, 'locmusoff');
  ({ node: N, e5, e6, e7, e8, e9, e10, e11, scopedHrA, scopedHrB } = await seedLocationFixture(h.admin, f, 'locmus'));
  const device = async (branchId: string, name: string, locationId: string | null, status: 'active' | 'decommissioned' = 'active') => {
    const id = await seedDevice(h.admin, f.orgId, branchId, { code: name.toUpperCase().replace(/\W+/g, '-') });
    await h.admin.updateTable('devices').set({ name, locationId, status }).where('id', '=', id).execute();
    return id;
  };
  D.gate = await device(f.branchA, 'Site A gate', N.siteA);
  D.floor = await device(f.branchA, 'Floor 2 reader', N.floor2);
  D.zone = await device(f.branchA, 'Zone C reader', N.zoneC);
  D.lobby = await device(f.branchA, 'Lobby', null);
  D.old = await device(f.branchA, 'Old reader', N.floor2, 'decommissioned');
  D.siteB = await device(f.branchB, 'Site B reader', N.siteB);
  // the employee portal's virtual device (web / mobile punches), kept in branch A
  D.portal = (await h.admin.transaction().execute((trx) => ensureSelfServiceDevice(trx, f.orgId))).id;
  await h.admin.updateTable('devices').set({ branchId: f.branchA }).where('id', '=', D.portal).execute();
  // e10 (branch B) is deployed to branch A around the day: their events carry their home branch
  await h.admin.insertInto('employeeBranchDeployments').values({ organizationId: f.orgId, employeeId: e10, branchId: f.branchA, homeBranchId: f.branchB, fromDate: '2026-09-14', toDate: '2026-09-16', reason: 'Cover the floor', enrolOnDevices: false }).execute();

  await punch(e5, f.branchA, D.floor, 'PUNCH_IN', at(DAY, '07:00'));
  // e6 started in Zone C and moved to the Site A gate: only the latest event counts
  await punch(e6, f.branchA, D.zone, 'PUNCH_IN', at(DAY, '07:05'));
  await punch(e6, f.branchA, D.gate, 'PUNCH', at(DAY, '10:00'));
  await punch(f.e3, f.branchA, D.zone, 'PUNCH_IN', at(DAY, '08:00'));
  await punch(f.e3, f.branchA, D.zone, 'BREAK_START', at(DAY, '12:00'));
  await punch(f.e1, f.branchA, D.floor, 'PUNCH_IN', at(DAY, '07:30'));
  await punch(f.e1, f.branchA, D.floor, 'PUNCH_OUT', at(DAY, '15:00'));
  // a terminal without a place: the branch
  await punch(e7, f.branchA, D.lobby, 'PUNCH_IN', at(DAY, '08:00'));
  // e8's latest punch is a portal one: not attributed anywhere
  await punch(e8, f.branchA, D.floor, 'PUNCH_IN', at(DAY, '07:00'));
  await punch(e8, f.branchA, D.portal, 'PUNCH_OUT', at(DAY, '08:10'));
  // e9's only punch was voided by a correction
  await punch(e9, f.branchA, D.floor, 'PUNCH_IN', at(DAY, '08:00'), true);
  // e11: out at 23:30 the evening before, in at 00:30 — the branch's local day (Asia/Muscat), not UTC
  await punch(e11, f.branchA, D.floor, 'PUNCH_OUT', at('2026-09-14', '23:30'));
  await punch(e11, f.branchA, D.floor, 'PUNCH_IN', at(DAY, '00:30'));
  await punch(e10, f.branchB, D.floor, 'PUNCH_IN', at(DAY, '09:00'));
  // e2 in branch B (Asia/Kolkata): 00:10 local on the day is still the evening before in Muscat
  await punch(f.e2, f.branchB, D.siteB, 'PUNCH_IN', at(DAY, '00:10', 'Asia/Kolkata'));
});
afterAll(async () => { await h?.close(); });

describe('the muster list of a location', () => {
  it('needs advanced_scheduling (the module gate)', async () => {
    const offNode = (await h.admin.selectFrom('locations').select('id').where('branchId', '=', off.branchA).where('role', '=', 'branch').executeTakeFirstOrThrow()).id;
    const r = await h.request('GET', `${base(off)}/locations/${offNode}/muster`, { token: off.hrAdmin });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_DISABLED', details: { reason: 'MODULE_DISABLED', module: 'advanced_scheduling' } });
  });

  it('a place: who was last seen on its terminals and below, by state then name, with the totals per child', async () => {
    const r = await muster(N.siteA);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ locationId: N.siteA, date: DAY, deviceCount: 3, totals: { on_site: 3, on_break: 1, left: 1, seen: 1 } });
    expect(who(r.body)).toEqual([`${e10}:on_site`, `${e11}:on_site`, `${e5}:on_site`, `${f.e3}:on_break`, `${f.e1}:left`, `${e6}:seen`]);
    const entry = (id: string) => r.body.data.entries.find((e: { employeeId: string }) => e.employeeId === id);
    expect(entry(e5)).toEqual({
      employeeId: e5, employeeNumber: 'EMP5', displayName: 'Employee 5', branchId: f.branchA, state: 'on_site', eventType: 'PUNCH_IN',
      punchedAt: at(DAY, '07:00').toISOString(), deviceId: D.floor, deviceName: 'Floor 2 reader', locationId: N.floor2, locationName: 'Site A › Floor 2',
    });
    expect(entry(e6)).toMatchObject({ state: 'seen', eventType: 'PUNCH', deviceId: D.gate, locationId: N.siteA, locationName: 'Site A' });
    expect(entry(f.e3)).toMatchObject({ state: 'on_break', eventType: 'BREAK_START', locationId: N.zoneC, locationName: 'Site A › Floor 2 › Zone C' });
    expect(entry(e10)).toMatchObject({ branchId: f.branchB, state: 'on_site', locationId: N.floor2 }); // deployed from branch B
    expect(r.body.data.children).toEqual([{ locationId: N.floor2, name: 'Floor 2', nameAr: null, totals: { on_site: 3, on_break: 1, left: 1, seen: 0 } }]);
  });

  it('the latest event wins: someone who moved to another zone is listed there only', async () => {
    const zone = await muster(N.zoneC);
    expect(who(zone.body)).toEqual([`${f.e3}:on_break`]);
    expect(zone.body.data).toMatchObject({ deviceCount: 1, children: [] });
    const floor = await muster(N.floor2);
    expect(who(floor.body)).toEqual([`${e10}:on_site`, `${e11}:on_site`, `${e5}:on_site`, `${f.e3}:on_break`, `${f.e1}:left`]);
    expect(floor.body.data.deviceCount).toBe(2); // the decommissioned reader is not a terminal any more
    expect(floor.body.data.children).toEqual([{ locationId: N.zoneC, name: 'Zone C', nameAr: null, totals: { ...zero, on_break: 1 } }]);
    // the evening before: e11 had left
    expect(who((await muster(N.floor2, { date: '2026-09-14' })).body)).toEqual([`${e11}:left`]);
  });

  it('a branch or a group location: every terminal of its branches, at its place or at the branch', async () => {
    const branch = await muster(N.branchA);
    expect(branch.status).toBe(200);
    expect(branch.body.data.totals).toEqual({ on_site: 4, on_break: 1, left: 1, seen: 1 });
    expect(branch.body.data.deviceCount).toBe(4); // gate, floor, zone, lobby — not the portal's virtual device
    expect(branch.body.data.entries.find((e: { employeeId: string }) => e.employeeId === e7)).toMatchObject({ state: 'on_site', deviceId: D.lobby, locationId: N.branchA, locationName: 'Branch A' });
    // e8's latest punch was on the portal, e9's only punch was voided
    expect(branch.body.data.entries.map((e: { employeeId: string }) => e.employeeId)).not.toContain(e8);
    expect(branch.body.data.entries.map((e: { employeeId: string }) => e.employeeId)).not.toContain(e9);
    // the archived Old store has nobody: not a child
    expect(branch.body.data.children).toEqual([
      { locationId: N.annex, name: 'Annex', nameAr: null, totals: zero },
      { locationId: N.siteA, name: 'Site A', nameAr: null, totals: { on_site: 3, on_break: 1, left: 1, seen: 1 } },
    ]);
    const north = await muster(N.north);
    expect(north.body.data.children).toEqual([{ locationId: N.branchA, name: 'Branch A', nameAr: null, totals: { on_site: 4, on_break: 1, left: 1, seen: 1 } }]);
    // the whole organisation: branch B's day is Asia/Kolkata's
    const hq = await muster(N.hq);
    expect(hq.body.data.totals).toEqual({ on_site: 5, on_break: 1, left: 1, seen: 1 });
    expect(hq.body.data.entries.find((e: { employeeId: string }) => e.employeeId === f.e2)).toMatchObject({ branchId: f.branchB, locationId: N.siteB, locationName: 'Site B', deviceName: 'Site B reader' });
    expect(hq.body.data.children.map((c: { locationId: string; totals: { on_site: number } }) => [c.locationId, c.totals.on_site])).toEqual([[N.north, 4], [N.south, 1]]);
    expect(hq.body.data.deviceCount).toBe(5);
  });

  it('a place without terminals: nothing to attribute', async () => {
    const r = await muster(N.annex);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ locationId: N.annex, date: DAY, totals: zero, children: [], entries: [], deviceCount: 0 });
  });

  it('a branch-scoped member sees their branches only; the home branch keeps a deployed employee\'s data', async () => {
    const a = await muster(N.hq, { token: scopedHrA });
    expect(a.status).toBe(200);
    // e10's events belong to branch B, outside this member's scope
    expect(who(a.body).sort()).toEqual([`${e11}:on_site`, `${e5}:on_site`, `${e7}:on_site`, `${f.e3}:on_break`, `${f.e1}:left`, `${e6}:seen`].sort());
    expect(a.body.data.deviceCount).toBe(4);
    expect(a.body.data.children.map((c: { locationId: string; totals: { on_site: number } }) => [c.locationId, c.totals.on_site])).toEqual([[N.north, 3], [N.south, 0]]);
    const b = await muster(N.hq, { token: scopedHrB });
    expect(who(b.body)).toEqual([`${f.e2}:on_site`]);
    expect(b.body.data.deviceCount).toBe(1);
    // branch A's places are not theirs to see
    expect((await muster(N.siteA, { token: scopedHrB })).status).toBe(404);
    expect((await muster(N.branchA, { token: scopedHrB })).status).toBe(404);
  });

  it('needs attendance.view; an unknown location is a 404; the day defaults to today in the branch\'s (or organisation\'s) time zone', async () => {
    expect((await muster(N.siteA, { token: f.employeeUser })).status).toBe(403);
    expect((await muster(uuid('9'))).status).toBe(404);
    expect((await muster(N.siteA, { date: '2026-13-01' })).status).toBe(400);
    expect((await muster(N.annex, { date: null })).body.data.date).toBe(isoTodayIn('Asia/Muscat'));
    expect((await muster(N.siteB, { date: null })).body.data.date).toBe(isoTodayIn('Asia/Kolkata'));
    expect((await muster(N.hq, { date: null })).body.data.date).toBe(isoTodayIn('Asia/Muscat'));
  });
});

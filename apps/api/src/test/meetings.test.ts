/**
 * Meeting rooms & access (Enterprise module meeting_rooms, docs/time-away.md §4): the module gate, rooms on places of the
 * location tree, meetings (no double booking, capacity), attendance from the room's ACCESS entries (on time / late / absent,
 * unauthorised walk-ins in a restricted room), the access log (meeting.rooms only) and an employee's own invitations.
 * Review fixes: the organiser and an early arrival for the next back-to-back booking are no walk-ins; backdated bookings and
 * walk-in identities are the room administrators'; the access log pages in SQL over local dates; a cancellation after an entry
 * keeps it covered; rooms show their readers and today's meetings (branch day) without device.view; DTOs carry the branch zone.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withContext } from '@flowza/database';
import { createApiHarness, enableModules, seedEmployee, seedMembership, seedOrg, seedUser, uuid, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
let placeId: string; let readerId: string; let roomId: string; let meetingId: string; let nextId: string; let standUpId: string; let e4: string; let e5: string; let e6: string;
// the room's branch runs on Riyadh time while the organisation is in Muscat: the branch zone must win everywhere
const ZONE = 'Asia/Riyadh';
// a room booker: a custom role with meeting.view + meeting.manage only (no meeting.rooms, device.view nor branch.view — like a
// manager an organisation lets book rooms), employee e6
const booker = uuid('c');
const start = new Date(Date.now() - 2 * 3_600_000); start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 3_600_000);
const plus = (min: number) => new Date(start.getTime() + min * 60_000);
/** The local date of an instant in the room's zone. */
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function entry(employeeId: string | null, deviceEmployeeId: string, at: Date) {
  await h.admin.insertInto('accessEvents').values({ organizationId: f.orgId, branchId: f.branchA, deviceId: readerId, locationId: placeId, roomId, employeeId, deviceEmployeeId, occurredAt: at, direction: 'in', rawTransactionId: String(Math.floor(Math.random() * 1e12)) } as never).execute();
}
const log = (query: string, token = f.hrAdmin) => h.request('GET', `${base()}/access-events?${query}`, { token });

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_meetings_${process.pid}`);
  f = await seedOrg(h.admin, 'meetings');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4, { departmentId: f.departmentA });
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5);
  e6 = await seedEmployee(h.admin, f.orgId, f.branchA, 6);
  const bookerRole = uuid('9');
  await withContext(h.tdb.db, { kind: 'system', organizationId: f.orgId }, async (trx) => {
    await trx.insertInto('roles').values({ id: bookerRole, organizationId: f.orgId, key: 'room_booker', name: 'Room booker', isSystem: false }).execute();
    await trx.insertInto('rolePermissions').values(['meeting.view', 'meeting.manage'].map((permissionKey) => ({ roleId: bookerRole, permissionKey }))).execute();
  });
  await seedUser(h.admin, booker, 'room-booker-meetings@test.local', 'Room booker');
  await seedMembership(h.admin, f.orgId, booker, bookerRole, { employeeId: e6 });
  await h.admin.updateTable('branches').set({ timezone: ZONE }).where('id', '=', f.branchA).execute();
  // a place under branch A: level "Room" below the branch level
  const branchLevel = await h.admin.selectFrom('locationLevels').select('id').where('organizationId', '=', f.orgId).where('role', '=', 'branch').executeTakeFirstOrThrow();
  const branchNode = await h.admin.selectFrom('locations').select('id').where('organizationId', '=', f.orgId).where('branchId', '=', f.branchA).where('role', '=', 'branch').executeTakeFirstOrThrow();
  const lvl = await h.admin.insertInto('locationLevels').values({ organizationId: f.orgId, position: 2, role: 'place', name: 'Room', icon: 'room' }).returning('id').executeTakeFirstOrThrow();
  void branchLevel;
  placeId = (await h.admin.insertInto('locations').values({ organizationId: f.orgId, levelId: lvl.id, role: 'place', parentId: branchNode.id, code: 'BRD', name: 'Boardroom', path: [] } as never).returning('id').executeTakeFirstOrThrow()).id;
  readerId = (await h.admin.insertInto('devices').values({ organizationId: f.orgId, branchId: f.branchA, locationId: placeId, code: 'BRD-1', name: 'Boardroom reader', providerKey: 'mock', manufacturer: 'FlowZa', integrationType: 'DEVICE_PUSH', capabilities: '{}', config: '{}', timezone: 'Asia/Muscat', punchRole: 'ACCESS' } as never).returning('id').executeTakeFirstOrThrow()).id;
});
afterAll(async () => { await h?.close(); });

describe('module gate and permissions', () => {
  it('is closed while the module is off', async () => {
    const r = await h.request('GET', `${base()}/meeting-rooms`, { token: f.hrAdmin });
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ reason: 'MODULE_DISABLED', module: 'meeting_rooms' });
    await enableModules(h.admin, f.orgId, ['meeting_rooms']);
  });

  it('rooms are configured with meeting.rooms on a place of the tree; an employee cannot', async () => {
    expect((await h.request('POST', `${base()}/meeting-rooms`, { token: f.employeeUser, body: { locationId: placeId, name: 'Boardroom' } })).status).toBe(403);
    const r = await h.request('POST', `${base()}/meeting-rooms`, { token: f.hrAdmin, body: { locationId: placeId, name: 'Boardroom', capacity: 3, restricted: true, allowedDepartmentIds: [f.departmentA] } });
    expect(r.status).toBe(201);
    roomId = r.body.data.id;
    expect(r.body.data).toMatchObject({ name: 'Boardroom', capacity: 3, restricted: true, branchId: f.branchA, timezone: ZONE, readers: [{ id: readerId, code: 'BRD-1' }] });
    expect((await h.request('POST', `${base()}/meeting-rooms`, { token: f.hrAdmin, body: { locationId: placeId, name: 'Again' } })).status).toBe(409);
  });
});

describe('meetings and their attendance', () => {
  it('books a room (capacity, no double booking)', async () => {
    const tooMany = await h.request('POST', `${base()}/meetings`, { token: f.hrAdmin, body: { roomId, title: 'Big', startsAt: start.toISOString(), endsAt: end.toISOString(), invitees: [f.e1, f.e2, f.e3, e4].map((employeeId) => ({ employeeId })) } });
    expect(tooMany.status).toBe(400);
    const r = await h.request('POST', `${base()}/meetings`, { token: f.hrAdmin, body: { roomId, title: 'QA review', startsAt: start.toISOString(), endsAt: end.toISOString(), lateAfterMinutes: 5, invitees: [{ employeeId: f.e1 }, { employeeId: f.e3 }, { employeeId: e4, required: false }] } });
    expect(r.status).toBe(201);
    meetingId = r.body.data.id;
    expect(r.body.data).toMatchObject({ title: 'QA review', invitedCount: 3, noReader: false, timezone: ZONE });
    const clash = await h.request('POST', `${base()}/meetings`, { token: f.hrAdmin, body: { roomId, title: 'Clash', startsAt: plus(30).toISOString(), endsAt: plus(90).toISOString(), invitees: [{ employeeId: f.e1 }] } });
    expect(clash.status).toBe(409);
  });

  it('derives attendance from the room entries: on time, late, absent; an uninvited outsider is an unauthorised walk-in', async () => {
    await entry(f.e1, f.deviceUserIds.e1, plus(-4));
    await entry(f.e3, f.deviceUserIds.e3, plus(9));
    await entry(e5, '1005', plus(20)); // not invited, not in the allowed department
    await entry(f.e1, f.deviceUserIds.e1, plus(-120)); // long before the meeting: ignored
    const r = await h.request('GET', `${base()}/meetings/${meetingId}`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    const by = new Map(r.body.data.attendees.map((a: { employeeId: string }) => [a.employeeId, a]));
    expect(by.get(f.e1)).toMatchObject({ status: 'ON_TIME', lateMinutes: 0, entries: 1 });
    expect(by.get(f.e3)).toMatchObject({ status: 'LATE', lateMinutes: 9 });
    expect(by.get(e4)).toMatchObject({ status: 'ABSENT', required: false });
    expect(r.body.data.walkIns).toEqual([expect.objectContaining({ employeeId: e5, unauthorized: true })]);
    expect(r.body.data).toMatchObject({ attendedCount: 2, lateCount: 1, absentCount: 1, walkInCount: 1, phase: 'over' });
    const list = await h.request('GET', `${base()}/meetings?from=${start.toISOString().slice(0, 10)}&to=${start.toISOString().slice(0, 10)}`, { token: f.hrUser });
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: meetingId, attendedCount: 2 });
  });

  it('back-to-back: an invitee arriving early for the next booking is no walk-in of the running one, nor unauthorised', async () => {
    // the next meeting starts when QA review ends; e2 (invited to it only, outside the allowed department) badges in 10 minutes early
    const r = await h.request('POST', `${base()}/meetings`, { token: f.hrAdmin, body: { roomId, title: 'Follow-up', startsAt: plus(60).toISOString(), endsAt: plus(90).toISOString(), invitees: [{ employeeId: f.e2 }] } });
    expect(r.status).toBe(201);
    nextId = r.body.data.id;
    await entry(f.e2, f.deviceUserIds.e2, plus(50));
    const qa = await h.request('GET', `${base()}/meetings/${meetingId}`, { token: f.hrAdmin });
    expect(qa.body.data.walkIns).toEqual([expect.objectContaining({ employeeId: e5 })]);
    expect(qa.body.data.walkInCount).toBe(1);
    const next = await h.request('GET', `${base()}/meetings/${nextId}`, { token: f.hrAdmin });
    expect(next.body.data.attendees).toEqual([expect.objectContaining({ employeeId: f.e2, status: 'ON_TIME' })]);
  });

  it('the access log is the room administrators\' (meeting.rooms); an invitee sees their own meeting', async () => {
    const range = `from=${localDate(start)}&to=${localDate(end)}`;
    const unauthorized = await log(`${range}&unauthorizedOnly=true`);
    expect(unauthorized.status).toBe(200);
    expect(unauthorized.body.data).toEqual([expect.objectContaining({ employeeId: e5, unauthorized: true, meetingId })]);
    expect(unauthorized.body.meta.total).toBe(1);
    // the early arrival belongs to the meeting they are invited to, whatever order the meetings come in
    const all = await log(range);
    expect(all.body.data.find((a: { employeeId: string }) => a.employeeId === f.e2)).toMatchObject({ unauthorized: false, meetingId: nextId, meetingTitle: 'Follow-up' });
    expect((await h.request('GET', `${base()}/access-events?from=2026-01-01&to=2026-01-02`, { token: f.hrUser })).status).toBe(403);
    const mine = await h.request('GET', `${base()}/me/meetings?from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}`, { token: f.employeeUser });
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([expect.objectContaining({ id: meetingId, myStatus: 'ON_TIME' })]);
  });

  it('a meeting cancelled after an entry keeps covering it; an entry after the cancellation is not covered', async () => {
    expect((await h.request('POST', `${base()}/meetings/${nextId}/cancel`, { token: f.hrAdmin })).status).toBe(200);
    const range = `from=${localDate(start)}&to=${localDate(end)}`;
    const all = await log(range);
    expect(all.body.data.find((a: { employeeId: string }) => a.employeeId === f.e2)).toMatchObject({ unauthorized: false, meetingId: nextId });
    expect((await log(`${range}&unauthorizedOnly=true`)).body.data.map((a: { employeeId: string }) => a.employeeId)).toEqual([e5]);
    // pretend it was cancelled 5 minutes into its window: e2 entering after that is unauthorised (both the badge and the SQL filter)
    await h.admin.updateTable('meetings').set({ cancelledAt: plus(65) }).where('id', '=', nextId).execute();
    await entry(f.e2, f.deviceUserIds.e2, plus(70));
    const after = await log(range);
    const e2Rows = after.body.data.filter((a: { employeeId: string }) => a.employeeId === f.e2).map((a: { occurredAt: string; unauthorized: boolean }) => [a.occurredAt, a.unauthorized]);
    expect(e2Rows).toEqual([[plus(70).toISOString(), true], [plus(50).toISOString(), false]]);
    const filtered = await log(`${range}&unauthorizedOnly=true`);
    expect(filtered.body.data.map((a: { employeeId: string; occurredAt: string }) => [a.employeeId, a.occurredAt])).toEqual([[f.e2, plus(70).toISOString()], [e5, plus(20).toISOString()]]);
  });

  it('cancels a meeting (meeting.manage)', async () => {
    expect((await h.request('POST', `${base()}/meetings/${meetingId}/cancel`, { token: f.employeeUser })).status).toBe(403);
    const r = await h.request('POST', `${base()}/meetings/${meetingId}/cancel`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
  });
});

describe('the room administrators\' boundary (meeting.manage without meeting.rooms)', () => {
  it('refuses a booking that starts in the past beyond the grace; a few minutes late is fine and the organiser is no walk-in', async () => {
    const backdated = await h.request('POST', `${base()}/meetings`, { token: booker, body: { roomId, title: 'Peek', startsAt: plus(-60 * 24).toISOString(), endsAt: plus(-60 * 24 + 600).toISOString(), invitees: [{ employeeId: f.e1 }] } });
    expect(backdated.status).toBe(400);
    expect(backdated.body.details.issues[0].path).toBe('startsAt');
    const now = Date.now();
    const r = await h.request('POST', `${base()}/meetings`, { token: booker, body: { roomId, title: 'Stand-up', startsAt: new Date(now - 5 * 60_000).toISOString(), endsAt: new Date(now + 25 * 60_000).toISOString(), invitees: [{ employeeId: f.e1 }] } });
    expect(r.status).toBe(201);
    standUpId = r.body.data.id;
    expect(r.body.data).toMatchObject({ organizerEmployeeId: e6, timezone: ZONE });
    // the organiser (no allowed department, not on the invitee list) enters their own meeting
    await entry(e6, '1006', new Date(now - 60_000));
    const detail = await h.request('GET', `${base()}/meetings/${standUpId}`, { token: f.hrAdmin });
    expect(detail.body.data).toMatchObject({ walkInCount: 0, walkIns: [] });
    const own = await log(`from=${localDate(new Date(now - 60_000))}&to=${localDate(new Date(now - 60_000))}&employeeId=${e6}`);
    expect(own.body.data).toEqual([expect.objectContaining({ employeeId: e6, unauthorized: false, meetingId: standUpId })]);
  });

  it('a meeting shows its walk-in count but not who walked in (that is the access log)', async () => {
    const asManager = await h.request('GET', `${base()}/meetings/${meetingId}`, { token: booker });
    expect(asManager.status).toBe(200);
    expect(asManager.body.data).toMatchObject({ walkInCount: 1, walkIns: [] });
    expect(asManager.body.data.attendees.length).toBe(3);
    const asAdmin = await h.request('GET', `${base()}/meetings/${meetingId}`, { token: f.hrAdmin });
    expect(asAdmin.body.data.walkIns).toEqual([expect.objectContaining({ employeeId: e5, unauthorized: true })]);
  });

  it('the rooms list shows a meeting.view holder without device.view / branch.view the readers, the branch and its zone, and today\'s meetings in the branch day', async () => {
    // tomorrow 09:00 in the branch: inside a ±12 h widening of a server-zone day, not today
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86_400_000));
    const tomorrowNine = new Date(`${tomorrow}T06:00:00Z`); // 09:00 Riyadh
    await h.admin.insertInto('meetings').values({ organizationId: f.orgId, branchId: f.branchA, roomId, title: 'Tomorrow', startsAt: tomorrowNine, endsAt: new Date(tomorrowNine.getTime() + 3_600_000) } as never).execute();
    const r = await h.request('GET', `${base()}/meeting-rooms`, { token: booker });
    expect(r.status).toBe(200);
    const today = localDate(new Date());
    const scheduled = await h.admin.selectFrom('meetings').select('startsAt').where('roomId', '=', roomId).where('status', '=', 'scheduled').execute();
    const expected = scheduled.filter((m) => localDate(m.startsAt) === today).length;
    expect(r.body.data).toEqual([expect.objectContaining({ id: roomId, branchName: 'Branch A', timezone: ZONE, readers: [expect.objectContaining({ id: readerId, code: 'BRD-1', connectionStatus: expect.any(String) })], meetingsToday: expected })]);
  });
});

describe('the access log pages in the database over the entries\' local dates', () => {
  it('counts and pages beyond a couple of thousand entries; "unauthorised only" is filtered before paging', async () => {
    // 2,050 entries of e5 (unauthorised), one a minute from 1 Feb 08:00 Riyadh, and 3 of e1 (allowed department)
    await sql`insert into public.access_events (organization_id, branch_id, device_id, location_id, room_id, employee_id, device_employee_id, occurred_at, direction, raw_transaction_id)
      select ${f.orgId}::uuid, ${f.branchA}::uuid, ${readerId}::uuid, ${placeId}::uuid, ${roomId}::uuid, ${e5}::uuid, '1005', '2026-02-01T05:00:00Z'::timestamptz + make_interval(mins => g), 'in', 900000000000 + g
      from generate_series(0, 2049) g`.execute(h.admin);
    for (const [i, at] of ['2026-02-01T06:00:30Z', '2026-02-01T07:00:30Z', '2026-02-01T08:00:30Z'].entries()) {
      await h.admin.insertInto('accessEvents').values({ organizationId: f.orgId, branchId: f.branchA, deviceId: readerId, locationId: placeId, roomId, employeeId: f.e1, deviceEmployeeId: '1001', occurredAt: new Date(at), direction: 'in', rawTransactionId: String(910000000000 + i) } as never).execute();
    }
    const first = await log('from=2026-02-01&to=2026-02-03&pageSize=200');
    expect(first.body.meta).toMatchObject({ total: 2053, totalPages: 11 });
    expect(first.body.data).toHaveLength(200);
    const last = await log('from=2026-02-01&to=2026-02-03&pageSize=200&page=11');
    expect(last.body.data).toHaveLength(53);
    expect(last.body.data.at(-1)).toMatchObject({ occurredAt: '2026-02-01T05:00:00.000Z', employeeId: e5, unauthorized: true });
    const unauthorized = await log('from=2026-02-01&to=2026-02-03&pageSize=200&page=11&unauthorizedOnly=true');
    expect(unauthorized.body.meta.total).toBe(2050);
    expect(unauthorized.body.data).toHaveLength(50);
    expect(unauthorized.body.data.every((a: { employeeId: string; unauthorized: boolean }) => a.employeeId === e5 && a.unauthorized)).toBe(true);
  });

  it('a date range is the entries\' local dates in the branch zone, nothing from the neighbouring days', async () => {
    // Riyadh is UTC+3: 14 Mar 23:30, 15 Mar 00:30, 15 Mar 23:30, 16 Mar 00:30 (local)
    for (const at of ['2026-03-14T20:30:00Z', '2026-03-14T21:30:00Z', '2026-03-15T20:30:00Z', '2026-03-15T21:30:00Z']) await entry(e5, '1005', new Date(at));
    const day = await log('from=2026-03-15&to=2026-03-15');
    expect(day.body.data.map((a: { occurredAt: string }) => a.occurredAt)).toEqual(['2026-03-15T20:30:00.000Z', '2026-03-14T21:30:00.000Z']);
    expect(day.body.meta.total).toBe(2);
    expect((await log('from=2026-03-15&to=2026-03-15&unauthorizedOnly=true')).body.meta.total).toBe(2);
    expect((await log('from=2026-03-14&to=2026-03-16')).body.meta.total).toBe(4);
  });
});

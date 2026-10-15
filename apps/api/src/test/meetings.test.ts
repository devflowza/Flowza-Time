/**
 * Meeting rooms & access (Enterprise module meeting_rooms, docs/time-away.md §4): the module gate, rooms on places of the
 * location tree, meetings (no double booking, capacity), attendance from the room's ACCESS entries (on time / late / absent,
 * unauthorised walk-ins in a restricted room), the access log (meeting.rooms only) and an employee's own invitations.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiHarness, enableModules, seedEmployee, seedOrg, type ApiHarness, type OrgFixture } from './features-harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });
let h: ApiHarness; let f: OrgFixture;
const base = () => `/api/v1/orgs/${f.orgId}`;
let placeId: string; let readerId: string; let roomId: string; let meetingId: string; let e4: string; let e5: string;
const start = new Date(Date.now() - 2 * 3_600_000); start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 3_600_000);
const plus = (min: number) => new Date(start.getTime() + min * 60_000);

async function entry(employeeId: string | null, deviceEmployeeId: string, at: Date) {
  await h.admin.insertInto('accessEvents').values({ organizationId: f.orgId, branchId: f.branchA, deviceId: readerId, locationId: placeId, roomId, employeeId, deviceEmployeeId, occurredAt: at, direction: 'in', rawTransactionId: String(Math.floor(Math.random() * 1e12)) } as never).execute();
}

beforeAll(async () => {
  h = await createApiHarness(`flowza_api_meetings_${process.pid}`);
  f = await seedOrg(h.admin, 'meetings');
  e4 = await seedEmployee(h.admin, f.orgId, f.branchA, 4, { departmentId: f.departmentA });
  e5 = await seedEmployee(h.admin, f.orgId, f.branchA, 5);
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
    expect(r.body.data).toMatchObject({ name: 'Boardroom', capacity: 3, restricted: true, branchId: f.branchA, readers: [{ id: readerId, code: 'BRD-1' }] });
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
    expect(r.body.data).toMatchObject({ title: 'QA review', invitedCount: 3, noReader: false });
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

  it('the access log is the room administrators\' (meeting.rooms); an invitee sees their own meeting', async () => {
    const log = await h.request('GET', `${base()}/access-events?from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}&unauthorizedOnly=true`, { token: f.hrAdmin });
    expect(log.status).toBe(200);
    expect(log.body.data).toEqual([expect.objectContaining({ employeeId: e5, unauthorized: true, meetingId })]);
    expect((await h.request('GET', `${base()}/access-events?from=2026-01-01&to=2026-01-02`, { token: f.hrUser })).status).toBe(403);
    const mine = await h.request('GET', `${base()}/me/meetings?from=${start.toISOString().slice(0, 10)}&to=${end.toISOString().slice(0, 10)}`, { token: f.employeeUser });
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([expect.objectContaining({ id: meetingId, myStatus: 'ON_TIME' })]);
  });

  it('cancels a meeting (meeting.manage)', async () => {
    expect((await h.request('POST', `${base()}/meetings/${meetingId}/cancel`, { token: f.employeeUser })).status).toBe(403);
    const r = await h.request('POST', `${base()}/meetings/${meetingId}/cancel`, { token: f.hrAdmin });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
  });
});

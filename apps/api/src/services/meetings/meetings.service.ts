import { DateTime } from 'luxon';
import type {
  AccessEventDto, AccessLogQuery, MeetingAttendeeDto, MeetingDetailDto, MeetingDto, MeetingInput, MeetingRoomDto, MeetingRoomInput, MeetingRoomUpdateInput, MeetingsQuery, MyMeetingDto,
} from '@flowza/contracts';
import { locationLabels, type Trx } from '@flowza/database';
import { accessAllowed, meetingAttendance, meetingPhase, type RoomAccessRule } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
import { assertPlaceOfBranch } from '../../lib/location-scope.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { isoDateTime } from '../../lib/mappers.js';
import { portalSelf } from '../portal/common.js';

/**
 * Meeting rooms & access (Enterprise module `meeting_rooms`, docs/time-away.md §4).
 *
 *   - Rooms: a place of the location tree (its readers are the ACCESS terminals installed there), a capacity, an optional
 *     restriction to departments / employees. Read with meeting.view, configured with meeting.rooms (RLS: branch scope).
 *   - Meetings: a room, a window, invitees. Scheduled / cancelled with meeting.manage; one meeting per room at a time
 *     (exclusion constraint). Attendance is derived on read from the room's access events (packages/domain meetingAttendance).
 *   - The access log (meeting.rooms): every entry with the meeting in progress and whether it was authorised.
 *   - "My meetings": the caller's own invitations and their own attendance (read in the organisation's system scope for the
 *     caller's own employee id only — an employee holds no meeting key).
 * Access events are written by the worker's normaliser only; nothing here writes them.
 */

type RoomRow = { id: string; branchId: string; locationId: string; name: string; capacity: number | null; restricted: boolean; allowedDepartmentIds: string[]; allowedEmployeeIds: string[]; status: string };
type MeetingRow = { id: string; branchId: string; roomId: string; title: string; description: string | null; startsAt: Date; endsAt: Date; lateAfterMinutes: number; organizerEmployeeId: string | null; status: 'scheduled' | 'cancelled' };
const ROOM_COLUMNS = ['id', 'branchId', 'locationId', 'name', 'capacity', 'restricted', 'allowedDepartmentIds', 'allowedEmployeeIds', 'status'] as const;
const MEETING_COLUMNS = ['id', 'branchId', 'roomId', 'title', 'description', 'startsAt', 'endsAt', 'lateAfterMinutes', 'organizerEmployeeId', 'status'] as const;

const ruleOf = (r: Pick<RoomRow, 'restricted' | 'allowedDepartmentIds' | 'allowedEmployeeIds'>): RoomAccessRule => ({ restricted: r.restricted, allowedDepartmentIds: r.allowedDepartmentIds ?? [], allowedEmployeeIds: r.allowedEmployeeIds ?? [] });
const iso = (d: Date) => d.toISOString();

// ----- rooms ---------------------------------------------------------------------------------------------------------------------

async function roomDtos(trx: Trx, orgId: string, rows: readonly RoomRow[]): Promise<MeetingRoomDto[]> {
  if (rows.length === 0) return [];
  const [labels, branches, readers] = await Promise.all([
    locationLabels(trx, orgId, rows.map((r) => r.locationId)),
    trx.selectFrom('branches').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((r) => r.branchId))]).execute(),
    trx.selectFrom('devices').select(['id', 'code', 'name', 'connectionStatus', 'locationId']).where('organizationId', '=', orgId).where('punchRole', '=', 'ACCESS').where('status', '!=', 'decommissioned')
      .where('locationId', 'in', rows.map((r) => r.locationId)).orderBy('code').execute(),
  ]);
  const dayStart = DateTime.now().startOf('day').minus({ hours: 12 }).toJSDate();
  const dayEnd = DateTime.now().endOf('day').plus({ hours: 12 }).toJSDate();
  const today = await trx.selectFrom('meetings').select(['roomId', (eb) => eb.fn.countAll<string>().as('n')]).where('organizationId', '=', orgId).where('status', '=', 'scheduled')
    .where('roomId', 'in', rows.map((r) => r.id)).where('startsAt', '>=', dayStart).where('startsAt', '<', dayEnd).groupBy('roomId').execute();
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const todayOf = new Map(today.map((t) => [t.roomId, Number(t.n)]));
  return rows.map((r) => ({
    id: r.id, branchId: r.branchId, branchName: branchName.get(r.branchId) ?? null, locationId: r.locationId, locationName: labels.get(r.locationId) ?? null, name: r.name, capacity: r.capacity,
    restricted: r.restricted, allowedDepartmentIds: r.allowedDepartmentIds ?? [], allowedEmployeeIds: r.allowedEmployeeIds ?? [], status: r.status === 'active' ? 'active' : 'inactive',
    readers: readers.filter((d) => d.locationId === r.locationId).map((d) => ({ id: d.id, code: String(d.code), name: d.name, connectionStatus: String(d.connectionStatus) })),
    meetingsToday: todayOf.get(r.id) ?? 0,
  }));
}

export async function listRooms(deps: ApiDeps, actor: Actor, orgId: string): Promise<MeetingRoomDto[]> {
  requirePermission(actor.principal, orgId, 'meeting.view');
  return runUser(deps.db, actor, async (trx) => roomDtos(trx, orgId, (await trx.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).orderBy('name').orderBy('id').limit(500).execute()) as RoomRow[]));
}

export async function createRoom(deps: ApiDeps, actor: Actor, orgId: string, input: MeetingRoomInput): Promise<MeetingRoomDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.rooms');
  return runUser(deps.db, actor, async (trx) => {
    const place = await trx.selectFrom('locations').select(['id', 'branchId', 'role']).where('organizationId', '=', orgId).where('id', '=', input.locationId).executeTakeFirst();
    if (!place || place.role !== 'place' || !place.branchId) throw errors.validation('A meeting room is a place of the location tree (a floor, zone or room of a branch).', { issues: [{ path: 'locationId', message: 'Not a place' }] });
    requireBranchAccess(grant, place.branchId);
    await assertPlaceOfBranch(trx, orgId, input.locationId, place.branchId);
    const taken = await trx.selectFrom('meetingRooms').select('id').where('organizationId', '=', orgId).where('locationId', '=', input.locationId).executeTakeFirst();
    if (taken) throw errors.conflict('This place is already a meeting room.', { roomId: taken.id });
    const row = await trx.insertInto('meetingRooms').values({
      organizationId: orgId, branchId: place.branchId, locationId: input.locationId, name: input.name, capacity: input.capacity ?? null, restricted: input.restricted ?? false,
      allowedDepartmentIds: input.allowedDepartmentIds ?? [], allowedEmployeeIds: input.allowedEmployeeIds ?? [], createdBy: actor.userId,
    }).returning(ROOM_COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'meeting_room.created', 'meeting_room', { entityId: row.id, branchId: row.branchId, newValue: input });
    return (await roomDtos(trx, orgId, [row as RoomRow]))[0]!;
  });
}

export async function updateRoom(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: MeetingRoomUpdateInput): Promise<MeetingRoomDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.rooms');
  return runUser(deps.db, actor, async (trx) => {
    const before = (await trx.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as RoomRow | undefined;
    if (!before) throw errors.notFound('Meeting room', id);
    requireBranchAccess(grant, before.branchId);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('meetingRooms').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = (await trx.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow()) as RoomRow;
    await audit(trx, actor, orgId, 'meeting_room.updated', 'meeting_room', { entityId: id, branchId: after.branchId, ...diffObjects(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    return (await roomDtos(trx, orgId, [after]))[0]!;
  });
}

// ----- meetings ------------------------------------------------------------------------------------------------------------------

/** Room entries around the meetings (system scope: attendance is served for meetings the caller can see, never the raw log). */
async function entriesFor(trx: Trx, orgId: string, meetings: readonly MeetingRow[]): Promise<Map<string, Array<{ employeeId: string | null; deviceEmployeeId: string; occurredAt: string }>>> {
  const out = new Map<string, Array<{ employeeId: string | null; deviceEmployeeId: string; occurredAt: string }>>();
  if (meetings.length === 0) return out;
  const from = new Date(Math.min(...meetings.map((m) => m.startsAt.getTime())) - 15 * 60_000);
  const to = new Date(Math.max(...meetings.map((m) => m.endsAt.getTime())));
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('accessEvents').select(['roomId', 'employeeId', 'deviceEmployeeId', 'occurredAt'])
    .where('organizationId', '=', orgId).where('roomId', 'in', [...new Set(meetings.map((m) => m.roomId))]).where('occurredAt', '>=', from).where('occurredAt', '<=', to).orderBy('occurredAt').execute());
  for (const m of meetings) {
    out.set(m.id, rows.filter((r) => r.roomId === m.roomId && r.occurredAt >= new Date(m.startsAt.getTime() - 15 * 60_000) && r.occurredAt <= m.endsAt)
      .map((r) => ({ employeeId: r.employeeId, deviceEmployeeId: r.deviceEmployeeId, occurredAt: iso(r.occurredAt) })));
  }
  return out;
}

async function meetingDetails(trx: Trx, orgId: string, rows: readonly MeetingRow[], withPeople: boolean): Promise<MeetingDetailDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const ids = rows.map((m) => m.id);
    const [rooms, invitees, entries] = await Promise.all([
      t.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((m) => m.roomId))]).execute() as Promise<RoomRow[]>,
      t.selectFrom('meetingInvitees').select(['meetingId', 'employeeId', 'isRequired']).where('organizationId', '=', orgId).where('meetingId', 'in', ids).execute(),
      entriesFor(t, orgId, rows),
    ]);
    const readerRooms = new Set((await t.selectFrom('devices').select('locationId').where('organizationId', '=', orgId).where('punchRole', '=', 'ACCESS').where('status', '!=', 'decommissioned')
      .where('locationId', 'in', rooms.map((r) => r.locationId)).execute()).map((d) => d.locationId));
    const people = [...new Set([...invitees.map((i) => i.employeeId), ...rows.map((m) => m.organizerEmployeeId).filter((x): x is string => !!x), ...[...entries.values()].flat().map((e) => e.employeeId).filter((x): x is string => !!x)])];
    const emps = people.length ? await t.selectFrom('employees as e').leftJoin('departments as d', 'd.id', 'e.departmentId').select(['e.id', 'e.displayName', 'e.employeeNumber', 'e.departmentId', 'd.name as departmentName']).where('e.organizationId', '=', orgId).where('e.id', 'in', people).execute() : [];
    const empOf = new Map(emps.map((e) => [e.id, e]));
    const roomOf = new Map(rooms.map((r) => [r.id, r]));
    const now = new Date().toISOString();
    return rows.map((m): MeetingDetailDto => {
      const room = roomOf.get(m.roomId);
      const result = meetingAttendance({
        meeting: { startsAt: iso(m.startsAt), endsAt: iso(m.endsAt), lateAfterMinutes: m.lateAfterMinutes },
        invitees: invitees.filter((i) => i.meetingId === m.id).map((i) => ({ employeeId: i.employeeId, required: i.isRequired })),
        entries: entries.get(m.id) ?? [], room: room ? ruleOf(room) : { restricted: false, allowedDepartmentIds: [], allowedEmployeeIds: [] },
        departmentOf: new Map(emps.map((e) => [e.id, e.departmentId])), now,
      });
      const attendees: MeetingAttendeeDto[] = result.attendees.map((a) => { const e = empOf.get(a.employeeId); return { employeeId: a.employeeId, employeeName: e?.displayName ?? '—', employeeNumber: e?.employeeNumber ?? null, departmentName: e?.departmentName ?? null, required: a.required, status: a.status, enteredAt: a.enteredAt, lateMinutes: a.lateMinutes, entries: a.entries }; })
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
      return {
        id: m.id, branchId: m.branchId, roomId: m.roomId, roomName: room?.name ?? '—', title: m.title, description: m.description, startsAt: iso(m.startsAt), endsAt: iso(m.endsAt), lateAfterMinutes: m.lateAfterMinutes,
        organizerEmployeeId: m.organizerEmployeeId, organizerName: m.organizerEmployeeId ? empOf.get(m.organizerEmployeeId)?.displayName ?? null : null, status: m.status, phase: result.phase,
        invitedCount: result.counts.invited, attendedCount: result.counts.attended, lateCount: result.counts.late, absentCount: result.counts.absent, walkInCount: result.counts.walkIns,
        attendees: withPeople ? attendees : [],
        walkIns: withPeople ? result.walkIns.map((w) => ({ employeeId: w.employeeId, employeeName: w.employeeId ? empOf.get(w.employeeId)?.displayName ?? null : null, deviceEmployeeId: w.deviceEmployeeId, enteredAt: w.enteredAt, unauthorized: w.unauthorized })) : [],
        noReader: room ? !readerRooms.has(room.locationId) : true,
      };
    });
  });
}

export async function listMeetings(deps: ApiDeps, actor: Actor, orgId: string, q: MeetingsQuery): Promise<MeetingDto[]> {
  requirePermission(actor.principal, orgId, 'meeting.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId)
      .where('startsAt', '>=', DateTime.fromISO(q.from).minus({ hours: 14 }).toJSDate()).where('startsAt', '<', DateTime.fromISO(q.to).plus({ days: 1, hours: 14 }).toJSDate());
    if (q.roomId) base = base.where('roomId', '=', q.roomId);
    if (q.branchId) base = base.where('branchId', '=', q.branchId);
    if (!q.includeCancelled) base = base.where('status', '=', 'scheduled');
    const rows = (await base.orderBy('startsAt').orderBy('id').limit(500).execute()) as MeetingRow[];
    return (await meetingDetails(trx, orgId, rows, false)).map(({ attendees: _a, walkIns: _w, noReader: _n, ...m }) => m);
  });
}

export async function getMeeting(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MeetingDetailDto> {
  requirePermission(actor.principal, orgId, 'meeting.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as MeetingRow | undefined;
    if (!row) throw errors.notFound('Meeting', id);
    return (await meetingDetails(trx, orgId, [row], true))[0]!;
  });
}

export async function createMeeting(deps: ApiDeps, actor: Actor, orgId: string, input: MeetingInput): Promise<MeetingDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.manage');
  return runUser(deps.db, actor, async (trx) => {
    const room = (await trx.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).where('id', '=', input.roomId).executeTakeFirst()) as RoomRow | undefined;
    if (!room || room.status !== 'active') throw errors.validation('Meeting room not found.', { issues: [{ path: 'roomId', message: 'Unknown room' }] });
    requireBranchAccess(grant, room.branchId);
    const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
    if (endsAt.getTime() - startsAt.getTime() > 12 * 3_600_000) throw errors.validation('A meeting is at most 12 hours.', { issues: [{ path: 'endsAt', message: 'Too long' }] });
    const people = [...new Set(input.invitees.map((i) => i.employeeId))];
    if (room.capacity !== null && people.length > room.capacity) throw errors.validation(`The room holds ${room.capacity} people; ${people.length} are invited.`, { issues: [{ path: 'invitees', message: 'Over capacity' }] });
    const known = await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', 'in', people).where('deletedAt', 'is', null).execute());
    if (known.length !== people.length) throw errors.validation('An invitee is not an employee of this organisation.', { issues: [{ path: 'invitees', message: 'Unknown employee' }] });
    const clash = await trx.selectFrom('meetings').select(['id', 'title']).where('organizationId', '=', orgId).where('roomId', '=', room.id).where('status', '=', 'scheduled').where('startsAt', '<', endsAt).where('endsAt', '>', startsAt).executeTakeFirst();
    if (clash) throw errors.conflict(`The room is booked for "${clash.title}" at that time.`, { meetingId: clash.id });
    const row = await trx.insertInto('meetings').values({
      organizationId: orgId, branchId: room.branchId, roomId: room.id, title: input.title, description: input.description ?? null, startsAt, endsAt, lateAfterMinutes: input.lateAfterMinutes ?? 5,
      organizerEmployeeId: input.organizerEmployeeId ?? requireMembership(actor.principal, orgId).employeeId ?? null, createdBy: actor.userId,
    }).returning(MEETING_COLUMNS).executeTakeFirstOrThrow();
    const required = new Map(input.invitees.map((i) => [i.employeeId, i.required ?? true]));
    await trx.insertInto('meetingInvitees').values(people.map((employeeId) => ({ organizationId: orgId, meetingId: row.id, employeeId, isRequired: required.get(employeeId) ?? true }))).execute();
    await audit(trx, actor, orgId, 'meeting.created', 'meeting', { entityId: row.id, branchId: room.branchId, newValue: { title: input.title, roomId: room.id, startsAt: input.startsAt, endsAt: input.endsAt, invitees: people.length } });
    return (await meetingDetails(trx, orgId, [row as MeetingRow], true))[0]!;
  });
}

export async function cancelMeeting(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MeetingDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as MeetingRow | undefined;
    if (!row) throw errors.notFound('Meeting', id);
    requireBranchAccess(grant, row.branchId);
    if (row.status === 'cancelled') throw errors.invalidState('The meeting is already cancelled.');
    await trx.updateTable('meetings').set({ status: 'cancelled', cancelledBy: actor.userId, cancelledAt: new Date() }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'meeting.cancelled', 'meeting', { entityId: id, branchId: row.branchId });
    return (await meetingDetails(trx, orgId, [{ ...row, status: 'cancelled' }], true))[0]!;
  });
}

// ----- access log ----------------------------------------------------------------------------------------------------------------

export async function listAccessEvents(deps: ApiDeps, actor: Actor, orgId: string, q: AccessLogQuery): Promise<{ data: AccessEventDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'meeting.rooms');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('accessEvents as a').leftJoin('employees as e', 'e.id', 'a.employeeId').leftJoin('devices as d', 'd.id', 'a.deviceId').leftJoin('meetingRooms as r', 'r.id', 'a.roomId')
      .where('a.organizationId', '=', orgId).where('a.occurredAt', '>=', DateTime.fromISO(q.from).minus({ hours: 14 }).toJSDate()).where('a.occurredAt', '<', DateTime.fromISO(q.to).plus({ days: 1, hours: 14 }).toJSDate());
    if (q.roomId) base = base.where('a.roomId', '=', q.roomId);
    if (q.employeeId) base = base.where('a.employeeId', '=', q.employeeId);
    const rows = await base.select(['a.id', 'a.occurredAt', 'a.roomId', 'r.name as roomName', 'r.restricted', 'r.allowedDepartmentIds', 'r.allowedEmployeeIds', 'a.deviceId', 'd.name as deviceName', 'a.employeeId', 'e.displayName as employeeName', 'e.departmentId', 'a.deviceEmployeeId'])
      .orderBy('a.occurredAt', 'desc').orderBy('a.id').limit(2000).execute();
    // the meeting in progress in each room at each entry, and its invitees (an invitee may always enter)
    const roomIds = [...new Set(rows.map((r) => r.roomId).filter((x): x is string => !!x))];
    const meetings = roomIds.length ? (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('status', '=', 'scheduled').where('roomId', 'in', roomIds)
      .where('endsAt', '>=', DateTime.fromISO(q.from).minus({ days: 1 }).toJSDate()).where('startsAt', '<=', DateTime.fromISO(q.to).plus({ days: 2 }).toJSDate()).execute()) as MeetingRow[] : [];
    const invitees = meetings.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('meetingInvitees').select(['meetingId', 'employeeId']).where('organizationId', '=', orgId).where('meetingId', 'in', meetings.map((m) => m.id)).execute()) : [];
    const all = rows.map((r): AccessEventDto => {
      const m = meetings.find((x) => x.roomId === r.roomId && r.occurredAt.getTime() >= x.startsAt.getTime() - 15 * 60_000 && r.occurredAt <= x.endsAt) ?? null;
      const invited = !!m && !!r.employeeId && invitees.some((i) => i.meetingId === m.id && i.employeeId === r.employeeId);
      const rule = { restricted: r.restricted ?? false, allowedDepartmentIds: r.allowedDepartmentIds ?? [], allowedEmployeeIds: r.allowedEmployeeIds ?? [] };
      return {
        id: r.id, occurredAt: isoDateTime(r.occurredAt), roomId: r.roomId, roomName: r.roomName ?? null, deviceId: r.deviceId, deviceName: r.deviceName ?? null, employeeId: r.employeeId, employeeName: r.employeeName ?? null,
        deviceEmployeeId: r.deviceEmployeeId, unauthorized: !accessAllowed(rule, { employeeId: r.employeeId, departmentId: r.departmentId ?? null }, invited), meetingId: m?.id ?? null, meetingTitle: m?.title ?? null,
      };
    });
    const filtered = q.unauthorizedOnly ? all.filter((a) => a.unauthorized) : all;
    return { data: filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total: filtered.length };
  });
}

// ----- my meetings ---------------------------------------------------------------------------------------------------------------

export async function listMyMeetings(deps: ApiDeps, actor: Actor, orgId: string, q: { from: string; to: string }): Promise<MyMeetingDto[]> {
  const self = portalSelf(actor, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const rows = await withSystemScope(trx, orgId, async (t) => {
      const mine = await t.selectFrom('meetingInvitees').select('meetingId').where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId).execute();
      if (mine.length === 0) return [] as MeetingRow[];
      return (await t.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', mine.map((m) => m.meetingId))
        .where('startsAt', '>=', DateTime.fromISO(q.from).minus({ hours: 14 }).toJSDate()).where('startsAt', '<', DateTime.fromISO(q.to).plus({ days: 1, hours: 14 }).toJSDate()).orderBy('startsAt').limit(200).execute()) as MeetingRow[];
    });
    const details = await meetingDetails(trx, orgId, rows, true);
    return details.map((m): MyMeetingDto => {
      const me = m.attendees.find((a) => a.employeeId === self.employeeId);
      return { id: m.id, title: m.title, roomName: m.roomName, startsAt: m.startsAt, endsAt: m.endsAt, status: m.status, phase: meetingPhase(m, new Date().toISOString()), myStatus: me?.status ?? 'UPCOMING', enteredAt: me?.enteredAt ?? null, lateMinutes: me?.lateMinutes ?? 0 };
    });
  });
}

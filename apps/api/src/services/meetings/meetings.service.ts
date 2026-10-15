import { DateTime } from 'luxon';
import { sql } from 'kysely';
import {
  MEETING_BACKDATE_GRACE_MINUTES,
  type AccessEventDto, type AccessLogQuery, type MeetingAttendeeDto, type MeetingDetailDto, type MeetingDto, type MeetingInput, type MeetingRoomDto, type MeetingRoomInput, type MeetingRoomUpdateInput, type MeetingsQuery, type MyMeetingDto,
} from '@flowza/contracts';
import { locationLabels, type Trx } from '@flowza/database';
import { ARRIVAL_WINDOW_MINUTES, accessAllowed, entryMeeting, meetingAttendance, meetingPhase, type RoomAccessRule, type RoomMeetingSpec } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
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
 *     Who WALKED IN is a slice of the room access log: its identities go to meeting.rooms holders only (others read the count),
 *     and a booking may start in the past (beyond a short grace) only for them — else a backdated meeting would read the log.
 *   - The access log (meeting.rooms): every entry with the meeting it belongs to and whether it was authorised; the dates are the
 *     entries' local dates (branch zone), paged and filtered ("unauthorised only") in the database.
 *   - Times: every room / meeting carries its branch's IANA zone (read in system scope: a meeting.view holder may lack branch.view).
 *   - "My meetings": the caller's own invitations and their own attendance (read in the organisation's system scope for the
 *     caller's own employee id only — an employee holds no meeting key).
 * Access events are written by the worker's normaliser only; nothing here writes them.
 */

type RoomRow = { id: string; branchId: string; locationId: string; name: string; capacity: number | null; restricted: boolean; allowedDepartmentIds: string[]; allowedEmployeeIds: string[]; status: string };
type MeetingRow = { id: string; branchId: string; roomId: string; title: string; description: string | null; startsAt: Date; endsAt: Date; lateAfterMinutes: number; organizerEmployeeId: string | null; status: 'scheduled' | 'cancelled'; cancelledAt: Date | null };
const ROOM_COLUMNS = ['id', 'branchId', 'locationId', 'name', 'capacity', 'restricted', 'allowedDepartmentIds', 'allowedEmployeeIds', 'status'] as const;
const MEETING_COLUMNS = ['id', 'branchId', 'roomId', 'title', 'description', 'startsAt', 'endsAt', 'lateAfterMinutes', 'organizerEmployeeId', 'status', 'cancelledAt'] as const;
const WINDOW_MS = ARRIVAL_WINDOW_MINUTES * 60_000;

const ruleOf = (r: Pick<RoomRow, 'restricted' | 'allowedDepartmentIds' | 'allowedEmployeeIds'>): RoomAccessRule => ({ restricted: r.restricted, allowedDepartmentIds: r.allowedDepartmentIds ?? [], allowedEmployeeIds: r.allowedEmployeeIds ?? [] });
const iso = (d: Date) => d.toISOString();
/** A meeting row + its invitee ids → what the access verdicts need (domain entryMeeting / meetingAttendance's other meetings). */
const specOf = (m: MeetingRow, inviteeIds: readonly string[]): RoomMeetingSpec => ({
  id: m.id, startsAt: iso(m.startsAt), endsAt: iso(m.endsAt), organizerEmployeeId: m.organizerEmployeeId, inviteeIds, status: m.status, cancelledAt: m.cancelledAt ? iso(m.cancelledAt) : null,
});
function groupIds<T>(rows: readonly T[], key: (r: T) => string, value: (r: T) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) { const k = key(r); const list = out.get(k); if (list) list.push(value(r)); else out.set(k, [value(r)]); }
  return out;
}

/**
 * Name and IANA zone of branches, in the organisation's system scope: a room's local time is needed by every meeting.view holder,
 * and meeting.view does not imply branch.view (a custom booking role: under RLS the branch row would be hidden). Names and zones only.
 */
async function branchInfo(trx: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, { name: string; timezone: string }>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select(['id', 'name', 'timezone']).where('organizationId', '=', orgId).where('id', 'in', wanted).execute());
  return new Map(rows.map((b) => [b.id, { name: b.name, timezone: b.timezone }]));
}

// ----- rooms ---------------------------------------------------------------------------------------------------------------------

async function roomDtos(trx: Trx, orgId: string, rows: readonly RoomRow[]): Promise<MeetingRoomDto[]> {
  if (rows.length === 0) return [];
  // (sequential: withSystemScope switches the transaction's role, so nothing may run beside it)
  const labels = await locationLabels(trx, orgId, rows.map((r) => r.locationId));
  const branches = await branchInfo(trx, orgId, rows.map((r) => r.branchId));
  // the readers in system scope as well: a meeting.view holder without device.view (the Auditor, a custom role) must still see which
  // terminals a room has — id, code, name and connection only
  const readers = await withSystemScope(trx, orgId, (t) => t.selectFrom('devices').select(['id', 'code', 'name', 'connectionStatus', 'locationId']).where('organizationId', '=', orgId).where('punchRole', '=', 'ACCESS')
    .where('status', '!=', 'decommissioned').where('locationId', 'in', rows.map((r) => r.locationId)).orderBy('code').execute());
  const zoneOf = (r: RoomRow) => branches.get(r.branchId)?.timezone ?? 'UTC';
  // "today" is each room's branch calendar day [00:00, +1 day) in its zone (Luxon), one count per zone
  const todayOf = new Map<string, number>();
  for (const [zone, roomIds] of groupIds(rows, zoneOf, (r) => r.id)) {
    const dayStart = DateTime.now().setZone(zone).startOf('day');
    const counts = await trx.selectFrom('meetings').select(['roomId', (eb) => eb.fn.countAll<string>().as('n')]).where('organizationId', '=', orgId).where('status', '=', 'scheduled')
      .where('roomId', 'in', roomIds).where('startsAt', '>=', dayStart.toJSDate()).where('startsAt', '<', dayStart.plus({ days: 1 }).toJSDate()).groupBy('roomId').execute();
    for (const c of counts) todayOf.set(c.roomId, Number(c.n));
  }
  return rows.map((r) => ({
    id: r.id, branchId: r.branchId, branchName: branches.get(r.branchId)?.name ?? null, timezone: zoneOf(r), locationId: r.locationId, locationName: labels.get(r.locationId) ?? null, name: r.name, capacity: r.capacity,
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

/**
 * Attendance of meetings. `people`: the attendee rows; `walkIns`: who walked in (a slice of the room access log — meeting.rooms
 * holders only; anyone else reads `walkInCount`). The room's neighbouring meetings are read too: a person expected at an adjacent
 * booking whose arrival window holds the entry is not a walk-in of this one, and the organiser is expected like an invitee.
 */
async function meetingDetails(trx: Trx, orgId: string, rows: readonly MeetingRow[], opts: { people: boolean; walkIns: boolean }): Promise<MeetingDetailDto[]> {
  if (rows.length === 0) return [];
  const branches = await branchInfo(trx, orgId, rows.map((m) => m.branchId));
  return withSystemScope(trx, orgId, async (t) => {
    const roomIds = [...new Set(rows.map((m) => m.roomId))];
    const from = new Date(Math.min(...rows.map((m) => m.startsAt.getTime())) - WINDOW_MS);
    const to = new Date(Math.max(...rows.map((m) => m.endsAt.getTime())) + WINDOW_MS);
    const [rooms, neighbours, entries] = await Promise.all([
      t.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', roomIds).execute() as Promise<RoomRow[]>,
      // every meeting of those rooms whose arrival window can overlap one of these (scheduled or cancelled: a cancellation after an entry keeps it covered)
      t.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('roomId', 'in', roomIds).where('startsAt', '<=', to).where('endsAt', '>=', from).execute() as Promise<MeetingRow[]>,
      entriesFor(t, orgId, rows),
    ]);
    const ids = [...new Set([...rows.map((m) => m.id), ...neighbours.map((m) => m.id)])];
    const invitees = await t.selectFrom('meetingInvitees').select(['meetingId', 'employeeId', 'isRequired']).where('organizationId', '=', orgId).where('meetingId', 'in', ids).execute();
    const inviteeIdsOf = groupIds(invitees, (i) => i.meetingId, (i) => i.employeeId);
    const neighbourSpecs = neighbours.map((n) => ({ row: n, spec: specOf(n, inviteeIdsOf.get(n.id) ?? []) }));
    // the room's other meetings whose arrival window overlaps this one's
    const othersOf = (m: MeetingRow) => neighbourSpecs.filter(({ row: n }) => n.id !== m.id && n.roomId === m.roomId && n.startsAt.getTime() - WINDOW_MS <= m.endsAt.getTime() && n.endsAt.getTime() >= m.startsAt.getTime() - WINDOW_MS).map((n) => n.spec);
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
        departmentOf: new Map(emps.map((e) => [e.id, e.departmentId])), now, organizerEmployeeId: m.organizerEmployeeId,
        otherMeetings: othersOf(m),
      });
      const attendees: MeetingAttendeeDto[] = result.attendees.map((a) => { const e = empOf.get(a.employeeId); return { employeeId: a.employeeId, employeeName: e?.displayName ?? '—', employeeNumber: e?.employeeNumber ?? null, departmentName: e?.departmentName ?? null, required: a.required, status: a.status, enteredAt: a.enteredAt, lateMinutes: a.lateMinutes, entries: a.entries }; })
        .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
      return {
        id: m.id, branchId: m.branchId, timezone: branches.get(m.branchId)?.timezone ?? 'UTC', roomId: m.roomId, roomName: room?.name ?? '—', title: m.title, description: m.description, startsAt: iso(m.startsAt), endsAt: iso(m.endsAt), lateAfterMinutes: m.lateAfterMinutes,
        organizerEmployeeId: m.organizerEmployeeId, organizerName: m.organizerEmployeeId ? empOf.get(m.organizerEmployeeId)?.displayName ?? null : null, status: m.status, phase: result.phase,
        invitedCount: result.counts.invited, attendedCount: result.counts.attended, lateCount: result.counts.late, absentCount: result.counts.absent, walkInCount: result.counts.walkIns,
        attendees: opts.people ? attendees : [],
        walkIns: opts.people && opts.walkIns ? result.walkIns.map((w) => ({ employeeId: w.employeeId, employeeName: w.employeeId ? empOf.get(w.employeeId)?.displayName ?? null : null, deviceEmployeeId: w.deviceEmployeeId, enteredAt: w.enteredAt, unauthorized: w.unauthorized })) : [],
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
    return (await meetingDetails(trx, orgId, rows, { people: false, walkIns: false })).map(({ attendees: _a, walkIns: _w, noReader: _n, ...m }) => m);
  });
}

export async function getMeeting(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MeetingDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as MeetingRow | undefined;
    if (!row) throw errors.notFound('Meeting', id);
    return (await meetingDetails(trx, orgId, [row], { people: true, walkIns: hasPermission(grant, 'meeting.rooms') }))[0]!;
  });
}

export async function createMeeting(deps: ApiDeps, actor: Actor, orgId: string, input: MeetingInput): Promise<MeetingDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.manage');
  return runUser(deps.db, actor, async (trx) => {
    const room = (await trx.selectFrom('meetingRooms').select(ROOM_COLUMNS).where('organizationId', '=', orgId).where('id', '=', input.roomId).executeTakeFirst()) as RoomRow | undefined;
    if (!room || room.status !== 'active') throw errors.validation('Meeting room not found.', { issues: [{ path: 'roomId', message: 'Unknown room' }] });
    requireBranchAccess(grant, room.branchId);
    const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
    // a booking after the fact would read who entered the room then (walk-ins, attendance): the room administrators only
    const roomsAdmin = hasPermission(grant, 'meeting.rooms');
    if (!roomsAdmin && startsAt.getTime() < Date.now() - MEETING_BACKDATE_GRACE_MINUTES * 60_000) throw errors.validation('A meeting cannot start in the past.', { issues: [{ path: 'startsAt', message: 'In the past' }] });
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
    return (await meetingDetails(trx, orgId, [row as MeetingRow], { people: true, walkIns: roomsAdmin }))[0]!;
  });
}

export async function cancelMeeting(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MeetingDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'meeting.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as MeetingRow | undefined;
    if (!row) throw errors.notFound('Meeting', id);
    requireBranchAccess(grant, row.branchId);
    if (row.status === 'cancelled') throw errors.invalidState('The meeting is already cancelled.');
    const cancelledAt = new Date();
    await trx.updateTable('meetings').set({ status: 'cancelled', cancelledBy: actor.userId, cancelledAt }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'meeting.cancelled', 'meeting', { entityId: id, branchId: row.branchId });
    return (await meetingDetails(trx, orgId, [{ ...row, status: 'cancelled', cancelledAt }], { people: true, walkIns: hasPermission(grant, 'meeting.rooms') }))[0]!;
  });
}

// ----- access log ----------------------------------------------------------------------------------------------------------------

/**
 * The verdict "unauthorised" in SQL (the "unauthorised only" filter pages in the database) — the rule of the domain's accessAllowed
 * + entryMeeting, evaluated per row: a restricted room, and an unknown card, or a person neither on the allowed lists nor expected
 * (invitee / organiser) at a meeting of the room covering the entry — its arrival window, and standing then (scheduled, or cancelled
 * only after the entry). Aliases: a = access_events, r = meeting_rooms, e = employees.
 */
const UNAUTHORIZED_ENTRY = sql<boolean>`(r.restricted and (a.employee_id is null or (
  not (a.employee_id = any (r.allowed_employee_ids))
  and (e.department_id is null or not (e.department_id = any (r.allowed_department_ids)))
  and not exists (
    select 1 from public.meetings m
    where m.organization_id = a.organization_id and m.room_id = a.room_id
      and (m.status = 'scheduled' or m.cancelled_at > a.occurred_at)
      and a.occurred_at >= m.starts_at - ${sql.raw(`interval '${ARRIVAL_WINDOW_MINUTES} minutes'`)} and a.occurred_at <= m.ends_at
      and (m.organizer_employee_id = a.employee_id
        or exists (select 1 from public.meeting_invitees i where i.organization_id = m.organization_id and i.meeting_id = m.id and i.employee_id = a.employee_id))))))`;

export async function listAccessEvents(deps: ApiDeps, actor: Actor, orgId: string, q: AccessLogQuery): Promise<{ data: AccessEventDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'meeting.rooms');
  return runUser(deps.db, actor, async (trx) => {
    // `from` / `to` are the entries' LOCAL dates in their branch's zone: one exact UTC range per zone (Luxon), so the bounds stay
    // index-friendly and nothing from the neighbouring days leaks in (branch ids and zones read in system scope)
    const zones = groupIds(await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select(['id', 'timezone']).where('organizationId', '=', orgId).execute()), (b) => b.timezone, (b) => b.id);
    if (zones.size === 0) return { data: [], total: 0 };
    let base = trx.selectFrom('accessEvents as a').leftJoin('employees as e', 'e.id', 'a.employeeId').leftJoin('meetingRooms as r', 'r.id', 'a.roomId')
      .where('a.organizationId', '=', orgId)
      .where((eb) => eb.or([...zones].map(([zone, branchIds]) => eb.and([
        eb('a.branchId', 'in', branchIds),
        eb('a.occurredAt', '>=', DateTime.fromISO(q.from, { zone }).startOf('day').toJSDate()),
        eb('a.occurredAt', '<', DateTime.fromISO(q.to, { zone }).startOf('day').plus({ days: 1 }).toJSDate()),
      ]))));
    if (q.roomId) base = base.where('a.roomId', '=', q.roomId);
    if (q.employeeId) base = base.where('a.employeeId', '=', q.employeeId);
    if (q.unauthorizedOnly) base = base.where(UNAUTHORIZED_ENTRY);
    const counted = await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst();
    const rows = await base.leftJoin('devices as d', 'd.id', 'a.deviceId')
      .select(['a.id', 'a.occurredAt', 'a.roomId', 'r.name as roomName', 'r.restricted', 'r.allowedDepartmentIds', 'r.allowedEmployeeIds', 'a.deviceId', 'd.name as deviceName', 'a.employeeId', 'e.displayName as employeeName', 'e.departmentId', 'a.deviceEmployeeId'])
      .orderBy('a.occurredAt', 'desc').orderBy('a.id').offset((q.page - 1) * q.pageSize).limit(q.pageSize).execute();
    // the page's verdicts: the meetings of each room around its entries and who is expected at them (an invitee / the organiser may always enter)
    const roomIds = [...new Set(rows.map((r) => r.roomId).filter((x): x is string => !!x))];
    const times = rows.map((r) => r.occurredAt.getTime());
    const meetings = roomIds.length ? (await trx.selectFrom('meetings').select(MEETING_COLUMNS).where('organizationId', '=', orgId).where('roomId', 'in', roomIds)
      .where('startsAt', '<=', new Date(Math.max(...times) + WINDOW_MS)).where('endsAt', '>=', new Date(Math.min(...times)))
      .where((eb) => eb.or([eb('status', '=', 'scheduled'), eb('cancelledAt', '>', new Date(Math.min(...times)))])).orderBy('startsAt').orderBy('id').execute()) as MeetingRow[] : [];
    const invitees = meetings.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('meetingInvitees').select(['meetingId', 'employeeId']).where('organizationId', '=', orgId).where('meetingId', 'in', meetings.map((m) => m.id)).execute()) : [];
    const inviteeIdsOf = groupIds(invitees, (i) => i.meetingId, (i) => i.employeeId);
    const specs = meetings.map((m) => ({ ...specOf(m, inviteeIdsOf.get(m.id) ?? []), roomId: m.roomId, title: m.title }));
    const data = rows.map((r): AccessEventDto => {
      const { meeting: m, invited } = r.roomId ? entryMeeting({ employeeId: r.employeeId, occurredAt: iso(r.occurredAt) }, specs.filter((x) => x.roomId === r.roomId)) : { meeting: null, invited: false };
      const rule = { restricted: r.restricted ?? false, allowedDepartmentIds: r.allowedDepartmentIds ?? [], allowedEmployeeIds: r.allowedEmployeeIds ?? [] };
      return {
        id: r.id, occurredAt: isoDateTime(r.occurredAt), roomId: r.roomId, roomName: r.roomName ?? null, deviceId: r.deviceId, deviceName: r.deviceName ?? null, employeeId: r.employeeId, employeeName: r.employeeName ?? null,
        deviceEmployeeId: r.deviceEmployeeId, unauthorized: !accessAllowed(rule, { employeeId: r.employeeId, departmentId: r.departmentId ?? null }, invited), meetingId: m?.id ?? null, meetingTitle: m?.title ?? null,
      };
    });
    return { data, total: Number(counted?.n ?? 0) };
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
    const details = await meetingDetails(trx, orgId, rows, { people: true, walkIns: false });
    return details.map((m): MyMeetingDto => {
      const me = m.attendees.find((a) => a.employeeId === self.employeeId);
      return { id: m.id, title: m.title, roomName: m.roomName, startsAt: m.startsAt, endsAt: m.endsAt, status: m.status, phase: meetingPhase(m, new Date().toISOString()), myStatus: me?.status ?? 'UPCOMING', enteredAt: me?.enteredAt ?? null, lateMinutes: me?.lateMinutes ?? 0 };
    });
  });
}

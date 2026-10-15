import { z } from 'zod';
import { booleanQuerySchema, isoDateSchema, isoDateTimeSchema, uuidSchema } from '../common.js';
import type { MeetingStatus } from '../enums.js';

/**
 * Meeting rooms & access (Enterprise module `meeting_rooms`, docs/time-away.md §4). A meeting room is a place of the location
 * tree whose readers are ACCESS terminals (`devices.punch_role`); their entries are `access_events`, never attendance. A
 * meeting books a room for a window with invitees; who attended (first entry from 15 minutes before the start to the end),
 * who came late (after the start + `lateAfterMinutes`), who never came, and who walked in uninvited is derived from the
 * room's entries. A restricted room admits its allowed departments / employees (and the invitees of a meeting in progress):
 * any other entry is reported as unauthorised.
 */

const idList = z.array(uuidSchema).max(2000);

export const meetingRoomInputSchema = z.object({
  locationId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  restricted: z.boolean().optional(),
  allowedDepartmentIds: z.array(uuidSchema).max(200).optional(),
  allowedEmployeeIds: idList.optional(),
});
export type MeetingRoomInput = z.infer<typeof meetingRoomInputSchema>;
/** PATCH: every field optional, no defaults (Zod 4: a partial of defaulted fields would re-apply them). */
export const meetingRoomUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  capacity: z.number().int().min(1).max(1000).nullable().optional(),
  restricted: z.boolean().optional(),
  allowedDepartmentIds: z.array(uuidSchema).max(200).optional(),
  allowedEmployeeIds: idList.optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type MeetingRoomUpdateInput = z.infer<typeof meetingRoomUpdateSchema>;

export interface MeetingRoomDto {
  id: string;
  branchId: string;
  branchName: string | null;
  /** The IANA zone of the room's branch (resolved by the API): a booking's wall-clock window is read in it. */
  timezone: string;
  locationId: string;
  /** The place's path below the branch, e.g. "HQ Tower › Floor 3 › Boardroom". */
  locationName: string | null;
  name: string;
  capacity: number | null;
  restricted: boolean;
  allowedDepartmentIds: string[];
  allowedEmployeeIds: string[];
  status: 'active' | 'inactive';
  /** The ACCESS terminals placed in the room. */
  readers: Array<{ id: string; code: string; name: string; connectionStatus: string }>;
  /** The room's scheduled meetings starting today (the branch's calendar day). */
  meetingsToday: number;
}

/** A booking may start at most this many minutes in the past (later: meeting.rooms only — a backdated meeting reveals the room's log). */
export const MEETING_BACKDATE_GRACE_MINUTES = 15;

export const meetingInputSchema = z.object({
  roomId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  lateAfterMinutes: z.number().int().min(0).max(120).optional(),
  organizerEmployeeId: uuidSchema.nullable().optional(),
  invitees: z.array(z.object({ employeeId: uuidSchema, required: z.boolean().optional() })).min(1).max(500),
}).refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), { path: ['endsAt'], message: 'Must be after the start' });
export type MeetingInput = z.infer<typeof meetingInputSchema>;

export const meetingsQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  roomId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  includeCancelled: booleanQuerySchema.default(false),
});
export type MeetingsQuery = z.infer<typeof meetingsQuerySchema>;

export const ATTENDEE_STATUSES = ['ON_TIME', 'LATE', 'ABSENT', 'UPCOMING'] as const;
export type AttendeeStatus = (typeof ATTENDEE_STATUSES)[number];

export interface MeetingAttendeeDto {
  employeeId: string;
  employeeName: string;
  employeeNumber: string | null;
  departmentName: string | null;
  required: boolean;
  status: AttendeeStatus;
  /** First entry into the room for this meeting (15 min before the start → the end). */
  enteredAt: string | null;
  lateMinutes: number;
  /** Every entry into the room during the meeting window. */
  entries: number;
}
export interface MeetingWalkInDto {
  employeeId: string | null;
  employeeName: string | null;
  deviceEmployeeId: string;
  enteredAt: string;
  /** The room is restricted and the person is neither allowed nor invited. */
  unauthorized: boolean;
}
export interface MeetingDto {
  id: string;
  branchId: string;
  /** The IANA zone of the room's branch: the meeting's local day and times. */
  timezone: string;
  roomId: string;
  roomName: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  lateAfterMinutes: number;
  organizerEmployeeId: string | null;
  organizerName: string | null;
  status: MeetingStatus;
  /** Upcoming / in progress / over (by the server clock). */
  phase: 'upcoming' | 'in_progress' | 'over';
  invitedCount: number;
  attendedCount: number;
  lateCount: number;
  absentCount: number;
  /** Uninvited people who entered during the meeting (their identities: `walkIns`, room administrators only). */
  walkInCount: number;
}
export interface MeetingDetailDto extends MeetingDto {
  attendees: MeetingAttendeeDto[];
  /**
   * Who walked in — a slice of the room access log, so only for meeting.rooms holders; anyone else gets [] and reads
   * `walkInCount` alone.
   */
  walkIns: MeetingWalkInDto[];
  /** The room has no ACCESS reader: attendance cannot be measured. */
  noReader: boolean;
}

/** `from` / `to`: the LOCAL dates of the entries (each in its branch's zone), inclusive; paged in the database. */
export const accessLogQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  roomId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
  unauthorizedOnly: booleanQuerySchema.default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AccessLogQuery = z.infer<typeof accessLogQuerySchema>;
export interface AccessEventDto {
  id: string;
  occurredAt: string;
  roomId: string | null;
  roomName: string | null;
  deviceId: string;
  deviceName: string | null;
  employeeId: string | null;
  employeeName: string | null;
  deviceEmployeeId: string;
  /** Restricted room and the person was neither allowed nor expected (invitee / organiser) at a meeting covering the entry. */
  unauthorized: boolean;
  /** The meeting the entry belongs to: the one the person is expected at, else the one in progress, else the upcoming one. */
  meetingId: string | null;
  meetingTitle: string | null;
}

/** GET /orgs/:orgId/me/meetings — the employee's own invitations around a date range, with their own attendance. */
export interface MyMeetingDto {
  id: string;
  title: string;
  roomName: string;
  startsAt: string;
  endsAt: string;
  status: MeetingStatus;
  phase: MeetingDto['phase'];
  myStatus: AttendeeStatus;
  enteredAt: string | null;
  lateMinutes: number;
}
export const myMeetingsQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });


import { z } from 'zod';
import type { AttendanceDailyRecordDto } from '../attendance.js';
import type { AttendanceFlag, AttendanceStatus } from '../enums.js';
import { isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import type { TeamLeaveDto } from './leave.js';

/**
 * The line manager's team workspace (HR portal Prompt 5, Finance B-61 … B-66): today's picture of every direct report
 * (primary or secondary), their daily records and leave, and the two counts behind the manager badge. Every endpoint is
 * scoped to the caller's direct reports (`app.team_employee_ids()`) AND the team key the RLS predicate requires
 * (attendance.view_team / leave.view_team) or the organisation-wide key (attendance.view / leave.view, branch scope applies).
 */

/** How a report's day reads on the team board (derived from the engine's daily record, leave and today's punches). */
export const TEAM_DAY_STATUSES = ['present', 'late', 'absent', 'on_leave', 'missing_punch', 'weekly_off', 'holiday', 'not_in_yet', 'not_scheduled'] as const;
export type TeamDayStatus = (typeof TEAM_DAY_STATUSES)[number];

/** In / out from today's normalised punches (IN = the last punch opened a work segment). */
export const LIVE_PUNCH_STATES = ['IN', 'OUT', 'NONE'] as const;
export type LivePunchState = (typeof LIVE_PUNCH_STATES)[number];

/** Primary (`manager_employee_id`) or secondary (`secondary_manager_employee_id`) line manager of the report. */
export const TEAM_RELATIONS = ['primary', 'secondary'] as const;
export type TeamRelation = (typeof TEAM_RELATIONS)[number];

const MAX_RANGE_DAYS = 62;
const rangeOk = (v: { from: string; to: string }) => Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) <= (MAX_RANGE_DAYS - 1) * 86_400_000;

// ----- today ------------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/team/summary?date — absent date = the organisation's today. */
export const teamSummaryQuerySchema = z.object({ date: isoDateSchema.optional() });
export type TeamSummaryQuery = z.infer<typeof teamSummaryQuerySchema>;

export interface TeamMemberLeaveDto { leaveTypeName: string; leaveTypeCode: string; color: string | null; isHalfDay: boolean; halfDayPart: string | null; status: 'APPROVED' }

export interface TeamMemberTodayDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  designationName: string | null;
  departmentName: string | null;
  branchId: string;
  branchName: string | null;
  relation: TeamRelation;
  /** The report's day (branch zone, else the organisation's). */
  date: string;
  timezone: string;
  status: TeamDayStatus;
  /** The engine's status of the day (null before the day was computed). */
  recordStatus: AttendanceStatus | null;
  recordId: string | null;
  flags: AttendanceFlag[];
  firstInAt: string | null;
  lastOutAt: string | null;
  liveState: LivePunchState;
  lastPunchAt: string | null;
  /** Worked minutes so far: a live estimate from today's punches while checked in, else the engine's figure. */
  workedMinutes: number;
  workedIsLive: boolean;
  lateMinutes: number;
  /** Approved leave covering the day (full or half day). */
  leave: TeamMemberLeaveDto | null;
  /** Items of this report waiting for the caller: approval requests on the caller's level + reasons the caller may review. */
  pendingItems: number;
}

export interface TeamTotalsDto {
  reports: number;
  /** Present includes the late arrivals (late is a subset). */
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  missingPunch: number;
  weeklyOff: number;
  holiday: number;
  notInYet: number;
  /** Reports checked in right now. */
  inNow: number;
  pendingItems: number;
}

export interface TeamSummaryDto { date: string; generatedAt: string; members: TeamMemberTodayDto[]; totals: TeamTotalsDto }

// ----- attendance ---------------------------------------------------------------------------------------------------------------

/**
 * GET /orgs/:orgId/team/attendance — the daily records of the caller's direct reports over [from, to] (at most 62 days),
 * paginated by REPORT so a report's range is never split across pages (a month grid needs every day of a row).
 */
export const teamAttendanceQuerySchema = paginationQuerySchema.extend({
  from: isoDateSchema,
  to: isoDateSchema,
  employeeId: uuidSchema.optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] })
  .refine(rangeOk, { message: `At most ${MAX_RANGE_DAYS} days`, path: ['to'] });
export type TeamAttendanceQuery = z.infer<typeof teamAttendanceQuerySchema>;

export interface TeamAttendanceRowDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string;
  departmentId: string | null;
  relation: TeamRelation;
  /** Every computed day of the report in [from, to], oldest first. */
  records: AttendanceDailyRecordDto[];
}

// ----- leave ------------------------------------------------------------------------------------------------------------------

/** GET /orgs/:orgId/team/leave — approved, pending and info-requested leave of the direct reports overlapping [from, to]. */
export const teamLeaveQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema })
  .refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] })
  .refine(rangeOk, { message: `At most ${MAX_RANGE_DAYS} days`, path: ['to'] });
export type TeamLeaveQuery = z.infer<typeof teamLeaveQuerySchema>;

export interface TeamLeaveOverviewDto {
  from: string;
  to: string;
  today: string;
  /** Every leave overlapping [from, to] (the month calendar). */
  entries: TeamLeaveDto[];
  /** Leave ending today or later, soonest first, at most 20 (Finance B-62: the card hides when empty). */
  upcoming: TeamLeaveDto[];
  /** Leave requests of the team waiting for the caller on their level (links to Approvals). */
  pendingForMe: number;
}

// ----- badge ------------------------------------------------------------------------------------------------------------------

/**
 * GET /orgs/:orgId/team/pending-counts — the manager badge (Finance B-63). `approvals` is exactly `/me.approvals.actionable`
 * (`app.approval_actionable_request_ids`); `notes` is the reasons the caller may review as a mapped line manager that the
 * approvals half does not already count. Each half is computed on its own and reads 0 (with a logged warning) on failure.
 */
export interface TeamPendingCountsDto { approvals: number; notes: number; total: number }

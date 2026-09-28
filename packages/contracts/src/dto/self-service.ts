import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '../common.js';
import type { AttendanceDailyRecordDto } from '../attendance.js';
import type { ApprovalRequestStatus, LeaveAccrualValue, LeaveCountModeValue, LeaveStatus } from '../enums.js';
import type { CompOffBalanceDto, LeaveBalanceDto, LeaveWarningDto, SelfLeaveTotalsDto } from '../dto-features/leave.js';

// Employee self-service (/orgs/:orgId/me/…). Every endpoint acts on the caller's own employee record in that
// organisation (the membership's employee link); no endpoint accepts an employee id.

export const selfMonthQuerySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected yyyy-MM').optional() });
export const selfLeaveQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

/** POST /orgs/:orgId/me/leave — a request starts PENDING; HR approves or rejects it on the Leave page. */
export const selfLeaveRequestSchema = z.object({
  leaveTypeId: uuidSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  isHalfDay: z.boolean().optional(),
  halfDayPart: z.enum(['FIRST_HALF', 'SECOND_HALF']).optional(),
  reason: z.string().trim().min(3, 'Tell HR briefly why').max(1000),
}).superRefine((v, ctx) => {
  if (v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'endDate must be on/after startDate' });
  if (v.isHalfDay && v.endDate !== v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'A half day is a single date' });
});
export type SelfLeaveRequestInput = z.infer<typeof selfLeaveRequestSchema>;

/** Correction types an employee may request for their own day (status overrides stay with HR). */
export const SELF_CORRECTION_TYPES = ['ADD_PUNCH', 'EDIT_PUNCH', 'REMOVE_PUNCH'] as const;

export interface SelfRef { id: string; name: string }
export interface SelfProfileDto {
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  displayNameAr: string | null;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  gender: string | null;
  dateOfBirth: string | null;
  nationality: string | null;
  joiningDate: string;
  employmentStatus: string;
  employmentType: string | null;
  photoUrl: string | null;
  branch: (SelfRef & { timezone: string | null }) | null;
  department: SelfRef | null;
  designation: SelfRef | null;
  manager: (SelfRef & { employeeNumber: string }) | null;
  /** Dotted-line / backup manager, when HR recorded one. */
  secondaryManager?: (SelfRef & { employeeNumber: string }) | null;
  teams: SelfRef[];
  weeklyOffDays: number[];
  roleName: string;
}

export interface SelfMonthTotals {
  present: number; absent: number; leave: number; holiday: number; weeklyOff: number; halfDay: number; late: number; missingPunch: number;
  workedMinutes: number; overtimeMinutes: number; lateMinutes: number; earlyDepartureMinutes: number;
  /**
   * Days the employee was expected to work so far — THE portal definition shared with the statistics card (HR portal Prompt 4
   * review, P2-14; `attendanceRateOf` in @flowza/domain): present, half-day, absent and missing-punch days; approved leave is
   * outside (a half-day-leave day counts 0.5), as are holidays, weekly offs, not-joined / exited and uncomputed days.
   */
  workingDays: number;
  /** Of `workingDays`, the days attended (present and missing-punch days in full, half days by half). Absent from older API builds. */
  attendedDays?: number;
  /** attendedDays / workingDays, 0..1; null before the first working day. */
  attendanceRate: number | null;
}

export type SelfDayDto = AttendanceDailyRecordDto & { branchName: string | null; departmentName: string | null };

export interface SelfAttendanceMonthDto {
  month: string; days: SelfDayDto[]; totals: SelfMonthTotals;
  /** `leaveTypeNameAr`: the type's Arabic name, shown in Arabic when the organisation gave one (absent from older API builds). */
  leaveByDate: Record<string, { leaveTypeName: string; leaveTypeNameAr?: string | null; color: string | null; isHalfDay: boolean }>;
  holidaysByDate: Record<string, string>;
  /** The Arabic names of the holidays in `holidaysByDate` that have one (absent from older API builds). */
  holidaysByDateAr?: Record<string, string>;
}

export interface SelfLeaveTypeDto {
  id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; color: string | null; annualAllowanceDays: number | null;
  // leave v2 policy (optional: older API builds omit them)
  requiresApproval?: boolean; countMode?: LeaveCountModeValue; allowHalfDay?: boolean; advanceNoticeDays?: number; maxConsecutiveDays?: number | null; accrual?: LeaveAccrualValue;
  /** The organisation's comp-off type (booked through "Use comp-off", not the ordinary form). */
  compOff?: boolean;
}
/**
 * Pre-v2 fields (allowance = entitlement, used = taken, remaining = available − pending) plus the full leave v2 balance of
 * the type (computeLeaveBalances), flattened; the v2 fields are optional so an older API build still parses.
 */
export interface SelfLeaveBalanceDto extends Partial<Omit<LeaveBalanceDto, 'leaveTypeId'>> { leaveTypeId: string; allowanceDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }
export interface SelfLeaveRecordDto {
  id: string; leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string; color: string | null; isPaid: boolean;
  /** The type's Arabic name, shown in Arabic when the organisation gave one (absent from older API builds). */
  leaveTypeNameAr?: string | null;
  startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null; days: number;
  reason: string | null; status: LeaveStatus; decisionNote: string | null; approvedByName: string | null; approvedAt: string | null; createdAt: string; updatedAt: string;
  /** The engine request behind the leave (null for leave recorded before the approval engine, or by HR directly without a workflow). */
  approvalRequestId: string | null;
  /** Its status — PENDING while approvers decide, INVALIDATED after an edit (a new request replaces it), CANCELLED on withdrawal. */
  approvalStatus: ApprovalRequestStatus | null;
  /** "Level 1 of 2" style progress for a pending request. */
  approvalCurrentStep: number | null;
  approvalStepCount: number | null;
  // ----- leave v2 (optional: older API builds omit them) -----
  withdrawnAt?: string | null;
  editedAt?: string | null;
  /** The caller may edit / withdraw (PENDING or INFO_REQUESTED) or reply (INFO_REQUESTED). */
  canEdit?: boolean;
  canWithdraw?: boolean;
  canReply?: boolean;
  /** The open question while INFO_REQUESTED (the latest info_request comment). */
  infoRequest?: { message: string; askedAt: string; askedByName: string | null } | null;
  commentCount?: number;
  /** Booked against comp-off credits. */
  compOff?: boolean;
  /** Rules the request broke that did not block it (returned by apply / edit). */
  warnings?: LeaveWarningDto[];
  /** Returned by withdraw when the request was already withdrawn or cancelled (leave v2 review P2-12: idempotent, not an error). */
  alreadyWithdrawn?: boolean;
}
export interface SelfLeaveDto {
  year: number;
  types: SelfLeaveTypeDto[];
  balances: SelfLeaveBalanceDto[];
  records: SelfLeaveRecordDto[];
  /**
   * What the apply form needs to preview the days a range will charge (the year and the next): the weekly offs of the
   * employee's current placement and the holiday dates, plus — leave v2 review P1-1 / P1-2 — `offDates`: every date of the
   * window that is NOT a working day by the per-date working calendar (the branch effective on that date, its weekly offs and
   * holidays, rotation-pattern off days), exactly as the attendance engine sees it. A client that knows `offDates` counts with
   * it; older clients keep using the weekly offs and holidays.
   */
  calendar: { weeklyOffDays: number[]; holidays: string[]; offDates?: string[]; from?: string; to?: string };
  // ----- leave v2 (optional: older API builds omit them) -----
  /** The date balances are computed for (today in the organisation's timezone, clamped into the year). */
  asOf?: string;
  /** The five tiles: entitlement, used, pending, available, accrued to date — summed over tracked ordinary types. */
  totals?: SelfLeaveTotalsDto;
  /** Comp-off credits balance (null when the organisation has no comp-off type). */
  compOff?: CompOffBalanceDto | null;
}

export interface SelfHolidayDto { date: string; endDate: string | null; name: string; nameAr: string | null }
export interface SelfOverviewDto {
  date: string;
  timezone: string;
  today: SelfDayDto | null;
  month: { month: string; totals: SelfMonthTotals };
  recent: SelfDayDto[];
  /** `nameAr`: the type's Arabic name (absent from older API builds). */
  balances: Array<SelfLeaveBalanceDto & { name: string; nameAr?: string | null; code: string; color: string | null }>;
  upcomingLeave: SelfLeaveRecordDto[];
  pendingLeave: number;
  pendingCorrections: number;
  upcomingHolidays: SelfHolidayDto[];
  /** Today's check-in state (HR portal Prompt 4; absent from API versions before it). */
  punch?: { lastDirection: 'in' | 'out' | null; lastPunchAt: string | null; punchesToday: number; canCheckIn: boolean; canCheckOut: boolean; checkInEnabled: boolean };
  /** Own attendance reasons waiting for a review, and those where the reviewer asked for more information. */
  pendingNotes?: number;
  infoRequestedNotes?: number;
  pendingRegularisations?: number;
  /** Shift swaps I filed that wait for a decision, and swaps colleagues filed that name me. */
  pendingSwaps?: number;
  /**
   * Days of the last 30 (before today) the organisation requires a reason for (`attendance.notes.requireReasonForLate` /
   * `requireReasonForAbsent`) and that carry none; absent when neither requirement is on.
   */
  reasonsRequired?: number;
}

import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '../common.js';
import type { AttendanceDailyRecordDto } from '../attendance.js';
import type { LeaveStatus } from '../enums.js';

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
  teams: SelfRef[];
  weeklyOffDays: number[];
  roleName: string;
}

export interface SelfMonthTotals {
  present: number; absent: number; leave: number; holiday: number; weeklyOff: number; halfDay: number; late: number; missingPunch: number;
  workedMinutes: number; overtimeMinutes: number; lateMinutes: number; earlyDepartureMinutes: number;
  /** Days the employee was expected to work so far (records other than holiday / weekly off / not joined / exited). */
  workingDays: number;
  /** (present + half days) / working days, 0..1; null before the first working day. */
  attendanceRate: number | null;
}

export type SelfDayDto = AttendanceDailyRecordDto & { branchName: string | null; departmentName: string | null };

export interface SelfAttendanceMonthDto { month: string; days: SelfDayDto[]; totals: SelfMonthTotals; leaveByDate: Record<string, { leaveTypeName: string; color: string | null; isHalfDay: boolean }>; holidaysByDate: Record<string, string> }

export interface SelfLeaveTypeDto { id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; color: string | null; annualAllowanceDays: number | null }
export interface SelfLeaveBalanceDto { leaveTypeId: string; allowanceDays: number | null; usedDays: number; pendingDays: number; remainingDays: number | null }
export interface SelfLeaveRecordDto {
  id: string; leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string; color: string | null; isPaid: boolean;
  startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null; days: number;
  reason: string | null; status: LeaveStatus; decisionNote: string | null; approvedByName: string | null; approvedAt: string | null; createdAt: string; updatedAt: string;
}
export interface SelfLeaveDto {
  year: number;
  types: SelfLeaveTypeDto[];
  balances: SelfLeaveBalanceDto[];
  records: SelfLeaveRecordDto[];
  /** What the apply form needs to preview the days a range will charge. */
  calendar: { weeklyOffDays: number[]; holidays: string[] };
}

export interface SelfHolidayDto { date: string; endDate: string | null; name: string; nameAr: string | null }
export interface SelfOverviewDto {
  date: string;
  timezone: string;
  today: SelfDayDto | null;
  month: { month: string; totals: SelfMonthTotals };
  recent: SelfDayDto[];
  balances: Array<SelfLeaveBalanceDto & { name: string; code: string; color: string | null }>;
  upcomingLeave: SelfLeaveRecordDto[];
  pendingLeave: number;
  pendingCorrections: number;
  upcomingHolidays: SelfHolidayDto[];
}

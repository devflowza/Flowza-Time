import type { LeaveWarningDto } from '@flowza/contracts';

export type { CompOffCreditDto, EmployeeLeaveBalancesDto, LeaveAllocationDto, LeaveBalanceDto, LeaveCalendarDto, LeaveCommentDto, LeaveWarningDto, TeamLeaveDto } from '@flowza/contracts';

export interface LeaveTypeDto {
  id: string; code: string; name: string; nameAr: string | null; isPaid: boolean; treatAsPresent: boolean; color: string | null; annualAllowanceDays: number | null; status: string; createdAt: string;
  // leave v2 policy (optional: an API build from before leave v2 omits them)
  requiresApproval?: boolean; countMode?: 'working' | 'calendar'; maxConsecutiveDays?: number | null; advanceNoticeDays?: number; applicableGender?: 'all' | 'male' | 'female'; accrual?: 'none' | 'monthly';
  /** Leave v2 review (B-41): the employment types the type applies to; null = every type. */
  applicableEmploymentTypes?: string[] | null;
  carryForwardMaxDays?: number; carryForwardExpiryMonths?: number | null; isSpecial?: boolean; allowHalfDay?: boolean; portalVisible?: boolean; systemKey?: string | null;
  /** The organisation's comp-off type: managed by the system (always active, no allowance, redeemed from credits). */
  compOff?: boolean;
}
export interface LeaveRecordDto {
  id: string; employeeId: string; employeeNumber?: string; employeeName?: string; leaveTypeId: string; leaveTypeName?: string; branchId: string | null; startDate: string; endDate: string; isHalfDay: boolean; halfDayPart: string | null;
  reason: string | null; status: string; source: string; decisionNote: string | null; approvedBy: string | null; approvedAt: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
  // leave v2 (optional: an API build from before leave v2 omits them)
  leaveTypeCode?: string; color?: string | null; compOff?: boolean; days?: number | null; withdrawnAt?: string | null; editedAt?: string | null;
  approvalRequestId?: string | null; approvalStatus?: string | null; approvalCurrentStep?: number | null; approvalStepCount?: number | null;
  /** Who the current level waits for (names), while the request is pending. */
  approvalWaitingFor?: string[];
  commentCount?: number;
}
/** A write's result: the record, the attendance recalculation it queued (past days) and the rules it broke without being blocked. */
export type WithRecalc<T> = T & { recalculationJobId: string | null; warnings?: LeaveWarningDto[] };

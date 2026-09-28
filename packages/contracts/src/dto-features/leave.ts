import { z } from 'zod';
import { COMP_OFF_WORKED_ON_TYPES, HALF_DAY_PARTS, type ApprovalRequestStatus, type CompOffStatus, type CompOffWorkedOnType, type LeaveAccrualValue, type LeaveCommentKind, type LeaveCountModeValue, type LeaveStatus } from '../enums.js';
import { booleanQuerySchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';

// Leave v2 (HR portal Prompt 7): balances, allocations, year close, the comment thread, comp-off, team views. Every figure
// of a balance is computed by the domain's computeLeaveBalances (packages/domain/src/leave/balances.ts) — no counters.

const halfDaysSchema = (min: number, max: number) => z.number().min(min).max(max).multipleOf(0.5);
const yearSchema = z.coerce.number().int().min(2000).max(2100);
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected yyyy-MM');

/** A rule the request broke that does not block it (over balance; for HR also notice / max consecutive). */
export interface LeaveWarningDto { code: string; message: string; params: Record<string, string | number | null> }

// ----- balances ------------------------------------------------------------------------------------------------------------

export interface LeaveBalanceDto {
  leaveTypeId: string;
  code: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  isPaid: boolean;
  countMode: LeaveCountModeValue;
  accrual: LeaveAccrualValue;
  /** The organisation's comp-off type (balance from credits). */
  compOff: boolean;
  /** An entitlement exists (allocation row, type allowance, or comp-off). */
  tracked: boolean;
  hasAllocation: boolean;
  allocatedDays: number | null;
  carriedForwardDays: number;
  carriedForwardExpiresOn: string | null;
  carriedForwardExpiredDays: number;
  openingBalanceDays: number;
  adjustmentDays: number;
  entitlementDays: number | null;
  takenDays: number;
  pendingDays: number;
  accruedToDateDays: number | null;
  availableDays: number | null;
  availableAfterPendingDays: number | null;
}

export const leaveBalancesQuerySchema = paginationQuerySchema.extend({
  year: yearSchema.optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type LeaveBalancesQuery = z.infer<typeof leaveBalancesQuerySchema>;

export interface EmployeeLeaveBalancesDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string | null;
  departmentId: string | null;
  joiningDate: string;
  year: number;
  asOf: string;
  balances: LeaveBalanceDto[];
}

// ----- allocations ---------------------------------------------------------------------------------------------------------

export const leaveAllocationListQuerySchema = paginationQuerySchema.extend({
  year: yearSchema,
  employeeId: uuidSchema.optional(),
  leaveTypeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export type LeaveAllocationListQuery = z.infer<typeof leaveAllocationListQuerySchema>;

/** One allocation row to create or replace (PUT = full row; omitted optional numbers are 0 / null). */
export const leaveAllocationRowSchema = z.object({
  employeeId: uuidSchema,
  leaveTypeId: uuidSchema,
  year: yearSchema,
  allocatedDays: halfDaysSchema(0, 366),
  carriedForwardDays: halfDaysSchema(0, 366).optional(),
  carriedForwardExpiresOn: isoDateSchema.nullable().optional(),
  openingBalanceDays: halfDaysSchema(-366, 366).optional(),
  adjustmentDays: halfDaysSchema(-366, 366).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.carriedForwardExpiresOn && !(v.carriedForwardDays && v.carriedForwardDays > 0)) ctx.addIssue({ code: 'custom', path: ['carriedForwardExpiresOn'], message: 'An expiry needs carried-forward days' });
});
export type LeaveAllocationRowInput = z.infer<typeof leaveAllocationRowSchema>;
export const leaveAllocationUpsertSchema = z.object({ rows: z.array(leaveAllocationRowSchema).min(1).max(500) });
export type LeaveAllocationUpsertInput = z.infer<typeof leaveAllocationUpsertSchema>;

export interface LeaveAllocationDto {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string | null;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  year: number;
  allocatedDays: number;
  carriedForwardDays: number;
  carriedForwardExpiresOn: string | null;
  openingBalanceDays: number;
  adjustmentDays: number;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
}
export interface LeaveAllocationUpsertResultDto { created: number; updated: number; unchanged: number; allocations: LeaveAllocationDto[] }

/** Create the missing rows of a year from the types' yearly allowance for every active employee (prorated for joiners). Existing rows are never overwritten. */
export const leaveAllocationGenerateSchema = z.object({
  year: yearSchema,
  leaveTypeIds: z.array(uuidSchema).min(1).max(50).optional(),
});
export interface LeaveAllocationGenerateResultDto {
  year: number; created: number; skipped: number; employees: number; leaveTypes: number;
  /** Leave v2 review P0-2: the caller's own rows, left for another HR user (nobody allocates leave to themselves); included in `skipped`. */
  skippedOwn?: number;
}

export const leaveYearCloseSchema = z.object({ fromYear: yearSchema });
export interface LeaveYearCloseQueuedDto { jobId: string; status: 'QUEUED'; fromYear: number; toYear: number }

// ----- comment thread ------------------------------------------------------------------------------------------------------

export const leaveCommentInputSchema = z.object({ body: z.string().trim().min(1).max(2000) });
export type LeaveCommentInput = z.infer<typeof leaveCommentInputSchema>;
export interface LeaveCommentDto { id: string; leaveRecordId: string; authorUserId: string | null; authorName: string | null; kind: LeaveCommentKind; body: string; createdAt: string; mine: boolean }

// ----- self-service v2 -----------------------------------------------------------------------------------------------------

/** PATCH /orgs/:orgId/me/leave/:id — edit a PENDING / INFO_REQUESTED request (omitted = unchanged; no defaults). */
export const selfLeaveEditSchema = z.object({
  leaveTypeId: uuidSchema.optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  isHalfDay: z.boolean().optional(),
  halfDayPart: z.enum(HALF_DAY_PARTS).nullable().optional(),
  reason: z.string().trim().min(3, 'Tell HR briefly why').max(1000).optional(),
});
export type SelfLeaveEditInput = z.infer<typeof selfLeaveEditSchema>;
/**
 * POST …/me/leave/:id/withdraw — the reason is required (Finance B-98; it reaches the approvers and the timeline). The
 * pre-v2 POST …/me/leave/:id/cancel takes no body and records "Withdrawn by the requester".
 */
export const selfLeaveWithdrawSchema = z.object({ reason: z.string().trim().min(3, 'Tell your approver why').max(500) });
/** POST …/me/leave/:id/reply — answer the approver's question; the request goes back to PENDING. */
export const selfLeaveReplySchema = z.object({ body: z.string().trim().min(1).max(2000) });

export interface SelfLeaveTotalsDto { entitlementDays: number; takenDays: number; pendingDays: number; availableDays: number; accruedToDateDays: number }

// ----- comp-off ------------------------------------------------------------------------------------------------------------

export const selfCompOffRequestSchema = z.object({
  workedOn: isoDateSchema,
  workedOnType: z.enum(COMP_OFF_WORKED_ON_TYPES),
  workedMinutes: z.number().int().min(1).max(1440),
  location: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1000),
});
export type SelfCompOffRequestInput = z.infer<typeof selfCompOffRequestSchema>;
export const selfCompOffPreviewQuerySchema = z.object({ workedOn: isoDateSchema });

export interface CompOffCreditDto {
  id: string;
  employeeId: string;
  employeeName?: string;
  workedOn: string;
  workedOnType: CompOffWorkedOnType;
  workedMinutes: number;
  daysEarned: number;
  location: string;
  summary: string;
  status: CompOffStatus;
  usedDays: number;
  /** days_earned − used_days while approved / partially used and unexpired, else 0. */
  remainingDays: number;
  expiresOn: string | null;
  decisionNote: string | null;
  approvalRequestId: string | null;
  approvalStatus: ApprovalRequestStatus | null;
  createdAt: string;
  updatedAt: string;
}
export interface CompOffBalanceDto { leaveTypeId: string | null; earnedDays: number; usedDays: number; availableDays: number; pendingDays: number; availableAfterPendingDays: number }
export interface SelfCompOffDto {
  balance: CompOffBalanceDto;
  credits: CompOffCreditDto[];
  /** What the request form needs: the thresholds (hours) and how long a credit lasts. */
  rules: { fullDayHours: number; halfDayHours: number; expiryDays: number };
}
/** What a worked date would earn: the day type from the working calendar, the recorded minutes from the daily record. */
export interface CompOffPreviewDto { workedOn: string; workedOnType: CompOffWorkedOnType | null; holidayName: string | null; recordedMinutes: number | null; daysEarned: number; alreadyRequested: boolean; eligible: boolean; reason: string | null }

// ----- team and calendar -----------------------------------------------------------------------------------------------------

export interface TeamLeaveDto {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveTypeCode: string;
  color: string | null;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  halfDayPart: string | null;
  /**
   * The days the leave charges: its stored value, or — leave v2 review P2-8 — computed on read for a leave stored without
   * one (recorded before leave v2), with the same per-date working calendar the balances use.
   */
  days: number | null;
  /** Leave v2 review P2-8: the days of this leave inside the period viewed (the calendar's month); totals sum this. */
  daysInPeriod?: number;
  status: LeaveStatus;
}

export const leaveCalendarQuerySchema = z.object({
  month: monthSchema,
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  includePending: booleanQuerySchema.default(true),
});
export type LeaveCalendarQuery = z.infer<typeof leaveCalendarQuerySchema>;
export interface LeaveCalendarDto {
  month: string;
  from: string;
  to: string;
  employees: Array<{ employeeId: string; employeeName: string; employeeNumber: string; branchId: string | null; departmentId: string | null }>;
  entries: TeamLeaveDto[];
  /** More than the page could show (the calendar lists at most 300 employees with leave). */
  truncated: boolean;
}

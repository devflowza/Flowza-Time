/**
 * Shift change requests (Enterprise, module `shift_requests`; migration 20261007000100, docs/enterprise/plan.md §7):
 * an employee asks to work ANOTHER shift (CHANGE) or a SECOND shift (ADDITIONAL — a double shift; needs the
 * `advanced_scheduling` module too) on a range of days. Routed through the approval engine as entity SHIFT_CHANGE and applied
 * on approval as EMPLOYEE shift assignments (CHANGE) or additional shift assignments (ADDITIONAL).
 */
import { z } from 'zod';
import { SHIFT_CHANGE_KINDS, SHIFT_CHANGE_STATUSES, type ApprovalRequestStatus, type ShiftChangeKind, type ShiftChangeStatus } from '../enums.js';
import { isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import type { SelfShiftDayDto } from '../dto/portal-attendance.js';

/** How far ahead a change may be asked for, and the longest range one request may cover (days, inclusive). */
export const SHIFT_CHANGE_AHEAD_DAYS = 180;
export const SHIFT_CHANGE_MAX_DAYS = 92;

export const selfShiftChangeInputSchema = z.object({
  kind: z.enum(SHIFT_CHANGE_KINDS).default('CHANGE'),
  fromDate: isoDateSchema,
  /** Inclusive last day. */
  toDate: isoDateSchema,
  shiftId: uuidSchema,
  reason: z.string().trim().min(3, 'Explain the request in a few words').max(1000),
}).refine((v) => v.toDate >= v.fromDate, { message: 'The last day cannot be before the first day', path: ['toDate'] });
export type SelfShiftChangeInput = z.infer<typeof selfShiftChangeInputSchema>;

export const shiftChangeListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SHIFT_CHANGE_STATUSES).optional(),
  kind: z.enum(SHIFT_CHANGE_KINDS).optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** Requests whose range touches [from, to]. */
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export const selfShiftChangesQuerySchema = z.object({ status: z.enum(SHIFT_CHANGE_STATUSES).optional() });
export const cancelShiftChangeSchema = z.object({ reason: z.string().trim().min(3).max(1000).optional() });

/** The shifts an employee may ask for (active shifts of the organisation), with the one they work on the first day. */
export const shiftChangeOptionsQuerySchema = z.object({ date: isoDateSchema });

/** One active shift of the organisation an employee may ask for (GET /me/shift-changes/options). */
export interface ShiftChangeOptionDto {
  id: string; code: string; name: string; nameAr: string | null; type: 'FIXED' | 'FLEXIBLE';
  startTime: string | null; endTime: string | null; crossesMidnight: boolean; color: string | null;
}
export interface ShiftChangeOptionsDto {
  date: string;
  /** What the employee works on `date` (the engine's resolution; null fields when nothing resolves). */
  current: Omit<SelfShiftDayDto, 'swap'>;
  shifts: ShiftChangeOptionDto[];
}

export interface ShiftChangeRequestDto {
  id: string; kind: ShiftChangeKind; status: ShiftChangeStatus;
  employeeId: string; employeeName: string | null; employeeNumber: string | null; branchId: string | null;
  fromDate: string; toDate: string;
  requestedShift: { id: string; code: string; name: string; startTime: string | null; endTime: string | null } | null;
  currentShift: { id: string; code: string; name: string } | null;
  reason: string;
  /** Whether the caller filed it. */
  mine: boolean;
  approvalRequestId: string | null; approvalStatus: ApprovalRequestStatus | null;
  appliedAssignmentIds: string[];
  decidedAt: string | null; decisionNote: string | null; createdAt: string; updatedAt: string;
}

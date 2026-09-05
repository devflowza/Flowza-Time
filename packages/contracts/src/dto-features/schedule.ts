import { z } from 'zod';
import { ASSIGNMENT_TARGETS, LEAVE_STATUSES, RECORD_STATUSES } from '../enums.js';
import { isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const shiftListQuerySchema = paginationQuerySchema.extend({ status: z.enum(RECORD_STATUSES).optional(), search: z.string().trim().max(100).optional() });
export const shiftAssignmentListQuerySchema = paginationQuerySchema.extend({
  targetType: z.enum(ASSIGNMENT_TARGETS).optional(),
  targetId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  /** Only assignments effective on this date. */
  activeOn: isoDateSchema.optional(),
});
export const shiftAssignmentUpdateSchema = z.object({ effectiveTo: isoDateSchema.nullable() });
export const shiftResolveQuerySchema = z.object({ employeeId: uuidSchema, date: isoDateSchema });

export const holidayListQuerySchema = z.object({
  calendarId: uuidSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export const leaveRecordListQuerySchema = paginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  leaveTypeId: uuidSchema.optional(),
  status: z.enum(LEAVE_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export const updateLeaveRecordSchema = z.object({
  leaveTypeId: uuidSchema.optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  isHalfDay: z.boolean().optional(),
  halfDayPart: z.enum(['FIRST_HALF', 'SECOND_HALF']).nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  status: z.enum(LEAVE_STATUSES).optional(),
});
export type UpdateLeaveRecordInput = z.infer<typeof updateLeaveRecordSchema>;
export const ruleSetListQuerySchema = z.object({ branchId: uuidSchema.optional(), activeOn: isoDateSchema.optional(), includeExpired: z.coerce.boolean().default(true) });

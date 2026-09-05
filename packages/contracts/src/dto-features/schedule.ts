import { z } from 'zod';
import { ASSIGNMENT_TARGETS, LEAVE_STATUSES, RECORD_STATUSES } from '../enums.js';
import { booleanQuerySchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { attendanceRuleSetInputSchema, type AttendanceRuleSetInput } from '../attendance.js';
import { holidayCalendarInputSchema, holidayInputSchema, leaveTypeInputSchema, shiftInputSchema, type HolidayInput, type ShiftInput } from '../shifts.js';
import { updateSchemaOf } from './devices.js';

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
/** PATCH bodies without defaults (see updateSchemaOf). The FIXED/FLEXIBLE consistency check runs in the service on the merged row. */
export const shiftUpdateSchema = updateSchemaOf<ShiftInput>(shiftInputSchema.shape);
export const holidayUpdateSchema = updateSchemaOf<HolidayInput>(holidayInputSchema.shape);
export const holidayCalendarUpdateSchema = updateSchemaOf<z.infer<typeof holidayCalendarInputSchema>>(holidayCalendarInputSchema.shape);
export const leaveTypeUpdateSchema = updateSchemaOf<z.infer<typeof leaveTypeInputSchema>>(leaveTypeInputSchema.shape).and(z.object({ status: z.enum(RECORD_STATUSES).optional() }));
export const ruleSetUpdateSchema = updateSchemaOf<AttendanceRuleSetInput>(attendanceRuleSetInputSchema.shape);
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
export const ruleSetListQuerySchema = z.object({ branchId: uuidSchema.optional(), activeOn: isoDateSchema.optional(), includeExpired: booleanQuerySchema.default(true) });

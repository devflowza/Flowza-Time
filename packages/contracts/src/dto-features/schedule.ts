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
  /** HR's comment on an approval or rejection; the employee sees it in the portal. */
  decisionNote: z.string().trim().max(1000).nullable().optional(),
  /**
   * Leave v2: the approval level the decider saw (the row's `approvalCurrentStep`). The Leave page sends it with every
   * decision; the level must still be the current one (else 409). A decision without it may only settle a seat the caller
   * actually holds on the current level — never another level by permission.
   */
  stepNo: z.number().int().min(1).max(50).optional(),
  /**
   * Leave v2 review (engine §9.8 seat choice): the waiting approver whose seat an organisation-wide override fills. Required
   * by the engine when the level is ALL / QUORUM and several approvers still wait (the request's `abilities.mustChooseSeat`).
   */
  onBehalfOfUserId: uuidSchema.optional(),
});
export type UpdateLeaveRecordInput = z.infer<typeof updateLeaveRecordSchema>;
/**
 * Attendance rule sets (policies). The scope filters beyond `branchId` (Enterprise, attendance_policies) match the policy's own
 * dimension exactly (a policy scoped to the group, not "policies that would apply to its members"). `locationId`: the policies
 * whose location is that node — a group location or a place by `locationId`, a branch's node by `branchId` (docs/locations.md §3).
 */
export const ruleSetListQuerySchema = z.object({
  branchId: uuidSchema.optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  departmentId: uuidSchema.optional(),
  employeeGroupId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  activeOn: isoDateSchema.optional(),
  includeExpired: booleanQuerySchema.default(true),
});

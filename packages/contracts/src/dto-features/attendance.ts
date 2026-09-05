import { z } from 'zod';
import { APPROVAL_ENTITIES, APPROVAL_STATUSES, APPROVER_TYPES, CORRECTION_STATUSES, RECORD_STATUSES } from '../enums.js';
import { booleanQuerySchema, cursorQuerySchema, isoDateSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import { updateSchemaOf } from './devices.js';
import { dailyAttendanceQuerySchema, monthlyAttendanceQuerySchema } from '../attendance.js';

export const dailyAttendanceListQuerySchema = dailyAttendanceQuerySchema.extend(paginationQuerySchema.shape);
export type DailyAttendanceListQuery = z.infer<typeof dailyAttendanceListQuerySchema>;

export const monthlyAttendanceListQuerySchema = monthlyAttendanceQuerySchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
});
export type MonthlyAttendanceListQuery = z.infer<typeof monthlyAttendanceListQuerySchema>;

export const RAW_PROCESSING_STATUSES = ['pending', 'normalized', 'unmatched', 'ignored', 'error', 'quarantined', 'held'] as const;
export const rawTransactionsQuerySchema = cursorQuerySchema.extend({
  deviceId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  processingStatus: z.enum(RAW_PROCESSING_STATUSES).optional(),
  deviceEmployeeId: z.string().max(64).optional(),
});
export type RawTransactionsQuery = z.infer<typeof rawTransactionsQuerySchema>;

export const correctionListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CORRECTION_STATUSES).optional(),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export const correctionCancelSchema = z.object({ reason: z.string().max(500).optional() });
export const approvalInboxQuerySchema = paginationQuerySchema;

export const approvalWorkflowStepSchema = z.object({
  order: z.number().int().min(1).max(5),
  approverType: z.enum(APPROVER_TYPES),
  roleId: uuidSchema.optional(),
  userId: uuidSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.approverType === 'ROLE' && !v.roleId) ctx.addIssue({ code: 'custom', path: ['roleId'], message: 'Required for ROLE steps' });
  if (v.approverType === 'USER' && !v.userId) ctx.addIssue({ code: 'custom', path: ['userId'], message: 'Required for USER steps' });
});
export const approvalWorkflowInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  entityType: z.enum(APPROVAL_ENTITIES).default('ATTENDANCE_CORRECTION'),
  branchId: uuidSchema.nullable().optional(),
  isDefault: z.boolean().default(true),
  status: z.enum(RECORD_STATUSES).default('active'),
  steps: z.array(approvalWorkflowStepSchema).min(1).max(5),
});
export type ApprovalWorkflowInput = z.infer<typeof approvalWorkflowInputSchema>;
/** PATCH body: no defaults, so a rename never flips isDefault/status/entityType. */
export const approvalWorkflowUpdateSchema = updateSchemaOf<ApprovalWorkflowInput>(approvalWorkflowInputSchema.shape);

export const periodUnlockSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const periodLockListQuerySchema = z.object({ branchId: uuidSchema.optional(), includeUnlocked: booleanQuerySchema.default(false), year: z.coerce.number().int().min(2000).max(2100).optional() });
export const recalculationListQuerySchema = paginationQuerySchema.extend({ status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional() });

export const approvalStepDtoSchema = z.object({
  id: uuidSchema,
  requestId: uuidSchema,
  stepNo: z.number().int(),
  approverType: z.enum(APPROVER_TYPES),
  approverRoleId: uuidSchema.nullable(),
  approverUserId: uuidSchema.nullable(),
  status: z.enum(APPROVAL_STATUSES),
  actedBy: uuidSchema.nullable(),
  actedAt: isoDateTimeSchema.nullable(),
  comment: z.string().nullable(),
});
export type ApprovalStepDto = z.infer<typeof approvalStepDtoSchema>;

export const approvalRequestDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  workflowId: uuidSchema.nullable(),
  entityType: z.enum(APPROVAL_ENTITIES),
  entityId: uuidSchema,
  branchId: uuidSchema.nullable(),
  employeeId: uuidSchema.nullable(),
  currentStep: z.number().int(),
  status: z.enum(APPROVAL_STATUSES),
  requestedBy: uuidSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  steps: z.array(approvalStepDtoSchema),
});
export type ApprovalRequestDto = z.infer<typeof approvalRequestDtoSchema>;

import { z } from 'zod';
import { CORRECTION_STATUSES } from '../enums.js';
import { booleanQuerySchema, cursorQuerySchema, isoDateSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';
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
export const periodUnlockSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const periodLockListQuerySchema = z.object({ branchId: uuidSchema.optional(), includeUnlocked: booleanQuerySchema.default(false), year: z.coerce.number().int().min(2000).max(2100).optional() });
export const recalculationListQuerySchema = paginationQuerySchema.extend({ status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional() });

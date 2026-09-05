import { z } from 'zod';
import { REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES } from './enums.js';
import { isoDateSchema, isoDateTimeSchema, uuidSchema } from './common.js';

export const reportParametersSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeIds: z.array(uuidSchema).max(5000).optional(),
  shiftId: uuidSchema.optional(),
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  status: z.string().optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  locale: z.enum(['en', 'ar']).optional(),
});
export type ReportParameters = z.infer<typeof reportParametersSchema>;

export const createReportRequestSchema = z.object({
  reportType: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS).default('xlsx'),
  parameters: reportParametersSchema.default({}),
  reason: z.string().max(500).optional(),
});
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

export const reportRequestDtoSchema = z.object({
  id: uuidSchema,
  reportType: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS),
  parameters: reportParametersSchema,
  status: z.enum(REPORT_STATUSES),
  rowCount: z.number().int().nullable(),
  fileSizeBytes: z.number().nullable(),
  error: z.string().nullable(),
  requestedBy: uuidSchema.nullable(),
  requestedByName: z.string().nullable().optional(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  downloadUrl: z.string().nullable().optional(),
});
export type ReportRequestDto = z.infer<typeof reportRequestDtoSchema>;

export const dashboardSummarySchema = z.object({
  date: isoDateSchema,
  employees: z.number().int(),
  presentToday: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  earlyDeparture: z.number().int(),
  overtimeMinutes: z.number().int(),
  missingPunch: z.number().int(),
  devicesOnline: z.number().int(),
  devicesOffline: z.number().int(),
  devicesUnknown: z.number().int(),
  syncFailures24h: z.number().int(),
  pendingApprovals: z.number().int(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

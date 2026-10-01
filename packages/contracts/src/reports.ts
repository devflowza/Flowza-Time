import { z } from 'zod';
import { REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES } from './enums.js';
import { codeSchema, isoDateSchema, isoDateTimeSchema, uuidSchema } from './common.js';

/** monthly_attendance: the codes grid (the sample layout), or each day's IN/OUT pairs and hours per employee (the Daily Report's rows for a month). */
export const MONTHLY_ATTENDANCE_LAYOUTS = ['summary', 'detailed'] as const;
export type MonthlyAttendanceLayout = (typeof MONTHLY_ATTENDANCE_LAYOUTS)[number];

export const reportParametersSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeIds: z.array(uuidSchema).max(5000).optional(),
  shiftId: uuidSchema.optional(),
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  status: z.string().trim().max(40).optional(),
  sort: z.string().max(64).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  locale: z.enum(['en', 'ar']).optional(),
  /** leave_report: which leave type (by code) the report lists. */
  leaveTypeCode: codeSchema.optional(),
  /** employee_directory: Active = active + on_leave; Inactive = suspended, terminated, resigned. */
  employmentStatus: z.enum(['active', 'inactive', 'all']).optional(),
  /** audit_report: attendance edits in the samples' layout, or the whole audit log. */
  scope: z.enum(['attendance', 'all']).optional(),
  /** monthly_summary: the summary page's name / employee-number search (HR portal Prompt 6a review, defect 10). */
  search: z.string().trim().max(100).optional(),
  /** monthly_attendance: `summary` (default) or `detailed`. */
  layout: z.enum(MONTHLY_ATTENDANCE_LAYOUTS).optional(),
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
  /** Approvals waiting for the CALLER (their pending seats, or of somebody who delegates to them today) — the Approvals card's "mine" queue. */
  pendingApprovals: z.number().int(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

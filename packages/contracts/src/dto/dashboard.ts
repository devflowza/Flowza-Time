import { z } from 'zod';
import { isoDateSchema, uuidSchema } from '../common.js';

/** `locationId`: a group / branch location → its branches; a place → the employees working in it or below (docs/locations.md). */
export const dashboardSummaryQuerySchema = z.object({ date: isoDateSchema.optional(), branchId: uuidSchema.optional(), locationId: uuidSchema.optional() });
export const dashboardTrendsQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema, branchId: uuidSchema.optional(), locationId: uuidSchema.optional() })
  .refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] });
export const dashboardBranchesQuerySchema = z.object({ date: isoDateSchema.optional() });

export const dashboardTrendPointSchema = z.object({
  date: isoDateSchema,
  present: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  missingPunch: z.number().int(),
  overtimeMinutes: z.number().int(),
});
export type DashboardTrendPoint = z.infer<typeof dashboardTrendPointSchema>;

export const dashboardBranchRowSchema = z.object({
  branchId: uuidSchema,
  branchCode: z.string(),
  branchName: z.string(),
  employees: z.number().int(),
  present: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  missingPunch: z.number().int(),
  devicesOnline: z.number().int(),
  devicesOffline: z.number().int(),
});
export type DashboardBranchRow = z.infer<typeof dashboardBranchRowSchema>;

/**
 * GET /orgs/:orgId/dashboard/departments — the day's attendance per department (Statistics and indicators), in the caller's
 * branch scope (and an optional branch / location filter). `departmentId` null = employees without a department.
 */
export const dashboardDepartmentsQuerySchema = z.object({ date: isoDateSchema.optional(), branchId: uuidSchema.optional(), locationId: uuidSchema.optional() });
export const dashboardDepartmentRowSchema = z.object({
  departmentId: uuidSchema.nullable(),
  departmentName: z.string().nullable(),
  /** Records of the day (employees expected or recorded that day). */
  employees: z.number().int(),
  present: z.number().int(),
  absent: z.number().int(),
  late: z.number().int(),
  onLeave: z.number().int(),
  missingPunch: z.number().int(),
  /** Present ÷ (present + absent + missing punch), 0–100 with one decimal; null when nobody was expected to work. */
  attendanceRate: z.number().nullable(),
});
export type DashboardDepartmentRow = z.infer<typeof dashboardDepartmentRowSchema>;

/**
 * GET /orgs/:orgId/dashboard/month-to-date — the indicators of the month up to the chosen day (inclusive), in the caller's
 * branch scope. Rates count working days only: present ÷ (present + absent + missing punch).
 */
export const dashboardMonthToDateQuerySchema = z.object({ date: isoDateSchema.optional(), branchId: uuidSchema.optional(), locationId: uuidSchema.optional() });
export const dashboardMonthToDateSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  /** Employee-days the engine judged as working days (present, half day, absent, missing punch). */
  workingDays: z.number().int(),
  presentDays: z.number().int(),
  absentDays: z.number().int(),
  lateDays: z.number().int(),
  lateMinutes: z.number().int(),
  earlyDepartureDays: z.number().int(),
  missingPunchDays: z.number().int(),
  leaveDays: z.number().int(),
  /** Short hours of worked days (the reports' UT), summed. */
  shortfallMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  /** 0–100 with one decimal; null when there was no working day yet. */
  attendanceRate: z.number().nullable(),
  /** Worked minutes per worked day; null when nobody worked yet. */
  avgWorkedMinutes: z.number().int().nullable(),
});
export type DashboardMonthToDate = z.infer<typeof dashboardMonthToDateSchema>;

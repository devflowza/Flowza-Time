import { z } from 'zod';
import { REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES, type ReportType } from '../enums.js';
import type { Permission } from '../permissions.js';
import { isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';

/** Query for GET /report-types: `allowed` is computed against the caller's membership in `orgId`. */
export const reportTypesQuerySchema = z.object({ orgId: uuidSchema.optional() });
export const reportListQuerySchema = paginationQuerySchema.extend({ status: z.enum(REPORT_STATUSES).optional(), reportType: z.enum(REPORT_TYPES).optional() });

export interface ReportTypeDefinition {
  key: ReportType;
  name: string;
  description: string;
  requiredParameters: string[];
  optionalParameters: string[];
  permissions: Permission[];
  formats: (typeof REPORT_FORMATS)[number][];
}

const ALL_FORMATS = [...REPORT_FORMATS];
const DATE_RANGE = ['from', 'to'];
const SCOPE = ['branchId', 'departmentId', 'employeeIds'];

/** Catalogue served by GET /report-types; the worker's GENERATE_REPORT handler implements the same keys. */
export const REPORT_TYPE_DEFINITIONS: readonly ReportTypeDefinition[] = [
  { key: 'daily_attendance', name: 'Daily attendance', description: 'Attendance status of every employee for one day.', requiredParameters: ['from'], optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'monthly_attendance', name: 'Monthly attendance', description: 'Per-employee day grid and totals for a month.', requiredParameters: ['month'], optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'employee_attendance', name: 'Employee attendance', description: 'Detailed attendance history for selected employees.', requiredParameters: [...DATE_RANGE, 'employeeIds'], optionalParameters: [], permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'branch_attendance', name: 'Branch attendance', description: 'Attendance totals grouped by branch.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId'], permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'department_attendance', name: 'Department attendance', description: 'Attendance totals grouped by department.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId'], permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'late_report', name: 'Late arrivals', description: 'Late arrivals with minutes per employee.', requiredParameters: DATE_RANGE, optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'absence_report', name: 'Absences', description: 'Absent days per employee.', requiredParameters: DATE_RANGE, optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'overtime_report', name: 'Overtime', description: 'Overtime minutes by category per employee.', requiredParameters: DATE_RANGE, optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'missing_punch_report', name: 'Missing punches', description: 'Days with a missing IN or OUT punch.', requiredParameters: DATE_RANGE, optionalParameters: SCOPE, permissions: ['report.view', 'attendance.view'], formats: ALL_FORMATS },
  { key: 'device_sync_report', name: 'Device synchronisation', description: 'Sync jobs, failures and ingested records per device.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'deviceIds'], permissions: ['report.view', 'device.view'], formats: ['csv', 'xlsx'] },
  { key: 'device_health_report', name: 'Device health', description: 'Connection status, heartbeats and offline periods per device.', requiredParameters: [], optionalParameters: ['branchId', 'deviceIds'], permissions: ['report.view', 'device.view'], formats: ['csv', 'xlsx'] },
  { key: 'audit_report', name: 'Audit log', description: 'Audit trail export for a date range.', requiredParameters: DATE_RANGE, optionalParameters: [], permissions: ['report.view', 'audit.view'], formats: ['csv', 'xlsx'] },
  { key: 'payroll_summary', name: 'Payroll summary', description: 'Period summaries ready for payroll.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId'], permissions: ['report.view', 'payroll.view'], formats: ALL_FORMATS },
];

export const payrollPeriodsQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), branchId: uuidSchema.optional() });
export const payrollPeriodActionSchema = z.object({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  branchId: uuidSchema.optional(),
  employeeIds: z.array(uuidSchema).max(5000).optional(),
}).refine((v) => v.periodEnd >= v.periodStart, { message: 'periodEnd must be on/after periodStart', path: ['periodEnd'] });
export type PayrollPeriodActionInput = z.infer<typeof payrollPeriodActionSchema>;
export const payrollSummariesQuerySchema = paginationQuerySchema.extend({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  branchId: uuidSchema.optional(),
  status: z.enum(['draft', 'finalized']).optional(),
  search: z.string().trim().max(100).optional(),
});

export interface PayrollPeriodDto {
  periodStart: string;
  periodEnd: string;
  label: string;
  locked: boolean;
  lockId: string | null;
  lockedAt: string | null;
  summaries: { total: number; draft: number; finalized: number; employees: number };
  isCurrent: boolean;
}

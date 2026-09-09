import { z } from 'zod';
import { REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES, type ReportFormat, type ReportType } from '../enums.js';
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
  formats: ReportFormat[];
  /**
   * `available` types have a generator in the worker; `planned` types are kept in the enum for stored rows but are
   * hidden from the catalogue and refused by POST /reports — a request for one would otherwise sit at QUEUED forever.
   */
  status: 'available' | 'planned';
  /** Page orientation of the printed layout. */
  orientation: 'portrait' | 'landscape';
  /** Format pre-selected in the request form. The sample layouts are print documents, so PDF unless noted. */
  defaultFormat: ReportFormat;
}

const ALL_FORMATS: ReportFormat[] = [...REPORT_FORMATS];
const DATA_FORMATS: ReportFormat[] = ['csv', 'xlsx'];
const DATE_RANGE = ['from', 'to'];
const SCOPE = ['branchId', 'departmentId', 'employeeIds'];
const ATTENDANCE: Permission[] = ['report.view', 'attendance.view'];

/** Catalogue served by GET /report-types; the worker's GENERATE_REPORT handler implements the `available` keys. */
export const REPORT_TYPE_DEFINITIONS: readonly ReportTypeDefinition[] = [
  { key: 'daily_attendance', name: 'Daily Report', description: 'Every employee on one day, grouped by department: attendance code, IN/OUT, worked, base and overtime hours.', requiredParameters: ['from'], optionalParameters: ['branchId', 'departmentId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'monthly_attendance', name: 'Monthly Attendance Report', description: 'Employees × days of the month with the attendance code in every cell and an absence count.', requiredParameters: ['month'], optionalParameters: SCOPE, permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'landscape', defaultFormat: 'pdf' },
  { key: 'employee_attendance', name: 'Detail Report', description: 'One page per employee: every day of the period with times, hours, overtime, under time and remarks.', requiredParameters: [...DATE_RANGE, 'employeeIds'], optionalParameters: [], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'branch_attendance', name: 'Branch attendance', description: 'Attendance totals grouped by branch.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'planned', orientation: 'portrait', defaultFormat: 'xlsx' },
  { key: 'department_attendance', name: 'Department attendance', description: 'Attendance totals grouped by department.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'planned', orientation: 'portrait', defaultFormat: 'xlsx' },
  { key: 'late_report', name: 'Staff Late Attendance Report', description: 'Per department: each employee\'s late days of the period and how many.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'absence_report', name: 'Staff Absents Monthly Report', description: 'Per department: each employee\'s absent days of the period and how many.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'overtime_report', name: 'Overtime', description: 'Overtime minutes by category per employee.', requiredParameters: DATE_RANGE, optionalParameters: SCOPE, permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'planned', orientation: 'portrait', defaultFormat: 'xlsx' },
  { key: 'missing_punch_report', name: 'Missed Punch Report', description: 'Every unpaired punch of the period, by date and department, with the time that was recorded.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'device_sync_report', name: 'Device synchronisation', description: 'Sync jobs, failures and ingested records per device.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'deviceIds'], permissions: ['report.view', 'device.view'], formats: DATA_FORMATS, status: 'planned', orientation: 'portrait', defaultFormat: 'xlsx' },
  { key: 'device_health_report', name: 'Device health', description: 'Connection status, heartbeats and offline periods per device.', requiredParameters: [], optionalParameters: ['branchId', 'deviceIds'], permissions: ['report.view', 'device.view'], formats: DATA_FORMATS, status: 'planned', orientation: 'portrait', defaultFormat: 'xlsx' },
  { key: 'audit_report', name: 'Audit Trail Report', description: 'Who changed what: attendance edits with old and new values (In Time, Out Time, Attendance Code), or the full audit log.', requiredParameters: DATE_RANGE, optionalParameters: ['scope', 'branchId', 'employeeIds'], permissions: ['report.view', 'audit.view'], formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'payroll_summary', name: 'Payroll summary', description: 'Period summaries ready for payroll.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId'], permissions: ['report.view', 'payroll.view'], formats: ALL_FORMATS, status: 'planned', orientation: 'landscape', defaultFormat: 'xlsx' },
  { key: 'leave_report', name: 'Staff Leave Report', description: 'Per department: each employee\u2019s days of one leave type in the period and how many (Casual Leave, Sick Leave, ...).', requiredParameters: [...DATE_RANGE, 'leaveTypeCode'], optionalParameters: ['branchId', 'departmentId'], permissions: ['report.view', 'attendance.view', 'leave.view'], formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'attendance_summary', name: 'Summary Report', description: 'One row per employee for the period: days per attendance code grouped into present, leave and absent totals, with OT1, OT2 and under time.', requiredParameters: DATE_RANGE, optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'landscape', defaultFormat: 'pdf' },
  { key: 'weekly_attendance', name: 'Weekly Report', description: 'The week containing the chosen date: first IN and last OUT per employee per day, starting on your first day of the week.', requiredParameters: ['from'], optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'landscape', defaultFormat: 'pdf' },
  { key: 'weekly_in_out', name: 'Weekly In/Out Report', description: 'The week containing the chosen date: IN over OUT for each day, or the attendance code when there were no punches.', requiredParameters: ['from'], optionalParameters: ['branchId', 'departmentId', 'employeeIds'], permissions: ATTENDANCE, formats: ALL_FORMATS, status: 'available', orientation: 'portrait', defaultFormat: 'pdf' },
  { key: 'employee_directory', name: 'Employees Report', description: 'Employees by department with card number, hire date, designation, status, shift and attendance policy.', requiredParameters: [], optionalParameters: ['employmentStatus', 'branchId', 'departmentId', 'employeeIds'], permissions: ['report.view', 'employee.view'], formats: ALL_FORMATS, status: 'available', orientation: 'landscape', defaultFormat: 'pdf' },
];

export const AVAILABLE_REPORT_TYPES: readonly ReportType[] = REPORT_TYPE_DEFINITIONS.filter((d) => d.status === 'available').map((d) => d.key);

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

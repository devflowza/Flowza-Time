/**
 * Feature DTOs (devices, sync, attendance, schedule, reports). Source of truth: packages/contracts/src/dto-features/*.
 * This file is a verbatim copy with imports pointed at the built package until the integrator re-exports dto-features
 * from @flowza/contracts (then delete this file and import from the package).
 */
import { z } from 'zod';
import { APPROVAL_ENTITIES, APPROVAL_STATUSES, APPROVER_TYPES, ASSIGNMENT_TARGETS, CONNECTION_STATUSES, CORRECTION_STATUSES, DEVICE_EMPLOYEE_SYNC_STATUSES, DEVICE_STATUSES, LEAVE_STATUSES, LOG_LEVELS, RECORD_STATUSES, REPORT_FORMATS, REPORT_STATUSES, REPORT_TYPES, SYNC_ITEM_STATUSES, type ReportType, type Permission, booleanQuerySchema, codeSchema, cursorQuerySchema, isoDateSchema, isoDateTimeSchema, jsonObjectSchema, paginationQuerySchema, timezoneSchema, uuidSchema, dailyAttendanceQuerySchema, monthlyAttendanceQuerySchema, attendanceRuleSetInputSchema, holidayCalendarInputSchema, holidayInputSchema, leaveTypeInputSchema, shiftInputSchema, type AttendanceRuleSetInput, type HolidayInput, type ShiftInput } from '@flowza/contracts';

/**
 * PATCH schema derived from a create schema: every field optional and *without* its default. Zod 4 `.partial()` keeps
 * `.default(...)` wrappers, so a one-field PATCH would silently reset every defaulted column (AGENTS.md "Zod 4 pitfalls").
 */
export function updateSchemaOf<T>(shape: z.ZodRawShape): z.ZodType<Partial<T>> {
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) { const inner = field instanceof z.ZodDefault ? (field as z.ZodDefault<z.ZodTypeAny>).removeDefault() : (field as z.ZodTypeAny); out[key] = inner.optional(); }
  return z.object(out) as unknown as z.ZodType<Partial<T>>;
}

// ----- devices -----

/** Query for GET /device-providers: when `orgId` is given the list is filtered by that organisation's provider_* flags. */
export const deviceProvidersQuerySchema = z.object({ orgId: uuidSchema.optional() });
export const deviceModelsQuerySchema = z.object({ providerKey: z.string().min(1).max(64).optional() });

export const deviceListQuerySchema = paginationQuerySchema.extend({
  branchId: uuidSchema.optional(),
  status: z.enum(DEVICE_STATUSES).optional(),
  connectionStatus: z.enum([...CONNECTION_STATUSES, 'vendor_degraded']).optional(),
  providerKey: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
  groupId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  includeDecommissioned: booleanQuerySchema.default(false),
});
export type DeviceListQuery = z.infer<typeof deviceListQuerySchema>;

export const deleteDeviceQuerySchema = z.object({ decommission: booleanQuerySchema.default(false) });

/** Secret config fields keyed by provider config field (validated against the provider's `secretFields`). */
export const deviceCredentialsInputSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.union([z.string().max(4096), z.number(), z.boolean()]))
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one credential field' });
export type DeviceCredentialsInput = z.infer<typeof deviceCredentialsInputSchema>;

export const deviceLogQuerySchema = paginationQuerySchema.extend({
  level: z.enum(LOG_LEVELS).optional(),
  event: z.string().max(80).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export const deviceCommandQuerySchema = paginationQuerySchema.extend({ status: z.enum(['pending', 'sent', 'acked', 'failed', 'expired']).optional() });
export const deviceEmployeeQuerySchema = paginationQuerySchema.extend({
  syncStatus: z.enum(DEVICE_EMPLOYEE_SYNC_STATUSES).optional(),
  desired: booleanQuerySchema.optional(),
  search: z.string().trim().max(100).optional(),
});

export const deviceGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  branchId: uuidSchema.nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
export type DeviceGroupInput = z.infer<typeof deviceGroupInputSchema>;
export const deviceGroupMembersSchema = z.object({ deviceIds: z.array(uuidSchema).min(1).max(500) });

export const pendingDevicesQuerySchema = z.object({ serialNumber: z.string().trim().min(1).max(120).optional() });
export const claimPendingDeviceSchema = z.object({
  branchId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  code: codeSchema,
  timezone: timezoneSchema.optional(),
  modelId: uuidSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});
export type ClaimPendingDeviceInput = z.infer<typeof claimPendingDeviceSchema>;

export const deviceGroupDtoSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  branchId: uuidSchema.nullable(),
  branchName: z.string().nullable().optional(),
  color: z.string().nullable(),
  deviceCount: z.number().int(),
  deviceIds: z.array(uuidSchema).optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DeviceGroupDto = z.infer<typeof deviceGroupDtoSchema>;

export const pendingDeviceDtoSchema = z.object({
  id: uuidSchema,
  providerKey: z.string(),
  serialNumber: z.string(),
  claimCode: z.string(),
  organizationId: uuidSchema.nullable(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  remoteIp: z.string().nullable(),
  deviceInfo: jsonObjectSchema,
  claimedDeviceId: uuidSchema.nullable(),
});
export type PendingDeviceDto = z.infer<typeof pendingDeviceDtoSchema>;

export const deviceLogDtoSchema = z.object({
  id: z.string(),
  deviceId: uuidSchema,
  level: z.enum(LOG_LEVELS),
  event: z.string(),
  message: z.string().nullable(),
  details: jsonObjectSchema.nullable(),
  jobId: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type DeviceLogDto = z.infer<typeof deviceLogDtoSchema>;

export const deviceCommandDtoSchema = z.object({
  id: uuidSchema,
  deviceId: uuidSchema,
  sequence: z.string(),
  commandType: z.string(),
  payload: jsonObjectSchema,
  status: z.enum(['pending', 'sent', 'acked', 'failed', 'expired']),
  syncJobItemId: uuidSchema.nullable(),
  result: jsonObjectSchema.nullable(),
  createdAt: isoDateTimeSchema,
  sentAt: isoDateTimeSchema.nullable(),
  ackedAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema,
});
export type DeviceCommandDto = z.infer<typeof deviceCommandDtoSchema>;

/** Returned once by POST /devices, /pending/:id/claim and /push-token/rotate — the token is never retrievable again. */
export interface DevicePushCredentials { pushToken: string; pushUrl: string | null; webhookUrl: string | null }

export interface TestConnectionResultDto {
  ok: boolean;
  message: string;
  latencyMs: number;
  code: string | null;
  retryable: boolean;
  deviceInfo: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  usedStoredCredentials: boolean;
}

// ----- sync -----

export const syncDeviceScopeSchema = z.object({
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  branchId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  all: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || v.groupId || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify devices, a branch, a group, or all' });
export type SyncDeviceScope = z.infer<typeof syncDeviceScopeSchema>;

export const syncHealthCheckRequestSchema = syncDeviceScopeSchema;
export const syncReconcileRequestSchema = z.object({
  deviceIds: z.array(uuidSchema).max(1000).optional(),
  branchId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  all: z.boolean().default(false),
  /** Create repair jobs (push/delete) for the differences found. */
  repair: z.boolean().default(false),
}).refine((v) => v.all || v.branchId || v.groupId || (v.deviceIds && v.deviceIds.length > 0), { message: 'Specify devices, a branch, a group, or all' });
export type SyncReconcileRequest = z.infer<typeof syncReconcileRequestSchema>;

export const syncJobItemsQuerySchema = paginationQuerySchema.extend({ status: z.enum(SYNC_ITEM_STATUSES).optional(), deviceId: uuidSchema.optional() });
export const reconciliationQuerySchema = z.object({ branchId: uuidSchema.optional(), deviceId: uuidSchema.optional() });

/** 202 body for every sync-job-creating endpoint. `jobId` is the user-facing sync_jobs id. */
export interface SyncJobAcceptedDto { jobId: string; status: 'QUEUED'; message: string; itemsTotal: number; deviceCount: number }

export interface DeviceReconciliationDto {
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  branchId: string;
  syncJobId: string | null;
  itemId: string | null;
  status: string | null;
  finishedAt: string | null;
  summary: Record<string, unknown> | null;
}

// ----- attendance -----

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

// ----- schedule -----

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

// ----- reports -----

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

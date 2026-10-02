import { z } from 'zod';
import type { AttendanceEventType, AttendanceStatus } from '../enums.js';
import { isoDateSchema, isoDateTimeSchema, paginationQuerySchema, uuidSchema } from '../common.js';

/**
 * HR attendance workspace (HR portal Prompt 6a): calendar register, add / edit record with a policy preview, bulk status,
 * punch timeline, monthly summary and the unmatched-punch triage. Every write is a correction (raw stays immutable) or a
 * device identity mapping; nothing here patches a daily record directly.
 */

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');

/** Statuses HR may set by hand (a SET_STATUS correction). PENDING / NOT_JOINED / EXITED / MISSING_PUNCH stay engine-derived. */
export const MANUAL_ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF'] as const satisfies readonly AttendanceStatus[];
export type ManualAttendanceStatus = (typeof MANUAL_ATTENDANCE_STATUSES)[number];

/** Auto = the engine decided the status; Manual = the day carries an applied SET_STATUS correction. */
export const STATUS_SOURCES = ['AUTO', 'MANUAL'] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

const outAfterIn = (v: { inAt?: string | null; outAt?: string | null; removeIn?: boolean; removeOut?: boolean }, ctx: z.RefinementCtx) => {
  if (v.inAt && v.outAt && Date.parse(v.outAt) <= Date.parse(v.inAt)) ctx.addIssue({ code: 'custom', path: ['outAt'], message: 'Check-out must be after check-in' });
  if (v.removeIn && v.inAt) ctx.addIssue({ code: 'custom', path: ['removeIn'], message: 'Either remove the check-in or move it, not both' });
  if (v.removeOut && v.outAt) ctx.addIssue({ code: 'custom', path: ['removeOut'], message: 'Either remove the check-out or move it, not both' });
};

// ---- preview (no writes) ------------------------------------------------------------------------------------------------

/** POST /orgs/:orgId/attendance/preview — the policy-derived status/hours of a day with the proposed check-in / check-out. */
export const attendancePreviewInputSchema = z.object({
  employeeId: uuidSchema,
  date: isoDateSchema,
  /** Proposed check-in (UTC instant); absent or null = keep the day's current check-in. */
  inAt: isoDateTimeSchema.nullish(),
  /** Proposed check-out (UTC instant); absent or null = keep the day's current check-out. */
  outAt: isoDateTimeSchema.nullish(),
  /** Remove the day's check-in (the first IN the engine attributed): what clearing the check-in time means. */
  removeIn: z.boolean().optional(),
  /** Remove the day's check-out (the last OUT the engine attributed): what clearing the check-out time means. */
  removeOut: z.boolean().optional(),
}).superRefine(outAfterIn);
export type AttendancePreviewInput = z.infer<typeof attendancePreviewInputSchema>;

/** What the engine makes of a day (a subset of the daily record). */
export interface AttendanceEngineOutcomeDto {
  status: AttendanceStatus;
  flags: string[];
  firstInAt: string | null;
  lastOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  scheduledMinutes: number;
  punchCount: number;
  lopDays: number;
}

/** A correction the record edit would file (the preview shows the plan; the edit endpoint files exactly this plan). */
export interface PlannedCorrectionDto {
  type: 'ADD_PUNCH' | 'EDIT_PUNCH' | 'REMOVE_PUNCH' | 'SET_STATUS';
  originalEventId: string | null;
  originalPunchedAt: string | null;
  proposedPunchedAt: string | null;
  proposedEventType: AttendanceEventType | null;
  proposedStatus: AttendanceStatus | null;
}

export interface AttendancePreviewDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  date: string;
  /** IANA zone of the day (branch, else organisation). */
  timezone: string;
  recordId: string | null;
  shift: { id: string; code: string; name: string; expectedStartAt: string | null; expectedEndAt: string | null; scheduledMinutes: number } | null;
  /** The engine on the day's real inputs, unchanged. */
  current: AttendanceEngineOutcomeDto;
  /** The engine with the proposed check-in / check-out applied (equal to `current` when nothing is proposed). */
  preview: AttendanceEngineOutcomeDto;
  /** Whether the day's stored status comes from the engine or from an applied SET_STATUS correction (which the engine does not see). */
  statusSource: StatusSource;
  manualStatus: AttendanceStatus | null;
  /** The punches an edit would replace: the first IN and the last OUT the engine attributed to the day. */
  punches: { in: { eventId: string; punchedAt: string } | null; out: { eventId: string; punchedAt: string } | null };
  plan: PlannedCorrectionDto[];
  /** Corrections of the day still pending or approved-but-not-yet-applied. */
  pendingCorrections: number;
  /** The date sits in a locked period (edits would be refused). */
  locked: boolean;
}

// ---- record edit (Add / Edit record dialog) -----------------------------------------------------------------------------

/** POST /orgs/:orgId/attendance/record-edits — files ADD_PUNCH / EDIT_PUNCH / REMOVE_PUNCH / SET_STATUS corrections through the engine path. */
export const attendanceRecordEditSchema = z.object({
  employeeId: uuidSchema,
  date: isoDateSchema,
  inAt: isoDateTimeSchema.nullish(),
  outAt: isoDateTimeSchema.nullish(),
  /** Remove the day's check-in / check-out (the time was cleared in the dialog): files a REMOVE_PUNCH correction for it. */
  removeIn: z.boolean().optional(),
  removeOut: z.boolean().optional(),
  /** Manual status override; absent = keep the policy-derived status. */
  status: z.enum(MANUAL_ATTENDANCE_STATUSES).optional(),
  reason: z.string().trim().min(3).max(1000),
}).superRefine((v, ctx) => {
  outAfterIn(v, ctx);
  if (!v.inAt && !v.outAt && !v.removeIn && !v.removeOut && !v.status) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Set a check-in, a check-out or a status' });
});
export type AttendanceRecordEditInput = z.infer<typeof attendanceRecordEditSchema>;

export interface FiledCorrectionDto { id: string; type: PlannedCorrectionDto['type']; status: string; approval: 'AUTO_APPROVED' | 'PENDING' }
export interface AttendanceRecordEditResultDto {
  corrections: FiledCorrectionDto[];
  /** Every filed correction was auto-approved (the worker applies them and recomputes the day within seconds). */
  applied: boolean;
  /** Present when a later correction of the plan failed after earlier ones were filed. */
  failed: { type: PlannedCorrectionDto['type']; code: string; message: string } | null;
  /** Plan items skipped because they changed nothing (the time already matches). */
  unchanged: number;
  /** Server time the corrections were filed: the day's record is up to date once it was computed after this (absent on an older API). */
  filedAt?: string;
}

// ---- bulk status ------------------------------------------------------------------------------------------------------------

export const BULK_STATUS_MAX_ITEMS = 200;
/** POST /orgs/:orgId/attendance/bulk-status — one SET_STATUS correction per row, one reason. */
export const bulkAttendanceStatusSchema = z.object({
  items: z.array(z.object({ employeeId: uuidSchema, date: isoDateSchema })).min(1).max(BULK_STATUS_MAX_ITEMS),
  status: z.enum(MANUAL_ATTENDANCE_STATUSES),
  reason: z.string().trim().min(3).max(1000),
});
export type BulkAttendanceStatusInput = z.infer<typeof bulkAttendanceStatusSchema>;
export interface BulkStatusItemResultDto {
  employeeId: string;
  date: string;
  ok: boolean;
  correctionId?: string;
  approval?: 'AUTO_APPROVED' | 'PENDING';
  error?: { code: string; message: string };
}
export interface BulkStatusResultDto { results: BulkStatusItemResultDto[]; succeeded: number; failed: number; autoApproved: number; pending: number }

// ---- Auto / Manual status source --------------------------------------------------------------------------------------------

/**
 * GET /orgs/:orgId/attendance/manual-statuses — the days in a range whose status is a manual override (an applied SET_STATUS
 * correction, latest wins), so the register can badge `Manual` next to the engine's `Auto` without widening the daily DTO.
 */
export const manualStatusesQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  branchId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
}).refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] })
  .refine((v) => Date.parse(`${v.to}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`) <= 62 * 86_400_000, { message: 'At most 62 days', path: ['to'] });
export type ManualStatusesQuery = z.infer<typeof manualStatusesQuerySchema>;
export interface ManualStatusDto { employeeId: string; date: string; status: AttendanceStatus; correctionId: string; reason: string; appliedAt: string | null }

// ---- calendar ------------------------------------------------------------------------------------------------------------

export const attendanceCalendarQuerySchema = z.object({
  month: monthSchema,
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
export type AttendanceCalendarQuery = z.infer<typeof attendanceCalendarQuerySchema>;
export interface AttendanceCalendarDayDto {
  recordId: string;
  status: AttendanceStatus;
  flags: string[];
  statusSource: StatusSource;
  firstInAt: string | null;
  lastOutAt: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  timezone: string;
}
export interface AttendanceCalendarRowDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string;
  departmentId: string | null;
  joiningDate: string;
  exitDate: string | null;
  days: Record<string, AttendanceCalendarDayDto>;
}

// ---- monthly summary --------------------------------------------------------------------------------------------------------

export const attendanceSummaryQuerySchema = z.object({
  month: monthSchema,
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AttendanceSummaryQuery = z.infer<typeof attendanceSummaryQuerySchema>;
/** The summary's filters without paging (the set an export covers). */
export const attendanceSummaryFiltersSchema = attendanceSummaryQuerySchema.omit({ page: true, pageSize: true });
export type AttendanceSummaryFilters = z.infer<typeof attendanceSummaryFiltersSchema>;
/**
 * POST /orgs/:orgId/attendance/summary/export — the summary of the filtered set as a FILE, generated by the worker like every
 * other report (report type `monthly_summary`, HR portal Prompt 6a review — defect 10): 202 with the report request id; the
 * file is downloaded from the Reports page (report.export, owner-only signed URL).
 */
export const attendanceSummaryExportSchema = attendanceSummaryFiltersSchema.extend({
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  /** Required when the organisation asks for a reason on exports (Settings → Security). */
  reason: z.string().trim().max(500).optional(),
});
export type AttendanceSummaryExportInput = z.infer<typeof attendanceSummaryExportSchema>;
/** Rows one export may hold; above it the export asks for a branch / department filter. */
export const ATTENDANCE_SUMMARY_EXPORT_MAX_ROWS = 10_000;

/**
 * The figures of one employee-month (same fractions as the period summary: a half day counts 0.5 present). Every calculated day
 * of employment adds up to one across present / absent / leave / missing punch / holiday / weekly off / pending (a half day is
 * ½ present + ½ absent or leave); a day never calculated is in `notCalculatedDays` instead. Late and half days count across them.
 */
export interface AttendanceSummaryFigures {
  presentDays: number;
  lateDays: number;
  halfDays: number;
  leaveDays: number;
  absentDays: number;
  /** Days whose check-in or check-out is missing so the hours are unknown (status MISSING_PUNCH): not in present nor days worked. */
  missingPunchDays: number;
  holidayDays: number;
  weeklyOffDays: number;
  /** Days with worked time (weekly-off / holiday work included). */
  daysWorked: number;
  workedMinutes: number;
  overtimeMinutes: number;
  /** Worked minutes ÷ days worked (0 without worked days). */
  averageWorkedMinutes: number;
  lopDays: number;
  unexcusedDays: number;
  pendingDays: number;
  recordCount: number;
  /** Days of employment in the month, up to yesterday, that have no calculated record yet (a recalculation fills them). */
  notCalculatedDays: number;
}
export interface AttendanceSummaryRowDto extends AttendanceSummaryFigures {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  branchId: string;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  /** FINALIZED = the day counts come from the finalised payroll period summary of this month (visible with payroll.view). */
  source: 'LIVE' | 'FINALIZED';
  finalizedAt: string | null;
}
/** 202 of POST …/attendance/summary/export: the queued report request (download it from the Reports page when COMPLETED). */
export interface AttendanceSummaryExportDto { reportId: string; jobId: string | null; status: 'QUEUED'; reportType: 'monthly_summary'; rowCount: number }

// ---- punch timeline -----------------------------------------------------------------------------------------------------------

export const attendanceTimelineQuerySchema = z.object({ employeeId: uuidSchema, date: isoDateSchema });
export type AttendanceTimelineQuery = z.infer<typeof attendanceTimelineQuerySchema>;
/** Self-service / connector facts read from the raw payload's allow-listed keys (only for attendance.view_raw holders). */
export interface PunchFactsDto {
  channel?: string;
  geofenceVerdict?: string;
  geofenceId?: string;
  distanceM?: number;
  lat?: number;
  lng?: number;
  accuracy?: number;
  isMock?: boolean;
  outOfWindow?: boolean;
}
export interface TimelineEventDto {
  id: string;
  punchedAt: string;
  eventType: string;
  source: string;
  verificationMethod: string | null;
  deviceId: string | null;
  deviceName: string | null;
  voidedAt: string | null;
  voidedByCorrectionId: string | null;
  correctionId: string | null;
  note: string | null;
  rawTransactionId: string | null;
  /** The engine's role for the punch on this day (IN, OUT, IGNORED, DUPLICATE, …); null when not attributed to the day. */
  role: string | null;
}
export interface TimelineRawDto {
  id: string;
  punchedAt: string;
  deviceId: string | null;
  deviceName: string | null;
  deviceEmployeeId: string | null;
  direction: string | null;
  verificationMethod: string | null;
  source: string;
  processingStatus: string;
  processingError: string | null;
  receivedAt: string;
  deviceLocalTime: string | null;
  clockSkewSeconds: number | null;
  facts: PunchFactsDto;
}
export interface AttendanceTimelineDto {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  date: string;
  timezone: string;
  recordId: string | null;
  status: AttendanceStatus | null;
  window: { from: string; to: string };
  events: TimelineEventDto[];
  /** Raw device transactions of the window; null when the caller lacks attendance.view_raw. */
  raw: TimelineRawDto[] | null;
}

// ---- unmatched punch triage --------------------------------------------------------------------------------------------------

export const UNMATCHED_STATUSES = ['unmatched', 'ignored'] as const;
export const unmatchedPunchesQuerySchema = paginationQuerySchema.extend({
  status: z.enum(UNMATCHED_STATUSES).default('unmatched'),
  deviceId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  search: z.string().trim().max(64).optional(),
});
export type UnmatchedPunchesQuery = z.infer<typeof unmatchedPunchesQuerySchema>;
export interface UnmatchedSuggestionDto { employeeId: string; employeeNumber: string; displayName: string; reason: 'device_user_id' | 'employee_number' }
/**
 * Devices whose punches are NOT attributed through the device identity mapping (HR portal Prompt 6a review — defect 4), so an
 * Assign could only write a mapping the normaliser never reads: the Flowza Finance connector resolves by employee number
 * (fix the number in FlowZa Time or in Finance), the self-service device by the member's linked employee.
 */
export const UNMATCHED_ASSIGN_BLOCKED_PROVIDERS = {
  flowza_finance: 'CONNECTOR_RESOLVES_BY_EMPLOYEE_NUMBER',
  self_service: 'SELF_SERVICE_RESOLVES_BY_MEMBERSHIP',
} as const;
export type UnmatchedAssignBlockedReason = (typeof UNMATCHED_ASSIGN_BLOCKED_PROVIDERS)[keyof typeof UNMATCHED_ASSIGN_BLOCKED_PROVIDERS];
/** Why Assign is refused for a device's provider, or null when the device identity mapping decides. */
export function unmatchedAssignBlockedReason(providerKey: string): UnmatchedAssignBlockedReason | null {
  return (UNMATCHED_ASSIGN_BLOCKED_PROVIDERS as Record<string, UnmatchedAssignBlockedReason>)[providerKey] ?? null;
}
export interface UnmatchedPunchGroupDto {
  deviceId: string;
  deviceName: string | null;
  deviceCode: string | null;
  providerKey: string;
  branchId: string | null;
  branchName: string | null;
  deviceEmployeeId: string;
  status: (typeof UNMATCHED_STATUSES)[number];
  count: number;
  firstPunchAt: string;
  lastPunchAt: string;
  lastReceivedAt: string;
  /** Empty when Assign is refused for the device (`assignBlockedReason`). */
  suggestions: UnmatchedSuggestionDto[];
  /** Set when Assign cannot work on this device (connector / system device); the UI shows the fix instead of the action. */
  assignBlockedReason: UnmatchedAssignBlockedReason | null;
}
const deviceUserSchema = z.object({ deviceId: uuidSchema, deviceEmployeeId: z.string().trim().min(1).max(64) });
export const unmatchedAssignSchema = deviceUserSchema.extend({ employeeId: uuidSchema });
export type UnmatchedAssignInput = z.infer<typeof unmatchedAssignSchema>;
export const unmatchedIgnoreSchema = deviceUserSchema.extend({ reason: z.string().trim().min(3).max(500) });
export type UnmatchedIgnoreInput = z.infer<typeof unmatchedIgnoreSchema>;
export const unmatchedRestoreSchema = deviceUserSchema;
export type UnmatchedRestoreInput = z.infer<typeof unmatchedRestoreSchema>;
export interface UnmatchedActionResultDto {
  deviceId: string;
  deviceEmployeeId: string;
  /** Rows moved by the action (re-queued for the normaliser, or ignored). */
  rows: number;
  employeeId?: string;
  /** Normaliser job (queue id) when rows were re-queued. */
  jobId?: string | null;
}

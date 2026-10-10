import { z } from 'zod';
import { REPORT_FORMATS, REPORT_TYPES, type ReportFormat, type ReportType } from '../enums.js';
import { codeSchema, isoDateSchema, paginationQuerySchema, timeSchema, uuidSchema } from '../common.js';
import { MONTHLY_ATTENDANCE_LAYOUTS, reportParametersSchema } from '../reports.js';
import { updateSchemaOf } from './devices.js';
import { REPORT_TYPE_DEFINITIONS } from './reports.js';

/**
 * Report sharing and schedules (HR portal Prompt 6a). A share ("Send now") or a scheduled run is a DISTRIBUTION of a report
 * type + filters: every recipient receives a report generated under THEIR OWN access scope (the exact parameters
 * POST /reports would build if that recipient asked for it) — recipients who could not request the report themselves are
 * skipped with a reason, never sent a copy of the sender's data. The file is fetched through the recipient's authenticated
 * session (a 5-minute signed URL minted on click); no bearer link ever leaves the application.
 */

export const REPORT_SCHEDULE_CADENCES = ['monthly', 'weekly'] as const;
export type ReportScheduleCadence = (typeof REPORT_SCHEDULE_CADENCES)[number];
export const REPORT_PERIOD_RULES = ['previous_month', 'month_to_date', 'previous_week', 'custom'] as const;
export type ReportPeriodRule = (typeof REPORT_PERIOD_RULES)[number];
/** Period rules a cadence may use (mirrors report_schedules_cadence_period_check). */
export const PERIOD_RULES_BY_CADENCE: Record<ReportScheduleCadence, readonly ReportPeriodRule[]> = {
  monthly: ['previous_month', 'month_to_date', 'custom'],
  weekly: ['previous_week', 'month_to_date'],
};
export const REPORT_DELIVERY_CHANNELS = ['in_app', 'email'] as const;
export type ReportDeliveryChannel = (typeof REPORT_DELIVERY_CHANNELS)[number];
/** `cancelled`: the recipient cancelled their queued copy (HR portal Prompt 6a review — minor 14). */
export const REPORT_DELIVERY_STATUSES = ['queued', 'delivered', 'skipped', 'failed', 'cancelled'] as const;
export type ReportDeliveryStatus = (typeof REPORT_DELIVERY_STATUSES)[number];
export const REPORT_DELIVERY_MODES = ['schedule', 'manual', 'send_now'] as const;
export type ReportDeliveryMode = (typeof REPORT_DELIVERY_MODES)[number];
export const REPORT_SCHEDULE_RUN_STATUSES = ['success', 'partial', 'failed', 'skipped'] as const;
export type ReportScheduleRunStatus = (typeof REPORT_SCHEDULE_RUN_STATUSES)[number];

export const REPORT_RECIPIENT_MAX_USERS = 50;
export const REPORT_RECIPIENT_MAX_ROLES = 10;
/** Resolved recipients of one share / run (explicit users + holders of the chosen roles), after de-duplication. */
export const REPORT_RECIPIENT_MAX_RESOLVED = 100;
/** Shares + run-now per organisation per hour (every share fans out to up to REPORT_RECIPIENT_MAX_RESOLVED generations). */
export const REPORT_SHARES_PER_HOUR = 10;

/**
 * Report types a schedule / share can carry: every available type whose period can be derived from a date range. The daily
 * report covers ONE day, which neither cadence produces, so it is shared from the Reports page as an ordinary request.
 */
export const SCHEDULABLE_REPORT_TYPES: readonly ReportType[] = REPORT_TYPE_DEFINITIONS
  .filter((d) => d.status === 'available' && d.key !== 'daily_attendance')
  .map((d) => d.key);

/** Types whose period parameter is a whole month (`month`): only whole-month rules make sense for them. */
export const MONTH_PARAMETER_REPORT_TYPES: readonly ReportType[] = REPORT_TYPE_DEFINITIONS.filter((d) => d.requiredParameters.includes('month')).map((d) => d.key);
/** Types that print the week containing `from`: only the previous-week rule produces one whole week. */
export const WEEK_PARAMETER_REPORT_TYPES: readonly ReportType[] = REPORT_TYPE_DEFINITIONS
  .filter((d) => d.requiredParameters.includes('from') && !d.requiredParameters.includes('to') && d.key !== 'daily_attendance')
  .map((d) => d.key);

/** The report's own parameters minus the period (which the period rule derives at run time). */
export const reportScheduleFiltersSchema = z.object({
  branchId: uuidSchema.optional(),
  /** As `reportParametersSchema.locationId`: a group / branch location → its branches; a place → the employees working in it or below. */
  locationId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeIds: z.array(uuidSchema).min(1).max(500).optional(),
  leaveTypeCode: codeSchema.optional(),
  employmentStatus: z.enum(['active', 'inactive', 'all']).optional(),
  scope: z.enum(['attendance', 'all']).optional(),
  layout: z.enum(MONTHLY_ATTENDANCE_LAYOUTS).optional(),
  locale: z.enum(['en', 'ar']).optional(),
}).strict();
export type ReportScheduleFilters = z.infer<typeof reportScheduleFiltersSchema>;

export const reportRecipientsSchema = z.object({
  /** Specific members (including the managers picked in the Managers list). */
  userIds: z.array(uuidSchema).max(REPORT_RECIPIENT_MAX_USERS).default([]),
  /** Every active member holding one of these roles at run time (e.g. hr_admin). */
  roleKeys: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(REPORT_RECIPIENT_MAX_ROLES).default([]),
}).refine((r) => r.userIds.length + r.roleKeys.length > 0, { message: 'Choose at least one recipient', path: ['userIds'] });
export type ReportRecipients = z.infer<typeof reportRecipientsSchema>;

const channelsSchema = z.array(z.enum(REPORT_DELIVERY_CHANNELS)).min(1).max(2).transform((c) => [...new Set(c)]);

const periodRuleRefinement = (v: { cadence?: ReportScheduleCadence; periodRule?: ReportPeriodRule; runDay?: number; customFromDay?: number | null; customToDay?: number | null; reportType?: ReportType }, ctx: z.RefinementCtx) => {
  if (v.cadence && v.periodRule && !PERIOD_RULES_BY_CADENCE[v.cadence].includes(v.periodRule)) ctx.addIssue({ code: 'custom', path: ['periodRule'], message: `A ${v.cadence} schedule cannot use ${v.periodRule}` });
  if (v.cadence === 'monthly' && v.runDay !== undefined && (v.runDay < 1 || v.runDay > 28)) ctx.addIssue({ code: 'custom', path: ['runDay'], message: 'Run day must be 1–28' });
  if (v.cadence === 'weekly' && v.runDay !== undefined && (v.runDay < 0 || v.runDay > 6)) ctx.addIssue({ code: 'custom', path: ['runDay'], message: 'Run day must be a weekday (0–6)' });
  if (v.periodRule === 'custom' && (v.customFromDay == null || v.customToDay == null)) ctx.addIssue({ code: 'custom', path: ['customFromDay'], message: 'A custom period needs a from day and a to day' });
  if (v.periodRule === 'custom' && v.customFromDay != null && v.customToDay != null && v.customFromDay <= v.customToDay) {
    ctx.addIssue({ code: 'custom', path: ['customFromDay'], message: 'A custom period runs from a day of the previous month to an earlier day of the next (e.g. 26 → 25)' });
  }
  if (v.reportType && !SCHEDULABLE_REPORT_TYPES.includes(v.reportType)) ctx.addIssue({ code: 'custom', path: ['reportType'], message: 'This report type cannot be scheduled' });
  if (v.reportType && MONTH_PARAMETER_REPORT_TYPES.includes(v.reportType) && v.periodRule && v.periodRule !== 'previous_month' && v.periodRule !== 'month_to_date') {
    ctx.addIssue({ code: 'custom', path: ['periodRule'], message: 'This report covers a whole month: use previous month or month to date' });
  }
  if (v.reportType && WEEK_PARAMETER_REPORT_TYPES.includes(v.reportType) && v.periodRule && v.periodRule !== 'previous_week') {
    ctx.addIssue({ code: 'custom', path: ['periodRule'], message: 'This report covers one week: use a weekly schedule with the previous week' });
  }
};

const scheduleShape = {
  name: z.string().trim().min(1).max(120),
  reportType: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS).default('pdf'),
  filters: reportScheduleFiltersSchema.default({}),
  cadence: z.enum(REPORT_SCHEDULE_CADENCES),
  /** monthly: day of month 1–28; weekly: 0 = Sunday … 6 = Saturday. */
  runDay: z.coerce.number().int().min(0).max(28),
  /** Local time (organisation timezone) the run starts. */
  runTime: timeSchema.default('07:00'),
  periodRule: z.enum(REPORT_PERIOD_RULES),
  /** custom: the period runs from `customFromDay` of the previous month to `customToDay` of the run month. */
  customFromDay: z.coerce.number().int().min(1).max(28).nullish(),
  customToDay: z.coerce.number().int().min(1).max(28).nullish(),
  recipients: reportRecipientsSchema,
  channels: channelsSchema.default(['in_app', 'email']),
  isActive: z.boolean().default(true),
};

export const createReportScheduleSchema = z.object(scheduleShape).superRefine(periodRuleRefinement);
export type CreateReportScheduleInput = z.infer<typeof createReportScheduleSchema>;
/** PATCH: every field optional and default-free (a `.partial()` would re-apply the defaults and overwrite stored values). */
export const updateReportScheduleSchema = updateSchemaOf<CreateReportScheduleInput>(scheduleShape);
export type UpdateReportScheduleInput = Partial<CreateReportScheduleInput>;

export const reportScheduleListQuerySchema = paginationQuerySchema.extend({ reportType: z.enum(REPORT_TYPES).optional() });
export const reportDeliveryListQuerySchema = paginationQuerySchema.extend({
  scheduleId: uuidSchema.optional(),
  status: z.enum(REPORT_DELIVERY_STATUSES).optional(),
  mode: z.enum(REPORT_DELIVERY_MODES).optional(),
});

/** POST /orgs/:orgId/reports/share — generate now for every recipient under their own scope. */
export const shareReportSchema = z.object({
  reportType: z.enum(REPORT_TYPES),
  format: z.enum(REPORT_FORMATS).default('pdf'),
  /** Same parameters as POST /reports (period included); recipient scopes are applied per recipient by the worker. */
  parameters: reportParametersSchema.default({}),
  recipients: reportRecipientsSchema,
  channels: channelsSchema.default(['in_app', 'email']),
  note: z.string().trim().max(500).optional(),
});
export type ShareReportInput = z.infer<typeof shareReportSchema>;

export interface ReportScheduleDto {
  id: string;
  name: string;
  reportType: ReportType;
  format: ReportFormat;
  filters: ReportScheduleFilters;
  branchId: string | null;
  cadence: ReportScheduleCadence;
  runDay: number;
  runTime: string;
  periodRule: ReportPeriodRule;
  customFromDay: number | null;
  customToDay: number | null;
  recipients: { userIds: string[]; roleKeys: string[] };
  channels: ReportDeliveryChannel[];
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ReportScheduleRunStatus | null;
  lastError: string | null;
  lastSummary: ReportRunSummaryDto | null;
  /** The period the next run will cover (organisation timezone). */
  nextPeriod: { from: string; to: string } | null;
  timezone: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRunSummaryDto {
  period: { from: string; to: string } | null;
  recipients: number;
  queued: number;
  skipped: number;
  failed: number;
}

export interface ReportDeliveryDto {
  id: string;
  scheduleId: string | null;
  scheduleName: string | null;
  mode: ReportDeliveryMode;
  reportType: string;
  format: ReportFormat;
  periodFrom: string | null;
  periodTo: string | null;
  recipientUserId: string;
  recipientName: string | null;
  sentBy: string | null;
  sentByName: string | null;
  channels: ReportDeliveryChannel[];
  /** The access scope the recipient's copy was generated under (TEAM = the recipient's direct reports; SELF = only their own record). */
  scope: { kind?: 'ORGANIZATION' | 'BRANCHES' | 'TEAM' | 'SELF'; branchCount?: number; employeeCount?: number };
  status: ReportDeliveryStatus;
  skipReason: string | null;
  error: string | null;
  reportRequestId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * Recipient picker: members (with the facts the UI groups by) and the roles of the organisation. A branch-scoped caller gets the
 * members whose access or employee record touches one of their branches; `email` is null unless the caller holds user.view
 * (HR portal Prompt 6a review — minor 12).
 */
export interface ReportRecipientOptionsDto {
  users: Array<{ userId: string; displayName: string; email: string | null; roleKey: string; roleName: string; isManager: boolean; branchCount: number | null }>;
  roles: Array<{ key: string; name: string; members: number }>;
}

export interface ReportShareResultDto { jobId: string | null; runKey: string; status: 'QUEUED'; recipients: number }
export interface ReportRunNowResultDto { jobId: string | null; runKey: string; status: 'QUEUED'; period: { from: string; to: string } | null }

/** Occurrence period stored with a delivery (inclusive local dates). */
export const reportPeriodSchema = z.object({ from: isoDateSchema, to: isoDateSchema });

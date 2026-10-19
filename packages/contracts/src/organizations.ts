import { z } from 'zod';
import { MEMBERSHIP_STATUSES, ORG_STATUSES, RECORD_STATUSES } from './enums.js';
import { addressSchema, codeSchema, contactSchema, countryCodeSchema, currencyCodeSchema, emailSchema, isoDateTimeSchema, timeSchema, timezoneSchema, uuidSchema, weeklyOffDaysSchema } from './common.js';
import { PERMISSIONS } from './permissions.js';

export const organizationDtoSchema = z.object({
  id: uuidSchema,
  companyCode: z.string(),
  legalName: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  timezone: z.string(),
  currencyCode: z.string(),
  locale: z.string(),
  weeklyOffDays: z.array(z.number()),
  logoPath: z.string().nullable(),
  logoUrl: z.string().nullable().optional(),
  contact: contactSchema,
  address: addressSchema,
  status: z.enum(ORG_STATUSES),
  createdAt: isoDateTimeSchema,
});
export type OrganizationDto = z.infer<typeof organizationDtoSchema>;

export const createOrganizationSchema = z.object({
  companyCode: codeSchema,
  legalName: z.string().trim().min(2).max(200),
  displayName: z.string().trim().min(2).max(120),
  countryCode: countryCodeSchema.default('OM'),
  timezone: timezoneSchema.default('Asia/Muscat'),
  currencyCode: currencyCodeSchema.default('OMR'),
  locale: z.enum(['en', 'ar']).default('en'),
  weeklyOffDays: weeklyOffDaysSchema.default([5, 6]),
  contact: contactSchema.default({}),
  address: addressSchema.default({}),
  ownerEmail: emailSchema,
  ownerFullName: z.string().trim().min(1).max(160),
  planKey: z.string().trim().min(1).max(64).default('trial'),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/**
 * Self-service tenant creation (`POST /orgs`): the caller becomes the owner of a trial organisation. Deliberately much
 * smaller than the platform console's schema — no plan, no owner lookup, and the company code is derived from the
 * display name when omitted, so a sign-up form only has to ask for the company name.
 */
export const createOwnOrganizationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(200).optional(),
  companyCode: codeSchema.optional(),
  countryCode: countryCodeSchema.default('OM'),
  timezone: timezoneSchema.default('Asia/Muscat'),
  currencyCode: currencyCodeSchema.default('OMR'),
  locale: z.enum(['en', 'ar']).default('en'),
  ownerFullName: z.string().trim().min(1).max(160).optional(),
});
export type CreateOwnOrganizationInput = z.infer<typeof createOwnOrganizationSchema>;
export const createOwnOrganizationResultSchema = z.object({ organization: organizationDtoSchema, membershipId: uuidSchema });
export type CreateOwnOrganizationResult = z.infer<typeof createOwnOrganizationResultSchema>;
/** PATCH body: no creation defaults (a `.partial()` of the create schema would re-apply them and reset omitted fields). */
export const updateOrganizationSchema = z.object({
  legalName: z.string().trim().min(2).max(200).optional(),
  displayName: z.string().trim().min(2).max(120).optional(),
  countryCode: countryCodeSchema.optional(),
  timezone: timezoneSchema.optional(),
  currencyCode: currencyCodeSchema.optional(),
  locale: z.enum(['en', 'ar']).optional(),
  weeklyOffDays: weeklyOffDaysSchema.optional(),
  contact: contactSchema.optional(),
  address: addressSchema.optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Dashboard styles a tenant can pick under Settings → Dashboard. Each key has a `[data-theme]` block in the web app's
 * `globals.css` (sidebar, brand scale, accent, chart palette); the web app's `DASHBOARD_THEME_META` carries the labels.
 */
export const DASHBOARD_THEMES = ['emerald', 'midnight', 'classic', 'desert', 'ocean', 'graphite', 'crimson'] as const;
export type DashboardTheme = (typeof DASHBOARD_THEMES)[number];
/** Which widgets the dashboard shows and how they are arranged. */
export const DASHBOARD_LAYOUTS = ['overview', 'operations', 'executive'] as const;
export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];
/** Days shown by the attendance trend chart. */
export const DASHBOARD_TREND_RANGES = [7, 14, 30] as const;
export type DashboardTrendRange = (typeof DASHBOARD_TREND_RANGES)[number];

/** A local-time window (`HH:mm`), e.g. the hours in which a self-service check-in is accepted; may wrap midnight. */
export const timeWindowSchema = z.object({ start: timeSchema, end: timeSchema });
export type TimeWindow = z.infer<typeof timeWindowSchema>;

/** Pay effect of one unexcused day in days (0 = no deduction, 0.5 = half a day, 1 = a full day). */
export const payEffectDaysSchema = z.union([z.literal(0), z.literal(0.5), z.literal(1)]);
/** A single IPv4/IPv6 address or a CIDR block for the self-service IP allow-list. */
export const ipOrCidrSchema = z.union([z.cidrv4(), z.cidrv6(), z.ipv4(), z.ipv6()]);
/** Leave-type codes as the tenant configured them (the catalogue's `code` column is case-insensitive). */
const leaveTypeCodeSchema = z.string().trim().min(1).max(32).transform((v) => v.toUpperCase());

/** What a self-service check-in must satisfy before it is stored (HR portal Prompt 3; enforced by the punch endpoint of Prompt 4). */
export const attendanceSelfServiceSettingsSchema = z.object({
  /**
   * Web check-in switch (default off — tenants opt in). The web / mobile switches judge the channel the CLIENT declares
   * (`channel` of the punch): the apps respect them, but they are a product switch, not a security control — the location,
   * geofence, IP allow-list and window rules are what an adversarial client cannot get around (HR portal Prompt 4 review, P2-8).
   */
  webCheckIn: z.boolean().default(false),
  /** Mobile check-in switch (default off; client-declared channel, see `webCheckIn`). */
  mobileCheckIn: z.boolean().default(false),
  /**
   * Employees may file regularisation requests (missed / wrong punch, WFH unmarked, system downtime) from the portal (default
   * on). Independent of `allowSelfServiceCorrections`: a regularisation is always decided through the approval engine and its
   * outcome is applied on behalf of that approval (the audit names the approver) — HR-only rules for DIRECT corrections stand.
   */
  regularisation: z.boolean().default(true),
  /** How an outside-geofence punch is treated: ignored, stored with the OUTSIDE_GEOFENCE flag, or refused. */
  requireGeofence: z.enum(['off', 'flag', 'block']).default('flag'),
  /** Selfie check-in for employees with an open-attendance grant. */
  allowSelfieCheckIn: z.boolean().default(false),
  /** Empty = any address; otherwise a punch must come from one of these addresses / CIDR blocks. */
  ipAllowList: z.array(ipOrCidrSchema).max(50).default([]),
  /** Local-time windows in which a check-in / check-out is expected; null = any time of day. */
  checkInWindow: timeWindowSchema.nullable().default(null),
  checkOutWindow: timeWindowSchema.nullable().default(null),
  /** A punch outside its window is accepted silently, stored with the OUT_OF_WINDOW flag, or refused. */
  outOfWindowAction: z.enum(['accept', 'flag', 'reject']).default('flag'),
  /** A second self-service punch within this many seconds is answered as a duplicate (replay guard). */
  duplicatePunchSeconds: z.number().int().min(0).max(3600).default(60),
});

/** Missed-punch detection and the day-close grace: how many days after a day the sweep may judge it. */
export const attendanceMissedPunchSettingsSchema = z.object({
  detectionEnabled: z.boolean().default(true),
  /** Days after an attendance date before the day-close sweep marks it (0–7). */
  dayCloseGraceDays: z.number().int().min(0).max(7).default(2),
  /** A single device punch on a working day before this local time is a check-in, after it a check-out. */
  singlePunchSplitTime: timeSchema.default('12:00'),
});

/**
 * Work on a weekly off / holiday: count it as overtime (default — customer review: hours worked on a weekly off are overtime,
 * calculated and recorded automatically; the rule set's weekly-off / holiday overtime switches and daily cap still apply),
 * record it (status stays WEEKLY_OFF/HOLIDAY, minutes kept, no overtime) or ignore it (zero minutes).
 */
export const attendanceNonWorkingDaySettingsSchema = z.object({
  action: z.enum(['record', 'ignore', 'overtime']).default('overtime'),
});

/** Unexcused days (absent / late / missing punch left unexplained after the grace period) and their pay effect. */
export const attendanceUnexcusedSettingsSchema = z.object({
  /** When on, the sweep charges the pay effect to paid leave (then LOP) — default off: marking only. */
  autoDeductEnabled: z.boolean().default(false),
  /** Days an employee has to explain a day before the sweep marks it UNEXCUSED (0–30). */
  graceDays: z.number().int().min(0).max(30).default(3),
  payEffectAbsent: payEffectDaysSchema.default(1),
  payEffectLate: payEffectDaysSchema.default(0.5),
  payEffectMissingPunch: payEffectDaysSchema.default(0.5),
  /** Paid leave types charged first, in this order; then the paid type with the most remaining allowance. */
  leaveTypePriority: z.array(leaveTypeCodeSchema).max(20).default(['AL', 'CL']),
  /**
   * Leave types never charged automatically: sick, maternity, paternity, Hajj, and — Finance parity (ATT-82) — marriage,
   * bereavement, adoption and compassionate leave. A leave type flagged `is_special` is never charged whatever this list says.
   */
  excludeLeaveTypeCodes: z.array(leaveTypeCodeSchema).max(50).default(['SL', 'ML', 'PTL', 'HJ', 'MARRIAGE', 'BEREAVEMENT', 'ADOPTION', 'COMPASSIONATE']),
  /**
   * Days after an attendance date during which the employee may still give a reason for it in the portal (1–60); null = no
   * deadline. The deadline is `attendance date + excuseDeadlineDays` (inclusive, the employee's local date): the absence
   * notice and its reminder state it, and a NEW reason for a day past it is refused (HR can still record or excuse the day).
   * Independent of `graceDays` / the day-close grace, which decide when an unexplained day is marked.
   */
  excuseDeadlineDays: z.number().int().min(1).max(60).nullable().default(null),
});

/** The deadline (inclusive, `YYYY-MM-DD`) to give a reason for `attendanceDate`, or null when the organisation sets none. */
export function excuseDeadlineOf(attendanceDate: string, excuseDeadlineDays: number | null | undefined): string | null {
  if (excuseDeadlineDays === null || excuseDeadlineDays === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) return null;
  const d = new Date(`${attendanceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + excuseDeadlineDays);
  return d.toISOString().slice(0, 10);
}

/** Whether the portal insists on a reason for a late / absent day (Prompt 4 reads it). */
export const attendanceNotesSettingsSchema = z.object({
  requireReasonForLate: z.boolean().default(false),
  requireReasonForAbsent: z.boolean().default(false),
});

/** Targets behind the employee's self statistics and the "improvement required" hints. */
export const attendanceStatsSettingsSchema = z.object({
  attendanceTargetPct: z.number().min(0).max(100).default(90),
  fullDayHours: z.number().min(1).max(24).default(8),
});

/**
 * `organization_settings.attendance` — the organisation-wide attendance policy switches (HR portal Prompt 3). Detailed
 * thresholds (grace, late/half-day limits, rounding, overtime, missing-punch behaviour) live in effective-dated
 * `attendance_rule_sets`; this group carries what Finance's `attendance_policies` singleton had and rule sets do not:
 * self-service check-in switches and windows, missed-punch detection / day close, non-working-day handling, unexcused
 * auto-deduction, note requirements and stats targets. Nested groups use `.prefault({})` so a settings row saved before a
 * group existed still resolves to the full defaults (`.default({})` would short-circuit to an empty object in Zod 4).
 * The stored group is `attendanceSettingsSchema.partial()`; read it through `resolveAttendanceSettings`.
 */
export const attendanceSettingsSchema = z.object({
  defaultShiftId: uuidSchema.nullable().optional(),
  processingDelaySeconds: z.number().int().min(0).max(3600).default(30),
  payrollPeriod: z.enum(['calendar_month', 'custom_cutoff']).default('calendar_month'),
  payrollCutoffDay: z.number().int().min(1).max(28).default(25),
  allowSelfServiceCorrections: z.boolean().default(false),
  selfService: attendanceSelfServiceSettingsSchema.prefault({}),
  missedPunch: attendanceMissedPunchSettingsSchema.prefault({}),
  nonWorkingDay: attendanceNonWorkingDaySettingsSchema.prefault({}),
  unexcused: attendanceUnexcusedSettingsSchema.prefault({}),
  notes: attendanceNotesSettingsSchema.prefault({}),
  stats: attendanceStatsSettingsSchema.prefault({}),
});
export type AttendanceSettings = z.output<typeof attendanceSettingsSchema>;
export type AttendanceSettingsInput = z.input<typeof attendanceSettingsSchema>;
export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = attendanceSettingsSchema.parse({});

/**
 * The effective attendance settings of an organisation from whatever the settings row holds (`null`, `{}`, a row saved
 * before a key existed, or a full document): every key present, defaults filled in. Never throws — the worker and the
 * engine must not stop because a setting is malformed. A malformed key (only possible through a manual edit: writes are
 * validated) falls back to its own default and never drags the valid keys down with it.
 */
export function resolveAttendanceSettings(raw: unknown): AttendanceSettings {
  const parsed = attendanceSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const stored = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(attendanceSettingsSchema.shape)) {
    const one = (schema as z.ZodType).safeParse(stored[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  const salvaged = attendanceSettingsSchema.safeParse(kept);
  return salvaged.success ? salvaged.data : DEFAULT_ATTENDANCE_SETTINGS;
}

/**
 * `organization_settings.leave` — leave v2 settings (HR portal Prompt 7). Comp-off credits expire this many days after the
 * worked day (Finance parity: 90). The comp-off day thresholds reuse `attendance.stats.fullDayHours` (half a day from half
 * of it). The stored group is `leaveSettingsSchema.partial()`; read it through `resolveLeaveSettings`.
 */
export const leaveSettingsSchema = z.object({
  compOffExpiryDays: z.number().int().min(1).max(365).default(90),
});
export type LeaveSettings = z.output<typeof leaveSettingsSchema>;
export const DEFAULT_LEAVE_SETTINGS: LeaveSettings = leaveSettingsSchema.parse({});
/** Effective leave settings from whatever the row holds; a malformed key falls back to its default (never throws). */
export function resolveLeaveSettings(raw: unknown): LeaveSettings {
  const stored = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(leaveSettingsSchema.shape)) {
    const one = (schema as z.ZodType).safeParse(stored[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  return leaveSettingsSchema.parse(kept);
}

/**
 * `organization_settings.approvals` — who decides a request when no approval workflow applies to it, and who stands in for
 * the line manager. Workflows (Approvals → Workflows) still win wherever one applies; these keys shape the default routing
 * and the manager levels of every workflow alike.
 *  - `defaultRouting`: leave, comp-off and attendance corrections without a workflow go to the requester's LINE MANAGER
 *    (default — the reporting line, like attendance notes and regularisations), or to every holder of the approve permission
 *    in reach of the employee (`permission_holders`: HR decides, the behaviour before this setting existed).
 *  - `secondaryManager`: the secondary manager is a BACKUP who decides only when the primary manager cannot (on approved
 *    leave, no login — default), or decides ALONGSIDE the primary manager on every request of the reporting line.
 *  - `managerUnavailable`: when neither manager can act, the NEXT MANAGER UP the reporting line decides (default), or the
 *    request goes straight to the HR admins.
 *  - `topLevel`: a request about somebody with no manager at all (the top of the organisation) goes to the HR admins
 *    (then the organisation admins, then the owner — default), to one NAMED approver (`topLevelUserId`, e.g. the Director
 *    General), or is APPROVED AUTOMATICALLY (only where no workflow applies; recorded on the request's timeline).
 *  - `handOverWhenAway`: a request already waiting for a manager who goes on approved leave afterwards is handed to the
 *    backup (the secondary manager, else per `managerUnavailable`) by the hourly approvals sweep — the manager keeps the seat.
 * The stored group is `approvalSettingsSchema.partial()`; read it through `resolveApprovalSettings`.
 */
export const APPROVAL_DEFAULT_ROUTINGS = ['line_manager', 'permission_holders'] as const;
export const APPROVAL_SECONDARY_MANAGER_MODES = ['backup', 'alongside'] as const;
export const APPROVAL_MANAGER_UNAVAILABLE_MODES = ['next_level_manager', 'hr_admins'] as const;
export const APPROVAL_TOP_LEVEL_MODES = ['hr_admins', 'named_user', 'auto_approve'] as const;
export const approvalSettingsSchema = z.object({
  defaultRouting: z.enum(APPROVAL_DEFAULT_ROUTINGS).default('line_manager'),
  secondaryManager: z.enum(APPROVAL_SECONDARY_MANAGER_MODES).default('backup'),
  managerUnavailable: z.enum(APPROVAL_MANAGER_UNAVAILABLE_MODES).default('next_level_manager'),
  topLevel: z.enum(APPROVAL_TOP_LEVEL_MODES).default('hr_admins'),
  /** The named approver of `topLevel = named_user` (an active member; the API refuses anybody else). */
  topLevelUserId: uuidSchema.nullable().default(null),
  handOverWhenAway: z.boolean().default(true),
});
export type ApprovalSettings = z.output<typeof approvalSettingsSchema>;
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = approvalSettingsSchema.parse({});
/** Effective approval routing settings from whatever the row holds; a malformed key falls back to its default (never throws). */
export function resolveApprovalSettings(raw: unknown): ApprovalSettings {
  const stored = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(approvalSettingsSchema.shape)) {
    const one = (schema as z.ZodType).safeParse(stored[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  return approvalSettingsSchema.parse(kept);
}

/**
 * A late-arrival / early-departure alert (customer requirement "lateness and early departure notifications"): sent once per
 * employee-day and kind, for today or yesterday only (never for a historical recalculation), to the employee and / or their
 * direct (primary) manager, when the day's late / early minutes reach `minMinutes`.
 */
export const attendanceAlertSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  notifyEmployee: z.boolean().default(true),
  notifyManager: z.boolean().default(true),
  minMinutes: z.number().int().min(1).max(600).default(1),
});
/** The absence notice: a working day judged ABSENT (its window closed) is told to the employee and / or their manager once. */
export const absenceAlertSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  notifyEmployee: z.boolean().default(true),
  notifyManager: z.boolean().default(true),
});
/** What disqualifies an employee from the weekly thank-you message (each criterion on = such a day disqualifies). */
export const appreciationCriteriaSchema = z.object({
  noLate: z.boolean().default(true),
  noEarlyDeparture: z.boolean().default(true),
  noAbsence: z.boolean().default(true),
  noMissingPunch: z.boolean().default(true),
  noUnexcused: z.boolean().default(true),
});
export const APPRECIATION_DEFAULT_MESSAGE_EN = 'Thank you for your punctuality and commitment this week. Your dedication makes a real difference to the team!';
export const APPRECIATION_DEFAULT_MESSAGE_AR = 'شكرًا لالتزامك وانضباطك في المواعيد هذا الأسبوع. تفانيك يصنع فرقًا حقيقيًا للفريق!';
/**
 * Weekly appreciation ("thank-you") messages: once a week, on `weekday` (0 = Sunday … 6 = Saturday) from `hour` (0–23,
 * organisation time), the PREVIOUS seven days are reviewed and every employee with a login who worked at least
 * `minWorkedDays` days and has none of the selected kinds of day receives the message in their language. Leave, holidays
 * and weekly offs neither count nor disqualify. Off by default.
 */
export const appreciationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  weekday: z.number().int().min(0).max(6).default(4),
  hour: z.number().int().min(0).max(23).default(14),
  criteria: appreciationCriteriaSchema.prefault({}),
  minWorkedDays: z.number().int().min(1).max(7).default(5),
  messageEn: z.string().trim().min(1).max(500).default(APPRECIATION_DEFAULT_MESSAGE_EN),
  messageAr: z.string().trim().min(1).max(500).default(APPRECIATION_DEFAULT_MESSAGE_AR),
});
export type AppreciationSettings = z.output<typeof appreciationSettingsSchema>;

/**
 * `organization_settings.notifications` — the organisation's switches (HR portal Prompt 8; written with
 * `notification.manage`). A switch governs the E-MAIL of the notification types it covers (the notification catalogue's
 * `orgSetting`): off ⇒ no e-mail for those types, the in-app notice is still written — the inbox is part of the product.
 * `missingPunchReminder` additionally switches the reminder itself on or off (it exists only to nudge), and
 * `missingPunchReminderHours` is how long after the shift end an open check-in is reminded. The attendance alert keys
 * (`lateArrivalAlert`, `earlyDepartureAlert`, `absenceAlert`, `absenceReminder`, `missingCheckIn*`, `appreciation`) switch the
 * worker's automatic attendance notices on or off, say who hears them, and govern their e-mail the same way. The stored group is
 * `notificationSettingsSchema.partial()`; read it through `resolveNotificationSettings`.
 */
export const notificationSettingsSchema = z.object({
  deviceOffline: z.boolean().default(true),
  syncFailed: z.boolean().default(true),
  approvalPending: z.boolean().default(true),
  reportReady: z.boolean().default(true),
  /** The 08:00 daily digest of pending approvals by e-mail (the in-app digest is always written). */
  dailyDigest: z.boolean().default(false),
  leaveUpdates: z.boolean().default(true),
  attendanceNotes: z.boolean().default(true),
  punchFlagged: z.boolean().default(true),
  missingPunchReminder: z.boolean().default(true),
  missingPunchReminderHours: z.number().int().min(1).max(12).default(2),
  reportScheduledDelivery: z.boolean().default(true),
  // ----- attendance alerts (customer requirements: lateness / early departure, absence handling, missing check-in, thanks) ---
  // Nested groups use `.prefault({})` so a row saved before a group existed resolves to the group's full defaults.
  lateArrivalAlert: attendanceAlertSettingsSchema.prefault({}),
  earlyDepartureAlert: attendanceAlertSettingsSchema.prefault({}),
  absenceAlert: absenceAlertSettingsSchema.prefault({}),
  /** One reminder, the day before the excuse deadline (`attendance.unexcused.excuseDeadlineDays`), for absences still unexplained. */
  absenceReminder: z.boolean().default(true),
  /** Remind an employee who has not checked in `missingCheckInReminderMinutes` after the expected shift start (off by default). */
  missingCheckInReminder: z.boolean().default(false),
  missingCheckInReminderMinutes: z.number().int().min(15).max(240).default(30),
  /** Also tell the employee's direct (primary) manager about the missing check-in. */
  missingCheckInNotifyManager: z.boolean().default(false),
  appreciation: appreciationSettingsSchema.prefault({}),
});
export type NotificationSettings = z.output<typeof notificationSettingsSchema>;
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = notificationSettingsSchema.parse({});
/** Effective notification switches from whatever the row holds; a malformed key falls back to its default (never throws). */
export function resolveNotificationSettings(raw: unknown): NotificationSettings {
  const stored = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(notificationSettingsSchema.shape)) {
    const one = (schema as z.ZodType).safeParse(stored[key]);
    if (one.success && one.data !== undefined) kept[key] = one.data;
  }
  return notificationSettingsSchema.parse(kept);
}

export const organizationSettingsSchema = z.object({
  general: z.object({
    dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).default('DD/MM/YYYY'),
    timeFormat: z.enum(['24h', '12h']).default('24h'),
    firstDayOfWeek: z.number().int().min(0).max(6).default(0),
    calendar: z.enum(['gregorian', 'hijri_secondary']).default('gregorian'),
  }).partial().default({}),
  attendance: attendanceSettingsSchema.partial().default({}),
  sync: z.object({
    defaultIntervalMinutes: z.number().int().min(1).max(1440).default(5),
    adaptivePolling: z.boolean().default(true),
    offlineThresholdMinutes: z.number().int().min(1).max(1440).default(15),
    autoPushNewEmployees: z.boolean().default(true),
    reconciliationIntervalHours: z.number().int().min(1).max(168).default(24),
    /** Ceiling for adaptive polling (minutes). */
    maxIntervalMinutes: z.number().int().min(1).max(1440).default(60),
    /** Punches whose device clock skew exceeds this are quarantined (minutes). */
    maxClockSkewMinutes: z.number().int().min(1).max(1440).default(60),
  }).partial().default({}),
  notifications: notificationSettingsSchema.partial().default({}),
  security: z.object({
    mfaRequired: z.boolean().default(false),
    sessionIdleMinutes: z.number().int().min(5).max(1440).default(480),
    allowedEmailDomains: z.array(z.string().min(3).max(253)).max(20).default([]),
    exportRequiresReason: z.boolean().default(false),
  }).partial().default({}),
  integrations: z.object({}).partial().default({}),
  dashboard: z.object({
    /** Colour style of the app shell and the dashboard: sidebar, accents and chart palette. */
    theme: z.enum(DASHBOARD_THEMES).default('emerald'),
    /** Widget set and arrangement of the dashboard page. */
    layout: z.enum(DASHBOARD_LAYOUTS).default('overview'),
    /** Days shown by the attendance trend chart (7, 14 or 30). */
    trendDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(14),
    /** "Good morning, <name>" heading instead of the plain page title. */
    showGreeting: z.boolean().default(true),
    /** Quote card in the side rail. */
    showQuote: z.boolean().default(true),
    /** Highlight card (headline + link to reports) next to the KPI tiles. */
    showHighlight: z.boolean().default(true),
    /**
     * Statistics widgets (migration 20261019000500): the day's attendance per department and the month-to-date indicators. No
     * `.default()` on purpose — an absent value means "shown", and saving the group without them never rewrites them.
     */
    showDepartmentBreakdown: z.boolean(),
    showMonthToDate: z.boolean(),
  }).partial().default({}),
  reports: z.object({
    /** How hour columns print: 9.45 = 9 h 45 min (the GCC payroll notation the sample reports use) or 9:45. */
    hoursNotation: z.enum(['h.mm', 'hh:mm']).default('h.mm'),
    /** Two-letter code per attendance status (keys: PRESENT, ABSENT, WEEKLY_OFF, HOLIDAY, HALF_DAY, HALF_DAY_LEAVE, LEAVE). Leave days use the leave type's own code. */
    codeOverrides: z.record(z.string().min(1).max(40), z.string().trim().min(1).max(6)).default({}),
    defaultFormat: z.enum(['pdf', 'xlsx', 'csv']).default('pdf'),
    showLegend: z.boolean().default(true),
  }).partial().default({}),
  leave: leaveSettingsSchema.partial().default({}),
  approvals: approvalSettingsSchema.partial().default({}),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export const SETTINGS_GROUPS = ['general', 'attendance', 'sync', 'notifications', 'security', 'integrations', 'reports', 'dashboard', 'leave', 'approvals'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const branchInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  countryCode: countryCodeSchema.default('OM'),
  city: z.string().trim().max(100).optional(),
  address: addressSchema.default({}),
  timezone: timezoneSchema.default('Asia/Muscat'),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceRadiusM: z.number().int().min(10).max(5000).optional(),
  contact: contactSchema.default({}),
  weeklyOffDays: weeklyOffDaysSchema.nullable().optional(),
  holidayCalendarId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).default('active'),
  /** The group location the branch sits under (Headquarters, Region…; docs/locations.md); null / absent = the top level. */
  parentLocationId: uuidSchema.nullable().optional(),
});
export type BranchInput = z.infer<typeof branchInputSchema>;

export const departmentInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  branchId: uuidSchema.nullable().optional(),
  parentId: uuidSchema.nullable().optional(),
  managerEmployeeId: uuidSchema.nullable().optional(),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export const designationInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  level: z.number().int().min(0).max(100).default(0),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export const teamInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  branchId: uuidSchema.nullable().optional(),
  leadEmployeeId: uuidSchema.nullable().optional(),
  memberIds: z.array(uuidSchema).max(500).optional(),
});

/**
 * POST /orgs/:orgId/invitations. `allBranches` has no default of its own (HR portal Prompt 5 review, P0-1): left out, the
 * invitation gets the CALLER's scope — every branch for an organisation-wide user admin, exactly their branches for a
 * branch-scoped one, who can never grant every branch. `allBranches: false` needs at least one branch.
 */
export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  allBranches: z.boolean().optional(),
  branchIds: z.array(uuidSchema).max(200).default([]),
  employeeId: uuidSchema.optional(),
}).refine((v) => v.allBranches !== false || v.branchIds.length > 0, { message: 'Select at least one branch or grant all branches', path: ['branchIds'] });
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export const updateMemberSchema = z.object({
  roleId: uuidSchema.optional(),
  status: z.enum(MEMBERSHIP_STATUSES).optional(),
  allBranches: z.boolean().optional(),
  branchIds: z.array(uuidSchema).max(200).optional(),
  employeeId: uuidSchema.nullable().optional(),
});
export const roleInputSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
});
export type RoleInput = z.infer<typeof roleInputSchema>;

/** Bootstrap payload returned by GET /me. UI gating only — the server re-checks everything. */
export const meDtoSchema = z.object({
  user: z.object({ id: uuidSchema, email: z.string(), fullName: z.string(), avatarUrl: z.string().nullable(), locale: z.string(), mfaEnrolled: z.boolean(), isPlatformAdmin: z.boolean() }),
  memberships: z.array(z.object({
    membershipId: uuidSchema,
    organization: organizationDtoSchema,
    roleId: uuidSchema,
    roleKey: z.string(),
    roleName: z.string(),
    permissions: z.array(z.string()),
    allBranches: z.boolean(),
    branchIds: z.array(uuidSchema),
    employeeId: uuidSchema.nullable(),
    /** True when at least one active employee reports (primary or secondary manager) to the linked employee record. */
    isManager: z.boolean().default(false),
    /** Number of direct reports (defaults keep a /me document cached before this field existed parseable). */
    teamSize: z.number().int().min(0).default(0),
    /**
     * The caller's own approval work in the organisation: `actionable` = pending seats waiting for them (theirs, or of
     * somebody who delegates to them today) — exactly what the Approvals inbox lists under "Mine"; `delegatedToMe` = a
     * delegation to them is in force today. Opens the Approvals navigation for people who hold no approve key.
     */
    approvals: z.object({ actionable: z.number().int().min(0), delegatedToMe: z.boolean() }).default({ actionable: 0, delegatedToMe: false }),
    featureFlags: z.record(z.string(), z.boolean()),
    /**
     * Module key → enabled (migration 20260929000600): the plan, the platform's per-tenant override, the fleet-wide switch and
     * a lapsed subscription decide. A key missing here (a /me cached before the field existed) reads as enabled — the API's
     * module gate is the authority.
     */
    modules: z.record(z.string(), z.boolean()).default({}),
    /** The subscription was expired / cancelled by the platform: only the core of the product remains. */
    subscriptionLapsed: z.boolean().default(false),
    settings: organizationSettingsSchema,
  })),
});
export type MeDto = z.infer<typeof meDtoSchema>;

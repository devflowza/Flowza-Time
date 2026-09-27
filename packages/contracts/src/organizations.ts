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
  planKey: z.string().default('trial'),
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
  /** Web check-in switch (default off — tenants opt in). */
  webCheckIn: z.boolean().default(false),
  /** Mobile check-in switch (default off). */
  mobileCheckIn: z.boolean().default(false),
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

/** Work on a weekly off / holiday: record it (status stays WEEKLY_OFF/HOLIDAY, minutes kept), ignore it (zero minutes), or count it as overtime. */
export const attendanceNonWorkingDaySettingsSchema = z.object({
  action: z.enum(['record', 'ignore', 'overtime']).default('record'),
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
  /** Leave types never charged automatically (sick, maternity, paternity, Hajj by default). */
  excludeLeaveTypeCodes: z.array(leaveTypeCodeSchema).max(50).default(['SL', 'ML', 'PTL', 'HJ']),
});

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
  notifications: z.object({
    deviceOffline: z.boolean().default(true),
    syncFailed: z.boolean().default(true),
    approvalPending: z.boolean().default(true),
    reportReady: z.boolean().default(true),
    dailyDigest: z.boolean().default(false),
  }).partial().default({}),
  security: z.object({
    mfaRequired: z.boolean().default(false),
    sessionIdleMinutes: z.number().int().min(5).max(1440).default(480),
    allowedEmailDomains: z.array(z.string().min(3)).max(20).default([]),
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
  }).partial().default({}),
  reports: z.object({
    /** How hour columns print: 9.45 = 9 h 45 min (the GCC payroll notation the sample reports use) or 9:45. */
    hoursNotation: z.enum(['h.mm', 'hh:mm']).default('h.mm'),
    /** Two-letter code per attendance status (keys: PRESENT, ABSENT, WEEKLY_OFF, HOLIDAY, HALF_DAY, HALF_DAY_LEAVE, LEAVE). Leave days use the leave type's own code. */
    codeOverrides: z.record(z.string(), z.string().trim().min(1).max(6)).default({}),
    defaultFormat: z.enum(['pdf', 'xlsx', 'csv']).default('pdf'),
    showLegend: z.boolean().default(true),
  }).partial().default({}),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export const SETTINGS_GROUPS = ['general', 'attendance', 'sync', 'notifications', 'security', 'integrations', 'reports', 'dashboard'] as const;
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

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roleId: uuidSchema,
  allBranches: z.boolean().default(true),
  branchIds: z.array(uuidSchema).max(200).default([]),
  employeeId: uuidSchema.optional(),
}).refine((v) => v.allBranches || v.branchIds.length > 0, { message: 'Select at least one branch or grant all branches', path: ['branchIds'] });
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
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
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
    featureFlags: z.record(z.string(), z.boolean()),
    settings: organizationSettingsSchema,
  })),
});
export type MeDto = z.infer<typeof meDtoSchema>;

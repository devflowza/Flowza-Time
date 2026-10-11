import { z } from 'zod';
import { ATTENDANCE_EVENT_TYPES, ATTENDANCE_FLAGS, ATTENDANCE_STATUSES, CORRECTION_TYPES, MISSING_PUNCH_BEHAVIORS, PUNCH_INTERPRETATIONS, ROUNDING_MODES } from './enums.js';
import { isoDateSchema, isoDateTimeSchema, timeSchema, uuidSchema } from './common.js';

export const ramadanModeSchema = z.object({
  enabled: z.boolean().default(false),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  scheduledMinutes: z.number().int().min(60).max(600).optional(),
  appliesTo: z.enum(['all', 'flagged_employees']).default('all'),
});
export type RamadanMode = z.infer<typeof ramadanModeSchema>;

/** Disciplinary escalation steps of an attendance policy (Enterprise, attendance_policies). */
export const DISCIPLINE_ACTIONS = ['NOTIFY_MANAGER', 'VERBAL_WARNING', 'WRITTEN_WARNING', 'FINAL_WARNING', 'HR_REVIEW'] as const;
export type DisciplineAction = (typeof DISCIPLINE_ACTIONS)[number];
/** What an attendance point is given for (one occurrence per day and kind; VERY_LATE replaces LATE on the same day). */
export const ATTENDANCE_POINT_KINDS = ['LATE', 'VERY_LATE', 'EARLY_DEPARTURE', 'ABSENT', 'MISSING_PUNCH', 'UNEXCUSED', 'REPEATED_LATE'] as const;
export type AttendancePointKind = (typeof ATTENDANCE_POINT_KINDS)[number];

const pointsValue = z.number().min(0).max(100).multipleOf(0.5);
const otRate = z.number().min(1).max(5).multipleOf(0.05);
/**
 * The sections of an attendance POLICY beyond the classic rule-set thresholds (Enterprise, `attendance_rule_sets.policy`,
 * docs/enterprise/plan.md §4). Every key is read by something — nothing here is decorative:
 *   late.veryLateAfterMinutes     → engine flag VERY_LATE (engine 1.4.0)
 *   late.repeatedLate             → attendance points (REPEATED_LATE occurrences)
 *   methods                       → the web / mobile / selfie check-in endpoints (per-policy restriction of the org switches)
 *   overtime.weeklyThresholdMinutes, overtime.rates, overtime.maxDailyWorkMinutes → the overtime summary (weighted hours,
 *                                   weekly overtime, days over the statutory daily maximum)
 *   points                        → the attendance points & discipline report
 *   regularisation                → the self-service regularisation endpoint (monthly limit, how far back)
 *   countryPack                   → provenance of a policy created from a country rule pack (compliance check)
 * A PATCH replaces the policy object as a whole (the editor always sends every section).
 */
export const attendancePolicySectionsSchema = z.object({
  countryPack: z.object({ code: z.string().regex(/^[A-Z]{2}$/), version: z.string().trim().min(1).max(20) }).nullable().default(null),
  late: z.object({
    /** Arriving more than this many minutes after the SCHEDULED start (not after the grace) flags VERY_LATE. Null = off. */
    veryLateAfterMinutes: z.number().int().min(1).max(720).nullable().default(null),
    /** Every `occurrences` late arrivals within `periodDays` count one REPEATED_LATE occurrence (points). Null = off. */
    repeatedLate: z.object({ occurrences: z.number().int().min(2).max(31), periodDays: z.number().int().min(7).max(90) }).nullable().default(null),
  }).prefault({}),
  methods: z.object({
    /** Web / mobile / selfie check-in allowed for employees on this policy (the organisation switches must also allow it). */
    web: z.boolean().default(true),
    mobile: z.boolean().default(true),
    selfie: z.boolean().default(true),
    /** Geofence requirement for web / mobile check-in; `inherit` = Settings → Attendance. */
    requireGeofence: z.enum(['inherit', 'off', 'flag', 'block']).default('inherit'),
  }).prefault({}),
  overtime: z.object({
    /** Worked minutes in an ISO week (Mon–Sun) beyond this count as weekly overtime, net of the daily overtime already counted. */
    weeklyThresholdMinutes: z.number().int().min(60).max(10080).nullable().default(null),
    /** Statutory maximum of work (regular + overtime) per day; days above it are reported. */
    maxDailyWorkMinutes: z.number().int().min(60).max(1440).nullable().default(null),
    /** Pay multipliers for the weighted overtime hours of the payroll export. */
    rates: z.object({ regular: otRate.default(1.25), weekly: otRate.default(1.25), weeklyOff: otRate.default(1.5), holiday: otRate.default(2) }).prefault({}),
  }).prefault({}),
  points: z.object({
    enabled: z.boolean().default(false),
    late: pointsValue.default(1),
    veryLate: pointsValue.default(2),
    earlyDeparture: pointsValue.default(1),
    absent: pointsValue.default(3),
    missingPunch: pointsValue.default(1),
    unexcused: pointsValue.default(2),
    repeatedLate: pointsValue.default(2),
    /** A point counts for this many days (rolling window), then drops off. */
    expiryDays: z.number().int().min(7).max(730).default(90),
    /** Escalation ladder: reaching `points` within the window calls for `action` (ascending thresholds, each action once). */
    escalation: z.array(z.object({ points: z.number().min(0.5).max(1000).multipleOf(0.5), action: z.enum(DISCIPLINE_ACTIONS) })).max(DISCIPLINE_ACTIONS.length).default([])
      .refine((a) => a.every((s, i) => i === 0 || s.points > a[i - 1]!.points), { message: 'Thresholds must increase' })
      .refine((a) => new Set(a.map((s) => s.action)).size === a.length, { message: 'Each action once' }),
  }).prefault({}),
  regularisation: z.object({
    /** At most this many regularisation requests per employee per calendar month. Null = no limit. */
    maxPerMonth: z.number().int().min(1).max(31).nullable().default(null),
    /** A regularisation may concern a day at most this many days back. Null = no limit. */
    backdateDays: z.number().int().min(1).max(365).nullable().default(null),
  }).prefault({}),
});
export type AttendancePolicySections = z.infer<typeof attendancePolicySectionsSchema>;
export const DEFAULT_POLICY_SECTIONS: AttendancePolicySections = attendancePolicySectionsSchema.parse({});

/**
 * Configurable attendance rules (§107). Mirrors attendance_rule_sets — the attendance POLICY. Scope (Enterprise,
 * attendance_policies): every dimension that is set must match the employee on the date; the most specific matching
 * policy wins (shift > employee group > department > location / branch > country > organisation — packages/domain
 * resolvePolicy; between locations the deeper one). Without the module only `branchId` may be set (the classic organisation /
 * branch rule sets).
 */
export const attendanceRuleSetInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  branchId: uuidSchema.nullable().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  departmentId: uuidSchema.nullable().optional(),
  employeeGroupId: uuidSchema.nullable().optional(),
  shiftId: uuidSchema.nullable().optional(),
  /**
   * A group location (Headquarters, Region…; then no `branchId`) or a place (Site, Floor, Zone…; then `branchId` is the
   * place's branch) — docs/locations.md §3. A branch itself is named through `branchId`.
   */
  locationId: uuidSchema.nullable().optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
  graceInMinutes: z.number().int().min(0).max(240).default(10),
  graceOutMinutes: z.number().int().min(0).max(240).default(0),
  lateThresholdMinutes: z.number().int().min(0).max(480).default(0),
  earlyDepartureThresholdMinutes: z.number().int().min(0).max(480).default(0),
  minFullDayMinutes: z.number().int().min(0).max(1440).default(420),
  halfDayThresholdMinutes: z.number().int().min(0).max(1440).default(240),
  overtimeEnabled: z.boolean().default(true),
  // Regular overtime is the time worked after the shift end (before its start too with `countEarlyInAsOvertime`); by default
  // every minute counts. The threshold, rounding, minimum block and cap below are the organisation's policy on top of it.
  overtimeStartAfterMinutes: z.number().int().min(0).max(480).default(0),
  overtimeMinBlockMinutes: z.number().int().min(0).max(480).default(0),
  overtimeRoundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).default(0),
  overtimeMaxMinutesPerDay: z.number().int().min(0).max(1440).nullable().optional(),
  countEarlyInAsOvertime: z.boolean().default(false),
  /** Only the work beyond the scheduled minutes is overtime: a late arrival who makes up the time after the shift end earns none. */
  overtimeRequiresScheduledHours: z.boolean().default(false),
  punchRoundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(0),
  punchRoundingMode: z.enum(ROUNDING_MODES).default('NONE'),
  workedRoundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30)]).default(0),
  workedRoundingMode: z.enum(ROUNDING_MODES).default('NONE'),
  punchInterpretation: z.enum(PUNCH_INTERPRETATIONS).default('FIRST_LAST'),
  duplicatePunchWindowSeconds: z.number().int().min(0).max(3600).default(60),
  missingPunchBehavior: z.enum(MISSING_PUNCH_BEHAVIORS).default('FLAG_ONLY'),
  autoAbsentWithoutPunches: z.boolean().default(true),
  weeklyOffWorkCountsAsOvertime: z.boolean().default(true),
  holidayWorkCountsAsOvertime: z.boolean().default(true),
  ramadanMode: ramadanModeSchema.default({ enabled: false, appliesTo: 'all' }),
  /** `.default` (not `.prefault`) so a PATCH without `policy` keeps the stored one (updateSchemaOf strips top-level defaults). */
  policy: attendancePolicySectionsSchema.default(() => attendancePolicySectionsSchema.parse({})),
});
export type AttendanceRuleSetInput = z.infer<typeof attendanceRuleSetInputSchema>;
/** The scope and naming fields of a policy — everything that is not a rule the engine applies. */
export const POLICY_SCOPE_KEYS = ['branchId', 'countryCode', 'departmentId', 'employeeGroupId', 'shiftId', 'locationId'] as const;
export type PolicyScopeKey = (typeof POLICY_SCOPE_KEYS)[number];
export type AttendanceRules = Omit<AttendanceRuleSetInput, 'name' | 'description' | PolicyScopeKey | 'effectiveFrom' | 'effectiveTo'>;
export const DEFAULT_ATTENDANCE_RULES: AttendanceRules = attendanceRuleSetInputSchema.parse({ name: 'default', effectiveFrom: '2000-01-01' });

export const attendanceDailyRecordDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  employeeNumber: z.string().optional(),
  employeeName: z.string().optional(),
  attendanceDate: isoDateSchema,
  branchId: uuidSchema,
  departmentId: uuidSchema.nullable(),
  shiftId: uuidSchema.nullable(),
  shiftName: z.string().nullable().optional(),
  timezone: z.string(),
  expectedStartAt: isoDateTimeSchema.nullable(),
  expectedEndAt: isoDateTimeSchema.nullable(),
  scheduledMinutes: z.number().int(),
  firstInAt: isoDateTimeSchema.nullable(),
  lastOutAt: isoDateTimeSchema.nullable(),
  workedMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyDepartureMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  overtimeCategory: z.string().nullable(),
  status: z.enum(ATTENDANCE_STATUSES),
  flags: z.array(z.string()),
  punchCount: z.number().int(),
  hasCorrection: z.boolean(),
  calculationVersion: z.number().int(),
  computedAt: isoDateTimeSchema,
  lockedAt: isoDateTimeSchema.nullable(),
  /** Loss-of-pay days of this record (0, 0.5 or 1) — derived from the LOP + PAY_EFFECT_* flags, never stored separately. */
  lopDays: z.number().default(0),
  /** True when the day carries an unrevoked UNEXCUSED mark. */
  unexcused: z.boolean().default(false),
});
export type AttendanceDailyRecordDto = z.infer<typeof attendanceDailyRecordDtoSchema>;

/**
 * Loss-of-pay days a record's flags express: `LOP` with `PAY_EFFECT_FULL` = 1, with `PAY_EFFECT_HALF` = 0.5. A pay effect
 * charged to paid leave carries the PAY_EFFECT_* flag without `LOP` and costs no pay. One rule for the engine, the API
 * mappers and the reports, so the figure cannot drift between them.
 */
export function lopDaysOf(flags: readonly string[]): number {
  if (!flags.includes('LOP')) return 0;
  if (flags.includes('PAY_EFFECT_FULL')) return 1;
  if (flags.includes('PAY_EFFECT_HALF')) return 0.5;
  return 0;
}

export const attendanceFlagSchema = z.enum(ATTENDANCE_FLAGS);

export const dailyAttendanceQuerySchema = z.object({
  date: isoDateSchema,
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  flag: attendanceFlagSchema.optional(),
  search: z.string().max(100).optional(),
});
export const monthlyAttendanceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
});
export const attendanceEventsQuerySchema = z.object({
  employeeId: uuidSchema,
  from: isoDateSchema,
  to: isoDateSchema,
});

// ---- activity (one employee's day shape over a period) ----------------------------------------------------------------

/** Period the activity view covers, always a whole calendar day/week/month/year around an anchor date. */
export const ACTIVITY_RANGES = ['day', 'week', 'month', 'year'] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const attendanceActivityQuerySchema = z.object({
  employeeId: uuidSchema,
  range: z.enum(ACTIVITY_RANGES).default('week'),
  /** Any date inside the period; defaults to today in the employee's branch timezone. */
  anchor: isoDateSchema.optional(),
});
export type AttendanceActivityQuery = z.infer<typeof attendanceActivityQuerySchema>;

/** OFFICE = inside between an IN and its OUT; FIELD = away between two in-office spans (field work or a break). */
export const attendanceActivitySegmentSchema = z.object({
  kind: z.enum(['OFFICE', 'FIELD']),
  startAt: isoDateTimeSchema,
  endAt: isoDateTimeSchema.nullable(),
  minutes: z.number().int(),
});
export type AttendanceActivitySegmentDto = z.infer<typeof attendanceActivitySegmentSchema>;

export const attendanceActivityPunchSchema = z.object({
  at: isoDateTimeSchema,
  role: z.string(),
  eventId: uuidSchema.nullable(),
});
export type AttendanceActivityPunchDto = z.infer<typeof attendanceActivityPunchSchema>;

/**
 * One recorded day. `officeMinutes` is the engine's worked minutes (the productive time) and `fieldMinutes` is the rest
 * of the span between the first and the last punch, so the two always add up to `spanMinutes`.
 */
export const attendanceActivityDaySchema = z.object({
  date: isoDateSchema,
  recordId: uuidSchema,
  status: z.enum(ATTENDANCE_STATUSES),
  shiftName: z.string().nullable(),
  expectedStartAt: isoDateTimeSchema.nullable(),
  expectedEndAt: isoDateTimeSchema.nullable(),
  scheduledMinutes: z.number().int(),
  firstInAt: isoDateTimeSchema.nullable(),
  lastOutAt: isoDateTimeSchema.nullable(),
  spanMinutes: z.number().int(),
  officeMinutes: z.number().int(),
  fieldMinutes: z.number().int(),
  breakMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  overtimeCategory: z.enum(['REGULAR', 'WEEKLY_OFF', 'HOLIDAY']).nullable(),
  lateMinutes: z.number().int(),
  earlyDepartureMinutes: z.number().int(),
  punchCount: z.number().int(),
  flags: z.array(z.string()),
  segments: z.array(attendanceActivitySegmentSchema),
  punches: z.array(attendanceActivityPunchSchema),
});
export type AttendanceActivityDayDto = z.infer<typeof attendanceActivityDaySchema>;

/** A calendar month of the year range, where per-day detail would be too much to chart. */
export const attendanceActivityMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  recordedDays: z.number().int(),
  presentDays: z.number(),
  absentDays: z.number(),
  leaveDays: z.number(),
  lateDays: z.number(),
  scheduledMinutes: z.number().int(),
  officeMinutes: z.number().int(),
  fieldMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
});
export type AttendanceActivityMonthDto = z.infer<typeof attendanceActivityMonthSchema>;

export const attendanceActivityTotalsSchema = z.object({
  recordedDays: z.number().int(),
  workingDays: z.number(),
  presentDays: z.number(),
  absentDays: z.number(),
  leaveDays: z.number(),
  holidayDays: z.number(),
  weeklyOffDays: z.number(),
  halfDays: z.number(),
  lateDays: z.number(),
  missingPunchDays: z.number(),
  scheduledMinutes: z.number().int(),
  spanMinutes: z.number().int(),
  /** Productive (in-office) minutes over the period, and the part of them that is overtime. */
  officeMinutes: z.number().int(),
  fieldMinutes: z.number().int(),
  overtimeMinutes: z.number().int(),
  regularMinutes: z.number().int(),
  lateMinutes: z.number().int(),
  earlyDepartureMinutes: z.number().int(),
  /** Office minutes per day that recorded any, so a period with days off is not averaged down. */
  averageOfficeMinutes: z.number().int(),
});
export type AttendanceActivityTotalsDto = z.infer<typeof attendanceActivityTotalsSchema>;

export const attendanceActivityDtoSchema = z.object({
  employeeId: uuidSchema,
  employeeNumber: z.string(),
  employeeName: z.string(),
  range: z.enum(ACTIVITY_RANGES),
  from: isoDateSchema,
  to: isoDateSchema,
  timezone: z.string(),
  /** Recorded days only, oldest first; empty for the year range, which answers with `months` instead. */
  days: z.array(attendanceActivityDaySchema),
  months: z.array(attendanceActivityMonthSchema),
  totals: attendanceActivityTotalsSchema,
});
export type AttendanceActivityDto = z.infer<typeof attendanceActivityDtoSchema>;

export const createCorrectionSchema = z.object({
  employeeId: uuidSchema,
  attendanceDate: isoDateSchema,
  type: z.enum(CORRECTION_TYPES),
  originalEventId: uuidSchema.optional(),
  proposedPunchedAt: isoDateTimeSchema.optional(),
  proposedEventType: z.enum(ATTENDANCE_EVENT_TYPES).optional(),
  proposedStatus: z.enum(ATTENDANCE_STATUSES).optional(),
  reason: z.string().trim().min(3).max(1000),
}).superRefine((v, ctx) => {
  if (v.type === 'ADD_PUNCH' && !v.proposedPunchedAt) ctx.addIssue({ code: 'custom', path: ['proposedPunchedAt'], message: 'Required for ADD_PUNCH' });
  if ((v.type === 'EDIT_PUNCH' || v.type === 'REMOVE_PUNCH') && !v.originalEventId) ctx.addIssue({ code: 'custom', path: ['originalEventId'], message: 'Required' });
  if (v.type === 'EDIT_PUNCH' && !v.proposedPunchedAt) ctx.addIssue({ code: 'custom', path: ['proposedPunchedAt'], message: 'Required for EDIT_PUNCH' });
  if (v.type === 'SET_STATUS' && !v.proposedStatus) ctx.addIssue({ code: 'custom', path: ['proposedStatus'], message: 'Required for SET_STATUS' });
});
export type CreateCorrectionInput = z.infer<typeof createCorrectionSchema>;

export const approvalDecisionSchema = z.object({ comment: z.string().max(1000).optional() });

export const recalculateSchema = z.object({
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeIds: z.array(uuidSchema).max(1000).optional(),
  reason: z.string().trim().min(3).max(500),
});
export type RecalculateInput = z.infer<typeof recalculateSchema>;

export const periodLockSchema = z.object({
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  branchId: uuidSchema.optional(),
  reason: z.string().max(500).optional(),
});
export type PeriodLockInput = z.infer<typeof periodLockSchema>;

export const shiftBreakSchema = z.union([
  z.object({ start: timeSchema, end: timeSchema, paid: z.boolean().default(false) }),
  z.object({ minutes: z.number().int().min(1).max(480), paid: z.boolean().default(false) }),
]);
export type ShiftBreak = z.infer<typeof shiftBreakSchema>;

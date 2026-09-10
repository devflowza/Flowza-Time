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

/** Configurable attendance rules (§107). Mirrors attendance_rule_sets. */
export const attendanceRuleSetInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  branchId: uuidSchema.nullable().optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
  graceInMinutes: z.number().int().min(0).max(240).default(10),
  graceOutMinutes: z.number().int().min(0).max(240).default(0),
  lateThresholdMinutes: z.number().int().min(0).max(480).default(0),
  earlyDepartureThresholdMinutes: z.number().int().min(0).max(480).default(0),
  minFullDayMinutes: z.number().int().min(0).max(1440).default(420),
  halfDayThresholdMinutes: z.number().int().min(0).max(1440).default(240),
  overtimeEnabled: z.boolean().default(true),
  overtimeStartAfterMinutes: z.number().int().min(0).max(480).default(30),
  overtimeMinBlockMinutes: z.number().int().min(0).max(480).default(30),
  overtimeRoundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).default(15),
  overtimeMaxMinutesPerDay: z.number().int().min(0).max(1440).nullable().optional(),
  countEarlyInAsOvertime: z.boolean().default(false),
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
});
export type AttendanceRuleSetInput = z.infer<typeof attendanceRuleSetInputSchema>;
export type AttendanceRules = Omit<AttendanceRuleSetInput, 'name' | 'branchId' | 'effectiveFrom' | 'effectiveTo'>;
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
});
export type AttendanceDailyRecordDto = z.infer<typeof attendanceDailyRecordDtoSchema>;

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

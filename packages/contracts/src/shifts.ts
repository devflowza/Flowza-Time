import { z } from 'zod';
import { ASSIGNMENT_TARGETS, EMPLOYMENT_TYPES, HOLIDAY_TYPES, LEAVE_ACCRUALS, LEAVE_APPLICABLE_GENDERS, LEAVE_COUNT_MODES, RECORD_STATUSES, SHIFT_TYPES } from './enums.js';
import { codeSchema, isoDateSchema, timeSchema, uuidSchema } from './common.js';
import { shiftBreakSchema } from './attendance.js';

/** A new shift's attendance day starts at midnight (12:00 AM): a plain calendar day. Only FLEXIBLE shifts read the boundary. */
export const DEFAULT_SHIFT_DAY_BOUNDARY = '00:00';
/** Platform default punch windows (minutes): what a shift uses unless its own window is switched on. */
export const DEFAULT_PUNCH_IN_WINDOW_MINUTES = 240;
export const DEFAULT_PUNCH_OUT_WINDOW_MINUTES = 360;

export const shiftInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  type: z.enum(SHIFT_TYPES).default('FIXED'),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  requiredMinutes: z.number().int().min(0).max(1440).optional(),
  /** FLEXIBLE only, optional: arriving after `coreStart` is late, leaving before `coreEnd` is early. `null` clears them on PATCH. */
  coreStart: timeSchema.nullable().optional(),
  coreEnd: timeSchema.nullable().optional(),
  dayBoundary: timeSchema.default(DEFAULT_SHIFT_DAY_BOUNDARY),
  breaks: z.array(shiftBreakSchema).max(6).default([]),
  punchInWindowBeforeMinutes: z.number().int().min(0).max(720).default(DEFAULT_PUNCH_IN_WINDOW_MINUTES),
  punchOutWindowAfterMinutes: z.number().int().min(0).max(720).default(DEFAULT_PUNCH_OUT_WINDOW_MINUTES),
  graceInMinutes: z.number().int().min(0).max(240).nullable().optional(),
  graceOutMinutes: z.number().int().min(0).max(240).nullable().optional(),
  /** `null` clears the colour on PATCH (the shift is shown in the neutral colour). */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  status: z.enum(RECORD_STATUSES).default('active'),
}).superRefine((v, ctx) => {
  if (v.type === 'FIXED' && (!v.startTime || !v.endTime)) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Fixed shifts need start and end time' });
  if (v.type === 'FLEXIBLE' && v.requiredMinutes === undefined) ctx.addIssue({ code: 'custom', path: ['requiredMinutes'], message: 'Flexible shifts need required minutes' });
});
export type ShiftInput = z.infer<typeof shiftInputSchema>;

export const shiftPatternInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  cycleLengthDays: z.number().int().min(1).max(366),
  sequence: z.array(z.union([
    z.object({ day: z.number().int().min(0), shiftId: uuidSchema }),
    z.object({ day: z.number().int().min(0), off: z.literal(true) }),
  ])).min(1).max(366),
  anchorDate: isoDateSchema,
});
export type ShiftPatternInput = z.infer<typeof shiftPatternInputSchema>;

export const shiftAssignmentInputSchema = z.object({
  targetType: z.enum(ASSIGNMENT_TARGETS),
  targetId: uuidSchema,
  shiftId: uuidSchema.optional(),
  shiftPatternId: uuidSchema.optional(),
  effectiveFrom: isoDateSchema,
  /**
   * The assignment's LAST day — inclusive: "1 Sep → 2 Sep" covers both days (2026-10-02 field report). The API stores the day after
   * it, the half-open bound of the table's `[effective_from, effective_to)` range. Null / absent = open-ended.
   */
  effectiveTo: isoDateSchema.nullable().optional(),
}).refine((v) => (v.shiftId ? 1 : 0) + (v.shiftPatternId ? 1 : 0) === 1, { message: 'Provide exactly one of shiftId or shiftPatternId' })
  .refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'The last day cannot be before the first day', path: ['effectiveTo'] });
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentInputSchema>;

export const holidayInputSchema = z.object({
  /**
   * The calendar the holiday belongs to. Absent = the organisation's DEFAULT calendar — created on the spot when the organisation
   * has none — so a holiday can be marked in one step and always applies (a holiday in a calendar that is neither the default nor
   * any branch's calendar applies to nobody).
   */
  calendarId: uuidSchema.optional(),
  name: z.string().trim().min(1).max(160),
  nameAr: z.string().trim().max(160).optional(),
  date: isoDateSchema,
  endDate: isoDateSchema.nullable().optional(),
  isHalfDay: z.boolean().default(false),
  type: z.enum(HOLIDAY_TYPES).default('PUBLIC'),
  branchIds: z.array(uuidSchema).max(200).nullable().optional(),
  isTentative: z.boolean().default(false),
});
export type HolidayInput = z.infer<typeof holidayInputSchema>;

export const holidayCalendarInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  countryCode: z.string().length(2).optional(),
  isDefault: z.boolean().default(false),
});

export const leaveTypeInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  isPaid: z.boolean().default(true),
  /** A paid day away from the terminal that reports count with present days (Site Duty), not with leave. */
  treatAsPresent: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Days per calendar year shown as the employee's balance in the self-service portal; null = not tracked. Informs, never blocks. */
  annualAllowanceDays: z.number().min(0).max(366).multipleOf(0.5).nullable().optional(),
  // ----- leave v2 policy (HR portal Prompt 7); defaults = the behaviour every existing type already had -----
  /** false: an application is approved at once (the approval request is recorded as auto-approved). */
  requiresApproval: z.boolean().default(true),
  /** How a range is charged: working days (weekly offs / holidays free) or every calendar day. */
  countMode: z.enum(LEAVE_COUNT_MODES).default('working'),
  /** At most this many days charged by one request (self-service: refused; HR: warned). */
  maxConsecutiveDays: z.number().int().min(1).max(366).nullable().optional(),
  /** Calendar days between the application and the first day (self-service: refused below; HR: warned). */
  advanceNoticeDays: z.number().int().min(0).max(365).default(0),
  /** Who may take it: everyone, or only employees whose gender on file matches. */
  applicableGender: z.enum(LEAVE_APPLICABLE_GENDERS).default('all'),
  /**
   * Leave v2 review (Finance parity B-41): only employees of these employment types may take it (their employment type on
   * file); null / absent = every employment type. Checked with the gender by the one applicability rule (portal, API,
   * unexcused-day charger, year close, allocation generation).
   */
  applicableEmploymentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).min(1).max(EMPLOYMENT_TYPES.length)
    .refine((a) => new Set(a).size === a.length, { message: 'Each employment type once' }).nullable().optional(),
  /** monthly: the yearly entitlement is earned month by month (accrued to date). */
  accrual: z.enum(LEAVE_ACCRUALS).default('none'),
  /** Unused days carried into the next year at year close (0 = none). */
  carryForwardMaxDays: z.number().min(0).max(366).multipleOf(0.5).default(0),
  /** Carried-forward days expire after this many months of the new year (null = never). */
  carryForwardExpiryMonths: z.number().int().min(1).max(24).nullable().optional(),
  /** Never charged automatically for unexcused days (sick, maternity, Hajj…). */
  isSpecial: z.boolean().default(false),
  allowHalfDay: z.boolean().default(true),
  /** Offered in the self-service apply form. */
  portalVisible: z.boolean().default(true),
});

/**
 * Default leave types for a new organisation (GCC practice; decision #3 of the reports plan). Codes are what the
 * attendance reports print in place of a leave day, so they are the two/three-letter codes payroll teams recognise.
 */
export const DEFAULT_LEAVE_TYPES: ReadonlyArray<{ code: string; name: string; nameAr: string; isPaid: boolean; treatAsPresent: boolean; color: string }> = [
  { code: 'AL', name: 'Annual Leave', nameAr: 'إجازة سنوية', isPaid: true, treatAsPresent: false, color: '#175cd3' },
  { code: 'CL', name: 'Casual Leave', nameAr: 'إجازة عرضية', isPaid: true, treatAsPresent: false, color: '#0e7490' },
  { code: 'SL', name: 'Sick Leave', nameAr: 'إجازة مرضية', isPaid: true, treatAsPresent: false, color: '#b54708' },
  { code: 'EL', name: 'Emergency Leave', nameAr: 'إجازة طارئة', isPaid: true, treatAsPresent: false, color: '#b42318' },
  { code: 'SPL', name: 'Special Leave', nameAr: 'إجازة خاصة', isPaid: true, treatAsPresent: false, color: '#7a2e9d' },
  { code: 'ML', name: 'Maternity Leave', nameAr: 'إجازة أمومة', isPaid: true, treatAsPresent: false, color: '#c11574' },
  { code: 'NP', name: 'No Pay Leave', nameAr: 'إجازة بدون راتب', isPaid: false, treatAsPresent: false, color: '#475467' },
  { code: 'SD', name: 'Site Duty', nameAr: 'مهمة عمل خارجية', isPaid: true, treatAsPresent: true, color: '#0f6e56' },
];

export const leaveRecordInputSchema = z.object({
  employeeId: uuidSchema,
  leaveTypeId: uuidSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  isHalfDay: z.boolean().default(false),
  halfDayPart: z.enum(['FIRST_HALF', 'SECOND_HALF']).optional(),
  reason: z.string().max(1000).optional(),
}).refine((v) => v.endDate >= v.startDate, { message: 'endDate must be on/after startDate', path: ['endDate'] });
export type LeaveRecordInput = z.infer<typeof leaveRecordInputSchema>;

import { z } from 'zod';
import { ASSIGNMENT_TARGETS, HOLIDAY_TYPES, RECORD_STATUSES, SHIFT_TYPES } from './enums.js';
import { codeSchema, isoDateSchema, timeSchema, uuidSchema } from './common.js';
import { shiftBreakSchema } from './attendance.js';

export const shiftInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).optional(),
  type: z.enum(SHIFT_TYPES).default('FIXED'),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  requiredMinutes: z.number().int().min(0).max(1440).optional(),
  coreStart: timeSchema.optional(),
  coreEnd: timeSchema.optional(),
  dayBoundary: timeSchema.default('04:00'),
  breaks: z.array(shiftBreakSchema).max(6).default([]),
  punchInWindowBeforeMinutes: z.number().int().min(0).max(720).default(240),
  punchOutWindowAfterMinutes: z.number().int().min(0).max(720).default(360),
  graceInMinutes: z.number().int().min(0).max(240).nullable().optional(),
  graceOutMinutes: z.number().int().min(0).max(240).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
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
  ])).min(1),
  anchorDate: isoDateSchema,
});
export type ShiftPatternInput = z.infer<typeof shiftPatternInputSchema>;

export const shiftAssignmentInputSchema = z.object({
  targetType: z.enum(ASSIGNMENT_TARGETS),
  targetId: uuidSchema,
  shiftId: uuidSchema.optional(),
  shiftPatternId: uuidSchema.optional(),
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
}).refine((v) => (v.shiftId ? 1 : 0) + (v.shiftPatternId ? 1 : 0) === 1, { message: 'Provide exactly one of shiftId or shiftPatternId' });
export type ShiftAssignmentInput = z.infer<typeof shiftAssignmentInputSchema>;

export const holidayInputSchema = z.object({
  calendarId: uuidSchema,
  name: z.string().trim().min(1).max(160),
  nameAr: z.string().trim().max(160).optional(),
  date: isoDateSchema,
  endDate: isoDateSchema.nullable().optional(),
  isHalfDay: z.boolean().default(false),
  type: z.enum(HOLIDAY_TYPES).default('PUBLIC'),
  branchIds: z.array(uuidSchema).nullable().optional(),
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

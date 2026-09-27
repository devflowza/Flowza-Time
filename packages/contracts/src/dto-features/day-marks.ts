import { z } from 'zod';
import { DAY_MARK_KINDS, DAY_MARK_SOURCES } from '../enums.js';
import { isoDateSchema, isoDateTimeSchema, uuidSchema } from '../common.js';
import { payEffectDaysSchema } from '../organizations.js';

/**
 * Attendance day marks (HR portal Prompt 3): a reviewed verdict on one employee-day that the engine folds into the daily
 * record as flags. Rows are never edited — a wrong mark is revoked (kept, with who/why) and a new one written.
 *
 *   UNEXCUSED   the day was left unexplained past the grace period (sweep) or judged so by HR/manager → flag UNEXCUSED
 *   EXCUSED     the consequences are waived: LATE/ABSENT stay on the record, lopDays = 0 → flag EXCUSED
 *   PAY_EFFECT  a pay effect charged to paid leave (0.5 / 1 day) → flag PAY_EFFECT_HALF / PAY_EFFECT_FULL
 *   LOP         loss of pay (no leave balance left, or HR decided so) → flags LOP + PAY_EFFECT_*, lopDays = 0.5 / 1
 */
export const dayMarkDtoSchema = z.object({
  id: uuidSchema,
  employeeId: uuidSchema,
  attendanceDate: isoDateSchema,
  branchId: uuidSchema.nullable(),
  kind: z.enum(DAY_MARK_KINDS),
  payEffectDays: z.number(),
  source: z.enum(DAY_MARK_SOURCES),
  sourceId: uuidSchema.nullable(),
  reason: z.string().nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  revokedBy: uuidSchema.nullable(),
  revokeReason: z.string().nullable(),
});
export type DayMarkDto = z.infer<typeof dayMarkDtoSchema>;

export const dayMarksQuerySchema = z.object({
  employeeId: uuidSchema.optional(),
  from: isoDateSchema,
  to: isoDateSchema,
  /** Include revoked marks (default: active only). */
  includeRevoked: z.enum(['true', 'false', '1', '0']).optional(),
  kind: z.enum(DAY_MARK_KINDS).optional(),
}).refine((v) => v.to >= v.from, { message: 'to must be on/after from', path: ['to'] });
export type DayMarksQuery = z.infer<typeof dayMarksQuerySchema>;

/** Kinds HR / a manager may write by hand; LOP is produced by the pay-effect charger only. */
export const MANUAL_DAY_MARK_KINDS = ['EXCUSED', 'UNEXCUSED', 'PAY_EFFECT'] as const;
export const createDayMarkSchema = z.object({
  employeeId: uuidSchema,
  attendanceDate: isoDateSchema,
  kind: z.enum(MANUAL_DAY_MARK_KINDS),
  /** Required for PAY_EFFECT (0.5 or 1); ignored for EXCUSED, optional for UNEXCUSED (0 = mark only). */
  payEffectDays: payEffectDaysSchema.optional(),
  reason: z.string().trim().min(3).max(1000),
}).superRefine((v, ctx) => {
  if (v.kind === 'PAY_EFFECT' && !(v.payEffectDays === 0.5 || v.payEffectDays === 1)) ctx.addIssue({ code: 'custom', path: ['payEffectDays'], message: 'A pay effect must be 0.5 or 1 day' });
});
export type CreateDayMarkInput = z.infer<typeof createDayMarkSchema>;

export const revokeDayMarkSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export type RevokeDayMarkInput = z.infer<typeof revokeDayMarkSchema>;

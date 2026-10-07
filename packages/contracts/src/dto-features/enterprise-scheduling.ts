/**
 * Round-the-clock scheduling (Enterprise, module `advanced_scheduling`; migration 20261007000100, docs/enterprise/plan.md §8–§10):
 * 24/7 rotation templates, coverage targets, additional (double) shift assignments and temporary branch deployments.
 */
import { z } from 'zod';
import { codeSchema, isoDateSchema, paginationQuerySchema, timeSchema, uuidSchema, weeklyOffDaysSchema } from '../common.js';

// ----- additional (double) shift assignments --------------------------------------------------------------------------------

export const additionalShiftAssignmentInputSchema = z.object({
  employeeId: uuidSchema,
  shiftId: uuidSchema,
  effectiveFrom: isoDateSchema,
  /** Inclusive last day; null / absent = open-ended. */
  effectiveTo: isoDateSchema.nullable().optional(),
}).refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'The last day cannot be before the first day', path: ['effectiveTo'] });
export type AdditionalShiftAssignmentInput = z.infer<typeof additionalShiftAssignmentInputSchema>;
export const additionalShiftAssignmentUpdateSchema = z.object({ effectiveTo: isoDateSchema.nullable() });
export const additionalShiftAssignmentListQuerySchema = paginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  activeOn: isoDateSchema.optional(),
});
export interface AdditionalShiftAssignmentDto {
  id: string; employeeId: string; employeeName: string | null; employeeNumber: string | null; branchId: string | null;
  shift: { id: string; code: string; name: string; startTime: string | null; endTime: string | null };
  effectiveFrom: string;
  /** Inclusive last day, null = open-ended. */
  effectiveTo: string | null;
  shiftChangeRequestId: string | null; createdAt: string;
}

// ----- branch deployments ---------------------------------------------------------------------------------------------------

export const branchDeploymentInputSchema = z.object({
  employeeId: uuidSchema,
  branchId: uuidSchema,
  fromDate: isoDateSchema,
  /** Inclusive last day (at most 367 days after the first). */
  toDate: isoDateSchema,
  reason: z.string().trim().min(3).max(1000),
  /** Enrol the employee on the branch's active terminals (async device job). */
  enrolOnDevices: z.boolean().default(true),
}).refine((v) => v.toDate >= v.fromDate, { message: 'The last day cannot be before the first day', path: ['toDate'] });
export type BranchDeploymentInput = z.infer<typeof branchDeploymentInputSchema>;
export const cancelBranchDeploymentSchema = z.object({ reason: z.string().trim().min(3).max(1000) });
export const BRANCH_DEPLOYMENT_STATUSES = ['scheduled', 'active', 'ended', 'cancelled'] as const;
export type BranchDeploymentStatus = (typeof BRANCH_DEPLOYMENT_STATUSES)[number];
export const branchDeploymentListQuerySchema = paginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  /** Host OR home branch. */
  branchId: uuidSchema.optional(),
  status: z.enum(BRANCH_DEPLOYMENT_STATUSES).optional(),
  activeOn: isoDateSchema.optional(),
});
export interface BranchDeploymentDto {
  id: string; employeeId: string; employeeName: string | null; employeeNumber: string | null;
  homeBranchId: string | null; homeBranchName: string | null; branchId: string; branchName: string | null;
  fromDate: string; toDate: string; reason: string; status: BranchDeploymentStatus;
  enrolOnDevices: boolean;
  /** The device enrolment job (a sync_jobs id: /sync/:id renders it). */
  enrolJobId: string | null;
  cleanupJobId: string | null; cleanedUpAt: string | null;
  cancelledAt: string | null; cancelReason: string | null; createdAt: string;
}

// ----- round-the-clock templates --------------------------------------------------------------------------------------------

/**
 * 24/7 rotation templates (docs/enterprise/plan.md §8). Each crew follows the same cycle, offset so that every shift of every
 * day is covered:
 *   TWO_SHIFT_4ON4OFF  2 × 12 h (day / night), 4 crews: 4 days, 4 off, 4 nights, 4 off (16-day cycle)
 *   TWO_SHIFT_PANAMA_223      2 × 12 h, 4 crews: 2-2-3 (Panama), 14-day cycle per shift kind, 28-day full cycle
 *   THREE_SHIFT_CONTINENTAL   3 × 8 h (morning / evening / night), 4 crews: 2 mornings, 2 evenings, 2 nights, 2 off (8-day cycle)
 *   THREE_SHIFT_WEEKLY        3 × 8 h, 4 crews: a week of mornings, of evenings, of nights, a week off (28-day cycle)
 */
export const ROUND_THE_CLOCK_TEMPLATES = ['TWO_SHIFT_4ON4OFF', 'TWO_SHIFT_PANAMA_223', 'THREE_SHIFT_CONTINENTAL', 'THREE_SHIFT_WEEKLY'] as const;
export type RoundTheClockTemplate = (typeof ROUND_THE_CLOCK_TEMPLATES)[number];

export const roundTheClockInputSchema = z.object({
  template: z.enum(ROUND_THE_CLOCK_TEMPLATES),
  /** Code prefix of the created shifts and patterns (e.g. "247" → 247-D, 247-N, 247-A…). */
  codePrefix: codeSchema.refine((c) => c.length <= 20, { message: 'At most 20 characters' }),
  namePrefix: z.string().trim().min(1).max(60),
  /** Start of the first shift of the day (the others follow back to back). */
  firstShiftStart: timeSchema.default('06:00'),
  /** Day 0 of every crew's cycle. */
  anchorDate: isoDateSchema,
  /** Unpaid break inside each shift, minutes (0 = none). */
  breakMinutes: z.number().int().min(0).max(120).default(60),
  /** Optional: put existing teams on crews A, B, C, D (TEAM assignments from the anchor date). */
  crewTeams: z.array(z.object({ crew: z.enum(['A', 'B', 'C', 'D']), teamId: uuidSchema })).max(4).default([])
    .refine((a) => new Set(a.map((c) => c.crew)).size === a.length && new Set(a.map((c) => c.teamId)).size === a.length, { message: 'Each crew and team once' }),
  /** Optional: a coverage target per created shift on this branch (min headcount on every weekday). */
  coverage: z.object({ branchId: uuidSchema, minHeadcount: z.number().int().min(1).max(10000) }).nullable().default(null),
});
export type RoundTheClockInput = z.infer<typeof roundTheClockInputSchema>;
export interface RoundTheClockPlanDto {
  template: RoundTheClockTemplate;
  shifts: Array<{ key: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number; color: string }>;
  /** One rotation pattern per crew; `sequence` uses the shift `key`s above. */
  crews: Array<{ crew: 'A' | 'B' | 'C' | 'D'; code: string; name: string; cycleLengthDays: number; sequence: Array<{ day: number; shiftKey: string } | { day: number; off: true }> }>;
  /** Head count per shift per day of the cycle with one person per crew (each must be ≥ 1 for 24/7 cover). */
  coverageCheck: { covered: boolean; minCrewsPerShift: number };
  /** Average weekly hours per crew member over the full cycle. */
  averageWeeklyHours: number;
}
export interface RoundTheClockResultDto { plan: RoundTheClockPlanDto; shiftIds: string[]; patternIds: string[]; assignmentIds: string[]; coverageIds: string[] }

// ----- coverage --------------------------------------------------------------------------------------------------------------

export const shiftCoverageInputSchema = z.object({
  branchId: uuidSchema,
  shiftId: uuidSchema,
  weekdays: weeklyOffDaysSchema.min(1).refine((a) => new Set(a).size === a.length, { message: 'Each weekday once' }).default([0, 1, 2, 3, 4, 5, 6]),
  minHeadcount: z.number().int().min(1).max(10000),
});
export type ShiftCoverageInput = z.infer<typeof shiftCoverageInputSchema>;
export const shiftCoverageUpdateSchema = z.object({ weekdays: weeklyOffDaysSchema.min(1).optional(), minHeadcount: z.number().int().min(1).max(10000).optional() });
export const shiftCoverageListQuerySchema = z.object({ branchId: uuidSchema.optional(), shiftId: uuidSchema.optional() });
export interface ShiftCoverageDto { id: string; branchId: string; shiftId: string; shiftName: string | null; weekdays: number[]; minHeadcount: number; createdAt: string; updatedAt: string }
/** Scheduled head count vs the targets per day and shift (rotation patterns, assignments, double shifts; leave and offs excluded). */
export const shiftCoverageReportQuerySchema = z.object({ branchId: uuidSchema, from: isoDateSchema, to: isoDateSchema })
  .refine((v) => v.to >= v.from, { message: 'The last day cannot be before the first day', path: ['to'] });
export interface ShiftCoverageReportDto {
  branchId: string; from: string; to: string;
  shifts: Array<{ id: string; code: string; name: string; startTime: string | null; endTime: string | null }>;
  days: Array<{ date: string; cells: Array<{ shiftId: string; required: number; scheduled: number; gap: number }> }>;
}

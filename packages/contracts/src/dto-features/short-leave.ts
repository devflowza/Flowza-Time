/**
 * Short leave — hourly permissions, special reduced hours and out-of-office time (migration 20261019000310, engine 1.5.0).
 *
 *  - `time_off_types`: the organisation's permission types (personal permission, official assignment, remote work, nursing
 *    hour, disability short leave…). A type of a category that is work (OFFICIAL, REMOTE) counts as worked time by default.
 *  - `time_off_requests`: one window of one day (local times of the employee's branch, start < end within 00:00–24:00), its
 *    minutes computed by the server. Routed through the approval engine as entity SHORT_LEAVE; HR may record one on behalf of
 *    an employee (approved at once, like recorded leave).
 *  - `employee_hour_allowances`: recurring reduced hours (the nursing hour, reduced hours for persons with disabilities):
 *    minutes per working day off the start, the end, or either.
 * The attendance engine reads the approved windows and the allowances of a day: lateness / early departure inside a window is
 * excused, work-like windows are credited to the worked minutes, and out-of-office time no window covers is "lost time".
 */
import { z } from 'zod';
import { RECORD_STATUSES, type ApprovalRequestStatus, type RecordStatus } from '../enums.js';
import { codeSchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';

export const TIME_OFF_CATEGORIES = ['PERSONAL', 'OFFICIAL', 'REMOTE', 'NURSING', 'DISABILITY', 'OTHER'] as const;
export type TimeOffCategory = (typeof TIME_OFF_CATEGORIES)[number];
/** Categories whose time is work (an official assignment, remote work): a new type of these counts as worked time by default. */
export const TIME_OFF_WORK_CATEGORIES: readonly TimeOffCategory[] = ['OFFICIAL', 'REMOTE'];
export const timeOffCountsAsWorkByDefault = (category: TimeOffCategory): boolean => TIME_OFF_WORK_CATEGORIES.includes(category);

/** A request is PENDING until the approval engine decides it; withdrawing (employee) or cancelling (HR) makes it CANCELLED. */
export const TIME_OFF_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type TimeOffStatus = (typeof TIME_OFF_STATUSES)[number];
/** PENDING and APPROVED requests count against the monthly quota and block an overlapping request. */
export const ACTIVE_TIME_OFF_STATUSES: readonly TimeOffStatus[] = ['PENDING', 'APPROVED'];

export const TIME_OFF_GENDERS = ['all', 'male', 'female'] as const;
export type TimeOffGender = (typeof TIME_OFF_GENDERS)[number];

export const HOUR_ALLOWANCE_KINDS = ['NURSING', 'DISABILITY', 'OTHER'] as const;
export type HourAllowanceKind = (typeof HOUR_ALLOWANCE_KINDS)[number];
/** Where the reduced minutes go: the expected start moves later, the expected end earlier, or whichever the day needs (late first). */
export const HOUR_ALLOWANCE_POSITIONS = ['START', 'END', 'EITHER'] as const;
export type HourAllowancePosition = (typeof HOUR_ALLOWANCE_POSITIONS)[number];

/** A clock time of a short-leave window: HH:mm from 00:00 to 24:00 (24:00 = the end of the day). */
export const clockTimeSchema = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Expected HH:mm between 00:00 and 24:00');
/** "HH:mm" (or "HH:mm:ss", as Postgres returns a `time`) → minutes after midnight. */
export function clockToMinutes(v: string): number {
  const [h, m] = v.split(':');
  return Number(h) * 60 + Number(m);
}
/** Minutes after midnight → "HH:mm" (1440 → "24:00"). */
export function minutesToClock(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/** Minutes of a window, or null when it is not a forward window of one day. */
export function windowMinutes(startTime: string, endTime: string): number | null {
  const s = clockToMinutes(startTime); const e = clockToMinutes(endTime);
  return Number.isFinite(s) && Number.isFinite(e) && s < e && s < 1440 && e <= 1440 ? e - s : null;
}

// ----- types -----------------------------------------------------------------------------------------------------------------

export const timeOffTypeInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).nullable().optional(),
  category: z.enum(TIME_OFF_CATEGORIES),
  /** Counted as worked time (credited to the day's worked minutes). Omitted: true for OFFICIAL / REMOTE, false otherwise. */
  countsAsWork: z.boolean().optional(),
  /** Longest window one request may ask for. Null = no limit. */
  maxMinutesPerRequest: z.number().int().min(5).max(1440).nullable().optional(),
  /** Per employee and calendar month (pending + approved requests). Null = no limit. */
  monthlyQuotaMinutes: z.number().int().min(5).max(20_000).nullable().optional(),
  monthlyQuotaCount: z.number().int().min(1).max(100).nullable().optional(),
  /** False: a request is approved at once (no approver). */
  requiresApproval: z.boolean().optional(),
  applicableGender: z.enum(TIME_OFF_GENDERS).optional(),
  /** Offered in the employee portal; false = HR records it on the employee's behalf only. */
  portalVisible: z.boolean().optional(),
  status: z.enum(RECORD_STATUSES).optional(),
});
export type TimeOffTypeInput = z.infer<typeof timeOffTypeInputSchema>;
/**
 * PATCH body: every field optional and none defaulted (AGENTS.md Zod 4 pitfall — a one-field PATCH changes one field). The code
 * is the type's identity in the attendance trace and cannot be changed.
 */
export const timeOffTypeUpdateSchema = timeOffTypeInputSchema.omit({ code: true }).partial();
export type TimeOffTypeUpdateInput = z.infer<typeof timeOffTypeUpdateSchema>;

export interface TimeOffTypeDto {
  id: string; code: string; name: string; nameAr: string | null; category: TimeOffCategory; countsAsWork: boolean;
  maxMinutesPerRequest: number | null; monthlyQuotaMinutes: number | null; monthlyQuotaCount: number | null;
  requiresApproval: boolean; applicableGender: TimeOffGender; portalVisible: boolean; status: RecordStatus; createdAt: string; updatedAt: string;
}

// ----- requests ----------------------------------------------------------------------------------------------------------------

const windowRefinement = <T extends { startTime: string; endTime: string }>(v: T, ctx: z.RefinementCtx): void => {
  if (windowMinutes(v.startTime, v.endTime) === null) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'The end must be after the start, on the same day' });
};

/** POST /orgs/:orgId/me/time-off — the employee asks for a short leave on one day. */
export const selfTimeOffRequestSchema = z.object({
  typeId: uuidSchema,
  date: isoDateSchema,
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  reason: z.string().trim().min(3, 'Explain the request in a few words').max(1000),
}).superRefine(windowRefinement);
export type SelfTimeOffRequestInput = z.infer<typeof selfTimeOffRequestSchema>;

/** POST /orgs/:orgId/time-off-requests — HR records a short leave for an employee (leave.manage). */
export const timeOffRequestInputSchema = z.object({
  employeeId: uuidSchema,
  typeId: uuidSchema,
  date: isoDateSchema,
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  reason: z.string().trim().min(3).max(1000),
}).superRefine(windowRefinement);
export type TimeOffRequestInput = z.infer<typeof timeOffRequestInputSchema>;

/** Withdrawing (employee, pending only) or cancelling (HR, also approved) always says why. */
export const timeOffCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const timeOffRequestListQuerySchema = paginationQuerySchema.extend({
  employeeId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
  typeId: uuidSchema.optional(),
  status: z.enum(TIME_OFF_STATUSES).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export type TimeOffRequestListQuery = z.infer<typeof timeOffRequestListQuerySchema>;
/** GET /me/time-off?month=YYYY-MM — the employee's requests of a month (default: the current one) and the month's usage. */
export const selfTimeOffQuerySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });

export interface TimeOffRequestDto {
  id: string; employeeId: string; employeeName: string | null; employeeNumber: string | null; branchId: string | null;
  typeId: string; typeCode: string; typeName: string; typeNameAr: string | null; category: TimeOffCategory; countsAsWork: boolean;
  date: string; startTime: string; endTime: string; minutes: number; reason: string; status: TimeOffStatus;
  decisionNote: string | null; decidedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  approvalRequestId: string | null; approvalStatus: ApprovalRequestStatus | null; approvalCurrentStep: number | null; approvalStepCount: number | null;
  /** The approver asked a question the employee has not answered yet (the request stays PENDING). */
  infoRequested: boolean;
  /** HR filed it on the employee's behalf (somebody else than the employee). */
  recordedByHr: boolean;
  createdBy: string | null; createdAt: string; updatedAt: string;
  /** The caller may withdraw it (their own pending filing). */
  canWithdraw: boolean;
}

/** One type's use in a month: what pending + approved requests take of its quota. */
export interface TimeOffUsageDto { typeId: string; month: string; usedMinutes: number; usedCount: number; quotaMinutes: number | null; quotaCount: number | null }

export interface SelfTimeOffDto {
  month: string;
  /** The types the employee may ask for (active, portal-visible, applicable to them). */
  types: TimeOffTypeDto[];
  usage: TimeOffUsageDto[];
  requests: TimeOffRequestDto[];
  /** Reduced daily hours in force today or later (nursing hour, disability). */
  allowances: HourAllowanceDto[];
}

/** What the approval inbox shows next to a SHORT_LEAVE request. */
export interface ShortLeaveContextDto {
  id: string; typeName: string; typeNameAr: string | null; category: TimeOffCategory; countsAsWork: boolean;
  date: string; startTime: string; endTime: string; minutes: number; reason: string; status: TimeOffStatus;
  /** The month's use of the type by the employee WITHOUT this request, and its quota. */
  monthUsedMinutes: number; monthUsedCount: number; monthQuotaMinutes: number | null; monthQuotaCount: number | null;
}

// ----- reduced hours (allowances) ------------------------------------------------------------------------------------------------

export const hourAllowanceInputSchema = z.object({
  kind: z.enum(HOUR_ALLOWANCE_KINDS),
  minutesPerDay: z.number().int().min(15).max(240),
  position: z.enum(HOUR_ALLOWANCE_POSITIONS),
  validFrom: isoDateSchema,
  /** Inclusive last day; null = open-ended (a permanent disability allowance). A nursing hour always ends. */
  validTo: isoDateSchema.nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.validTo && v.validTo < v.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'The last day cannot be before the first day' });
  if (v.kind === 'NURSING' && !v.validTo) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'A nursing hour needs its last day' });
});
export type HourAllowanceInput = z.infer<typeof hourAllowanceInputSchema>;
/** PATCH body (explicit, no defaults): the range and the minutes may change; the kind stays. */
export const hourAllowanceUpdateSchema = z.object({
  minutesPerDay: z.number().int().min(15).max(240).optional(),
  position: z.enum(HOUR_ALLOWANCE_POSITIONS).optional(),
  validFrom: isoDateSchema.optional(),
  validTo: isoDateSchema.nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type HourAllowanceUpdateInput = z.infer<typeof hourAllowanceUpdateSchema>;

export interface HourAllowanceDto {
  id: string; employeeId: string; kind: HourAllowanceKind; minutesPerDay: number; position: HourAllowancePosition;
  validFrom: string; validTo: string | null; reference: string | null; notes: string | null; createdAt: string; updatedAt: string;
  /** In force on the organisation's today. */
  active: boolean;
}

/** A write that changed attendance in the past: the recalculation queued for it (a queue job id, tracked under Attendance → Recalculations). */
export type WithTimeOffRecalc<T> = T & { recalculationJobId: string | null };

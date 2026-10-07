/**
 * Global attendance policies (Enterprise, module `attendance_policies`; migration 20261007000100, docs/enterprise/plan.md §4–§6):
 * employee groups, policy resolution, country packs and compliance, attendance points & disciplinary escalation, the overtime
 * summary. The policy itself is the attendance rule set (`attendanceRuleSetInputSchema`, scope + `policy` sections).
 */
import { z } from 'zod';
import { RECORD_STATUSES } from '../enums.js';
import { codeSchema, isoDateSchema, paginationQuerySchema, uuidSchema } from '../common.js';
import type { AttendancePointKind, DisciplineAction } from '../attendance.js';
import { updateSchemaOf } from './devices.js';

// ----- employee groups ------------------------------------------------------------------------------------------------------

export const employeeGroupInputSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(500).default(''),
  status: z.enum(RECORD_STATUSES).default('active'),
});
export type EmployeeGroupInput = z.infer<typeof employeeGroupInputSchema>;
export const employeeGroupUpdateSchema = updateSchemaOf<EmployeeGroupInput>(employeeGroupInputSchema.shape);
export const employeeGroupListQuerySchema = z.object({ status: z.enum(RECORD_STATUSES).optional(), search: z.string().trim().max(100).optional() });
export interface EmployeeGroupDto {
  id: string; code: string; name: string; nameAr: string | null; description: string; status: (typeof RECORD_STATUSES)[number];
  /** Members on today's date (organisation timezone). */
  memberCount: number;
  /** Policies scoped to the group (any date). */
  policyCount: number;
  createdAt: string; updatedAt: string;
}

/** Put employees in the group from `effectiveFrom` (an open membership of another group ends the day before). */
export const employeeGroupMembersInputSchema = z.object({
  employeeIds: z.array(uuidSchema).min(1).max(500).refine((a) => new Set(a).size === a.length, { message: 'Each employee once' }),
  effectiveFrom: isoDateSchema,
  /** Inclusive last day; null / absent = open-ended. */
  effectiveTo: isoDateSchema.nullable().optional(),
}).refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: 'The last day cannot be before the first day', path: ['effectiveTo'] });
export type EmployeeGroupMembersInput = z.infer<typeof employeeGroupMembersInputSchema>;
/** End a membership: its inclusive last day (the day before `effectiveFrom` deletes nothing — use DELETE for that). */
export const endEmployeeGroupMembershipSchema = z.object({ effectiveTo: isoDateSchema });
export const employeeGroupMembersQuerySchema = paginationQuerySchema.extend({
  /** Members on this date (default: today). */
  activeOn: isoDateSchema.optional(),
  /** Include past and future memberships (ignores activeOn). */
  all: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').default(false),
  search: z.string().trim().max(100).optional(),
});
export interface EmployeeGroupMemberDto {
  id: string; employeeGroupId: string; employeeId: string; employeeNumber: string; displayName: string; branchId: string;
  effectiveFrom: string;
  /** Inclusive last day, null = open-ended. */
  effectiveTo: string | null;
}

// ----- policy resolution ----------------------------------------------------------------------------------------------------

export const policyListQuerySchema = z.object({
  branchId: uuidSchema.optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  departmentId: uuidSchema.optional(),
  employeeGroupId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  activeOn: isoDateSchema.optional(),
});
export const policyResolveQuerySchema = z.object({ employeeId: uuidSchema, date: isoDateSchema });
/** Where an employee sits on a date — the facts every policy dimension is matched against. */
export interface PolicyScopeDto { countryCode: string | null; branchId: string | null; departmentId: string | null; employeeGroupId: string | null; shiftId: string | null }
export interface PolicyCandidateDto {
  id: string; name: string; scope: PolicyScopeDto; effectiveFrom: string; effectiveTo: string | null;
  /** Higher = more specific (shift 32, group 16, department 8, branch 4, country 2). */
  specificity: number;
  /** Whether it applies on the date; when not, which dimension (or the dates) ruled it out. */
  matches: boolean; mismatch: 'DATES' | 'COUNTRY' | 'BRANCH' | 'DEPARTMENT' | 'EMPLOYEE_GROUP' | 'SHIFT' | null;
}
export interface PolicyResolutionDto {
  employeeId: string; date: string; scope: PolicyScopeDto;
  /** The winning policy (null = the contract defaults apply). */
  policy: { id: string; name: string; specificity: number } | null;
  candidates: PolicyCandidateDto[];
}

// ----- country packs and compliance ----------------------------------------------------------------------------------------

export const COMPLIANCE_WARNING_CODES = [
  'FULL_DAY_ABOVE_STATUTORY_DAY', 'OVERTIME_CAP_MISSING', 'OVERTIME_CAP_ABOVE_LAW', 'MAX_DAILY_WORK_MISSING', 'MAX_DAILY_WORK_ABOVE_LAW',
  'WEEKLY_THRESHOLD_MISSING', 'WEEKLY_THRESHOLD_ABOVE_LAW', 'OVERTIME_RATE_BELOW_LAW', 'RAMADAN_HOURS_ABOVE_LAW', 'RAMADAN_NOT_CONFIGURED', 'SHIFT_LONGER_THAN_STATUTORY_DAY',
] as const;
export type ComplianceWarningCode = (typeof COMPLIANCE_WARNING_CODES)[number];
export interface ComplianceWarningDto { code: ComplianceWarningCode; severity: 'warning' | 'info'; field: string; params: Record<string, string | number | null> }
/** POST /attendance-policies/compliance — check a policy draft (the editor's body) against a country pack. */
export const policyComplianceQuerySchema = z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) });
export interface PolicyComplianceDto { countryCode: string; packVersion: string | null; warnings: ComplianceWarningDto[] }

// ----- attendance points & discipline --------------------------------------------------------------------------------------

export const attendancePointsQuerySchema = paginationQuerySchema.extend({
  /** The points standing on this date (default: today, organisation timezone): events of the policy's rolling window. */
  asOf: isoDateSchema.optional(),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeGroupId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
  /** Only employees with at least this many points. */
  minPoints: z.coerce.number().min(0).max(1000).optional(),
});
export interface AttendancePointEventDto { date: string; kind: AttendancePointKind; points: number; expiresOn: string; policyId: string | null }
export interface AttendancePointsRowDto {
  employeeId: string; employeeNumber: string; displayName: string; branchId: string;
  policyId: string | null; policyName: string | null;
  points: number;
  occurrences: Record<AttendancePointKind, number>;
  /** The highest escalation step reached (null = none) and the next one. */
  escalation: { action: DisciplineAction; threshold: number } | null;
  nextEscalation: { action: DisciplineAction; threshold: number } | null;
}
export interface AttendancePointsDetailDto extends AttendancePointsRowDto { asOf: string; windowFrom: string; events: AttendancePointEventDto[] }

// ----- overtime summary ----------------------------------------------------------------------------------------------------

export const overtimeSummaryQuerySchema = paginationQuerySchema.extend({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  branchId: uuidSchema.optional(),
  departmentId: uuidSchema.optional(),
  employeeGroupId: uuidSchema.optional(),
  search: z.string().trim().max(100).optional(),
});
export interface OvertimeSummaryRowDto {
  employeeId: string; employeeNumber: string; displayName: string; branchId: string; policyId: string | null; policyName: string | null;
  workedMinutes: number;
  regularOvertimeMinutes: number; weeklyOffOvertimeMinutes: number; holidayOvertimeMinutes: number;
  /** Minutes over the policy's weekly threshold, net of the daily overtime already counted in that week. */
  weeklyOvertimeMinutes: number;
  /** Σ minutes × the policy's rate per category — what payroll multiplies by the hourly wage. */
  weightedOvertimeMinutes: number;
  /** Days on which worked minutes exceeded the policy's statutory daily maximum. */
  daysOverDailyMaximum: number;
}

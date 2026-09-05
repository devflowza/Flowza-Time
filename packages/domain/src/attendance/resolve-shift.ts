import { DateTime } from 'luxon';
import type { AttendanceRules } from '@flowza/contracts';
import type { EngineShiftAssignment, EngineShiftPattern, ShiftResolution } from './types.js';

/** Where the employee sits in the organisation on the date being resolved. */
export interface EmployeeScope {
  employeeId: string;
  teamIds: readonly string[];
  departmentId: string | null;
  branchId: string | null;
  organizationId: string;
}

/** Higher = more specific. EMPLOYEE beats TEAM beats DEPARTMENT beats BRANCH beats ORGANIZATION (§25). */
export const ASSIGNMENT_SPECIFICITY: Record<EngineShiftAssignment['targetType'], number> = {
  EMPLOYEE: 5,
  TEAM: 4,
  DEPARTMENT: 3,
  BRANCH: 2,
  ORGANIZATION: 1,
};

/** Effective-dated rows use half-open ranges `[effectiveFrom, effectiveTo)` — mirrors the DB `daterange(..., '[)')`. */
export function isEffectiveOn(row: { effectiveFrom: string; effectiveTo: string | null }, date: string): boolean {
  return row.effectiveFrom <= date && (row.effectiveTo === null || date < row.effectiveTo);
}

function targets(assignment: EngineShiftAssignment, scope: EmployeeScope): boolean {
  switch (assignment.targetType) {
    case 'EMPLOYEE': return assignment.targetId === scope.employeeId;
    case 'TEAM': return scope.teamIds.includes(assignment.targetId);
    case 'DEPARTMENT': return scope.departmentId !== null && assignment.targetId === scope.departmentId;
    case 'BRANCH': return scope.branchId !== null && assignment.targetId === scope.branchId;
    case 'ORGANIZATION': return assignment.targetId === scope.organizationId;
    default: {
      const exhaustive: never = assignment.targetType;
      return exhaustive;
    }
  }
}

/** Most specific assignment first; among equals the most recently effective, then id for determinism. */
function compareAssignments(a: EngineShiftAssignment, b: EngineShiftAssignment): number {
  const specificity = ASSIGNMENT_SPECIFICITY[b.targetType] - ASSIGNMENT_SPECIFICITY[a.targetType];
  if (specificity !== 0) return specificity;
  if (a.effectiveFrom !== b.effectiveFrom) return b.effectiveFrom.localeCompare(a.effectiveFrom);
  return a.id.localeCompare(b.id);
}

/** Zero-based day of the rotation cycle for `date` given the pattern anchor (handles dates before the anchor). */
export function patternCycleDay(pattern: Pick<EngineShiftPattern, 'anchorDate' | 'cycleLengthDays'>, date: string): number {
  const anchor = DateTime.fromISO(pattern.anchorDate, { zone: 'utc' });
  const target = DateTime.fromISO(date, { zone: 'utc' });
  const elapsed = Math.round(target.diff(anchor, 'days').days);
  const length = Math.max(1, pattern.cycleLengthDays);
  return ((elapsed % length) + length) % length;
}

export interface ResolvedShiftDetail extends ShiftResolution {
  /** How the shift was obtained. */
  source: 'ASSIGNMENT' | 'PATTERN' | 'NONE';
  /** Cycle day used when the assignment points at a rotation pattern. */
  patternDay: number | null;
}

/**
 * Resolve the shift for an employee on a date (§G.2, §25): the most specific assignment effective on the
 * date wins. A pattern assignment maps the date onto the rotation cycle: an `{off: true}` entry (or a day
 * the sequence does not define) is a pattern off-day (`isPatternOff`); an unknown pattern id yields no shift.
 */
export function resolveShift(
  assignments: readonly EngineShiftAssignment[],
  patterns: readonly EngineShiftPattern[],
  scope: EmployeeScope,
  date: string,
): ResolvedShiftDetail {
  const candidates = assignments.filter((a) => isEffectiveOn(a, date) && targets(a, scope)).sort(compareAssignments);
  const assignment = candidates[0];
  if (!assignment) return { assignment: null, shiftId: null, isPatternOff: false, source: 'NONE', patternDay: null };

  if (assignment.shiftId !== null) {
    return { assignment, shiftId: assignment.shiftId, isPatternOff: false, source: 'ASSIGNMENT', patternDay: null };
  }
  const pattern = patterns.find((p) => p.id === assignment.shiftPatternId);
  if (!pattern) return { assignment, shiftId: null, isPatternOff: false, source: 'PATTERN', patternDay: null };

  const day = patternCycleDay(pattern, date);
  const entry = pattern.sequence.find((s) => s.day === day);
  if (!entry || 'off' in entry) return { assignment, shiftId: null, isPatternOff: true, source: 'PATTERN', patternDay: day };
  return { assignment, shiftId: entry.shiftId, isPatternOff: false, source: 'PATTERN', patternDay: day };
}

/** Effective-dated rule set row as loaded from `attendance_rule_sets`. */
export interface EngineRuleSet {
  id: string;
  branchId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  rules: AttendanceRules;
}

/**
 * Rule set effective on `date` for a branch: a branch-specific set wins over the organisation default
 * (`branchId === null`). Among several matches the latest `effectiveFrom` wins, then id.
 */
export function resolveRuleSet<T extends EngineRuleSet>(ruleSets: readonly T[], date: string, branchId: string | null): T | null {
  const active = ruleSets.filter((r) => isEffectiveOn(r, date));
  const pick = (rows: T[]): T | null =>
    rows.sort((a, b) => (a.effectiveFrom !== b.effectiveFrom ? b.effectiveFrom.localeCompare(a.effectiveFrom) : a.id.localeCompare(b.id)))[0] ?? null;
  const branchSpecific = branchId === null ? [] : active.filter((r) => r.branchId === branchId);
  return pick(branchSpecific) ?? pick(active.filter((r) => r.branchId === null));
}

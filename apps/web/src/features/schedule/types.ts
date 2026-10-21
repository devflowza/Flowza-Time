import type { AttendanceRuleSetInput, ShiftBreak } from '@flowza/contracts';

export interface ShiftDto {
  id: string; code: string; name: string; nameAr: string | null; type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; coreStart: string | null; coreEnd: string | null; dayBoundary: string; breaks: ShiftBreak[];
  punchInWindowBeforeMinutes: number; punchOutWindowAfterMinutes: number; graceInMinutes: number | null; graceOutMinutes: number | null; color: string | null; status: string; crossesMidnight: boolean | null; assignmentCount?: number; createdAt: string; updatedAt: string;
  /** FIXED only: the flexible start band (minutes after the start; 0 = off). Absent from an older API. */
  flexStartMinutes?: number;
}
export type PatternEntry = { day: number; shiftId: string } | { day: number; off: true };
export interface ShiftPatternDto { id: string; code: string; name: string; cycleLengthDays: number; sequence: PatternEntry[]; anchorDate: string; status: string; createdAt: string; updatedAt: string }
export interface ShiftAssignmentDto { id: string; targetType: string; targetId: string; targetName: string | null; branchId: string | null; shiftId: string | null; shiftName: string | null; shiftPatternId: string | null; patternName: string | null; effectiveFrom: string; effectiveTo: string | null; createdBy: string | null; createdAt: string; /** Whether the caller may end or remove it (absent from an older API: everybody holding shift.assign). */ canManage?: boolean }
export interface ShiftResolution {
  employeeId: string; date: string; source: string | null; isPatternOff: boolean; patternDay: number | null;
  assignment: { id: string; targetType: string; targetId: string; shiftId: string | null; shiftPatternId: string | null; effectiveFrom: string; effectiveTo: string | null } | null;
  shift: ShiftDto | null; ruleSet: { id: string; name: string; branchId: string | null } | null; scope: { employeeId: string; teamIds: string[]; departmentId: string | null; branchId: string; organizationId: string };
}
/**
 * An attendance rule set = the attendance policy: its scope (branch; Enterprise: country, location, department, employee group,
 * shift), the rules and the `policy` sections. `specificity` orders policies (shift 32 > group 16 > department 8 > location or
 * branch 4 > country 2; between two locations the deeper one wins — docs/locations.md §3). `locationId` is a group location
 * (no `branchId`) or a place (with `branchId` = the place's branch).
 */
export type RuleSetDto = AttendanceRuleSetInput & { id: string; version: number; specificity?: number; createdAt: string; updatedAt: string };
/**
 * `branchCount` = branches that picked this calendar (absent from an older API); the default also applies to branches without one.
 * `autoRollover`: next year's recurring holidays are created from 1 December.
 */
export interface HolidayCalendarDto { id: string; name: string; countryCode: string | null; isDefault: boolean; autoRollover?: boolean; holidayCount?: number; branchCount?: number; createdAt: string; updatedAt: string }
/** `recursYearly`: the same Gregorian date every year (copied to the next year by "Copy to year" and the rollover). */
export interface HolidayDto { id: string; calendarId: string; name: string; nameAr: string | null; date: string; endDate: string | null; isHalfDay: boolean; type: string; branchIds: string[] | null; isTentative: boolean; recursYearly?: boolean; createdAt: string }
export type WithRecalc<T> = T & { recalculationJobId: string | null };
/** POST /holiday-calendars/:id/copy-year: the holidays created in `toYear` and the ones left out (and why). */
export interface HolidayYearCopyDto {
  calendarId: string; fromYear: number; toYear: number; created: HolidayDto[];
  skipped: Array<{ sourceId: string; name: string; date: string; reason: 'NOT_RECURRING' | 'ALREADY_THERE' }>;
  recalculationJobId: string | null;
}

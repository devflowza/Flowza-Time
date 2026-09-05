import type { AttendanceRuleSetInput, ShiftBreak } from '@flowza/contracts';

export interface ShiftDto {
  id: string; code: string; name: string; nameAr: string | null; type: string; startTime: string | null; endTime: string | null; requiredMinutes: number | null; coreStart: string | null; coreEnd: string | null; dayBoundary: string; breaks: ShiftBreak[];
  punchInWindowBeforeMinutes: number; punchOutWindowAfterMinutes: number; graceInMinutes: number | null; graceOutMinutes: number | null; color: string | null; status: string; crossesMidnight: boolean | null; assignmentCount?: number; createdAt: string; updatedAt: string;
}
export type PatternEntry = { day: number; shiftId: string } | { day: number; off: true };
export interface ShiftPatternDto { id: string; code: string; name: string; cycleLengthDays: number; sequence: PatternEntry[]; anchorDate: string; status: string; createdAt: string; updatedAt: string }
export interface ShiftAssignmentDto { id: string; targetType: string; targetId: string; targetName: string | null; branchId: string | null; shiftId: string | null; shiftName: string | null; shiftPatternId: string | null; patternName: string | null; effectiveFrom: string; effectiveTo: string | null; createdBy: string | null; createdAt: string }
export interface ShiftResolution {
  employeeId: string; date: string; source: string | null; isPatternOff: boolean; patternDay: number | null;
  assignment: { id: string; targetType: string; targetId: string; shiftId: string | null; shiftPatternId: string | null; effectiveFrom: string; effectiveTo: string | null } | null;
  shift: ShiftDto | null; ruleSet: { id: string; name: string; branchId: string | null } | null; scope: { employeeId: string; teamIds: string[]; departmentId: string | null; branchId: string; organizationId: string };
}
export type RuleSetDto = AttendanceRuleSetInput & { id: string; version: number; createdAt: string; updatedAt: string };
export interface HolidayCalendarDto { id: string; name: string; countryCode: string | null; isDefault: boolean; holidayCount?: number; createdAt: string; updatedAt: string }
export interface HolidayDto { id: string; calendarId: string; name: string; nameAr: string | null; date: string; endDate: string | null; isHalfDay: boolean; type: string; branchIds: string[] | null; isTentative: boolean; createdAt: string }
export type WithRecalc<T> = T & { recalculationJobId: string | null };

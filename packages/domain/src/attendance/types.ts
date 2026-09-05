import type { AttendanceEventType, AttendanceFlag, AttendanceRules, AttendanceStatus, ShiftBreak, ShiftType, VerificationMethod } from '@flowza/contracts';

/** Inputs to the pure attendance engine (§G). All timestamps are UTC ISO strings; dates are YYYY-MM-DD. */
export interface EngineShift {
  id: string;
  code: string;
  name: string;
  type: ShiftType;
  startTime: string | null;       // HH:mm (FIXED)
  endTime: string | null;         // HH:mm (FIXED); <= startTime means the shift crosses midnight
  requiredMinutes: number | null; // FLEXIBLE
  coreStart: string | null;
  coreEnd: string | null;
  dayBoundary: string;            // HH:mm, FLEXIBLE attendance-day boundary (default 04:00)
  breaks: ShiftBreak[];
  punchInWindowBeforeMinutes: number;
  punchOutWindowAfterMinutes: number;
  graceInMinutes: number | null;  // overrides rule set when set
  graceOutMinutes: number | null;
}

export interface EngineEvent {
  id: string;
  punchedAt: string;              // UTC ISO
  eventType: AttendanceEventType; // PUNCH when the device has no direction
  source: 'DEVICE' | 'MANUAL' | 'CORRECTION' | 'IMPORT' | 'MOBILE';
  verificationMethod: VerificationMethod;
  deviceId: string | null;
  voided: boolean;
}

export interface EngineHoliday { id: string; name: string; isHalfDay: boolean }
export interface EngineLeave { id: string; leaveTypeCode: string; isPaid: boolean; isHalfDay: boolean; halfDayPart: 'FIRST_HALF' | 'SECOND_HALF' | null }

export interface DailyCalculationInput {
  employeeId: string;
  attendanceDate: string;          // YYYY-MM-DD in the branch timezone
  timezone: string;                // IANA
  shift: EngineShift | null;       // null = no shift assigned
  rules: AttendanceRules;
  ruleSetId: string | null;
  shiftAssignmentId: string | null;
  weeklyOffDays: number[];         // 0=Sun..6=Sat
  holiday: EngineHoliday | null;
  leave: EngineLeave | null;
  /** Events in a generous window around the date (engine filters by the shift punch window). */
  events: EngineEvent[];
  employment: { joiningDate: string; exitDate: string | null; status: 'active' | 'on_leave' | 'suspended' | 'terminated' | 'resigned' };
  /** Employee is subject to Ramadan hours (rules.ramadanMode decides). */
  ramadanEligible?: boolean;
  now?: string;                    // UTC ISO; used to decide whether a missing OUT is "still working"
  /**
   * Shifts of the previous / next attendance date, used to build the neighbouring punch windows for
   * attribution (§G.3). `undefined` = same shift as `shift`; `null` = no shift on that day.
   */
  adjacentShifts?: { previous?: EngineShift | null; next?: EngineShift | null };
}

export interface TraceStep { step: string; detail: string; values?: Record<string, unknown> }
export interface CalculationTrace {
  engineVersion: string;
  inputs: { shiftId: string | null; shiftType: ShiftType | null; ruleSetId: string | null; timezone: string; window: { start: string; end: string } | null; holiday: string | null; leave: string | null; weeklyOff: boolean };
  punches: Array<{ eventId: string; punchedAt: string; local: string; role: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END' | 'IGNORED' | 'DUPLICATE' | 'OUT_OF_WINDOW'; note?: string }>;
  steps: TraceStep[];
}

export interface DailyCalculationResult {
  employeeId: string;
  attendanceDate: string;
  timezone: string;
  shiftId: string | null;
  shiftAssignmentId: string | null;
  ruleSetId: string | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  scheduledMinutes: number;
  firstInAt: string | null;
  lastOutAt: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: 'REGULAR' | 'WEEKLY_OFF' | 'HOLIDAY' | null;
  status: AttendanceStatus;
  flags: AttendanceFlag[];
  punchCount: number;
  eventIds: string[];              // events attributed to this date (for has_correction etc.)
  trace: CalculationTrace;
}

/** Resolves which shift applies to an employee on a date (§25). Most specific assignment wins. */
export interface EngineShiftAssignment {
  id: string;
  targetType: 'ORGANIZATION' | 'BRANCH' | 'DEPARTMENT' | 'TEAM' | 'EMPLOYEE';
  targetId: string;
  shiftId: string | null;
  shiftPatternId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}
export interface EngineShiftPattern {
  id: string;
  cycleLengthDays: number;
  anchorDate: string;
  sequence: Array<{ day: number; shiftId: string } | { day: number; off: true }>;
}
export interface ShiftResolution { assignment: EngineShiftAssignment | null; shiftId: string | null; isPatternOff: boolean }

export const ENGINE_VERSION = 'attendance-engine/1.0.0';

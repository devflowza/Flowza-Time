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
  dayBoundary: string;            // HH:mm, FLEXIBLE attendance-day boundary (default 00:00)
  breaks: ShiftBreak[];
  punchInWindowBeforeMinutes: number;
  punchOutWindowAfterMinutes: number;
  graceInMinutes: number | null;  // overrides rule set when set
  graceOutMinutes: number | null;
}

/**
 * Facts a self-service punch carries in its raw payload (written by the check-in endpoint, HR portal Prompt 4). The
 * engine turns them into flags: `channel` → SELF_SERVICE_PUNCH, a punch a REAL fence judged outside → OUTSIDE_GEOFENCE
 * (see `withinGeofence`), `outOfWindow` → OUT_OF_WINDOW. Every field is optional: device punches carry none of them.
 */
export interface EnginePunchPayload {
  channel?: 'web' | 'mobile' | null;
  /**
   * The B-36 truth table (HR portal Prompt 4 review, P2-7): true = inside the fence that judged the punch; false = a real
   * fence was evaluated with a location and the punch failed it (outside, or a mocked location); null = cannot say (no
   * location, a fix too imprecise to judge, no fence assigned, geofencing off). When present it alone decides
   * OUTSIDE_GEOFENCE (only `false` flags); payloads written before it existed fall back to `geofenceVerdict` +
   * `geofenceReason`.
   */
  withinGeofence?: boolean | null;
  /** Why the verdict was given (`inside`, `outside`, `mock_location`, `location_missing`, `gps_accuracy_too_low`, `geofence_off`, `no_fences_assigned`). */
  geofenceReason?: string | null;
  /** Geofence verdict as the check-in endpoint evaluated it (`allowed`, `no_fence`, `flagged`, `logged`, `denied_outside`, `denied_mock`, …). */
  geofenceVerdict?: string | null;
  /** The device reported a mocked location. */
  isMock?: boolean | null;
  /** The punch fell outside the policy's check-in / check-out window. */
  outOfWindow?: boolean | null;
}

export interface EngineEvent {
  id: string;
  punchedAt: string;              // UTC ISO
  eventType: AttendanceEventType; // PUNCH when the device has no direction
  source: 'DEVICE' | 'MANUAL' | 'CORRECTION' | 'IMPORT' | 'MOBILE';
  verificationMethod: VerificationMethod;
  deviceId: string | null;
  voided: boolean;
  /** Self-service facts from the raw payload; absent for device punches. */
  payload?: EnginePunchPayload | null;
}

export interface EngineHoliday { id: string; name: string; isHalfDay: boolean }
export interface EngineLeave { id: string; leaveTypeCode: string; isPaid: boolean; isHalfDay: boolean; halfDayPart: 'FIRST_HALF' | 'SECOND_HALF' | null }

/**
 * An active (unrevoked) `attendance_day_marks` row for the date: a reviewed verdict the engine folds into the record.
 *   UNEXCUSED  → flag UNEXCUSED, `unexcused = true`
 *   EXCUSED    → flag EXCUSED; LATE / ABSENT consequences stay on the record but `lopDays = 0`
 *   PAY_EFFECT → flag PAY_EFFECT_HALF / PAY_EFFECT_FULL (charged to paid leave: no loss of pay)
 *   LOP        → flags LOP + PAY_EFFECT_HALF / PAY_EFFECT_FULL, `lopDays = payEffectDays`
 */
export interface EngineDayMark {
  id: string;
  kind: 'UNEXCUSED' | 'EXCUSED' | 'LOP' | 'PAY_EFFECT';
  /** 0, 0.5 or 1. */
  payEffectDays: number;
  source: 'SWEEP' | 'NOTE_REVIEW' | 'HR' | 'SYSTEM';
}

/** The organisation-level policy switches the engine reads (`organization_settings.attendance`, HR portal Prompt 3). */
export interface EngineAttendanceSettings {
  /** Work on a weekly off / holiday: `record` keeps the minutes (status unchanged), `overtime` also counts them as overtime, `ignore` zeroes them. */
  nonWorkingDay: { action: 'record' | 'ignore' | 'overtime' };
}

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
  /** Active day marks for the date (see EngineDayMark); absent = none. */
  dayMarks?: EngineDayMark[];
  /** Organisation policy switches; absent = the contract defaults (non-working-day work is recorded). */
  settings?: EngineAttendanceSettings;
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
  /** Loss-of-pay days (0 / 0.5 / 1) from an LOP mark; 0 when the day is excused or the pay effect was charged to leave. */
  lopDays: number;
  /** The day carries an active UNEXCUSED mark. */
  unexcused: boolean;
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

/**
 * 1.1.0 — FLEXIBLE shifts: the expected check-out is the check-in + required minutes + unpaid breaks (the later of that and the
 * core end); without core hours the employee may check in at any time and is never late.
 * 1.2.0 — FIXED shifts: regular overtime is the time worked after the shift end (before its start with early-in), measured on
 * the worked spans; "beyond the scheduled minutes only" is the rule set's `overtimeRequiresScheduledHours`.
 * 1.3.0 — FLEXIBLE shifts: the check-out that closes a day's open check-in stays with that day even after the day boundary
 * (overnight.ts); early departure is the shortfall against the required minutes (or the core end) and the grace-out forgives a
 * shortfall within it instead of shaving every one. FLAG_ONLY missing punches get their own status MISSING_PUNCH (hours unknown)
 * instead of PRESENT with 0 worked minutes.
 */
export const ENGINE_VERSION = 'attendance-engine/1.3.0';

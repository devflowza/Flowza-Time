import { DateTime } from 'luxon';
import { DEFAULT_ATTENDANCE_RULES, type AttendanceEventType, type AttendanceRules } from '@flowza/contracts';
import type { DailyCalculationInput, EngineEvent, EngineShift } from './types.js';

/**
 * Deterministic fixture builders for engine tests (not exported from the package index).
 * Default zone is Asia/Muscat (UTC+4, no DST); dates default to Tuesday 2026-03-10.
 */
export const MUSCAT = 'Asia/Muscat';
export const RIYADH = 'Asia/Riyadh';
export const DATE = '2026-03-10';

/** Local wall-clock `HH:mm[:ss]` on `date` in `zone` → UTC ISO string. */
export function at(date: string, time: string, zone: string = MUSCAT): string {
  const [h, m, s] = time.split(':').map(Number);
  return DateTime.fromISO(date, { zone }).set({ hour: h ?? 0, minute: m ?? 0, second: s ?? 0, millisecond: 0 }).toUTC().toISO({ suppressMilliseconds: true }) as string;
}

let counter = 0;
export function resetIds(): void {
  counter = 0;
}

export function event(punchedAt: string, overrides: Partial<EngineEvent> = {}): EngineEvent {
  counter += 1;
  return {
    id: overrides.id ?? `evt-${String(counter).padStart(3, '0')}`,
    punchedAt,
    eventType: overrides.eventType ?? 'PUNCH',
    source: overrides.source ?? 'DEVICE',
    verificationMethod: overrides.verificationMethod ?? 'fingerprint',
    deviceId: overrides.deviceId ?? 'device-1',
    voided: overrides.voided ?? false,
  };
}

/** Punch on `date` at local `time` (defaults to undirected PUNCH). */
export function punch(date: string, time: string, eventType: AttendanceEventType = 'PUNCH', zone: string = MUSCAT, overrides: Partial<EngineEvent> = {}): EngineEvent {
  return event(at(date, time, zone), { eventType, ...overrides });
}

export function fixedShift(overrides: Partial<EngineShift> = {}): EngineShift {
  return {
    id: 'shift-day',
    code: 'DAY',
    name: 'Day shift',
    type: 'FIXED',
    startTime: '09:00',
    endTime: '17:00',
    requiredMinutes: null,
    coreStart: null,
    coreEnd: null,
    dayBoundary: '04:00',
    breaks: [],
    punchInWindowBeforeMinutes: 240,
    punchOutWindowAfterMinutes: 360,
    graceInMinutes: null,
    graceOutMinutes: null,
    ...overrides,
  };
}

export function nightShift(overrides: Partial<EngineShift> = {}): EngineShift {
  return fixedShift({ id: 'shift-night', code: 'NIGHT', name: 'Night shift', startTime: '22:00', endTime: '06:00', ...overrides });
}

export function flexibleShift(overrides: Partial<EngineShift> = {}): EngineShift {
  return fixedShift({ id: 'shift-flex', code: 'FLEX', name: 'Flexible', type: 'FLEXIBLE', startTime: null, endTime: null, requiredMinutes: 480, dayBoundary: '04:00', ...overrides });
}

export function rules(overrides: Partial<AttendanceRules> = {}): AttendanceRules {
  return { ...DEFAULT_ATTENDANCE_RULES, ...overrides };
}

export function input(overrides: Partial<DailyCalculationInput> = {}): DailyCalculationInput {
  return {
    employeeId: 'emp-1',
    attendanceDate: DATE,
    timezone: MUSCAT,
    shift: fixedShift(),
    rules: rules(),
    ruleSetId: 'rules-1',
    shiftAssignmentId: 'assign-1',
    weeklyOffDays: [5, 6],
    holiday: null,
    leave: null,
    events: [],
    employment: { joiningDate: '2025-01-01', exitDate: null, status: 'active' },
    ...overrides,
  };
}

import type { AttendanceFlag, AttendanceStatus } from '@flowza/contracts';
import type { DailyCalculationResult } from './types.js';

/** The subset of a daily record the summariser needs (works for engine results and DB rows alike). */
export type PeriodRecordLike = Pick<
  DailyCalculationResult,
  'attendanceDate' | 'status' | 'flags' | 'workedMinutes' | 'overtimeMinutes' | 'overtimeCategory' | 'lateMinutes' | 'earlyDepartureMinutes'
> & {
  /** Whether the leave behind a LEAVE / HALF_DAY_LEAVE record is paid; defaults to `opts.defaultLeavePaid`. */
  leaveIsPaid?: boolean | null;
};

export interface PeriodSummaryOptions {
  /** Inclusive date range; records outside it are ignored. */
  periodStart: string;
  periodEnd: string;
  /** Used when a record does not say whether its leave is paid (default `true`). */
  defaultLeavePaid?: boolean;
}

/** Mirrors the numeric columns of `attendance_period_summaries` (§G.8). */
export interface PeriodSummary {
  periodStart: string;
  periodEnd: string;
  /** Days the employee was expected to work (everything except HOLIDAY, WEEKLY_OFF, NOT_JOINED, EXITED). */
  workingDays: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  paidLeaveDays: number;
  holidayDays: number;
  weeklyOffDays: number;
  halfDays: number;
  missingPunchDays: number;
  lateDays: number;
  /** Worked minutes that are not overtime. */
  regularMinutes: number;
  /** Overtime in the REGULAR category (working days). */
  overtimeMinutes: number;
  overtimeWeeklyOffMinutes: number;
  overtimeHolidayMinutes: number;
  /** Convenience: all three overtime categories combined. */
  totalOvertimeMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  /** Records still PENDING — payroll should not finalise while > 0. */
  pendingDays: number;
  recordCount: number;
}

const NON_WORKING: ReadonlySet<AttendanceStatus> = new Set(['HOLIDAY', 'WEEKLY_OFF', 'NOT_JOINED', 'EXITED']);

function has(flags: readonly AttendanceFlag[], flag: AttendanceFlag): boolean {
  return flags.includes(flag);
}

/**
 * Aggregate daily records into payroll totals. Fractions: a HALF_DAY counts 0.5 present; the other half is
 * 0.5 leave when the record carries HALF_DAY_LEAVE, otherwise 0.5 absent. ABSENT + HALF_DAY_LEAVE is 0.5
 * absent + 0.5 leave. Regular minutes are `worked − overtime` per record (never negative).
 */
export function summarisePeriod(records: readonly PeriodRecordLike[], opts: PeriodSummaryOptions): PeriodSummary {
  const defaultLeavePaid = opts.defaultLeavePaid ?? true;
  const summary: PeriodSummary = {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    workingDays: 0,
    presentDays: 0,
    absentDays: 0,
    leaveDays: 0,
    paidLeaveDays: 0,
    holidayDays: 0,
    weeklyOffDays: 0,
    halfDays: 0,
    missingPunchDays: 0,
    lateDays: 0,
    regularMinutes: 0,
    overtimeMinutes: 0,
    overtimeWeeklyOffMinutes: 0,
    overtimeHolidayMinutes: 0,
    totalOvertimeMinutes: 0,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    pendingDays: 0,
    recordCount: 0,
  };

  for (const record of records) {
    if (record.attendanceDate < opts.periodStart || record.attendanceDate > opts.periodEnd) continue;
    summary.recordCount += 1;
    if (!NON_WORKING.has(record.status)) summary.workingDays += 1;

    const halfDayLeave = has(record.flags, 'HALF_DAY_LEAVE');
    const leavePaid = record.leaveIsPaid ?? defaultLeavePaid;
    const addLeave = (days: number): void => {
      summary.leaveDays += days;
      if (leavePaid) summary.paidLeaveDays += days;
    };

    switch (record.status) {
      case 'PRESENT':
      case 'MISSING_PUNCH':
        summary.presentDays += 1;
        break;
      case 'HALF_DAY':
        summary.halfDays += 1;
        summary.presentDays += 0.5;
        if (halfDayLeave) addLeave(0.5);
        else summary.absentDays += 0.5;
        break;
      case 'ABSENT':
        if (halfDayLeave) { summary.absentDays += 0.5; addLeave(0.5); }
        else summary.absentDays += 1;
        break;
      case 'LEAVE':
        addLeave(1);
        break;
      case 'HOLIDAY':
        summary.holidayDays += 1;
        break;
      case 'WEEKLY_OFF':
        summary.weeklyOffDays += 1;
        break;
      case 'PENDING':
        summary.pendingDays += 1;
        break;
      case 'NOT_JOINED':
      case 'EXITED':
        break;
      default: {
        const exhaustive: never = record.status;
        return exhaustive;
      }
    }

    if (record.status === 'MISSING_PUNCH' || has(record.flags, 'MISSING_IN') || has(record.flags, 'MISSING_OUT')) summary.missingPunchDays += 1;
    if (has(record.flags, 'LATE')) summary.lateDays += 1;

    const overtime = Math.max(0, record.overtimeMinutes);
    summary.regularMinutes += Math.max(0, record.workedMinutes - overtime);
    summary.totalOvertimeMinutes += overtime;
    switch (record.overtimeCategory) {
      case 'WEEKLY_OFF': summary.overtimeWeeklyOffMinutes += overtime; break;
      case 'HOLIDAY': summary.overtimeHolidayMinutes += overtime; break;
      case 'REGULAR': summary.overtimeMinutes += overtime; break;
      case null: break;
      default: {
        const exhaustive: never = record.overtimeCategory;
        return exhaustive;
      }
    }
    summary.lateMinutes += Math.max(0, record.lateMinutes);
    summary.earlyDepartureMinutes += Math.max(0, record.earlyDepartureMinutes);
  }
  return summary;
}

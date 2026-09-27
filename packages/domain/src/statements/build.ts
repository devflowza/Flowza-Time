import { DateTime } from 'luxon';
import {
  STATEMENT_SNAPSHOT_VERSION,
  type StatementLeaveTotal,
  type StatementSnapshot,
  type StatementSnapshotDay,
} from '@flowza/contracts';
import { resolveAttendanceCode, type CodeOverrides, type LeaveTypeLike } from '../reports/codes.js';
import { summariseCodes, type SummaryRecordLike } from '../reports/summary.js';
import { DASH, formatClock, formatHours, formatIsoDate, type HoursNotation, type TimeFormat } from '../reports/format.js';

/** One daily record as the statement builder needs it (the worker maps DB rows to this). */
export interface StatementDayRecordInput {
  date: string; // YYYY-MM-DD
  status: string;
  flags: readonly string[];
  firstInAt: string | Date | null;
  lastOutAt: string | Date | null;
  workedMinutes: number;
  scheduledMinutes: number;
  lateMinutes: number;
  earlyDepartureMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: string | null;
  leave: { code: string; name: string; nameAr: string | null; isPaid: boolean; treatAsPresent: boolean } | null;
}

export interface StatementBuildInput {
  organization: {
    name: string;
    timezone: string;
    locale: 'en' | 'ar';
    hoursNotation: HoursNotation;
    timeFormat: TimeFormat;
    /** Luxon pattern for tabular dates (from settings.general.dateFormat via luxonDatePattern). */
    datePattern: string;
    codeOverrides: CodeOverrides;
  };
  period: { start: string; end: string }; // inclusive YYYY-MM-DD, same month
  employee: {
    id: string;
    displayName: string;
    employeeNumber: string;
    branchName: string | null;
    departmentName: string | null;
    designationName: string | null;
    joiningDate: string;
    exitDate: string | null;
  };
  records: readonly StatementDayRecordInput[];
  leaveTypes: readonly LeaveTypeLike[];
  now: Date;
}

/**
 * The statement document the employee reviews and signs: one row per calendar day of the month (days the engine has
 * not produced a record for render as pending, so a missing sign-in is visible instead of silently absent from the
 * list), and the totals block the product asks for — required vs. worked hours with the difference, every leave type
 * taken (comp-off, sick, …), and the month's total delay. Pure and deterministic: everything is derived from the
 * inputs, all display strings are fixed here in the organisation's own notation, clock and date format, and nothing
 * about the snapshot changes when records are recomputed later (reissue = void + new statement).
 */
export function buildStatementSnapshot(input: StatementBuildInput): StatementSnapshot {
  const { organization: org, period, employee } = input;
  const locale = org.locale;
  const byDate = new Map(input.records.map((r) => [r.date, r]));

  const start = DateTime.fromISO(period.start, { zone: 'utc' });
  const end = DateTime.fromISO(period.end, { zone: 'utc' });
  if (!start.isValid || !end.isValid || end < start) throw new Error(`invalid statement period ${period.start}..${period.end}`);

  const days: StatementSnapshotDay[] = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    const date = d.toISODate() as string;
    const rec = byDate.get(date);
    const beforeJoining = date < employee.joiningDate;
    const afterExit = employee.exitDate !== null && date > employee.exitDate;
    const employed = !beforeJoining && !afterExit;
    const status = rec?.status ?? (beforeJoining ? 'NOT_JOINED' : afterExit ? 'EXITED' : 'PENDING');
    const code = rec
      ? resolveAttendanceCode(
          {
            status: rec.status,
            flags: rec.flags,
            leaveTypeCode: rec.leave?.code ?? null,
            leaveTreatAsPresent: rec.leave?.treatAsPresent ?? null,
            leaveIsPaid: rec.leave?.isPaid ?? null,
          },
          org.codeOverrides
        ).code
      : '';
    const signIn = rec ? formatClock(rec.firstInAt, org.timezone, org.timeFormat, locale) : '';
    const signOut = rec ? formatClock(rec.lastOutAt, org.timezone, org.timeFormat, locale) : '';
    days.push({
      date,
      dateLabel: formatIsoDate(date, org.datePattern, locale),
      weekdayLabel: d.setLocale(locale === 'ar' ? 'ar' : 'en').toFormat('ccc'),
      status,
      code: code || DASH,
      leave: rec?.leave ? { code: rec.leave.code, name: rec.leave.name, nameAr: rec.leave.nameAr, isPaid: rec.leave.isPaid } : null,
      firstInAt: rec?.firstInAt ? toIso(rec.firstInAt) : null,
      lastOutAt: rec?.lastOutAt ? toIso(rec.lastOutAt) : null,
      signIn: signIn || DASH,
      signOut: signOut || DASH,
      workedMinutes: rec?.workedMinutes ?? 0,
      scheduledMinutes: rec?.scheduledMinutes ?? 0,
      lateMinutes: rec?.lateMinutes ?? 0,
      earlyDepartureMinutes: rec?.earlyDepartureMinutes ?? 0,
      overtimeMinutes: rec?.overtimeMinutes ?? 0,
      workedLabel: rec && rec.workedMinutes > 0 ? formatHours(rec.workedMinutes, org.hoursNotation) : DASH,
      flags: [...(rec?.flags ?? [])],
      commentable: employed,
    });
  }

  const summaryRecords: SummaryRecordLike[] = input.records.map((r) => ({
    status: r.status,
    flags: r.flags,
    leaveTypeCode: r.leave?.code ?? null,
    firstInAt: r.firstInAt,
    lastOutAt: r.lastOutAt,
    workedMinutes: r.workedMinutes,
    scheduledMinutes: r.scheduledMinutes,
    overtimeMinutes: r.overtimeMinutes,
    overtimeCategory: r.overtimeCategory,
  }));
  const codes = summariseCodes(summaryRecords, input.leaveTypes);

  const requiredMinutes = sum(input.records, (r) => r.scheduledMinutes);
  const workedMinutes = sum(input.records, (r) => r.workedMinutes);
  const delayMinutes = sum(input.records, (r) => r.lateMinutes);
  const differenceMinutes = workedMinutes - requiredMinutes;

  const leaveByType: StatementLeaveTotal[] = Object.entries(codes.leave)
    .map(([code, taken]) => {
      const lt = input.leaveTypes.find((l) => l.code.toUpperCase() === code.toUpperCase());
      return { code, name: lt?.name ?? code, nameAr: lt?.nameAr ?? null, isPaid: lt?.isPaid ?? true, days: taken };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    version: STATEMENT_SNAPSHOT_VERSION,
    organization: {
      name: org.name,
      timezone: org.timezone,
      locale,
      hoursNotation: org.hoursNotation,
      timeFormat: org.timeFormat,
    },
    period: {
      start: period.start,
      end: period.end,
      label: start.setLocale(locale === 'ar' ? 'ar' : 'en').toFormat('LLLL yyyy'),
    },
    employee: {
      id: employee.id,
      name: employee.displayName,
      employeeNumber: employee.employeeNumber,
      branchName: employee.branchName,
      departmentName: employee.departmentName,
      designationName: employee.designationName,
    },
    days,
    totals: {
      requiredMinutes,
      workedMinutes,
      differenceMinutes,
      delayMinutes,
      lateDays: input.records.filter((r) => r.lateMinutes > 0).length,
      earlyDepartureMinutes: sum(input.records, (r) => r.earlyDepartureMinutes),
      overtimeMinutes: sum(input.records, (r) => r.overtimeMinutes),
      workingDays: input.records.filter((r) => r.scheduledMinutes > 0).length,
      presentDays: codes.totalPresent,
      absentDays: codes.totalAbsent,
      halfDays: codes.halfDayPresent,
      holidayDays: codes.holiday,
      weeklyOffDays: codes.weeklyOff,
      missingPunchDays: input.records.filter((r) => r.status === 'MISSING_PUNCH' || r.flags.includes('MISSING_PUNCH')).length,
      leaveDays: codes.totalLeave,
      leaveByType,
      requiredLabel: formatHours(requiredMinutes, org.hoursNotation),
      workedLabel: formatHours(workedMinutes, org.hoursNotation),
      differenceLabel: signedHours(differenceMinutes, org.hoursNotation),
      delayLabel: formatHours(delayMinutes, org.hoursNotation),
      overtimeLabel: formatHours(sum(input.records, (r) => r.overtimeMinutes), org.hoursNotation),
    },
    generatedAt: input.now.toISOString(),
  };
}

function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((acc, r) => acc + pick(r), 0);
}

/** Signed difference, e.g. `-4.30` / `+2.15`; zero prints unsigned. */
export function signedHours(minutes: number, notation: HoursNotation): string {
  const body = formatHours(Math.abs(minutes), notation);
  if (minutes > 0) return `+${body}`;
  if (minutes < 0) return `-${body}`;
  return body;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

import { DateTime } from 'luxon';

/**
 * The validation matrix of a leave request (HR portal Prompt 7, Finance parity B-45…B-48, B-59/60) — pure, shared by the
 * self-service apply / edit endpoints and HR's "record leave". Errors refuse the request; warnings travel back with the
 * saved request (`warnings[]`) and never block it (B-46: HR decides).
 *
 *   applicability     the type's applicable gender must match the employee's (strict: an employee whose gender is not on
 *                     file does not get a gender-restricted type — HR updates the profile first)       error
 *   half day          only for types that allow it                                                     error
 *   working days      a range with nothing to charge (all weekly offs / holidays)                      error
 *   advance notice    start − today ≥ the type's notice (in calendar days)          self: error / HR: warning
 *   max consecutive   the days charged by one request ≤ the type's maximum          self: error / HR: warning
 *   comp-off balance  a comp-off redemption never exceeds the earned, unexpired, unreserved credits   error
 *   balance           an ordinary tracked type going below zero (after pending requests)              warning
 */

export type LeaveApplicableGender = 'all' | 'male' | 'female';

export const LEAVE_RULE_CODES = ['NOT_APPLICABLE', 'HALF_DAY_NOT_ALLOWED', 'NO_DAYS', 'ADVANCE_NOTICE', 'MAX_CONSECUTIVE', 'COMP_OFF_BALANCE', 'OVER_BALANCE'] as const;
export type LeaveRuleCode = (typeof LEAVE_RULE_CODES)[number];

export interface LeaveRuleIssue { code: LeaveRuleCode; path: string; message: string; params: Record<string, string | number | null> }

export interface LeaveRuleTypeInput {
  name: string;
  applicableGender: LeaveApplicableGender;
  allowHalfDay: boolean;
  advanceNoticeDays: number;
  maxConsecutiveDays: number | null;
  /** The organisation's comp-off type (balance from credits, never overdrawn). */
  compOff?: boolean;
}

export interface CheckLeaveRequestInput {
  type: LeaveRuleTypeInput;
  /** The employee's gender on file (male / female / other / unspecified). */
  employeeGender: string | null;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  /** Days the request charges (count mode of the type, working calendar of the employee). */
  days: number;
  /** Today in the organisation's timezone. */
  today: string;
  /** HR (leave.manage) recording leave: advance notice and the consecutive-day cap warn instead of refusing. */
  asHr: boolean;
  /** Available balance of the type after the other pending requests (this request excluded); null = not tracked. */
  availableAfterPendingDays: number | null;
}

export interface LeaveRuleResult { errors: LeaveRuleIssue[]; warnings: LeaveRuleIssue[] }

/** A gender-restricted type applies only to employees of that gender on file; `all` applies to everyone. */
export function leaveTypeApplies(applicableGender: LeaveApplicableGender, employeeGender: string | null | undefined): boolean {
  return applicableGender === 'all' || applicableGender === employeeGender;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days);
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function checkLeaveRequest(input: CheckLeaveRequestInput): LeaveRuleResult {
  const errors: LeaveRuleIssue[] = [];
  const warnings: LeaveRuleIssue[] = [];
  const { type } = input;
  if (!leaveTypeApplies(type.applicableGender, input.employeeGender)) {
    errors.push({ code: 'NOT_APPLICABLE', path: 'leaveTypeId', message: `${type.name} applies to ${type.applicableGender} employees only${input.employeeGender && input.employeeGender !== 'unspecified' ? '' : ' (the gender on the employee record is not set — HR updates it first)'}.`, params: { gender: type.applicableGender, employeeGender: input.employeeGender } });
  }
  if (input.isHalfDay && !type.allowHalfDay) {
    errors.push({ code: 'HALF_DAY_NOT_ALLOWED', path: 'isHalfDay', message: `${type.name} cannot be taken as a half day.`, params: {} });
  }
  if (input.days <= 0) {
    errors.push({ code: 'NO_DAYS', path: 'startDate', message: 'Every date in this range is a weekly off day or a holiday.', params: {} });
  }
  const notice = daysBetween(input.today, input.startDate);
  if (type.advanceNoticeDays > 0 && notice < type.advanceNoticeDays) {
    (input.asHr ? warnings : errors).push({ code: 'ADVANCE_NOTICE', path: 'startDate', message: `${type.name} needs ${type.advanceNoticeDays} day(s) of advance notice; this request gives ${Math.max(0, notice)}.`, params: { required: type.advanceNoticeDays, given: Math.max(0, notice) } });
  }
  if (type.maxConsecutiveDays !== null && input.days > type.maxConsecutiveDays) {
    (input.asHr ? warnings : errors).push({ code: 'MAX_CONSECUTIVE', path: 'endDate', message: `${type.name} allows at most ${type.maxConsecutiveDays} consecutive day(s) per request; this request charges ${fmt(input.days)}.`, params: { max: type.maxConsecutiveDays, days: input.days } });
  }
  if (input.availableAfterPendingDays !== null && input.days > 0) {
    const after = input.availableAfterPendingDays - input.days;
    if (type.compOff) {
      if (after < 0) errors.push({ code: 'COMP_OFF_BALANCE', path: 'endDate', message: `Not enough comp-off balance: ${fmt(Math.max(0, input.availableAfterPendingDays))} day(s) available, this request needs ${fmt(input.days)}.`, params: { available: input.availableAfterPendingDays, days: input.days } });
    } else if (after < 0) {
      warnings.push({ code: 'OVER_BALANCE', path: 'endDate', message: `This request exceeds the ${type.name} balance: ${fmt(input.availableAfterPendingDays)} day(s) available after pending requests, ${fmt(input.days)} requested.`, params: { available: input.availableAfterPendingDays, days: input.days, after } });
    }
  }
  return { errors, warnings };
}

/**
 * Comp-off days earned for minutes worked on a weekly off / holiday: a full day from `fullDayHours`, half a day from
 * half of it, nothing below (Finance: 8 h / 4 h defaults — here `attendance.stats.fullDayHours`).
 */
export function compOffDaysEarned(workedMinutes: number, fullDayHours: number): 0 | 0.5 | 1 {
  const full = Math.max(1, fullDayHours) * 60;
  if (workedMinutes >= full) return 1;
  if (workedMinutes >= full / 2) return 0.5;
  return 0;
}

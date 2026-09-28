import { DateTime } from 'luxon';

/**
 * Pure helpers of the leave v2 screens (HR Leave page, portal /my/leave). The server is authoritative for every figure; these
 * preview what a request will charge and whether the API will accept it, mirroring @flowza/domain (countLeaveDaysByMode,
 * checkLeaveRequest, compOffDaysEarned) so the form and the answer agree.
 */

export type LeaveTone = 'success' | 'warning' | 'danger' | 'neutral';
/** Badge tone per leave status (INFO_REQUESTED is drawn indigo on top of the neutral tone). */
export const LEAVE_STATUS_TONE: Record<string, LeaveTone> = { APPROVED: 'success', PENDING: 'warning', REJECTED: 'danger', CANCELLED: 'neutral', INFO_REQUESTED: 'neutral' };
/** Statuses an approver can still decide (the approval request is open). */
export const UNDECIDED_LEAVE_STATUSES: readonly string[] = ['PENDING', 'INFO_REQUESTED'];

/** Days without a trailing ".0" (half days keep their ".5"); "—" when unknown. */
export const fmtLeaveDays = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * `isOff`, when set, decides a date on its own (review P1-1 / P1-2: the per-date working calendar the API sends — the branch of
 * each date, its holidays, weekly offs and rotation off days); without it the weekly offs and holidays decide.
 */
export interface PreviewCalendar { weeklyOffDays: readonly number[]; holidays: ReadonlySet<string>; isOff?: (date: string) => boolean }
export type CountMode = 'working' | 'calendar';

/** The calendar of a /me/leave answer: its per-date off days inside the range they cover, the weekly offs and holidays outside it (and from older API builds). */
export function previewCalendarOf(c: { weeklyOffDays: readonly number[]; holidays: readonly string[]; offDates?: readonly string[]; from?: string; to?: string } | null | undefined): PreviewCalendar {
  const weeklyOffDays = c?.weeklyOffDays ?? [];
  const holidays = new Set(c?.holidays ?? []);
  if (!c?.offDates) return { weeklyOffDays, holidays };
  const off = new Set(c.offDates);
  const { from, to } = c;
  return { weeklyOffDays, holidays, isOff: (date) => ((!from || date >= from) && (!to || date <= to) ? off.has(date) : weeklyOffDays.includes(weekdayOf(date)) || holidays.has(date)) };
}

/** Days a range charges: working days (weekly offs and holidays free) or every calendar date; a half day is 0.5 of its date. */
export function previewLeaveDaysByMode(startDate: string, endDate: string, isHalfDay: boolean, cal: PreviewCalendar, mode: CountMode = 'working'): number {
  const start = DateTime.fromISO(startDate, { zone: 'utc' });
  const end = DateTime.fromISO(endDate, { zone: 'utc' });
  if (!start.isValid || !end.isValid || end < start) return 0;
  let days = 0;
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    const iso = d.toISODate()!;
    if (mode === 'calendar' || !(cal.isOff ? cal.isOff(iso) : cal.weeklyOffDays.includes(d.weekday % 7) || cal.holidays.has(iso))) days += 1;
  }
  return isHalfDay ? days * 0.5 : days;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days);
}

export type LeaveIssueCode = 'HALF_DAY_NOT_ALLOWED' | 'NO_DAYS' | 'ADVANCE_NOTICE' | 'MAX_CONSECUTIVE' | 'COMP_OFF_BALANCE' | 'OVER_BALANCE';
/** `blocking`: the API refuses an employee's request for it (checked again server-side); otherwise a warning that never blocks. */
export interface LeaveIssue { code: LeaveIssueCode; blocking: boolean; params: Record<string, number> }

export interface LeaveApplicationCheck {
  type: { allowHalfDay?: boolean; advanceNoticeDays?: number; maxConsecutiveDays?: number | null; compOff?: boolean };
  isHalfDay: boolean;
  days: number;
  startDate: string;
  /** Today in the organisation's timezone. */
  today: string;
  /** Balance available after the other pending requests (this request excluded); null = the type tracks no balance. */
  availableAfterPendingDays: number | null;
}

/** The self-service side of the server's validation matrix: what refuses the request, and the over-balance warning (B-46). */
export function checkLeaveApplication(c: LeaveApplicationCheck): LeaveIssue[] {
  const out: LeaveIssue[] = [];
  if (c.isHalfDay && c.type.allowHalfDay === false) out.push({ code: 'HALF_DAY_NOT_ALLOWED', blocking: true, params: {} });
  if (c.days <= 0) out.push({ code: 'NO_DAYS', blocking: true, params: {} });
  const notice = daysBetween(c.today, c.startDate);
  const required = c.type.advanceNoticeDays ?? 0;
  if (required > 0 && notice < required) out.push({ code: 'ADVANCE_NOTICE', blocking: true, params: { required, given: Math.max(0, notice) } });
  const max = c.type.maxConsecutiveDays ?? null;
  if (max !== null && c.days > max) out.push({ code: 'MAX_CONSECUTIVE', blocking: true, params: { max, days: c.days } });
  if (c.availableAfterPendingDays !== null && c.days > 0 && c.availableAfterPendingDays - c.days < 0) {
    out.push(c.type.compOff
      ? { code: 'COMP_OFF_BALANCE', blocking: true, params: { available: Math.max(0, c.availableAfterPendingDays), days: c.days } }
      : { code: 'OVER_BALANCE', blocking: false, params: { available: c.availableAfterPendingDays, days: c.days } });
  }
  return out;
}

/**
 * The caller's own active leave (pending, info requested, approved) that shares a date with the range — the API refuses a
 * second leave on a date already on leave (the other half of a half day included), so the form says so before sending.
 */
export function findOwnOverlap<T extends { id: string; status: string; startDate: string; endDate: string }>(records: readonly T[], range: { startDate: string; endDate: string }, excludeId?: string | null): T | null {
  return records.find((r) => r.id !== excludeId && ['PENDING', 'INFO_REQUESTED', 'APPROVED'].includes(r.status) && r.startDate <= range.endDate && r.endDate >= range.startDate) ?? null;
}

/** Comp-off days a worked day earns: a full day from `fullDayHours`, half a day from half of it, nothing below. */
export function compOffDaysEarned(workedMinutes: number, fullDayHours: number): 0 | 0.5 | 1 {
  const full = Math.max(1, fullDayHours) * 60;
  if (workedMinutes >= full) return 1;
  if (workedMinutes >= full / 2) return 0.5;
  return 0;
}

/**
 * What the Leave page says after a decision (P2-9): "Leave approved" / "rejected" only when the LEAVE itself reached that
 * status; when the request merely moved to its next level, "Level N approved — waiting for …"; when the level still needs
 * other approvers (quorum, or a rejection the others can still outvote), "Your approval/rejection was recorded — waiting for …".
 */
export type DecisionOutcomeKey = 'approved' | 'rejected' | 'advanced' | 'approvalRecorded' | 'rejectionRecorded';
export interface DecisionOutcome { key: DecisionOutcomeKey; level: number | null; waitingFor: string[] }
export function decisionOutcome(result: { status: string; approvalCurrentStep?: number | null; approvalWaitingFor?: string[] | null }, sent: { decision: 'APPROVED' | 'REJECTED'; stepNo: number | null }): DecisionOutcome {
  const waitingFor = result.approvalWaitingFor ?? [];
  if (result.status === 'APPROVED') return { key: 'approved', level: sent.stepNo, waitingFor: [] };
  if (result.status === 'REJECTED') return { key: 'rejected', level: sent.stepNo, waitingFor: [] };
  const now = result.approvalCurrentStep ?? null;
  if (sent.decision === 'APPROVED' && sent.stepNo !== null && now !== null && now > sent.stepNo) return { key: 'advanced', level: sent.stepNo, waitingFor };
  return { key: sent.decision === 'APPROVED' ? 'approvalRecorded' : 'rejectionRecorded', level: sent.stepNo, waitingFor };
}

/** "yyyy-MM" shifted by whole months. */
export const shiftLeaveMonth = (month: string, by: number): string => DateTime.fromISO(`${month}-01`, { zone: 'utc' }).plus({ months: by }).toFormat('yyyy-MM');

/** Every date of a "yyyy-MM" month. */
export function monthDates(month: string): string[] {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) return [];
  const out: string[] = [];
  for (let d = start; d.month === start.month; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

/** Weekday of an ISO date, 0=Sun..6=Sat (the convention of weeklyOffDays). */
export const weekdayOf = (date: string): number => DateTime.fromISO(date, { zone: 'utc' }).weekday % 7;

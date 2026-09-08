import type { LeaveTypeLike } from './codes.js';
import { deriveHours } from './derive.js';

export interface SummaryRecordLike {
  status: string;
  flags: readonly string[];
  leaveTypeCode?: string | null;
  firstInAt: string | Date | null;
  lastOutAt: string | Date | null;
  workedMinutes: number;
  scheduledMinutes: number;
  overtimeMinutes: number;
  overtimeCategory: string | null;
}

/**
 * One employee's period as the Summary report prints it: day counts per code, the three totals the sample groups
 * them into, and the hour columns.
 *
 *   T/PR = PR + HL + OF + (leave types that count as present, e.g. Site Duty) + ½·HP
 *   T/OL = paid leave types
 *   T/AB = AB + unpaid leave types (No-Pay)
 *
 * A half-day leave is half a leave day and half a present day; a half day without leave is HP (and half absent, which
 * the sample does not print — T/PR carries the half, T/AB does not).
 */
export interface CodeSummary {
  present: number;
  holiday: number;
  weeklyOff: number;
  halfDayPresent: number;
  absent: number;
  /** Leave days by leave-type code (fractional for half days). */
  leave: Record<string, number>;
  totalPresent: number;
  totalLeave: number;
  totalAbsent: number;
  ot1Minutes: number;
  ot2Minutes: number;
  utMinutes: number;
}

export type LeaveGroup = 'present' | 'leave' | 'absent';

/** Which total a leave type feeds. Unknown codes (a leave whose type was deleted) count as ordinary paid leave. */
export function leaveGroupOf(code: string, leaveTypes: readonly LeaveTypeLike[]): LeaveGroup {
  const lt = leaveTypes.find((l) => l.code.toUpperCase() === code.toUpperCase());
  if (!lt) return 'leave';
  if (lt.treatAsPresent) return 'present';
  if (!lt.isPaid) return 'absent';
  return 'leave';
}

export function summariseCodes(records: readonly SummaryRecordLike[], leaveTypes: readonly LeaveTypeLike[], fallbackLeaveCode = 'LV'): CodeSummary {
  const s: CodeSummary = { present: 0, holiday: 0, weeklyOff: 0, halfDayPresent: 0, absent: 0, leave: {}, totalPresent: 0, totalLeave: 0, totalAbsent: 0, ot1Minutes: 0, ot2Minutes: 0, utMinutes: 0 };
  const addLeave = (code: string | null | undefined, days: number) => { const k = (code ?? '').trim() || fallbackLeaveCode; s.leave[k] = (s.leave[k] ?? 0) + days; };
  for (const r of records) {
    const halfLeave = r.flags.includes('HALF_DAY_LEAVE');
    switch (r.status) {
      case 'PRESENT':
      case 'MISSING_PUNCH':
        if (halfLeave) { s.present += 0.5; addLeave(r.leaveTypeCode, 0.5); } else s.present += 1;
        break;
      case 'HALF_DAY':
        if (halfLeave) { s.present += 0.5; addLeave(r.leaveTypeCode, 0.5); } else s.halfDayPresent += 1;
        break;
      case 'ABSENT':
        if (halfLeave) { s.absent += 0.5; addLeave(r.leaveTypeCode, 0.5); } else s.absent += 1;
        break;
      case 'LEAVE': addLeave(r.leaveTypeCode, 1); break;
      case 'HOLIDAY': s.holiday += 1; break;
      case 'WEEKLY_OFF': s.weeklyOff += 1; break;
      default: break; // PENDING, NOT_JOINED, EXITED are not this employee's days
    }
    const h = deriveHours(r);
    if (h.worked !== null) { s.ot1Minutes += h.ot1 ?? 0; s.ot2Minutes += h.ot2 ?? 0; s.utMinutes += h.ut ?? 0; }
  }
  s.totalPresent = s.present + s.holiday + s.weeklyOff + s.halfDayPresent * 0.5;
  s.totalLeave = 0;
  s.totalAbsent = s.absent;
  for (const [code, days] of Object.entries(s.leave)) {
    const g = leaveGroupOf(code, leaveTypes);
    if (g === 'present') s.totalPresent += days; else if (g === 'absent') s.totalAbsent += days; else s.totalLeave += days;
  }
  return s;
}

/** Day counts print as integers when whole, otherwise with one decimal; the totals always with one decimal (`30.0`). */
export function formatDays(n: number, opts: { alwaysDecimal?: boolean; zeroAsDash?: boolean } = {}): string {
  if (n === 0 && opts.zeroAsDash) return '-';
  if (opts.alwaysDecimal) return n.toFixed(1);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

import type { ApprovalRequestDto, AttendanceNoteReviewItemDto, TeamAttendanceRowDto, TeamDayStatus, TeamLeaveDto, TeamMemberTodayDto } from '@flowza/contracts';
import type { MonthlyRow } from '@/features/attendance/types';
import { monthDates } from '@/features/leave/model';

/**
 * Pure helpers of the team workspace (HR portal Prompt 5). No React: the arithmetic and the action rules are unit-tested
 * on their own.
 */

export type TeamTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export const TEAM_STATUS_TONE: Record<TeamDayStatus, TeamTone> = {
  present: 'success', late: 'warning', absent: 'danger', on_leave: 'info', missing_punch: 'danger', weekly_off: 'neutral', holiday: 'neutral', not_in_yet: 'neutral', not_scheduled: 'neutral',
};

/** Finance B-61: the team rail gets a search box once it lists more than five reports. */
export const SEARCH_THRESHOLD = 5;
export const needsSearch = (count: number): boolean => count > SEARCH_THRESHOLD;

/** Case- and accent-tolerant match on name or employee number. */
export function filterMembers<T extends Pick<TeamMemberTodayDto, 'employeeName' | 'employeeNumber'>>(members: readonly T[], search: string): T[] {
  const q = normalise(search);
  if (!q) return [...members];
  return members.filter((m) => normalise(m.employeeName).includes(q) || m.employeeNumber.toLowerCase().includes(q));
}
function normalise(s: string): string { return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim(); }

/** First and last date of a `YYYY-MM` month (the leave model's month arithmetic). */
export const monthBounds = (month: string): { from: string; to: string } => {
  const days = monthDates(month);
  return { from: days[0] ?? `${month}-01`, to: days.at(-1) ?? `${month}-28` };
};

/**
 * The team's daily records as rows of the attendance month grid (the HR register's component), with the same totals the
 * register's API computes (half days count ½ present; late / missing punch from the flags).
 */
export function monthlyRowsFrom(rows: readonly TeamAttendanceRowDto[], days: readonly string[]): MonthlyRow[] {
  return rows.map((r) => {
    const row: MonthlyRow = {
      employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, branchId: r.branchId,
      days: Object.fromEntries(days.map((d) => [d, null])),
      totals: { present: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0, halfDay: 0, late: 0, missingPunch: 0, workedMinutes: 0, overtimeMinutes: 0, lateMinutes: 0 },
    };
    for (const rec of r.records) {
      if (!(rec.attendanceDate in row.days)) continue;
      row.days[rec.attendanceDate] = { status: rec.status, workedMinutes: rec.workedMinutes, lateMinutes: rec.lateMinutes, overtimeMinutes: rec.overtimeMinutes, flags: rec.flags, recordId: rec.id };
      const t = row.totals;
      if (rec.status === 'PRESENT') t.present += 1;
      else if (rec.status === 'ABSENT') t.absent += 1;
      else if (rec.status === 'LEAVE') t.leave += 1;
      else if (rec.status === 'HOLIDAY') t.holiday += 1;
      else if (rec.status === 'WEEKLY_OFF') t.weeklyOff += 1;
      else if (rec.status === 'HALF_DAY') { t.halfDay += 1; t.present += 0.5; }
      if (rec.flags.includes('LATE')) t.late += 1;
      if (rec.flags.includes('MISSING_IN') || rec.flags.includes('MISSING_OUT') || rec.status === 'MISSING_PUNCH') t.missingPunch += 1;
      t.workedMinutes += rec.workedMinutes; t.overtimeMinutes += rec.overtimeMinutes; t.lateMinutes += rec.lateMinutes;
    }
    return row;
  });
}

/** The leave entries covering a date. */
export const leaveOn = (entries: readonly TeamLeaveDto[], date: string): TeamLeaveDto[] => entries.filter((e) => e.startDate <= date && e.endDate >= date);

/** Rows of the team leave calendar: one per report with leave in the range, in name order. */
export function leaveRows(entries: readonly TeamLeaveDto[]): Array<{ employeeId: string; employeeName: string; employeeNumber: string; entries: TeamLeaveDto[] }> {
  const by = new Map<string, { employeeId: string; employeeName: string; employeeNumber: string; entries: TeamLeaveDto[] }>();
  for (const e of entries) {
    const row = by.get(e.employeeId) ?? { employeeId: e.employeeId, employeeName: e.employeeName, employeeNumber: e.employeeNumber, entries: [] };
    row.entries.push(e);
    by.set(e.employeeId, row);
  }
  return [...by.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

/**
 * Finance B-65: approve / reject / excuse / ask are offered only on a reason that waits for the caller — pending, reviewable
 * by them, and not seen through organisation-wide oversight (the oversight rows are marked, and decided on the notes page).
 */
export const canActOnNote = (n: Pick<AttendanceNoteReviewItemDto, 'status' | 'canReview' | 'isOversight'>): boolean => n.status === 'pending' && n.canReview && !n.isOversight;
/** The same rule for an approval request: pending and the caller may decide its current level. */
export const canActOnRequest = (r: Pick<ApprovalRequestDto, 'status' | 'abilities'>): boolean => r.status === 'PENDING' && r.abilities.canDecide;

/** Finance B-64: "All my team" shows at most this many recent requests of the direct reports, view only. */
export const TEAM_HISTORY_LIMIT = 50;
/** Newest first, de-duplicated, capped: pending and decided requests of the reports merged into one view-only list. */
export function recentTeamRequests(lists: ReadonlyArray<readonly ApprovalRequestDto[]>, limit = TEAM_HISTORY_LIMIT): ApprovalRequestDto[] {
  const seen = new Map<string, ApprovalRequestDto>();
  for (const list of lists) for (const r of list) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id))).slice(0, limit);
}

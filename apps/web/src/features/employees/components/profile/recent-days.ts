import type { MonthlyRow } from '@/features/attendance/types';

export interface RecentDay { date: string; status: string; workedMinutes: number; lateMinutes: number; overtimeMinutes: number; flags: string[]; recordId: string }

/**
 * The monthly endpoint answers with one row per employee whose `days` is a date → cell map (null on days without a
 * record). The profile's attendance tab wants the employee's recorded days, newest first. Tolerates a row for another
 * employee (scoped callers) and a missing or malformed `flags`, since a crash here takes the whole profile page down.
 */
export function recentDays(rows: MonthlyRow[] | undefined, employeeId: string, limit = 14): RecentDay[] {
  const row = rows?.find((r) => r.employeeId === employeeId) ?? rows?.[0];
  if (!row || !row.days || typeof row.days !== 'object') return [];
  const out: RecentDay[] = [];
  for (const [date, cell] of Object.entries(row.days)) {
    if (!cell) continue;
    out.push({ date, status: cell.status, workedMinutes: cell.workedMinutes ?? 0, lateMinutes: cell.lateMinutes ?? 0, overtimeMinutes: cell.overtimeMinutes ?? 0, flags: Array.isArray(cell.flags) ? cell.flags : [], recordId: cell.recordId });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out.slice(0, limit);
}

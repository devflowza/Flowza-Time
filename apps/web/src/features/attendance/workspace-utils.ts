import { DateTime } from 'luxon';
import type { AttendanceCalendarDayDto } from '@flowza/contracts';
import { fmtDate, fmtMinutes, fmtTime } from '@/lib/format';
import type { RecordDetail } from './types';

/**
 * Pure helpers of the HR attendance workspace (HR portal Prompt 6a): calendar weeks, local ↔ UTC punch times, the flag dots
 * and the mapping of Flowza Finance's ten register statuses onto the engine's status + flags.
 */

/** Weeks of a month (`YYYY-MM`) starting on `firstDayOfWeek` (0 = Sunday … 6 = Saturday); padding days are null. */
export function monthWeeks(month: string, firstDayOfWeek = 0): Array<Array<string | null>> {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) return [];
  const first = ((firstDayOfWeek % 7) + 7) % 7;
  const lead = ((start.weekday % 7) - first + 7) % 7; // Luxon: 1 = Monday … 7 = Sunday → 0 = Sunday
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = start; d.month === start.month; d = d.plus({ days: 1 })) cells.push(d.toISODate());
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Weekday headers (0 = Sunday … 6 = Saturday) in display order. */
export function weekdayOrder(firstDayOfWeek = 0): number[] {
  const first = ((firstDayOfWeek % 7) + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/** `YYYY-MM-DD` + `HH:mm` on the wall clock of `zone` (+1 day for a check-out after midnight) → UTC ISO instant. */
export function localToUtcIso(date: string, time: string, zone: string, nextDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const dt = DateTime.fromISO(`${date}T${time}`, { zone }).plus({ days: nextDay ? 1 : 0 });
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

/** UTC instant → `HH:mm` on the wall clock of `zone`, and whether it falls on the day after `date`. */
export function utcToLocalTime(iso: string | null | undefined, zone: string, date: string): { time: string; nextDay: boolean } | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone);
  if (!dt.isValid) return null;
  return { time: dt.toFormat('HH:mm'), nextDay: (dt.toISODate() ?? '') > date };
}

/** Client-side mirror of the API rule: a check-out must be after the check-in. */
export function checkOutBeforeIn(inIso: string | null, outIso: string | null): boolean {
  return !!inIso && !!outIso && Date.parse(outIso) <= Date.parse(inIso);
}

/** Clock tolerance of the API's "a punch cannot be in the future" rule (hr-workspace.service `FUTURE_TOLERANCE_MS`). */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Client-side mirror of the API rule: a proposed punch may not be later than now (plus the clock tolerance). */
export function isFuturePunch(iso: string | null, nowMs: number): boolean {
  return !!iso && Date.parse(iso) > nowMs + FUTURE_TOLERANCE_MS;
}

/** The field (`inAt` / `outAt`) a validation error of the preview / record-edit API names in `details.issues`, if any. */
export function issueField(details: Record<string, unknown> | undefined): 'inAt' | 'outAt' | null {
  const issues = details?.['issues'];
  if (!Array.isArray(issues)) return null;
  for (const i of issues as Array<{ path?: unknown }>) if (i?.path === 'inAt' || i?.path === 'outAt') return i.path;
  return null;
}

/** Small coloured dots per flag family in a calendar cell (the full labels live in the tooltip). */
export const FLAG_DOT: Record<string, string> = {
  LATE: 'bg-amber-500', EARLY_DEPARTURE: 'bg-amber-600', MISSING_IN: 'bg-red-600', MISSING_OUT: 'bg-red-600', OVERTIME: 'bg-blue-600',
  WORKED_ON_HOLIDAY: 'bg-violet-600', WORKED_ON_WEEKLY_OFF: 'bg-violet-600', HALF_DAY_LEAVE: 'bg-sky-500', UNEXCUSED: 'bg-rose-700', LOP: 'bg-rose-700',
  OUTSIDE_GEOFENCE: 'bg-orange-500',
};
export const DOT_FLAGS = Object.keys(FLAG_DOT);

/**
 * Flowza Finance's ten register statuses (docs/hr-portal/inventory/finance-hr-attendance-module.md §1.1) and how FlowZa's engine
 * expresses each: a status plus, where Finance has a separate value, a flag. The engine keeps "late" and "worked on a
 * non-working day" as flags so they combine (a late half day, a late missed punch) instead of replacing the status.
 * `note` is a key under `mapping.notes` of the attendanceWorkspace namespace ('' = nothing to add).
 */
export const FINANCE_STATUS_MAPPING: ReadonlyArray<{ finance: string; statuses: string[]; flags: string[]; note: string }> = [
  { finance: 'present', statuses: ['PRESENT'], flags: [], note: 'noLate' },
  { finance: 'late', statuses: ['PRESENT', 'HALF_DAY'], flags: ['LATE'], note: 'lateCombines' },
  { finance: 'half_day', statuses: ['HALF_DAY'], flags: [], note: 'halfDayLeave' },
  { finance: 'absent', statuses: ['ABSENT'], flags: [], note: 'reviewed' },
  { finance: 'on_leave', statuses: ['LEAVE'], flags: [], note: 'halfLeave' },
  { finance: 'holiday', statuses: ['HOLIDAY'], flags: [], note: '' },
  { finance: 'weekend', statuses: ['WEEKLY_OFF'], flags: [], note: '' },
  { finance: 'incomplete', statuses: ['MISSING_PUNCH', 'PRESENT', 'HALF_DAY', 'ABSENT'], flags: ['MISSING_IN', 'MISSING_OUT'], note: 'missedPunch' },
  { finance: 'holiday_work', statuses: ['HOLIDAY'], flags: ['WORKED_ON_HOLIDAY', 'NON_WORKING_DAY_WORK'], note: '' },
  { finance: 'weekly_off_work', statuses: ['WEEKLY_OFF'], flags: ['WORKED_ON_WEEKLY_OFF', 'NON_WORKING_DAY_WORK'], note: '' },
];

export type T = (k: string, o?: Record<string, unknown>) => string;

/** Tooltip / accessible name of a day: status (and source), in–out, worked, late, early, overtime and the other flags. */
export function calendarDayLabel(t: T, tw: T, date: string, day: AttendanceCalendarDayDto | undefined, zone: string): string {
  const head = fmtDate(date, 'EEE dd MMM');
  if (!day) return `${head}: ${tw('calendar.noRecord')}`;
  const tz = day.timezone || zone;
  const parts = [`${t(`status.${day.status}`, { defaultValue: day.status })}${day.statusSource === 'MANUAL' ? ` (${tw('source.MANUAL')})` : ''}`];
  if (day.firstInAt || day.lastOutAt) parts.push(`${tw('calendar.inOut')} ${fmtTime(day.firstInAt, tz)}–${fmtTime(day.lastOutAt, tz)}`);
  if (day.workedMinutes) parts.push(`${t('columns.worked')} ${fmtMinutes(day.workedMinutes)}`);
  if (day.lateMinutes) parts.push(`${t('columns.late')} ${fmtMinutes(day.lateMinutes)}`);
  if (day.earlyDepartureMinutes) parts.push(`${t('columns.early')} ${fmtMinutes(day.earlyDepartureMinutes)}`);
  if (day.overtimeMinutes) parts.push(`${t('columns.overtime')} ${fmtMinutes(day.overtimeMinutes)}`);
  const rest = day.flags.filter((f) => !['LATE', 'EARLY_DEPARTURE', 'OVERTIME'].includes(f));
  if (rest.length) parts.push(rest.map((f) => t(`flags.${f}`, { defaultValue: f })).join(', '));
  return `${head}: ${parts.join(' · ')}`;
}

/** Distinct dot colours of a day's flags (at most four, in legend order). */
export function dotsOf(day: AttendanceCalendarDayDto | undefined): string[] {
  if (!day) return [];
  const out: string[] = [];
  for (const f of day.flags) { const c = FLAG_DOT[f]; if (c && !out.includes(c)) out.push(c); }
  return out.slice(0, 4);
}

/** An applied SET_STATUS correction overrides the engine's status (the recompute keeps the latest one) — the `Manual` source. */
export const isManualStatus = (r: Pick<RecordDetail, 'corrections'>): boolean => (r.corrections ?? []).some((c) => c.type === 'SET_STATUS' && c.status === 'APPLIED');

/** The range the register currently shows: the daily tab's day, else the month of the monthly / calendar tab (to today at most). */
export function syncRangeOf(params: URLSearchParams, today: string): { fromDate: string; toDate: string } {
  const tab = params.get('tab') ?? (params.get('employeeId') ? 'monthly' : 'daily');
  if (tab === 'daily') {
    const d = params.get('date');
    const date = d && DateTime.fromISO(d).isValid ? d : today;
    return { fromDate: date, toDate: date };
  }
  const m = params.get('month');
  const month = m && /^\d{4}-\d{2}$/.test(m) ? m : today.slice(0, 7);
  const start = `${month}-01`;
  const end = DateTime.fromISO(start).endOf('month').toISODate()!;
  return { fromDate: start, toDate: end > today ? today : end };
}

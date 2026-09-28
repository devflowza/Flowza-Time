import type { NotesReportRowDto, RegularisationAdminItemDto } from '@flowza/contracts';

/**
 * Pure rules of the HR attendance administration pages (HR portal Prompt 6b).
 */

/** A regularisation the caller can decide right now: pending, with a live request whose current level they may decide. */
export const decidable = (r: RegularisationAdminItemDto): boolean => r.status === 'pending' && !!r.approval?.canDecide && r.approval.status === 'PENDING';

/** The filters a list sends to the API: only the keys that carry a value. */
export function presentFilters<K extends string>(keys: readonly K[], values: Record<string, string | undefined>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) { const v = values[k]; if (v) out[k] = v; }
  return out;
}

/** Whole days between two ISO dates, both included (0 when the range is reversed). */
export function inclusiveDays(from: string, to: string): number {
  const d = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) && d >= 0 ? Math.round(d) + 1 : 0;
}
/** The comments report accepts at most this many days (the API refuses longer ranges). */
export const REPORT_MAX_DAYS = 366;

/** Two characters of the shift code, the way a roster cell shows it (Finance ATT-105). */
export const rosterCode = (code: string): string => code.slice(0, 2).toUpperCase();

/** Days charged by a reason, as the impact column states it (paid leave, loss of pay, excused, nothing yet). */
export function impactDays(r: Pick<NotesReportRowDto, 'impact' | 'deductedLeaveDays' | 'payEffectDays'>): number {
  if (r.impact === 'leave') return r.deductedLeaveDays ?? r.payEffectDays ?? 0;
  if (r.impact === 'lop') return r.payEffectDays ?? 0;
  return 0;
}

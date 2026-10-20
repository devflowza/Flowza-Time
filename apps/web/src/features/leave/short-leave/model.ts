import { windowMinutes, type TimeOffStatus } from '@flowza/contracts';

/** Minutes → "1:30" (h:mm, tabular) for durations of short leave; null → "—". */
export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

export const STATUS_TONE: Record<TimeOffStatus, 'warning' | 'success' | 'danger' | 'neutral'> = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'danger', CANCELLED: 'neutral' };

export interface WindowCheck { minutes: number | null; error: 'window' | 'max' | 'quota' | null; remaining: number | null }

const CLOCK = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * What the request form can tell before the API does: the window's length, a window that does not run forward within the day,
 * one longer than the type allows, or one beyond what the month's quota leaves. The API checks every rule again (and overlaps).
 */
export function checkWindow(startTime: string, endTime: string, limits: { maxMinutesPerRequest: number | null; quotaMinutes: number | null; usedMinutes: number }): WindowCheck {
  const remaining = limits.quotaMinutes === null ? null : Math.max(0, limits.quotaMinutes - limits.usedMinutes);
  if (!CLOCK.test(startTime) || !CLOCK.test(endTime)) return { minutes: null, error: null, remaining };
  const minutes = windowMinutes(startTime, endTime);
  if (minutes === null) return { minutes: null, error: 'window', remaining };
  if (limits.maxMinutesPerRequest !== null && minutes > limits.maxMinutesPerRequest) return { minutes, error: 'max', remaining };
  if (remaining !== null && minutes > remaining) return { minutes, error: 'quota', remaining };
  return { minutes, error: null, remaining };
}

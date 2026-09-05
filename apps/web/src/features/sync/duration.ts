import { DateTime } from 'luxon';

/** Human duration between two ISO timestamps (end defaults to now while a job is still running). */
export function fmtDuration(startIso: string | null | undefined, endIso?: string | null, now: DateTime = DateTime.utc()): string {
  if (!startIso) return '—';
  const start = DateTime.fromISO(startIso, { zone: 'utc' });
  const end = endIso ? DateTime.fromISO(endIso, { zone: 'utc' }) : now;
  const seconds = Math.max(0, Math.round(end.diff(start, 'seconds').seconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

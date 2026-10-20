/**
 * Shortfall ("Short", 2026-10-19 "show shortfall hours and the difference in minutes"): the shift's hours not worked on a worked
 * day — `shortfallMinutes` of the daily record, the reports' UT computed by the API with the one rule of @flowza/domain.
 */
type T = (key: string, options?: Record<string, unknown>) => string;

/** "1 h 15 min (75 min)", or "45 min" under an hour (attendance namespace); null when the day was not short (or an older API). */
export function shortfallLabel(t: T, minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  const total = Math.round(minutes);
  if (total < 60) return t('record.shortfallMinutes', { total });
  return t('record.shortfallValue', { hours: Math.floor(total / 60), minutes: total % 60, total });
}

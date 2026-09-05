import { DateTime, Duration } from 'luxon';
import i18n from './i18n.js';

/** All server timestamps are UTC ISO; render them in the organisation/branch timezone. */
export function fmtDateTime(iso: string | null | undefined, zone: string, fmt = 'dd MMM yyyy, HH:mm'): string {
  if (!iso) return '—';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).setLocale(i18n.language).toFormat(fmt);
}
export function fmtTime(iso: string | null | undefined, zone: string, fmt = 'HH:mm'): string {
  if (!iso) return '—';
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).setLocale(i18n.language).toFormat(fmt);
}
export function fmtDate(isoDate: string | null | undefined, fmt = 'dd MMM yyyy'): string {
  if (!isoDate) return '—';
  return DateTime.fromISO(isoDate).setLocale(i18n.language).toFormat(fmt);
}
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes === 0) return '0m';
  const d = Duration.fromObject({ minutes }).shiftTo('hours', 'minutes');
  const h = Math.floor(d.hours);
  const m = Math.round(d.minutes);
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  return DateTime.fromISO(iso, { zone: 'utc' }).setLocale(i18n.language).toRelative() ?? '—';
}
export function todayIso(zone: string): string {
  return DateTime.now().setZone(zone).toISODate() ?? DateTime.now().toISODate()!;
}
export function fmtNumber(n: number): string {
  return new Intl.NumberFormat(i18n.language).format(n);
}

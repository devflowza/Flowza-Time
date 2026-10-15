import { DateTime } from 'luxon';
import type { TimeAwayKind, TimeAwayStatus, TimeAwaySummaryRowDto } from '@flowza/contracts';

/** The month's first and last day (`YYYY-MM` → ISO dates). */
export function monthRange(month: string): { from: string; to: string } {
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  return { from: start.toISODate()!, to: start.endOf('month').toISODate()! };
}

export interface AwayBreakdown { official: number; permission: number; unapproved: number; other: number; total: number }
/**
 * How a month's away time splits: official duty, personal permission, unapproved — and whatever the engine measured away but
 * classified otherwise (short absences under the tolerance), so the parts always add up to the total.
 */
export function awayBreakdown(row: Pick<TimeAwaySummaryRowDto, 'awayMinutes' | 'officialDutyMinutes' | 'permissionMinutes' | 'unapprovedAwayMinutes'>): AwayBreakdown {
  const official = Math.max(0, row.officialDutyMinutes);
  const permission = Math.max(0, row.permissionMinutes);
  const unapproved = Math.max(0, row.unapprovedAwayMinutes);
  const total = Math.max(row.awayMinutes, official + permission + unapproved);
  return { official, permission, unapproved, other: total - official - permission - unapproved, total };
}

export const STATUS_TONE: Record<TimeAwayStatus, 'warning' | 'success' | 'danger' | 'neutral'> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
export const KIND_TONE: Record<TimeAwayKind, 'info' | 'secondary'> = { OFFICIAL: 'info', PERSONAL: 'secondary' };

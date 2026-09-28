import { DateTime } from 'luxon';
import { errors } from '@flowza/shared';

export interface MonthPeriod { month: string; from: string; to: string; /** The whole calendar month (no from / to narrowing). */ whole: boolean }

/**
 * The period of a whole-month report type: `month` (YYYY-MM), narrowed to `from` / `to` when they lie inside it. A schedule's
 * "month to date" passes the exact days (HR portal Prompt 6a review — minor 13), so the report stops at the last complete day
 * instead of covering the rest of the month; `from` / `to` never widen the month.
 */
export function monthPeriod(params: { month?: string | undefined; from?: string | undefined; to?: string | undefined }): MonthPeriod {
  const month = params.month;
  if (!month) throw errors.validation('Missing report parameters.', { issues: [{ path: 'parameters.month', message: 'Required' }] });
  const start = DateTime.fromISO(`${month}-01`, { zone: 'utc' });
  if (!start.isValid) throw errors.validation('Invalid month.', { issues: [{ path: 'parameters.month', message: 'Expected YYYY-MM' }] });
  const monthStart = start.toISODate()!;
  const monthEnd = start.endOf('month').toISODate()!;
  const from = params.from && params.from > monthStart ? params.from : monthStart;
  const to = params.to && params.to < monthEnd ? params.to : monthEnd;
  if (from > to) throw errors.validation('The period must lie inside the month.', { issues: [{ path: 'parameters.to', message: 'Outside the month' }] });
  return { month, from, to, whole: from === monthStart && to === monthEnd };
}

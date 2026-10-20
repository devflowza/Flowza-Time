import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { addDays, localDateTime } from '@flowza/shared';
import type { EngineHourAllowance, EngineTimeOff } from '@flowza/domain';
import type { Trx } from '../context.js';

/*
 * Short leave inputs of the attendance engine (engine 1.5.0, migration 20261019000310): the APPROVED short leave windows around
 * a date and the reduced-hours allowances in force on it. Read under whatever context the caller's transaction carries (the
 * worker's system context, or the API's preview under the caller's RLS — a reader who cannot see the rows simply computes
 * without them, as with leave).
 */

const asDate = (date: string) => sql<Date>`${date}::date`;
function isoDate(v: Date | string): string {
  if (typeof v === 'string') return v.slice(0, 10);
  return DateTime.fromJSDate(v).toISODate() ?? v.toISOString().slice(0, 10);
}
const CATEGORIES: ReadonlySet<EngineTimeOff['category']> = new Set(['PERSONAL', 'OFFICIAL', 'REMOTE', 'NURSING', 'DISABILITY', 'OTHER']);
const KINDS: ReadonlySet<EngineHourAllowance['kind']> = new Set(['NURSING', 'DISABILITY', 'OTHER']);
const POSITIONS: ReadonlySet<EngineHourAllowance['position']> = new Set(['START', 'END', 'EITHER']);

/** A local wall-clock time of `date` (HH:mm[:ss]; 24:00 = the next midnight) in `zone` → UTC ISO. Luxon resolves the offset. */
export function localWindowInstant(date: string, time: string, zone: string): string {
  const hhmm = time.slice(0, 5);
  const at = hhmm === '24:00' ? localDateTime(addDays(date, 1), '00:00', zone) : localDateTime(date, hhmm, zone);
  return at.toUTC().toISO({ suppressMilliseconds: true }) ?? at.toUTC().toString();
}

/**
 * The engine's short leave inputs for one (employee, date): approved windows asked for on D−1, D and D+1 (a night shift's
 * schedule may reach into a neighbouring date; the engine keeps the windows that touch the day's schedule) and the allowances
 * whose validity covers D.
 */
export async function loadTimeOffInputs(trx: Trx, organizationId: string, employeeId: string, date: string, timezone: string): Promise<{ timeOff: EngineTimeOff[]; hourAllowances: EngineHourAllowance[] }> {
  const [windows, allowances] = await Promise.all([
    trx.selectFrom('timeOffRequests as r').innerJoin('timeOffTypes as t', (j) => j.onRef('t.id', '=', 'r.timeOffTypeId').onRef('t.organizationId', '=', 'r.organizationId'))
      .select(['r.id', 'r.requestDate', 'r.startTime', 'r.endTime', 't.code', 't.category', 't.countsAsWork'])
      .where('r.organizationId', '=', organizationId).where('r.employeeId', '=', employeeId).where('r.status', '=', 'APPROVED')
      .where('r.requestDate', '>=', asDate(addDays(date, -1))).where('r.requestDate', '<=', asDate(addDays(date, 1)))
      .orderBy('r.requestDate').orderBy('r.startTime').orderBy('r.id').execute(),
    trx.selectFrom('employeeHourAllowances').select(['id', 'kind', 'minutesPerDay', 'position'])
      .where('organizationId', '=', organizationId).where('employeeId', '=', employeeId)
      .where('validFrom', '<=', asDate(date)).where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', asDate(date))]))
      .orderBy('id').execute(),
  ]);
  const timeOff: EngineTimeOff[] = windows.flatMap((w) => {
    const day = isoDate(w.requestDate);
    const category = w.category as EngineTimeOff['category'];
    if (!CATEGORIES.has(category)) return [];
    return [{ id: w.id, date: day, start: localWindowInstant(day, w.startTime, timezone), end: localWindowInstant(day, w.endTime, timezone), countsAsWork: w.countsAsWork, typeCode: String(w.code), category }];
  });
  const hourAllowances: EngineHourAllowance[] = allowances.flatMap((a) => {
    const kind = a.kind as EngineHourAllowance['kind'];
    const position = a.position as EngineHourAllowance['position'];
    return KINDS.has(kind) && POSITIONS.has(position) ? [{ id: a.id, kind, minutesPerDay: a.minutesPerDay, position }] : [];
  });
  return { timeOff, hourAllowances };
}

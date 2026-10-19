import { DateTime } from 'luxon';
import { notificationReaders, type AppreciationSettings } from '@flowza/contracts';
import { addDays, event, isValidTimezone } from '@flowza/shared';
import { ATTENDANCE_APPRECIATION_JOB_TYPE, emitDomainEvent, withContext, writeAudit, type Trx } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { JobContext } from '../types.js';
import { asDate, chunk } from '../attendance/common.js';
import { claimAlert, loadAlertSettings } from './attendance-alerts.js';

/**
 * Weekly appreciation ("thank-you") messages (customer requirement: "weekly thank-you messages to committed employees").
 *
 * Once a week — on the organisation's `appreciation.weekday` from `appreciation.hour` (organisation time; the hourly scheduler
 * tick catches a missed hour up later the same day) — the PREVIOUS seven days (today − 7 … yesterday) are reviewed per
 * employee: leave, holidays, weekly offs (and days not calculated or still pending) neither count nor disqualify; a worked day
 * (PRESENT / HALF_DAY / MISSING_PUNCH) counts; a day with a selected criterion — late, early departure, absent, missing punch,
 * unexcused — disqualifies. An employee with at least `minWorkedDays` worked days and no disqualifying day receives
 * `attendance.appreciation` (in-app + e-mail per their preferences) with the organisation's message in their language.
 *
 * Once per employee and week: the ledger `attendance_alerts` (kind APPRECIATION, date = the first day reviewed) is claimed
 * before the event, and an employee thanked for an overlapping seven days (a "Send now" earlier in the week) is skipped.
 * Only active / on-leave employees with a login, not past their exit date — never a terminated or suspended one. "Send now"
 * (API, notification.manage) runs one organisation immediately for the last seven days (`force`), still only when enabled.
 */
export const APPRECIATION_MAX_EMPLOYEES = 10_000;
const WORKED = ['PRESENT', 'HALF_DAY', 'MISSING_PUNCH'];
const NEUTRAL = ['LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'NOT_JOINED', 'EXITED', 'PENDING'];
const R = notificationReaders;

export type AppreciationDisqualifier = 'late' | 'early_departure' | 'absence' | 'missing_punch' | 'unexcused';
export interface AppreciationVerdict { qualified: boolean; workedDays: number; disqualifiedBy: AppreciationDisqualifier | null }

/** The seven days reviewed by a run on `today` (organisation-local): today − 7 … yesterday. */
export function appreciationPeriod(today: string): { periodStart: string; periodEnd: string } {
  return { periodStart: addDays(today, -7), periodEnd: addDays(today, -1) };
}

/** Is it the organisation's appreciation time? (`weekday` 0 = Sunday … 6 = Saturday; from `hour` on, the same local day.) */
export function isAppreciationDue(local: DateTime, s: Pick<AppreciationSettings, 'weekday' | 'hour'>): boolean {
  return local.weekday % 7 === s.weekday && local.hour >= s.hour;
}

/** Judge one employee's week (pure). */
export function evaluateAppreciation(days: ReadonlyArray<{ status: string; flags: readonly string[] }>, s: Pick<AppreciationSettings, 'criteria' | 'minWorkedDays'>): AppreciationVerdict {
  let workedDays = 0;
  for (const d of days) {
    if (NEUTRAL.includes(d.status)) continue;
    const c = s.criteria;
    const why: AppreciationDisqualifier | null =
      c.noAbsence && d.status === 'ABSENT' ? 'absence'
      : c.noLate && d.flags.includes('LATE') ? 'late'
      : c.noEarlyDeparture && d.flags.includes('EARLY_DEPARTURE') ? 'early_departure'
      : c.noMissingPunch && (d.status === 'MISSING_PUNCH' || d.flags.includes('MISSING_IN') || d.flags.includes('MISSING_OUT')) ? 'missing_punch'
      : c.noUnexcused && d.flags.includes('UNEXCUSED') ? 'unexcused'
      : null;
    if (why) return { qualified: false, workedDays, disqualifiedBy: why };
    if (WORKED.includes(d.status)) workedDays++;
  }
  return { qualified: workedDays >= s.minWorkedDays, workedDays, disqualifiedBy: null };
}

export interface AppreciationSummary {
  organizationId: string; periodStart: string | null; periodEnd: string | null;
  employees: number; qualified: number; sent: number; alreadyThanked: number; disqualified: number; tooFewDays: number;
  skipped?: 'missing' | 'disabled' | 'not_due' | 'done';
}

/** One organisation's run, in its system context, on the injected clock. `force`: now, whatever the weekday and hour ("Send now"). */
export async function runAppreciation(deps: WorkerDeps, organizationId: string, opts: { force?: boolean; jobId?: string; requestedBy?: string | null } = {}): Promise<AppreciationSummary> {
  const now = deps.now();
  return withContext(deps.db, { kind: 'system', organizationId, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, async (trx) => {
    const summary: AppreciationSummary = { organizationId, periodStart: null, periodEnd: null, employees: 0, qualified: 0, sent: 0, alreadyThanked: 0, disqualified: 0, tooFewDays: 0 };
    const org = await trx.selectFrom('organizations').select(['timezone']).where('id', '=', organizationId).executeTakeFirst();
    if (!org) return { ...summary, skipped: 'missing' };
    const { notifications } = await loadAlertSettings(trx, organizationId);
    const s = notifications.appreciation;
    if (!s.enabled) return { ...summary, skipped: 'disabled' };
    const local = DateTime.fromJSDate(now).setZone(isValidTimezone(org.timezone) ? org.timezone : 'UTC');
    const today = local.toISODate() ?? now.toISOString().slice(0, 10);
    const { periodStart, periodEnd } = appreciationPeriod(today);
    Object.assign(summary, { periodStart, periodEnd });
    if (!opts.force) {
      if (!isAppreciationDue(local, s)) return { ...summary, skipped: 'not_due' };
      // a later hour of the same day: this week's run already thanked somebody
      const done = await trx.selectFrom('attendanceAlerts').select('employeeId').where('organizationId', '=', organizationId).where('kind', '=', 'APPRECIATION').where('alertDate', '=', asDate(periodStart)).limit(1).executeTakeFirst();
      if (done) return { ...summary, skipped: 'done' };
    }
    await thankEmployees(trx, organizationId, s, { today, periodStart, periodEnd }, now, summary);
    if (summary.sent > 0) {
      await writeAudit(trx, { organizationId, actorUserId: opts.requestedBy ?? null, actorType: opts.requestedBy ? 'USER' : 'SYSTEM', action: 'attendance.appreciation_sent', entityType: 'attendance_alert', entityId: null, newValue: { ...summary, manual: opts.force === true }, jobId: opts.jobId ?? null });
    }
    return summary;
  });
}

async function thankEmployees(trx: Trx, organizationId: string, s: AppreciationSettings, p: { today: string; periodStart: string; periodEnd: string }, now: Date, summary: AppreciationSummary): Promise<void> {
  const employees = await trx.selectFrom('employees').select(['id']).where('organizationId', '=', organizationId).where('deletedAt', 'is', null)
    .where('employmentStatus', 'in', ['active', 'on_leave']).where('joiningDate', '<=', asDate(p.periodEnd))
    .where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>=', asDate(p.today))]))
    .orderBy('id').limit(APPRECIATION_MAX_EMPLOYEES).execute();
  if (employees.length === 0) return;
  for (const ids of chunk(employees.map((e) => e.id), 1000)) {
    const [logins, records, thanked] = await Promise.all([
      trx.selectFrom('orgMemberships').select(['employeeId', 'userId']).where('organizationId', '=', organizationId).where('status', '=', 'active').where('employeeId', 'in', ids).execute(),
      trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'status', 'flags']).where('organizationId', '=', organizationId).where('employeeId', 'in', ids)
        .where('attendanceDate', '>=', asDate(p.periodStart)).where('attendanceDate', '<=', asDate(p.periodEnd)).execute(),
      // thanked for seven days overlapping these (once per week, whoever started the run)
      trx.selectFrom('attendanceAlerts').select('employeeId').where('organizationId', '=', organizationId).where('kind', '=', 'APPRECIATION').where('employeeId', 'in', ids)
        .where('alertDate', '>', asDate(addDays(p.periodStart, -7))).where('alertDate', '<', asDate(addDays(p.periodStart, 7))).execute(),
    ]);
    const already = new Set(thanked.map((t) => t.employeeId));
    for (const employeeId of ids) {
      const userIds = [...new Set(logins.filter((l) => l.employeeId === employeeId).map((l) => l.userId))].sort();
      // nothing for an employee without a login
      if (userIds.length === 0) continue;
      summary.employees++;
      const verdict = evaluateAppreciation(records.filter((r) => r.employeeId === employeeId).map((r) => ({ status: String(r.status), flags: Array.isArray(r.flags) ? (r.flags as string[]) : [] })), s);
      if (!verdict.qualified) { if (verdict.disqualifiedBy) summary.disqualified++; else summary.tooFewDays++; continue; }
      summary.qualified++;
      if (already.has(employeeId) || !(await claimAlert(trx, organizationId, employeeId, p.periodStart, 'APPRECIATION', now, userIds.length))) { summary.alreadyThanked++; continue; }
      await emitDomainEvent(trx, {
        organizationId, eventType: 'attendance.appreciation', aggregateType: 'employee', aggregateId: employeeId,
        payload: { employeeId, periodStart: p.periodStart, periodEnd: p.periodEnd, workedDays: verdict.workedDays, message: s.messageEn, messageAr: s.messageAr, userIds },
        actorUserId: null,
      });
      summary.sent++;
    }
  }
}

/**
 * ATTENDANCE_APPRECIATION: payload `{}` — every active organisation whose appreciation time has come (the scheduler's hourly
 * tick), each in its own system-context transaction; `{ organizationId, force: true, requestedBy }` — "Send now" for one
 * organisation (API, notification.manage). One organisation failing never stops the others.
 */
export async function appreciationHandler({ deps, log, job }: JobContext) {
  const only = R.id(job.payload['organizationId'] ?? job.organizationId);
  const force = only !== null && job.payload['force'] === true;
  const requestedBy = R.id(job.payload['requestedBy']);
  const orgIds = only ? [only] : (await withContext(deps.db, { kind: 'platform', jobId: job.id }, (trx) => trx.selectFrom('organizations').select('id').where('status', 'in', ['trial', 'active']).orderBy('id').execute())).map((o) => o.id);
  let sent = 0; let errors = 0;
  for (const orgId of orgIds) {
    try {
      const res = await runAppreciation(deps, orgId, { force, jobId: job.id, requestedBy });
      sent += res.sent;
      if (res.sent > 0 || force) log.info(event('attendance_appreciation', { jobId: job.id, ...res, manual: force }));
    } catch (err) {
      errors++;
      log.warn(event('attendance_appreciation_failed', { jobId: job.id, organizationId: orgId, err: (err as Error).message }));
    }
  }
  return { organizations: orgIds.length, sent, errors };
}

export { ATTENDANCE_APPRECIATION_JOB_TYPE };

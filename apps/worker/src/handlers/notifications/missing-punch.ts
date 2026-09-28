import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { notificationReaders, resolveAttendanceSettings, resolveNotificationSettings, type AttendanceSettings } from '@flowza/contracts';
import { event, isValidTimezone } from '@flowza/shared';
import { emitDomainEvent, withContext } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { JobContext } from '../types.js';
import { asDate, isoDate } from '../attendance/common.js';

/**
 * Missing check-out reminder (HR portal Prompt 8, Finance ATT-98): an employee who checked in today and has not checked out by
 * the end of their day (the resolved shift's expected end — the engine already falls back to the organisation's default
 * shift — else the self-service check-out window's end, else first IN + `attendance.stats.fullDayHours`) plus
 * `notifications.missingPunchReminderHours` gets ONE `punch.missing_out` notice for that employee-day.
 *
 *  - Branch-local: "today" and "yesterday" are the local dates of the record's BRANCH (its timezone; the organisation's when a
 *    branch's timezone is unusable) — a branch far east or west of the organisation keeps its reminder (review 8-P2-6), and a
 *    night shift that started yesterday is still reminded after midnight; a record's due time is computed in the record's own
 *    timezone (the one its attendance date is in).
 *  - Not on non-working days: records whose status is LEAVE / HOLIDAY / WEEKLY_OFF (or outside employment) and days covered
 *    by an approved full-day leave are skipped.
 *  - Once per employee-day: the `missing_punch_reminders` ledger (primary key organisation × employee × date) is claimed with
 *    ON CONFLICT DO NOTHING before the event is emitted, in the same transaction.
 *  - Not late: a reminder that became due more than MISSING_PUNCH_STALE_HOURS ago is not sent any more (the day-close sweep
 *    and the employee's own attendance take over).
 *  - The organisation switch `notifications.missingPunchReminder` turns the reminder off entirely; the relay then applies the
 *    employee's own ATTENDANCE preferences per channel.
 */
export const MISSING_PUNCH_REMINDER_JOB_TYPE = 'MISSING_PUNCH_REMINDERS';
export const MISSING_PUNCH_STALE_HOURS = 12;
export const MISSING_PUNCH_MAX_CANDIDATES = 5_000;
/** Ledger rows are kept this long (a reminder is never re-sent for a day this old anyway). */
export const MISSING_PUNCH_LEDGER_DAYS = 35;

const NON_WORKING = ['LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'NOT_JOINED', 'EXITED'] as const;

export interface MissingPunchSummary { organizationId: string; today: string | null; candidates: number; reminded: number; notDue: number; stale: number; skippedLeave: number; noLogin: number; alreadyReminded: number; capped: boolean; skipped?: 'disabled' | 'missing' }

interface Candidate { employeeId: string; attendanceDate: Date | string; firstInAt: Date; expectedEndAt: Date | null; timezone: string }

/** When the day of a record ends for the reminder, and where that end comes from. */
export function reminderEnd(rec: { attendanceDate: string; firstInAt: Date; expectedEndAt: Date | null; timezone: string }, attendance: AttendanceSettings): { endAt: Date; endSource: 'shift' | 'default' } {
  const firstIn = rec.firstInAt.getTime();
  const fallback = { endAt: new Date(firstIn + attendance.stats.fullDayHours * 3_600_000), endSource: 'default' as const };
  // a shift end before the first IN (checked in after the shift, unscheduled work) says nothing about this stint
  if (rec.expectedEndAt && rec.expectedEndAt.getTime() > firstIn) return { endAt: rec.expectedEndAt, endSource: 'shift' };
  const window = attendance.selfService.checkOutWindow;
  if (window) {
    let end = DateTime.fromISO(`${rec.attendanceDate}T${window.end}`, { zone: rec.timezone });
    if (window.end <= window.start) end = end.plus({ days: 1 }); // the window wraps midnight
    if (end.isValid && end.toMillis() > firstIn) return { endAt: end.toJSDate(), endSource: 'default' };
  }
  return fallback;
}

/** One organisation's run, in its system context, on the injected clock. */
export async function runMissingPunchReminders(deps: WorkerDeps, organizationId: string, opts: { jobId?: string } = {}): Promise<MissingPunchSummary> {
  const now = deps.now();
  return withContext(deps.db, { kind: 'system', organizationId, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, async (trx) => {
    const summary: MissingPunchSummary = { organizationId, today: null, candidates: 0, reminded: 0, notDue: 0, stale: 0, skippedLeave: 0, noLogin: 0, alreadyReminded: 0, capped: false };
    const org = await trx.selectFrom('organizations').select(['timezone']).where('id', '=', organizationId).executeTakeFirst();
    if (!org) return { ...summary, skipped: 'missing' };
    const settings = await trx.selectFrom('organizationSettings').select(['notifications', 'attendance']).where('organizationId', '=', organizationId).executeTakeFirst();
    const notifications = resolveNotificationSettings(settings?.notifications);
    if (!notifications.missingPunchReminder) return { ...summary, skipped: 'disabled' };
    const attendance = resolveAttendanceSettings(settings?.attendance ?? {});
    const zone = isValidTimezone(org.timezone) ? org.timezone : 'UTC';
    const local = DateTime.fromJSDate(now).setZone(zone);
    summary.today = local.toISODate() ?? now.toISOString().slice(0, 10);
    // each branch's own "yesterday … today" (review 8-P2-6): branches in the same local dates share one window — at most three
    // windows at any instant, since every timezone's date is within one day of UTC's
    const windows = new Map<string, { yesterday: string; today: string; branchIds: string[] }>();
    for (const b of await trx.selectFrom('branches').select(['id', 'timezone']).where('organizationId', '=', organizationId).execute()) {
      const branchLocal = DateTime.fromJSDate(now).setZone(isValidTimezone(b.timezone) ? b.timezone : zone);
      const today = branchLocal.toISODate() ?? summary.today;
      const w = windows.get(today) ?? { yesterday: branchLocal.minus({ days: 1 }).toISODate() ?? today, today, branchIds: [] };
      w.branchIds.push(b.id);
      windows.set(today, w);
    }
    if (windows.size === 0) return summary;
    const earliest = [...windows.values()].map((w) => w.yesterday).sort()[0]!;
    const latest = [...windows.values()].map((w) => w.today).sort().at(-1)!;

    // open days: a check-in without a check-out (the engine leaves last_out_at empty while the day is open, and flags
    // MISSING_OUT once it closed with an earlier OUT on record), not reminded yet
    const rows = await trx.selectFrom('attendanceDailyRecords as d').innerJoin('employees as e', (j) => j.onRef('e.id', '=', 'd.employeeId').onRef('e.organizationId', '=', 'd.organizationId'))
      .select(['d.employeeId', 'd.attendanceDate', 'd.firstInAt', 'd.expectedEndAt', 'd.timezone'])
      .where('d.organizationId', '=', organizationId)
      .where((eb) => eb.or([...windows.values()].map((w) => eb.and([eb('d.branchId', 'in', w.branchIds), eb('d.attendanceDate', '>=', asDate(w.yesterday)), eb('d.attendanceDate', '<=', asDate(w.today))]))))
      .where('d.firstInAt', 'is not', null)
      .where((eb) => eb.or([eb('d.lastOutAt', 'is', null), sql<boolean>`'MISSING_OUT' = any(d.flags)`]))
      .where('d.status', 'not in', [...NON_WORKING])
      .where('e.deletedAt', 'is', null)
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('missingPunchReminders as r').select('r.employeeId')
        .whereRef('r.organizationId', '=', 'd.organizationId').whereRef('r.employeeId', '=', 'd.employeeId').whereRef('r.attendanceDate', '=', 'd.attendanceDate'))))
      .orderBy('d.attendanceDate').orderBy('d.employeeId').limit(MISSING_PUNCH_MAX_CANDIDATES + 1).execute() as Candidate[];
    summary.capped = rows.length > MISSING_PUNCH_MAX_CANDIDATES;
    const candidates = rows.slice(0, MISSING_PUNCH_MAX_CANDIDATES);
    summary.candidates = candidates.length;

    if (candidates.length > 0) {
      const employeeIds = [...new Set(candidates.map((c) => c.employeeId))];
      const [leaves, logins] = await Promise.all([
        trx.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', organizationId).where('status', '=', 'APPROVED').where('isHalfDay', '=', false)
          .where('employeeId', 'in', employeeIds).where('startDate', '<=', asDate(latest)).where('endDate', '>=', asDate(earliest)).execute(),
        trx.selectFrom('orgMemberships').select(['employeeId', 'userId']).where('organizationId', '=', organizationId).where('status', '=', 'active').where('employeeId', 'in', employeeIds).execute(),
      ]);
      const onLeave = (employeeId: string, date: string) => leaves.some((l) => l.employeeId === employeeId && isoDate(l.startDate) <= date && isoDate(l.endDate) >= date);
      for (const c of candidates) {
        const date = isoDate(c.attendanceDate);
        if (onLeave(c.employeeId, date)) { summary.skippedLeave++; continue; }
        const firstInAt = c.firstInAt instanceof Date ? c.firstInAt : new Date(c.firstInAt);
        const expectedEndAt = c.expectedEndAt ? (c.expectedEndAt instanceof Date ? c.expectedEndAt : new Date(c.expectedEndAt)) : null;
        const { endAt, endSource } = reminderEnd({ attendanceDate: date, firstInAt, expectedEndAt, timezone: isValidTimezone(c.timezone) ? c.timezone : zone }, attendance);
        const dueAt = new Date(endAt.getTime() + notifications.missingPunchReminderHours * 3_600_000);
        if (now.getTime() < dueAt.getTime()) { summary.notDue++; continue; }
        if (now.getTime() - dueAt.getTime() > MISSING_PUNCH_STALE_HOURS * 3_600_000) { summary.stale++; continue; }
        const userIds = [...new Set(logins.filter((l) => l.employeeId === c.employeeId).map((l) => l.userId))].sort();
        const claimed = await sql<{ employeeId: string }>`insert into public.missing_punch_reminders (organization_id, employee_id, attendance_date, due_at, reminded_at, recipients)
          values (${organizationId}::uuid, ${c.employeeId}::uuid, ${date}::date, ${dueAt}, ${now}, ${userIds.length})
          on conflict (organization_id, employee_id, attendance_date) do nothing returning employee_id as "employeeId"`.execute(trx);
        if (claimed.rows.length === 0) { summary.alreadyReminded++; continue; }
        if (userIds.length === 0) { summary.noLogin++; continue; }
        await emitDomainEvent(trx, {
          organizationId, eventType: 'punch.missing_out', aggregateType: 'employee', aggregateId: c.employeeId,
          payload: { employeeId: c.employeeId, attendanceDate: date, firstInAt: firstInAt.toISOString(), expectedEndAt: endAt.toISOString(), endSource, hours: notifications.missingPunchReminderHours, userIds },
          actorUserId: null,
        });
        summary.reminded++;
      }
    }
    // the ledger only has to remember the days still in reach
    const keepFrom = local.minus({ days: MISSING_PUNCH_LEDGER_DAYS }).toISODate() ?? earliest;
    await trx.deleteFrom('missingPunchReminders').where('organizationId', '=', organizationId).where('attendanceDate', '<', asDate(keepFrom)).execute();
    return summary;
  });
}

/**
 * MISSING_PUNCH_REMINDERS: payload `{ organizationId? }` — one organisation, or every active organisation (the scheduler's
 * 15-minute tick), each in its own system-context transaction; one organisation failing never stops the others.
 */
export async function missingPunchRemindersHandler({ deps, log, job }: JobContext) {
  const only = notificationReaders.id(job.payload['organizationId'] ?? job.organizationId);
  const orgIds = only ? [only] : (await withContext(deps.db, { kind: 'platform', jobId: job.id }, (trx) => trx.selectFrom('organizations').select('id').where('status', 'in', ['trial', 'active']).orderBy('id').execute())).map((o) => o.id);
  let reminded = 0; let candidates = 0; let errors = 0;
  for (const orgId of orgIds) {
    try {
      const res = await runMissingPunchReminders(deps, orgId, { jobId: job.id });
      reminded += res.reminded; candidates += res.candidates;
      if (res.reminded > 0 || res.capped) log.info(event('missing_punch_reminders', { ...res }));
    } catch (err) {
      errors++;
      log.warn(event('missing_punch_reminders_failed', { organizationId: orgId, err: (err as Error).message }));
    }
  }
  return { organizations: orgIds.length, candidates, reminded, errors };
}

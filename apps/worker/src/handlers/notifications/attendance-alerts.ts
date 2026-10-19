import { sql } from 'kysely';
import { DateTime } from 'luxon';
import {
  excuseDeadlineOf, notificationReaders, resolveAttendanceSettings, resolveNotificationSettings,
  type AttendanceSettings, type DomainEventType, type NotificationSettings,
} from '@flowza/contracts';
import { addDays, event, isValidTimezone, localDateTime } from '@flowza/shared';
import { ATTENDANCE_ALERTS_JOB_TYPE, emitDomainEvent, loadEmployeeWorkingCalendars, withContext, type AttendanceAlertKind, type Trx } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { JobContext } from '../types.js';
import { asDate, asObject, isoDate } from '../attendance/common.js';

/**
 * Automatic attendance notices (customer requirements: "lateness and early departure notifications", "automatic handling of
 * absence", "identifying and handling missing check-ins") — each sent ONCE per employee-day and kind, claimed in the ledger
 * `attendance_alerts` (ON CONFLICT DO NOTHING) in the same transaction as its domain event:
 *
 *  - LATE_ARRIVAL / EARLY_DEPARTURE / ABSENCE — "record alerts": decided from the day's record when the recompute FIRST
 *    produces LATE, EARLY_DEPARTURE or ABSENT (recompute.ts calls `notifyRecordAlerts`), and caught up by the 15-minute sweep
 *    below (a setting switched on later in the day, an early departure whose scheduled end passed after the last recompute).
 *    Only for an attendance date that is TODAY or YESTERDAY in the record's own timezone — a historical recalculation or a
 *    backfill never alerts anybody. LATE: the LATE flag with at least `minMinutes` late. EARLY_DEPARTURE: the flag with at
 *    least `minMinutes` early, on a judged day (not PENDING) whose scheduled end has passed — a lunch-break check-out of an
 *    open day is not an early departure. ABSENCE: the engine judged the working day ABSENT (its window closed); the notice
 *    states the excuse deadline (`attendance.unexcused.excuseDeadlineDays`) and, with auto-deduction on, what may be deducted.
 *  - ABSENCE_REMINDER — the day before the excuse deadline (from ABSENCE_REMINDER_LOCAL_HOUR, organisation time), for an
 *    absence still unexplained: no reason given (pending / answered / accepted / excused), not excused, not on approved leave.
 *  - MISSING_CHECK_IN — `missingCheckInReminderMinutes` after the expected start of the day's shift (the resolved shift, else
 *    the organisation's default shift) with no punch in the shift's check-in window, no check-in on the record, no selfie
 *    check-in waiting, no approved leave, no holiday / weekly off. Never later than MISSING_CHECK_IN_STALE_MINUTES after due.
 *
 * Recipients: the employee's own login(s) and — per the alert's settings — their direct (primary) manager's login(s). Nothing
 * is sent about an employee without a login, or one terminated, resigned, suspended, deleted or past their exit date (the
 * day is still settled in the ledger, so it is not reconsidered every quarter hour). The organisation's switches turn each
 * alert off entirely; the relay then applies every recipient's own ATTENDANCE preferences per channel.
 */
export const ATTENDANCE_ALERT_MAX_CANDIDATES = 5_000;
/** The ledger keeps this many days (the appreciation's overlap guard needs two weeks; nothing older is ever reconsidered). */
export const ATTENDANCE_ALERT_LEDGER_DAYS = 60;
/** Local hour (organisation time) from which the absence reminders of the day are sent. */
export const ABSENCE_REMINDER_LOCAL_HOUR = 9;
/** A missing check-in reminder that became due longer ago than this is not sent any more. */
export const MISSING_CHECK_IN_STALE_MINUTES = 180;
/** Without a shift check-in window, a punch this long before the expected start counts as the check-in. */
const DEFAULT_CHECK_IN_WINDOW_MINUTES = 120;

const R = notificationReaders;
const NON_WORKING = ['LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'NOT_JOINED', 'EXITED'] as const;
/** A reason the employee gave for a day that the reviewer still has to decide, or accepted — the day is explained. */
const EXPLAINING_NOTE_STATUSES = ['pending', 'info_requested', 'approved', 'excused'] as const;
const EVENT_OF: Record<Exclude<AttendanceAlertKind, 'APPRECIATION'>, DomainEventType> = {
  LATE_ARRIVAL: 'attendance.late_arrival', EARLY_DEPARTURE: 'attendance.early_departure', ABSENCE: 'attendance.absence_recorded',
  ABSENCE_REMINDER: 'attendance.absence_reminder', MISSING_CHECK_IN: 'punch.missing_in',
};

/** The facts of a daily record an alert is decided from. */
export interface AlertRecord {
  employeeId: string;
  attendanceDate: string;
  timezone: string;
  status: string;
  flags: readonly string[];
  lateMinutes: number;
  earlyDepartureMinutes: number;
  firstInAt: Date | null;
  lastOutAt: Date | null;
  expectedStartAt: Date | null;
  expectedEndAt: Date | null;
}
export type RecordAlertKind = 'LATE_ARRIVAL' | 'EARLY_DEPARTURE' | 'ABSENCE';

/** Is the attendance date today or yesterday in `timezone` (the record's own)? Older days are history: never alerted. */
export function isRecentAttendanceDate(date: string, timezone: string, now: Date): boolean {
  const local = DateTime.fromJSDate(now).setZone(isValidTimezone(timezone) ? timezone : 'UTC');
  const today = local.toISODate() ?? now.toISOString().slice(0, 10);
  return date === today || date === addDays(today, -1);
}

/** The record alerts a day qualifies for under the organisation's switches (pure; the ledger decides whether one is new). */
export function dueRecordAlerts(rec: AlertRecord, settings: NotificationSettings, now: Date): RecordAlertKind[] {
  if (!isRecentAttendanceDate(rec.attendanceDate, rec.timezone, now)) return [];
  const out: RecordAlertKind[] = [];
  const reaches = (s: { notifyEmployee: boolean; notifyManager: boolean }) => s.notifyEmployee || s.notifyManager;
  const late = settings.lateArrivalAlert;
  if (late.enabled && reaches(late) && rec.flags.includes('LATE') && rec.lateMinutes >= late.minMinutes) out.push('LATE_ARRIVAL');
  const early = settings.earlyDepartureAlert;
  if (early.enabled && reaches(early) && rec.flags.includes('EARLY_DEPARTURE') && rec.earlyDepartureMinutes >= early.minMinutes
    && rec.status !== 'PENDING' && rec.expectedEndAt !== null && now.getTime() >= rec.expectedEndAt.getTime()) out.push('EARLY_DEPARTURE');
  const absence = settings.absenceAlert;
  if (absence.enabled && reaches(absence) && rec.status === 'ABSENT') out.push('ABSENCE');
  return out;
}

/** A record row as Kysely returns it (dates as Date or string, flags as an array). */
export function alertRecordOf(row: { employeeId: string; attendanceDate: Date | string; timezone: string; status: string; flags: unknown; lateMinutes: number; earlyDepartureMinutes: number; firstInAt: Date | string | null; lastOutAt: Date | string | null; expectedStartAt: Date | string | null; expectedEndAt: Date | string | null }): AlertRecord {
  const at = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v));
  return {
    employeeId: row.employeeId, attendanceDate: isoDate(row.attendanceDate), timezone: row.timezone, status: row.status, flags: Array.isArray(row.flags) ? (row.flags as string[]) : [],
    lateMinutes: Number(row.lateMinutes ?? 0), earlyDepartureMinutes: Number(row.earlyDepartureMinutes ?? 0),
    firstInAt: at(row.firstInAt), lastOutAt: at(row.lastOutAt), expectedStartAt: at(row.expectedStartAt), expectedEndAt: at(row.expectedEndAt),
  };
}

export interface AlertSettings { notifications: NotificationSettings; attendance: AttendanceSettings }
export async function loadAlertSettings(trx: Trx, organizationId: string): Promise<AlertSettings> {
  const row = await trx.selectFrom('organizationSettings').select(['notifications', 'attendance']).where('organizationId', '=', organizationId).executeTakeFirst();
  return { notifications: resolveNotificationSettings(asObject(row?.notifications)), attendance: resolveAttendanceSettings(asObject(row?.attendance)) };
}

/** Who an alert about an employee can reach: their own login(s), their direct manager's — and whether they may be told at all. */
interface EmployeeFacts { name: string; reachable: boolean; ownUserIds: string[]; managerUserIds: string[] }
export async function employeeAlertFacts(trx: Trx, organizationId: string, employeeIds: readonly string[], onDate: string): Promise<Map<string, EmployeeFacts>> {
  const ids = [...new Set(employeeIds)];
  const out = new Map<string, EmployeeFacts>();
  if (ids.length === 0) return out;
  const employees = await trx.selectFrom('employees').select(['id', 'displayName', 'employmentStatus', 'exitDate', 'deletedAt', 'managerEmployeeId'])
    .where('organizationId', '=', organizationId).where('id', 'in', ids).execute();
  const managerIds = [...new Set(employees.map((e) => e.managerEmployeeId).filter((m): m is string => m !== null))];
  const logins = await trx.selectFrom('orgMemberships').select(['employeeId', 'userId']).where('organizationId', '=', organizationId).where('status', '=', 'active')
    .where('employeeId', 'in', [...ids, ...managerIds]).execute();
  const usersOf = (employeeId: string | null) => (employeeId === null ? [] : [...new Set(logins.filter((l) => l.employeeId === employeeId).map((l) => l.userId))].sort());
  for (const e of employees) {
    const own = usersOf(e.id);
    const reachable = e.deletedAt === null && !['terminated', 'resigned', 'suspended'].includes(String(e.employmentStatus)) && (e.exitDate === null || isoDate(e.exitDate) >= onDate) && own.length > 0;
    out.set(e.id, { name: e.displayName, reachable, ownUserIds: own, managerUserIds: e.managerEmployeeId === e.id ? [] : usersOf(e.managerEmployeeId).filter((u) => !own.includes(u)) });
  }
  return out;
}

/** Claim one ledger row; true when this call claimed it (false: the alert was already sent). */
export async function claimAlert(trx: Trx, organizationId: string, employeeId: string, date: string, kind: AttendanceAlertKind, now: Date, recipients: number): Promise<boolean> {
  const res = await sql<{ employeeId: string }>`insert into public.attendance_alerts (organization_id, employee_id, alert_date, kind, sent_at, recipients)
    values (${organizationId}::uuid, ${employeeId}::uuid, ${date}::date, ${kind}, ${now}, ${recipients})
    on conflict (organization_id, employee_id, alert_date, kind) do nothing returning employee_id as "employeeId"`.execute(trx);
  return res.rows.length > 0;
}

async function alreadyClaimed(trx: Trx, organizationId: string, pairs: ReadonlyArray<{ employeeId: string; date: string }>, kinds: readonly AttendanceAlertKind[]): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const dates = [...new Set(pairs.map((p) => p.date))];
  const rows = await trx.selectFrom('attendanceAlerts').select(['employeeId', 'alertDate', 'kind']).where('organizationId', '=', organizationId)
    .where('employeeId', 'in', [...new Set(pairs.map((p) => p.employeeId))]).where('kind', 'in', [...kinds]).where(sql<boolean>`alert_date = any(${dates}::date[])`).execute();
  return new Set(rows.map((r) => `${r.employeeId}|${isoDate(r.alertDate)}|${r.kind}`));
}

/** The domain event of one alert, targeted at `userIds` (the relay keeps them to active members). */
async function emitAlert(trx: Trx, organizationId: string, kind: Exclude<AttendanceAlertKind, 'APPRECIATION'>, employeeId: string, payload: Record<string, unknown>, userIds: readonly string[]): Promise<void> {
  await emitDomainEvent(trx, { organizationId, eventType: EVENT_OF[kind], aggregateType: 'employee', aggregateId: employeeId, payload: { employeeId, ...payload, userIds: [...userIds] }, actorUserId: null });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface RecordAlertOutcome { sent: RecordAlertKind[]; settled: RecordAlertKind[] }
/**
 * Decide and send the record alerts of one day (recompute hook and sweep): every due kind not in the ledger yet is claimed and,
 * when somebody can be told, emitted. `facts` may be preloaded by a caller handling many records.
 */
export async function sendRecordAlerts(trx: Trx, organizationId: string, rec: AlertRecord, settings: AlertSettings, now: Date, facts?: Map<string, EmployeeFacts>): Promise<RecordAlertOutcome> {
  const outcome: RecordAlertOutcome = { sent: [], settled: [] };
  const due = dueRecordAlerts(rec, settings.notifications, now);
  if (due.length === 0) return outcome;
  const f = (facts ?? await employeeAlertFacts(trx, organizationId, [rec.employeeId], rec.attendanceDate)).get(rec.employeeId);
  for (const kind of due) {
    const s = kind === 'LATE_ARRIVAL' ? settings.notifications.lateArrivalAlert : kind === 'EARLY_DEPARTURE' ? settings.notifications.earlyDepartureAlert : settings.notifications.absenceAlert;
    const userIds = f && f.reachable ? [...new Set([...(s.notifyEmployee ? f.ownUserIds : []), ...(s.notifyManager ? f.managerUserIds : [])])] : [];
    if (!(await claimAlert(trx, organizationId, rec.employeeId, rec.attendanceDate, kind, now, userIds.length))) continue;
    outcome.settled.push(kind);
    if (userIds.length === 0) continue;
    const base = { employeeName: f?.name ?? null, attendanceDate: rec.attendanceDate };
    if (kind === 'LATE_ARRIVAL') {
      await emitAlert(trx, organizationId, kind, rec.employeeId, { ...base, minutes: rec.lateMinutes, firstInAt: iso(rec.firstInAt), expectedStartAt: iso(rec.expectedStartAt) }, userIds);
    } else if (kind === 'EARLY_DEPARTURE') {
      await emitAlert(trx, organizationId, kind, rec.employeeId, { ...base, minutes: rec.earlyDepartureMinutes, lastOutAt: iso(rec.lastOutAt), expectedEndAt: iso(rec.expectedEndAt) }, userIds);
    } else {
      const u = settings.attendance.unexcused;
      const payEffectDays = u.autoDeductEnabled && u.payEffectAbsent > 0 ? u.payEffectAbsent : null;
      await emitAlert(trx, organizationId, kind, rec.employeeId, { ...base, deadline: excuseDeadlineOf(rec.attendanceDate, u.excuseDeadlineDays), payEffectDays }, userIds);
    }
    outcome.sent.push(kind);
  }
  return outcome;
}

/**
 * The recompute hook (recompute.ts, after a record was created or changed): cheap checks first — a recent date and a flag /
 * status that can alert — then the organisation's switches (one read) and the ledger. Runs in the recompute's transaction
 * (the organisation's system context): the alert commits with the record or not at all.
 */
export async function notifyRecordAlerts(trx: Trx, organizationId: string, rec: AlertRecord, now: Date): Promise<RecordAlertOutcome> {
  const none: RecordAlertOutcome = { sent: [], settled: [] };
  if (!isRecentAttendanceDate(rec.attendanceDate, rec.timezone, now)) return none;
  if (!rec.flags.includes('LATE') && !rec.flags.includes('EARLY_DEPARTURE') && rec.status !== 'ABSENT') return none;
  return sendRecordAlerts(trx, organizationId, rec, await loadAlertSettings(trx, organizationId), now);
}

export interface AttendanceAlertsSummary {
  organizationId: string; today: string | null;
  records: number; recordAlerts: number;
  absenceReminders: number;
  missingCheckIn: { candidates: number; reminded: number; notDue: number; stale: number; punched: number; onLeave: number; noShift: number };
  capped: boolean; purged: number;
  skipped?: 'missing';
}

/** Record alerts the recompute could not send (switched on later, an early departure whose scheduled end passed since). */
async function sweepRecordAlerts(trx: Trx, organizationId: string, today: string, settings: AlertSettings, now: Date, summary: AttendanceAlertsSummary): Promise<void> {
  const n = settings.notifications;
  if (!n.lateArrivalAlert.enabled && !n.earlyDepartureAlert.enabled && !n.absenceAlert.enabled) return;
  // a window wide enough for every timezone's "yesterday … today"; the per-record check is exact
  const rows = await trx.selectFrom('attendanceDailyRecords')
    .select(['employeeId', 'attendanceDate', 'timezone', 'status', 'flags', 'lateMinutes', 'earlyDepartureMinutes', 'firstInAt', 'lastOutAt', 'expectedStartAt', 'expectedEndAt'])
    .where('organizationId', '=', organizationId).where('attendanceDate', '>=', asDate(addDays(today, -2))).where('attendanceDate', '<=', asDate(addDays(today, 1)))
    .where((eb) => eb.or([eb('status', '=', 'ABSENT'), sql<boolean>`flags && array['LATE', 'EARLY_DEPARTURE']::text[]`]))
    .orderBy('attendanceDate').orderBy('employeeId').limit(ATTENDANCE_ALERT_MAX_CANDIDATES + 1).execute();
  if (rows.length > ATTENDANCE_ALERT_MAX_CANDIDATES) summary.capped = true;
  const due = rows.slice(0, ATTENDANCE_ALERT_MAX_CANDIDATES).map(alertRecordOf).filter((r) => dueRecordAlerts(r, n, now).length > 0);
  if (due.length === 0) return;
  const claimed = await alreadyClaimed(trx, organizationId, due.map((r) => ({ employeeId: r.employeeId, date: r.attendanceDate })), ['LATE_ARRIVAL', 'EARLY_DEPARTURE', 'ABSENCE']);
  const open = due.filter((r) => dueRecordAlerts(r, n, now).some((k) => !claimed.has(`${r.employeeId}|${r.attendanceDate}|${k}`)));
  summary.records = open.length;
  if (open.length === 0) return;
  const facts = await employeeAlertFacts(trx, organizationId, open.map((r) => r.employeeId), addDays(today, -1));
  for (const rec of open) summary.recordAlerts += (await sendRecordAlerts(trx, organizationId, rec, settings, now, facts)).sent.length;
}

/** The reminder the day before the excuse deadline, for the absences still unexplained. */
async function sweepAbsenceReminders(trx: Trx, organizationId: string, local: DateTime, today: string, settings: AlertSettings, now: Date, summary: AttendanceAlertsSummary): Promise<void> {
  const days = settings.attendance.unexcused.excuseDeadlineDays;
  if (!settings.notifications.absenceReminder || days === null || local.hour < ABSENCE_REMINDER_LOCAL_HOUR) return;
  // deadline = date + days = tomorrow
  const date = addDays(today, 1 - days);
  const deadline = excuseDeadlineOf(date, days);
  const rows = await trx.selectFrom('attendanceDailyRecords').select(['employeeId']).where('organizationId', '=', organizationId).where('attendanceDate', '=', asDate(date))
    .where('status', '=', 'ABSENT').where(sql<boolean>`not (flags && array['EXCUSED']::text[])`).orderBy('employeeId').limit(ATTENDANCE_ALERT_MAX_CANDIDATES).execute();
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.employeeId);
  const [claimed, notes, leaves, facts] = await Promise.all([
    alreadyClaimed(trx, organizationId, ids.map((employeeId) => ({ employeeId, date })), ['ABSENCE_REMINDER']),
    trx.selectFrom('attendanceNotes').select('employeeId').where('organizationId', '=', organizationId).where('employeeId', 'in', ids).where('attendanceDate', '=', asDate(date))
      .where('status', 'in', [...EXPLAINING_NOTE_STATUSES]).execute(),
    trx.selectFrom('leaveRecords').select('employeeId').where('organizationId', '=', organizationId).where('status', '=', 'APPROVED').where('employeeId', 'in', ids)
      .where('startDate', '<=', asDate(date)).where('endDate', '>=', asDate(date)).execute(),
    employeeAlertFacts(trx, organizationId, ids, today),
  ]);
  const explained = new Set([...notes.map((n) => n.employeeId), ...leaves.map((l) => l.employeeId)]);
  for (const employeeId of ids) {
    if (claimed.has(`${employeeId}|${date}|ABSENCE_REMINDER`) || explained.has(employeeId)) continue;
    const f = facts.get(employeeId);
    const userIds = f?.reachable ? f.ownUserIds : [];
    if (!(await claimAlert(trx, organizationId, employeeId, date, 'ABSENCE_REMINDER', now, userIds.length)) || userIds.length === 0) continue;
    await emitAlert(trx, organizationId, 'ABSENCE_REMINDER', employeeId, { attendanceDate: date, deadline }, userIds);
    summary.absenceReminders++;
  }
}

interface CheckInCandidate { employeeId: string; date: string; expectedStartAt: Date; windowStart: Date }
/** The missing check-in reminder: no punch after the expected shift start + the configured minutes. */
async function sweepMissingCheckIns(trx: Trx, organizationId: string, zone: string, today: string, settings: AlertSettings, now: Date, summary: AttendanceAlertsSummary): Promise<void> {
  const n = settings.notifications;
  if (!n.missingCheckInReminder) return;
  const from = addDays(today, -1); const to = addDays(today, 1);
  const employees = await trx.selectFrom('employees').select(['id']).where('organizationId', '=', organizationId).where('deletedAt', 'is', null).where('employmentStatus', '=', 'active')
    .where('joiningDate', '<=', asDate(to)).where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>=', asDate(from))]))
    .where(({ exists, selectFrom }) => exists(selectFrom('orgMemberships as m').select('m.id').whereRef('m.employeeId', '=', 'employees.id').where('m.organizationId', '=', organizationId).where('m.status', '=', 'active')))
    .orderBy('id').limit(ATTENDANCE_ALERT_MAX_CANDIDATES + 1).execute();
  if (employees.length > ATTENDANCE_ALERT_MAX_CANDIDATES) summary.capped = true;
  const ids = employees.slice(0, ATTENDANCE_ALERT_MAX_CANDIDATES).map((e) => e.id);
  if (ids.length === 0) return;
  const { calendars, context } = await loadEmployeeWorkingCalendars(trx, organizationId, ids, { from, to });
  const defaultShiftId = settings.attendance.defaultShiftId ?? null;
  const planned: Array<{ employeeId: string; date: string; shiftId: string; zone: string }> = [];
  for (const id of ids) {
    const cal = calendars.get(id);
    if (!cal) continue;
    for (const date of [from, today, to]) {
      const day = cal.day(date);
      if (day.off || day.placement.status !== 'active') continue;
      const shiftId = day.shift.shiftId ?? (day.shift.isPatternOff ? null : defaultShiftId);
      if (!shiftId) { summary.missingCheckIn.noShift++; continue; }
      const tz = context.branches.get(day.placement.branchId)?.timezone;
      planned.push({ employeeId: id, date, shiftId, zone: tz && isValidTimezone(tz) ? tz : zone });
    }
  }
  if (planned.length === 0) return;
  const shifts = new Map((await trx.selectFrom('shifts').select(['id', 'type', 'startTime', 'coreStart', 'punchInWindowBeforeMinutes'])
    .where('organizationId', '=', organizationId).where('id', 'in', [...new Set(planned.map((p) => p.shiftId))]).execute()).map((s) => [s.id, s]));
  const minutes = n.missingCheckInReminderMinutes;
  const candidates: CheckInCandidate[] = [];
  for (const p of planned) {
    const shift = shifts.get(p.shiftId);
    // a fixed shift starts at its start time; a flexible one only has an expected arrival when it has core hours
    const start = shift ? (shift.type === 'FLEXIBLE' ? shift.coreStart : shift.startTime) : null;
    if (!start) { summary.missingCheckIn.noShift++; continue; }
    const expected = localDateTime(p.date, start.slice(0, 5), p.zone);
    if (!expected.isValid) continue;
    const dueAt = expected.plus({ minutes }).toMillis();
    if (now.getTime() < dueAt) { summary.missingCheckIn.notDue++; continue; }
    if (now.getTime() - dueAt > MISSING_CHECK_IN_STALE_MINUTES * 60_000) { summary.missingCheckIn.stale++; continue; }
    const before = shift && shift.punchInWindowBeforeMinutes > 0 ? shift.punchInWindowBeforeMinutes : DEFAULT_CHECK_IN_WINDOW_MINUTES;
    candidates.push({ employeeId: p.employeeId, date: p.date, expectedStartAt: expected.toJSDate(), windowStart: expected.minus({ minutes: before }).toJSDate() });
  }
  summary.missingCheckIn.candidates = candidates.length;
  if (candidates.length === 0) return;
  const cIds = [...new Set(candidates.map((c) => c.employeeId))];
  const earliest = new Date(Math.min(...candidates.map((c) => c.windowStart.getTime())));
  const [claimed, leaves, records, punches, selfies, facts] = await Promise.all([
    alreadyClaimed(trx, organizationId, candidates, ['MISSING_CHECK_IN']),
    trx.selectFrom('leaveRecords').select(['employeeId', 'startDate', 'endDate']).where('organizationId', '=', organizationId).where('status', '=', 'APPROVED').where('employeeId', 'in', cIds)
      .where('startDate', '<=', asDate(to)).where('endDate', '>=', asDate(from)).execute(),
    trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'attendanceDate', 'status', 'firstInAt']).where('organizationId', '=', organizationId).where('employeeId', 'in', cIds)
      .where('attendanceDate', '>=', asDate(from)).where('attendanceDate', '<=', asDate(to)).execute(),
    trx.selectFrom('attendanceEvents').select(['employeeId', 'punchedAt']).where('organizationId', '=', organizationId).where('employeeId', 'in', cIds)
      .where('punchedAt', '>=', earliest).where('punchedAt', '<=', now).where('voidedAt', 'is', null).execute(),
    trx.selectFrom('selfieCheckins').select(['employeeId', 'punchedAt']).where('organizationId', '=', organizationId).where('employeeId', 'in', cIds)
      .where('punchedAt', '>=', earliest).where('status', '=', 'pending').execute(),
    employeeAlertFacts(trx, organizationId, cIds, today),
  ]);
  const at = (v: Date | string) => (v instanceof Date ? v : new Date(v)).getTime();
  for (const c of candidates) {
    if (claimed.has(`${c.employeeId}|${c.date}|MISSING_CHECK_IN`)) continue;
    if (leaves.some((l) => l.employeeId === c.employeeId && isoDate(l.startDate) <= c.date && isoDate(l.endDate) >= c.date)) { summary.missingCheckIn.onLeave++; continue; }
    const rec = records.find((r) => r.employeeId === c.employeeId && isoDate(r.attendanceDate) === c.date);
    if (rec && ((NON_WORKING as readonly string[]).includes(rec.status) || rec.firstInAt !== null)) { summary.missingCheckIn.punched++; continue; }
    const inWindow = (t: Date | string) => at(t) >= c.windowStart.getTime() && at(t) <= now.getTime();
    if (punches.some((p) => p.employeeId === c.employeeId && inWindow(p.punchedAt)) || selfies.some((s) => s.employeeId === c.employeeId && inWindow(s.punchedAt))) { summary.missingCheckIn.punched++; continue; }
    const f = facts.get(c.employeeId);
    const userIds = f?.reachable ? [...new Set([...f.ownUserIds, ...(n.missingCheckInNotifyManager ? f.managerUserIds : [])])] : [];
    if (!(await claimAlert(trx, organizationId, c.employeeId, c.date, 'MISSING_CHECK_IN', now, userIds.length)) || userIds.length === 0) continue;
    await emitAlert(trx, organizationId, 'MISSING_CHECK_IN', c.employeeId, { employeeName: f?.name ?? null, attendanceDate: c.date, expectedStartAt: c.expectedStartAt.toISOString(), minutes }, userIds);
    summary.missingCheckIn.reminded++;
  }
}

/** One organisation's sweep, in its system context, on the injected clock. */
export async function runAttendanceAlerts(deps: WorkerDeps, organizationId: string, opts: { jobId?: string } = {}): Promise<AttendanceAlertsSummary> {
  const now = deps.now();
  return withContext(deps.db, { kind: 'system', organizationId, ...(opts.jobId ? { jobId: opts.jobId } : {}) }, async (trx) => {
    const summary: AttendanceAlertsSummary = {
      organizationId, today: null, records: 0, recordAlerts: 0, absenceReminders: 0, capped: false, purged: 0,
      missingCheckIn: { candidates: 0, reminded: 0, notDue: 0, stale: 0, punched: 0, onLeave: 0, noShift: 0 },
    };
    const org = await trx.selectFrom('organizations').select(['timezone']).where('id', '=', organizationId).executeTakeFirst();
    if (!org) return { ...summary, skipped: 'missing' };
    const settings = await loadAlertSettings(trx, organizationId);
    const zone = isValidTimezone(org.timezone) ? org.timezone : 'UTC';
    const local = DateTime.fromJSDate(now).setZone(zone);
    const today = local.toISODate() ?? now.toISOString().slice(0, 10);
    summary.today = today;
    await sweepRecordAlerts(trx, organizationId, today, settings, now, summary);
    await sweepAbsenceReminders(trx, organizationId, local, today, settings, now, summary);
    await sweepMissingCheckIns(trx, organizationId, zone, today, settings, now, summary);
    // the ledger only has to remember the days still in reach
    const purged = await trx.deleteFrom('attendanceAlerts').where('organizationId', '=', organizationId).where('alertDate', '<', asDate(addDays(today, -ATTENDANCE_ALERT_LEDGER_DAYS))).executeTakeFirst();
    summary.purged = Number(purged.numDeletedRows ?? 0);
    return summary;
  });
}

/**
 * ATTENDANCE_ALERTS: payload `{ organizationId? }` — one organisation, or every active organisation (the scheduler's 15-minute
 * tick), each in its own system-context transaction; one organisation failing never stops the others.
 */
export async function attendanceAlertsHandler({ deps, log, job }: JobContext) {
  const only = R.id(job.payload['organizationId'] ?? job.organizationId);
  const orgIds = only ? [only] : (await withContext(deps.db, { kind: 'platform', jobId: job.id }, (trx) => trx.selectFrom('organizations').select('id').where('status', 'in', ['trial', 'active']).orderBy('id').execute())).map((o) => o.id);
  let sent = 0; let errors = 0;
  for (const orgId of orgIds) {
    try {
      const res = await runAttendanceAlerts(deps, orgId, { jobId: job.id });
      const n = res.recordAlerts + res.absenceReminders + res.missingCheckIn.reminded;
      sent += n;
      if (n > 0 || res.capped) log.info(event('attendance_alerts', { jobId: job.id, ...res }));
    } catch (err) {
      errors++;
      log.warn(event('attendance_alerts_failed', { jobId: job.id, organizationId: orgId, err: (err as Error).message }));
    }
  }
  return { organizations: orgIds.length, sent, errors };
}

export { ATTENDANCE_ALERTS_JOB_TYPE };

import { sql } from 'kysely';
import { DateTime } from 'luxon';
import {
  SELF_SERVICE_PROVIDER_KEY,
  type AttendanceAwayIntervalDto, type TimeAwayBackInput, type TimeAwayKind, type TimeAwayListQuery, type TimeAwayRequestDto, type TimeAwayRequestInput, type TimeAwayStatus,
  type TimeAwayStatusDto, type TimeAwayStepOutInput, type TimeAwaySummaryQuery, type TimeAwaySummaryRowDto,
} from '@flowza/contracts';
import { effectiveBranchOn, ensureSelfServiceDevice, type Trx } from '@flowza/database';
import { AppError, addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireMembership } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate } from '../../lib/mappers.js';
import { awayIntervalsFromTrace } from '../features/mappers.js';
import { cancelForEntity, submit } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { enqueueNormalize, ingestRawTransactions } from '../features/ingest.js';
import { dv } from '../features/sql-helpers.js';
import { isPeriodLocked, isWorking, loadEmployeeCtx, localDate, localInstant, lockEmployee, portalSelf, type EmployeeCtx } from './common.js';
import { seatSecondaryManager } from './line-manager.js';
import { KIND_LABEL, loadTimeAway, personalMinutesInMonth, TIME_AWAY_COLUMNS, timeAwayDtos, timeAwayPolicyFor, type TimeAwayRow } from './time-away-effects.js';

/**
 * Time away inside the working day (docs/time-away.md) — the employee side and the HR / manager lists.
 *
 *   - Plan a window (`POST /me/time-away`): OFFICIAL duty or PERSONAL permission on one working day, decided through the
 *     approval engine (TIME_AWAY; the line manager with the secondary standing in, or a workflow).
 *   - Step out (`POST /me/time-away/step-out`): for a site with an entry-only terminal (no exit reader) — records a BREAK-OUT
 *     punch on the organisation's self-service device NOW (server clock) and files the window [now, expected return]; when the
 *     employee's own live window (planned ahead) covers now, the punch is linked to it instead (same kind, no second request).
 *     The return is the next check-in on a terminal, or the portal's "I'm back" (`POST /me/time-away/back`, a BREAK-IN punch)
 *     when the policy's `returnBy` allows it; a step-out window then ends at the return, so the rest of it never blocks the
 *     next step-out (trimmed by "I'm back", or by the next step-out / request after a terminal return).
 *   - The engine measures the actual away time from the punches and classifies it against the APPROVED windows only.
 *
 * Limits (the attendance policy of the day, `policy.timeAway`): the feature on, a punch interpretation that keeps the punches
 * in between (PAIRED / DIRECTIONAL), the personal monthly quota and the longest personal window. A window never overlaps
 * another live one (service check + exclusion constraint), lies on one day, is at most 16 hours, and is filed at most 7 days
 * back or 60 days ahead. Rows are written in the API's system step (client writes are revoked); reads go through RLS.
 */

const SELF_KEYS = ['attendance.checkin', 'attendance.note'] as const;
const BACKDATE_DAYS = 7;
const AHEAD_DAYS = 60;
/** A punch older than this no longer decides whether the employee is on site (a forgotten check-out). */
const SEQUENCE_WINDOW_MS = 20 * 3_600_000;
const REPLAY_WINDOW_MS = 14 * 86_400_000;

type Placement = 'in' | 'out' | 'away';
type PunchFact = { id: string; punchedAt: Date; direction: string; punchRole: string | null; source: string };

/**
 * Where the employee is, from their recent punches (raw, so a punch counts before the worker normalised it): a terminal's
 * punch role first (entry-only = in, exit-only = out, access readers ignored), else the reported direction; a direction-less
 * punch toggles. A break-out is `away` until the next arrival.
 */
export function placementOf(punches: readonly PunchFact[]): { state: Placement; last: PunchFact | null } {
  let state: Placement = 'out';
  let last: PunchFact | null = null;
  for (const p of punches) {
    if (p.punchRole === 'ACCESS') continue;
    const dir = p.punchRole === 'CHECK_IN' ? 'in' : p.punchRole === 'CHECK_OUT' ? 'out' : p.direction;
    if (dir === 'in' || dir === 'break_in') state = 'in';
    else if (dir === 'out') state = 'out';
    else if (dir === 'break_out') state = state === 'in' ? 'away' : state;
    else state = state === 'in' ? 'out' : 'in';
    last = p;
  }
  return { state, last };
}

async function recentPunches(trx: Trx, orgId: string, employeeId: string, now: Date): Promise<PunchFact[]> {
  return withSystemScope(trx, orgId, async (t) => (await t.selectFrom('attendanceRawTransactions as rt').leftJoin('devices as d', 'd.id', 'rt.deviceId')
    .select(['rt.id', 'rt.punchedAt', 'rt.direction', 'rt.source', 'd.punchRole'])
    .where('rt.organizationId', '=', orgId).where('rt.employeeId', '=', employeeId)
    .where('rt.punchedAt', '>=', new Date(now.getTime() - SEQUENCE_WINDOW_MS)).where('rt.punchedAt', '<=', new Date(now.getTime() + 60_000))
    .where('rt.processingStatus', 'in', ['pending', 'normalized'])
    .orderBy('rt.punchedAt', 'asc').orderBy('rt.id', 'asc').execute())
    .map((r) => ({ id: String(r.id), punchedAt: r.punchedAt, direction: String(r.direction), punchRole: r.punchRole ?? null, source: String(r.source) })));
}

/**
 * The open step-out of the employee: a live window whose break-out punch is still the latest punch (a step-out window, or the
 * employee's planned window the break-out was linked to).
 */
async function openStepOut(trx: Trx, orgId: string, employeeId: string, punches: readonly PunchFact[]): Promise<TimeAwayRow | null> {
  const { state, last } = placementOf(punches);
  if (state !== 'away' || !last) return null;
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
    .where('stepOutRawId', '=', last.id).where('status', 'in', ['pending', 'approved']).executeTakeFirst());
  return (row as TimeAwayRow | undefined) ?? null;
}

/** The employee's live (pending / approved) window covering `at` — live windows never overlap, so at most one. System scope. */
async function liveWindowAt(trx: Trx, orgId: string, employeeId: string, at: Date): Promise<TimeAwayRow | null> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
    .where('status', 'in', ['pending', 'approved']).where('startsAt', '<=', at).where('endsAt', '>', at).executeTakeFirst());
  return (row as TimeAwayRow | undefined) ?? null;
}

/** An arrival in `placementOf`'s terms (entry-only terminal, IN, BREAK-IN, or a direction-less punch toggling back in). */
const isArrival = (p: PunchFact): boolean => {
  if (p.punchRole === 'ACCESS') return false;
  const dir = p.punchRole === 'CHECK_IN' ? 'in' : p.punchRole === 'CHECK_OUT' ? 'out' : p.direction;
  return dir !== 'out' && dir !== 'break_out';
};

/**
 * A step-out window ends when the employee is back: "I'm back" (its `returnedAt`) or the first arrival after its break-out (a
 * terminal check-in). The window is trimmed to that return — never past its own end, never to nothing — and the return noted,
 * so the rest of it no longer blocks (or counts against the quota as) another window. Inside the caller's transaction.
 */
async function endStepOutAt(trx: Trx, actor: Actor, orgId: string, row: TimeAwayRow, returnedAt: Date, channel: string): Promise<void> {
  const endsAt = new Date(Math.min(row.endsAt.getTime(), Math.max(returnedAt.getTime(), row.startsAt.getTime() + 1)));
  const returned = row.returnedAt ?? (returnedAt.getTime() >= row.startsAt.getTime() ? returnedAt : endsAt);
  await systemStep(trx, orgId, (t) => t.updateTable('timeAwayRequests').set({ endsAt, returnedAt: returned }).where('organizationId', '=', orgId).where('id', '=', row.id).where('status', 'in', ['pending', 'approved']).execute());
  await audit(trx, actor, orgId, 'attendance.time_away_returned', 'time_away_request', { entityId: row.id, branchId: row.branchId, oldValue: { endsAt: row.endsAt.toISOString() }, newValue: { returnedAt: returned.toISOString(), endsAt: endsAt.toISOString(), channel } });
}

/**
 * The step-out window covering `now` that the employee already came back from (they are not away under it): ended at the
 * return, so it never blocks a later step-out or window. A terminal return is found among the recent punches; none found
 * (the break-out was quarantined) → the employee is back by now.
 */
async function endReturnedStepOut(trx: Trx, actor: Actor, orgId: string, employeeId: string, punches: readonly PunchFact[], now: Date): Promise<void> {
  const row = await liveWindowAt(trx, orgId, employeeId, now);
  if (!row || row.source !== 'step_out') return;
  const { state, last } = placementOf(punches);
  if (state === 'away' && last && row.stepOutRawId === last.id) return;
  if (await isPeriodLocked(trx, orgId, row.branchId, isoDate(row.attendanceDate))) return;
  const arrival = punches.find((p) => p.id !== row.stepOutRawId && p.punchedAt.getTime() >= row.startsAt.getTime() && isArrival(p));
  const back = row.returnedAt ?? arrival?.punchedAt ?? now;
  // never past now (a terminal clock a few seconds ahead): the window must stop covering now
  await endStepOutAt(trx, actor, orgId, row, back.getTime() > now.getTime() ? now : back, row.returnedAt ? 'portal' : arrival ? 'device' : 'unknown');
}

/**
 * Every path that files or changes an employee's windows (plan, step out, come back) takes the same two locks in one order —
 * self-punch (shared with check-in / check-out), then time-away — so the overlap and the personal quota checks always see the
 * other path's commit and the order can never deadlock.
 */
async function lockTimeAway(trx: Trx, employeeId: string): Promise<void> {
  await lockEmployee(trx, 'self-punch', employeeId);
  await lockEmployee(trx, 'time-away', employeeId);
}

const policyError = (inactive: 'DISABLED' | 'FIRST_LAST_INTERPRETATION') => new AppError('FORBIDDEN', inactive === 'DISABLED'
  ? 'Time away is not tracked by your attendance policy.'
  : 'Your attendance policy keeps only the first and the last punch of a day, so time away cannot be measured. Ask HR to switch the policy to paired or directional punches.', { details: { reason: inactive === 'DISABLED' ? 'TIME_AWAY_DISABLED' : 'TIME_AWAY_NOT_MEASURABLE' } });

/** Personal permission limits of the policy (null = no limit), checked before a window is filed. */
async function checkPersonalLimits(trx: Trx, orgId: string, emp: EmployeeCtx, date: string, minutes: number, policy: { personalMonthlyQuotaMinutes: number | null; personalMaxMinutes: number | null }): Promise<void> {
  if (policy.personalMaxMinutes !== null && minutes > policy.personalMaxMinutes) {
    throw errors.validation(`Your attendance policy allows at most ${policy.personalMaxMinutes} minutes of personal permission at a time.`, { reason: 'TIME_AWAY_TOO_LONG', maxMinutes: policy.personalMaxMinutes, issues: [{ path: 'endsAt', message: 'Too long' }] });
  }
  if (policy.personalMonthlyQuotaMinutes !== null) {
    const used = await personalMinutesInMonth(trx, orgId, emp.id, date);
    if (used + minutes > policy.personalMonthlyQuotaMinutes) {
      throw errors.validation(`Your attendance policy allows ${policy.personalMonthlyQuotaMinutes} minutes of personal permission per month; ${used} are already used or waiting.`, { reason: 'TIME_AWAY_QUOTA', quotaMinutes: policy.personalMonthlyQuotaMinutes, usedMinutes: used, issues: [{ path: 'kind', message: 'Monthly quota reached' }] });
    }
  }
}

async function assertNoOverlap(trx: Trx, orgId: string, employeeId: string, startsAt: Date, endsAt: Date): Promise<void> {
  const clash = await withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
    .where('status', 'in', ['pending', 'approved']).where('startsAt', '<', endsAt).where('endsAt', '>', startsAt).executeTakeFirst());
  if (clash) throw errors.conflict('This window overlaps another time-away request.', { reason: 'TIME_AWAY_OVERLAP', timeAwayId: clash.id });
}

/** Insert the row, route it through the approval engine, seat the secondary manager, audit. Inside the caller's transaction. */
async function fileRequest(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, emp: EmployeeCtx, row: { branchId: string; attendanceDate: string; kind: TimeAwayKind; source: 'request' | 'step_out'; startsAt: Date; endsAt: Date; reason: string; destination: string | null; stepOutRawId: string | null }): Promise<TimeAwayRow> {
  const inserted = await systemStep(trx, orgId, (t) => t.insertInto('timeAwayRequests').values({
    organizationId: orgId, employeeId: emp.id, branchId: row.branchId, attendanceDate: row.attendanceDate, kind: row.kind, source: row.source, startsAt: row.startsAt, endsAt: row.endsAt,
    reason: row.reason, destination: row.destination, status: 'pending', stepOutRawId: row.stepOutRawId, createdBy: actor.userId,
  }).returning('id').executeTakeFirstOrThrow());
  const submitted = await submit(deps, trx, actor, orgId, { entityType: 'TIME_AWAY', entityId: inserted.id, employeeId: emp.id, branchId: row.branchId, departmentId: emp.departmentId, units: null, requestedBy: actor.userId, noWorkflow: { kind: 'MANAGER' } });
  await systemStep(trx, orgId, async (t) => {
    await seatSecondaryManager(t, actor, orgId, { requestId: submitted.requestId, entityType: 'TIME_AWAY', entityId: inserted.id, employeeId: emp.id, secondaryManagerEmployeeId: emp.secondaryManagerEmployeeId, employeeName: emp.displayName });
    await t.updateTable('timeAwayRequests').set({ approvalRequestId: submitted.requestId }).where('id', '=', inserted.id).execute();
  });
  await audit(trx, actor, orgId, row.source === 'step_out' ? 'attendance.time_away_stepped_out' : 'attendance.time_away_requested', 'time_away_request', {
    entityId: inserted.id, branchId: row.branchId, newValue: { kind: row.kind, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString(), reason: row.reason, destination: row.destination },
  });
  return (await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, inserted.id)))!;
}

/** Write one self-service punch (break-out / break-in) on the organisation's virtual device; returns the raw id. */
async function writeSelfPunch(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, emp: EmployeeCtx, now: Date, input: { direction: 'break_out' | 'break_in'; channel: 'web' | 'mobile'; idempotencyKey: string; payload: Record<string, unknown> }): Promise<string> {
  return systemStep(trx, orgId, async (t) => {
    const device = await ensureSelfServiceDevice(t, orgId);
    const res = await ingestRawTransactions(t, { id: device.id, organizationId: orgId, generation: device.generation, providerKey: device.providerKey, branchId: emp.branchId, timezone: emp.timezone },
      [{ providerTransactionId: `self:${emp.id}:${input.idempotencyKey}`, deviceEmployeeId: emp.id, punchedAt: now.toISOString(), deviceLocalTime: null, verificationMethod: 'mobile', direction: input.direction,
        rawPayload: { channel: input.channel, ip: actor.ip, userAgent: actor.userAgent, timeAway: true, ...input.payload } }], { source: 'SELF_SERVICE', now });
    const rawId = res.ids[0];
    if (!rawId) throw errors.conflict('This punch was already recorded.', { reason: 'DUPLICATE_PUNCH' });
    await t.updateTable('attendanceRawTransactions').set({ employeeId: emp.id }).where('organizationId', '=', orgId).where('id', '=', rawId).where('punchedAt', '=', now).execute();
    await enqueueNormalize(deps, t, orgId, device.id, actor.requestId);
    return rawId;
  });
}

/**
 * A replayed self-service key: the raw row it already wrote (same key → same result, the offline queue may resend) and the
 * window it was written for (`timeAwayRequestId` in its payload — set by a linked break-out and by every "I'm back").
 */
async function replayOf(trx: Trx, orgId: string, employeeId: string, key: string, now: Date): Promise<{ rawId: string; timeAwayRequestId: string | null } | null> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceRawTransactions').select(['id', 'rawPayload']).where('organizationId', '=', orgId).where('providerKey', '=', SELF_SERVICE_PROVIDER_KEY)
    .where('providerTransactionId', '=', `self:${employeeId}:${key}`).where('punchedAt', '>=', new Date(now.getTime() - REPLAY_WINDOW_MS)).executeTakeFirst());
  if (!row) return null;
  const payload = row.rawPayload as { timeAwayRequestId?: unknown } | null;
  return { rawId: String(row.id), timeAwayRequestId: payload && typeof payload === 'object' && typeof payload.timeAwayRequestId === 'string' ? payload.timeAwayRequestId : null };
}

/** Today's classified away intervals from the last computed record (trace step `timeAway`). */
async function todaysIntervals(trx: Trx, orgId: string, employeeId: string, date: string): Promise<AttendanceAwayIntervalDto[]> {
  const rec = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceDailyRecords').select('trace').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('attendanceDate', '=', dv(date)).executeTakeFirst());
  return awayIntervalsFromTrace(rec?.trace);
}

// ----- employee ------------------------------------------------------------------------------------------------------------------

export async function getTimeAwayStatus(deps: ApiDeps, actor: Actor, orgId: string): Promise<TimeAwayStatusDto> {
  const self = portalSelf(actor, orgId, ...SELF_KEYS, 'attendance.view_own');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const now = new Date();
    const today = localInstant(now, emp.timezone).date;
    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchOn(t, orgId, emp.id, today))) ?? emp.branchId;
    const { policy, inactive } = await timeAwayPolicyFor(trx, orgId, emp, today, branchId);
    const punches = await recentPunches(trx, orgId, emp.id, now);
    const { state, last } = placementOf(punches);
    const open = await openStepOut(trx, orgId, emp.id, punches);
    // as stepOut: a live window covering now never blocks (linked, or ended at the return); a locked period does
    const locked = await isPeriodLocked(trx, orgId, branchId, today);
    const [mine, used, intervals] = await Promise.all([
      withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('attendanceDate', '=', dv(today)).orderBy('startsAt', 'asc').execute()),
      personalMinutesInMonth(trx, orgId, emp.id, today),
      todaysIntervals(trx, orgId, emp.id, today),
    ]);
    const working = isWorking(emp, today);
    return {
      date: today, timezone: emp.timezone, serverTime: now.toISOString(),
      policy: { enabled: policy.enabled, stepOutFromPortal: policy.stepOutFromPortal, returnBy: policy.returnBy, officialCountsAsWorked: policy.officialCountsAsWorked, personalMonthlyQuotaMinutes: policy.personalMonthlyQuotaMinutes, personalMaxMinutes: policy.personalMaxMinutes, personalUsedMinutes: used, inactiveReason: inactive },
      // since: the break-out itself (a planned window the step-out was linked to may have started earlier)
      away: open ? { requestId: open.id, kind: open.kind, since: (last?.punchedAt ?? open.startsAt).toISOString(), expectedBackAt: open.endsAt.toISOString(), reason: open.reason, destination: open.destination, status: open.status } : null,
      onSite: state === 'in',
      canStepOut: working && !locked && inactive === null && policy.stepOutFromPortal && state === 'in' && hasPermission(self.grant, 'attendance.checkin'),
      canComeBack: working && open !== null && policy.returnBy === 'device_or_portal' && hasPermission(self.grant, 'attendance.checkin'),
      intervals,
      requests: await timeAwayDtos(trx, orgId, mine as TimeAwayRow[]),
    };
  });
}

export async function listMyTimeAway(deps: ApiDeps, actor: Actor, orgId: string, q: { from?: string | undefined; to?: string | undefined; status?: TimeAwayStatus | undefined }): Promise<TimeAwayRequestDto[]> {
  const self = portalSelf(actor, orgId, ...SELF_KEYS, 'attendance.view_own');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId);
    if (q.from) base = base.where('attendanceDate', '>=', dv(q.from));
    if (q.to) base = base.where('attendanceDate', '<=', dv(q.to));
    if (q.status) base = base.where('status', '=', q.status);
    return timeAwayDtos(trx, orgId, (await base.orderBy('startsAt', 'desc').limit(500).execute()) as TimeAwayRow[]);
  });
}

export async function requestTimeAway(deps: ApiDeps, actor: Actor, orgId: string, input: TimeAwayRequestInput): Promise<TimeAwayRequestDto> {
  const self = portalSelf(actor, orgId, ...SELF_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    await lockTimeAway(trx, self.employeeId);
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const now = new Date();
    const today = localInstant(now, emp.timezone).date;
    if (!isWorking(emp, today)) throw errors.forbidden('Your employment is not active.');
    const startsAt = new Date(input.startsAt); const endsAt = new Date(input.endsAt);
    const date = localDate(startsAt, emp.timezone);
    if (endsAt.getTime() - startsAt.getTime() > 16 * 3_600_000) throw errors.validation('A time-away window is at most 16 hours.', { issues: [{ path: 'endsAt', message: 'Too long' }] });
    if (date < addDays(today, -BACKDATE_DAYS)) throw errors.validation(`Time away can be requested at most ${BACKDATE_DAYS} days back.`, { reason: 'TIME_AWAY_TOO_OLD', issues: [{ path: 'startsAt', message: 'Too far back' }] });
    if (date > addDays(today, AHEAD_DAYS)) throw errors.validation(`Time away can be requested at most ${AHEAD_DAYS} days ahead.`, { issues: [{ path: 'startsAt', message: 'Too far ahead' }] });
    if (date < emp.joiningDate) throw errors.validation('This date is before your joining date.', { issues: [{ path: 'startsAt', message: 'Before joining date' }] });
    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchOn(t, orgId, emp.id, date))) ?? emp.branchId;
    if (await isPeriodLocked(trx, orgId, branchId, date)) throw errors.periodLocked('The attendance period of this date is locked.');
    const { policy, inactive } = await timeAwayPolicyFor(trx, orgId, emp, date, branchId);
    if (inactive) throw policyError(inactive);
    const minutes = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
    // the rest of a step-out the employee came back from (terminal return) no longer blocks or counts
    await endReturnedStepOut(trx, actor, orgId, emp.id, await recentPunches(trx, orgId, emp.id, now), now);
    if (input.kind === 'PERSONAL') await checkPersonalLimits(trx, orgId, emp, date, minutes, policy);
    await assertNoOverlap(trx, orgId, emp.id, startsAt, endsAt);
    const row = await fileRequest(deps, trx, actor, orgId, emp, { branchId, attendanceDate: date, kind: input.kind, source: 'request', startsAt, endsAt, reason: input.reason, destination: input.destination ?? null, stepOutRawId: null });
    return (await timeAwayDtos(trx, orgId, [row]))[0]!;
  });
}

export async function stepOut(deps: ApiDeps, actor: Actor, orgId: string, input: TimeAwayStepOutInput): Promise<TimeAwayRequestDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  return runUser(deps.db, actor, async (trx) => {
    // one self-service punch of an employee at a time (the same lock as check-in / check-out), then the windows' lock
    await lockTimeAway(trx, self.employeeId);
    const now = new Date();
    const replayed = await replayOf(trx, orgId, self.employeeId, input.idempotencyKey, now);
    if (replayed) {
      // the window filed for that break-out, or the planned one it was linked to (a later step-out under it re-links stepOutRawId)
      const row = (await withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('stepOutRawId', '=', replayed.rawId).executeTakeFirst())) as TimeAwayRow | undefined
        ?? (replayed.timeAwayRequestId ? await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, replayed.timeAwayRequestId!)) : undefined);
      if (row && row.employeeId === self.employeeId) return (await timeAwayDtos(trx, orgId, [row]))[0]!;
      throw errors.conflict('This punch was already recorded.', { reason: 'DUPLICATE_PUNCH' });
    }
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(now, emp.timezone).date;
    if (!isWorking(emp, today)) throw errors.forbidden('Your employment is not active.');
    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchOn(t, orgId, emp.id, today))) ?? emp.branchId;
    if (await isPeriodLocked(trx, orgId, branchId, today)) throw errors.periodLocked('The attendance period of today is locked.');
    const { policy, inactive } = await timeAwayPolicyFor(trx, orgId, emp, today, branchId);
    if (inactive) throw policyError(inactive);
    if (!policy.stepOutFromPortal) throw new AppError('FORBIDDEN', 'Your attendance policy does not allow stepping out from the portal; ask your manager to record the time away.', { details: { reason: 'STEP_OUT_DISABLED' } });
    const punches = await recentPunches(trx, orgId, emp.id, now);
    const { state } = placementOf(punches);
    if (state === 'away') throw errors.conflict('You have already stepped out. Check in when you are back.', { reason: 'ALREADY_AWAY' });
    if (state !== 'in') throw errors.invalidState('Check in first: you can only step out while you are on site.', { reason: 'NOT_ON_SITE' });
    const expectedBackAt = new Date(input.expectedBackAt);
    const minutes = Math.round((expectedBackAt.getTime() - now.getTime()) / 60_000);
    if (minutes < 5) throw errors.validation('Expected return must be at least 5 minutes from now.', { issues: [{ path: 'expectedBackAt', message: 'Too soon' }] });
    if (minutes > 12 * 60) throw errors.validation('Expected return must be within 12 hours.', { issues: [{ path: 'expectedBackAt', message: 'Too late' }] });
    // the rest of an earlier step-out the employee came back from ends at that return (it never blocks this one)
    await endReturnedStepOut(trx, actor, orgId, emp.id, punches, now);
    // the employee's own live window covers now (planned ahead): the break-out records its actual start — no second request
    const covering = await liveWindowAt(trx, orgId, emp.id, now);
    if (covering && covering.source === 'request') {
      if (covering.kind !== input.kind) {
        throw errors.conflict(`Your ${KIND_LABEL[covering.kind]} window covers now: step out under it, or withdraw it first.`, { reason: 'TIME_AWAY_KIND_MISMATCH', timeAwayId: covering.id, kind: covering.kind });
      }
      const linkedRawId = await writeSelfPunch(deps, trx, actor, orgId, emp, now, { direction: 'break_out', channel: input.channel, idempotencyKey: input.idempotencyKey, payload: { kind: input.kind, expectedBackAt: expectedBackAt.toISOString(), timeAwayRequestId: covering.id } });
      // the latest break-out under the window is its open step-out ("I'm back" / the status card find it), the return not yet known
      await systemStep(trx, orgId, (t) => t.updateTable('timeAwayRequests').set({ stepOutRawId: linkedRawId, returnedAt: null }).where('organizationId', '=', orgId).where('id', '=', covering.id).where('status', 'in', ['pending', 'approved']).execute());
      await audit(trx, actor, orgId, 'attendance.time_away_stepped_out', 'time_away_request', { entityId: covering.id, branchId: covering.branchId, newValue: { kind: covering.kind, steppedOutAt: now.toISOString(), expectedBackAt: expectedBackAt.toISOString(), linked: true, channel: input.channel } });
      return (await timeAwayDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, covering.id)))!]))[0]!;
    }
    if (input.kind === 'PERSONAL') await checkPersonalLimits(trx, orgId, emp, today, minutes, policy);
    await assertNoOverlap(trx, orgId, emp.id, now, expectedBackAt);
    const rawId = await writeSelfPunch(deps, trx, actor, orgId, emp, now, { direction: 'break_out', channel: input.channel, idempotencyKey: input.idempotencyKey, payload: { kind: input.kind, expectedBackAt: expectedBackAt.toISOString() } });
    const row = await fileRequest(deps, trx, actor, orgId, emp, { branchId, attendanceDate: today, kind: input.kind, source: 'step_out', startsAt: now, endsAt: expectedBackAt, reason: input.reason, destination: input.destination ?? null, stepOutRawId: rawId });
    return (await timeAwayDtos(trx, orgId, [row]))[0]!;
  });
}

export async function comeBack(deps: ApiDeps, actor: Actor, orgId: string, input: TimeAwayBackInput): Promise<TimeAwayRequestDto> {
  const self = portalSelf(actor, orgId, 'attendance.checkin');
  return runUser(deps.db, actor, async (trx) => {
    await lockTimeAway(trx, self.employeeId);
    const now = new Date();
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const replayed = await replayOf(trx, orgId, emp.id, input.idempotencyKey, now);
    if (replayed) {
      // the window this return closed (a step-out window, or a planned one the break-out was linked to); an older row without
      // the id in its payload falls back to the latest step-out window
      const recorded = replayed.timeAwayRequestId ? await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, replayed.timeAwayRequestId!)) : undefined;
      const last = recorded && recorded.employeeId === emp.id ? recorded
        : (await withSystemScope(trx, orgId, (t) => t.selectFrom('timeAwayRequests').select(TIME_AWAY_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', emp.id).where('source', '=', 'step_out').orderBy('startsAt', 'desc').executeTakeFirst())) as TimeAwayRow | undefined;
      if (last) return (await timeAwayDtos(trx, orgId, [last]))[0]!;
    }
    const open = await openStepOut(trx, orgId, emp.id, await recentPunches(trx, orgId, emp.id, now));
    if (!open) throw errors.invalidState('You have not stepped out.', { reason: 'NOT_AWAY' });
    const date = isoDate(open.attendanceDate);
    const { policy } = await timeAwayPolicyFor(trx, orgId, emp, date, open.branchId ?? emp.branchId);
    if (policy.returnBy !== 'device_or_portal') throw new AppError('FORBIDDEN', 'Check in on the terminal when you are back: your attendance policy records the return on site only.', { details: { reason: 'RETURN_ON_DEVICE' } });
    await writeSelfPunch(deps, trx, actor, orgId, emp, now, { direction: 'break_in', channel: input.channel, idempotencyKey: input.idempotencyKey, payload: { timeAwayRequestId: open.id } });
    if (open.source === 'step_out') {
      // a step-out window ends at the return: the rest of it never blocks the next step-out or counts against the quota
      await endStepOutAt(trx, actor, orgId, open, now, input.channel);
    } else {
      // a planned window stays as planned (the employee may step out under it again); the return is noted
      await systemStep(trx, orgId, (t) => t.updateTable('timeAwayRequests').set({ returnedAt: now }).where('id', '=', open.id).where('returnedAt', 'is', null).execute());
      await audit(trx, actor, orgId, 'attendance.time_away_returned', 'time_away_request', { entityId: open.id, branchId: open.branchId, newValue: { returnedAt: now.toISOString(), channel: input.channel } });
    }
    return (await timeAwayDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, open.id)))!]))[0]!;
  });
}

export async function cancelMyTimeAway(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason?: string): Promise<TimeAwayRequestDto> {
  const self = portalSelf(actor, orgId, ...SELF_KEYS);
  const why = reason && reason.trim().length >= 3 ? reason.trim() : 'Withdrawn by the employee';
  return runUser(deps.db, actor, async (trx) => {
    const before = await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, id));
    if (!before || before.employeeId !== self.employeeId) throw errors.notFound('Time away request', id);
    if (before.status !== 'pending') throw errors.invalidState(`Only a pending request can be withdrawn (current: ${before.status}).`);
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('timeAwayRequests').set({ status: 'cancelled', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: why }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
      await cancelForEntity(deps, t, actor, orgId, 'TIME_AWAY', id, why, { source: 'self_service' });
    });
    await audit(trx, actor, orgId, 'attendance.time_away_withdrawn', 'time_away_request', { entityId: id, branchId: before.branchId, reason: why });
    return (await timeAwayDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadTimeAway(t, orgId, id)))!]))[0]!;
  });
}

// ----- HR / line manager ---------------------------------------------------------------------------------------------------------

/** Who the caller may list: organisation-wide (attendance.view, RLS branch scope) or their team (attendance.view_team). */
function listScope(actor: Actor, orgId: string, scope: 'all' | 'team'): { teamOnly: boolean; team: string[] } {
  const grant = requireMembership(actor.principal, orgId);
  const org = hasPermission(grant, 'attendance.view');
  const team = hasPermission(grant, 'attendance.view_team') ? grant.teamEmployeeIds.filter((e) => e !== grant.employeeId) : [];
  if (!org && team.length === 0) throw errors.forbidden('Missing permission: attendance.view.');
  return { teamOnly: scope === 'team' || !org, team };
}
const NIL = '00000000-0000-0000-0000-000000000000';

export async function listTimeAway(deps: ApiDeps, actor: Actor, orgId: string, q: TimeAwayListQuery): Promise<{ data: TimeAwayRequestDto[]; total: number }> {
  const scope = listScope(actor, orgId, q.scope);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('timeAwayRequests').where('organizationId', '=', orgId).where('attendanceDate', '>=', dv(q.from)).where('attendanceDate', '<=', dv(q.to));
    if (scope.teamOnly) base = base.where('employeeId', 'in', scope.team.length ? scope.team : [NIL]);
    if (q.status) base = base.where('status', '=', q.status);
    if (q.kind) base = base.where('kind', '=', q.kind);
    if (q.employeeId) base = base.where('employeeId', '=', q.employeeId);
    if (q.branchId) base = base.where('branchId', '=', q.branchId);
    if (q.departmentId) {
      // the employees of the department (system scope: the department filter needs no employee.view; RLS still scopes the rows)
      const deptId = q.departmentId;
      const members = await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('departmentId', '=', deptId).execute());
      base = base.where('employeeId', 'in', members.length ? members.map((m) => m.id) : [NIL]);
    }
    const total = Number((await base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirst())?.n ?? 0);
    const rows = await base.select(TIME_AWAY_COLUMNS).orderBy('startsAt', 'desc').orderBy('id', 'asc').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
    return { data: await timeAwayDtos(trx, orgId, rows as TimeAwayRow[], { withEmployee: true }), total };
  });
}

/** Monthly time-away totals per employee from the daily records (engine figures) + their pending requests. */
export async function timeAwaySummary(deps: ApiDeps, actor: Actor, orgId: string, q: TimeAwaySummaryQuery): Promise<TimeAwaySummaryRowDto[]> {
  const scope = listScope(actor, orgId, q.scope);
  const from = `${q.month}-01`;
  const to = DateTime.fromISO(from, { zone: 'utc' }).endOf('month').toISODate()!;
  return runUser(deps.db, actor, async (trx) => {
    const rows = await sql<{ employeeId: string; employeeNumber: string; employeeName: string; departmentName: string | null; days: string; away: string; official: string; permission: string; unapproved: string; unapprovedDays: string }>`
      select r.employee_id as "employeeId", e.employee_number as "employeeNumber", e.display_name as "employeeName", d.name as "departmentName",
             count(*) filter (where r.away_minutes > 0) as days, coalesce(sum(r.away_minutes), 0) as away, coalesce(sum(r.official_duty_minutes), 0) as official,
             coalesce(sum(r.permission_minutes), 0) as permission, coalesce(sum(r.unapproved_away_minutes), 0) as unapproved,
             count(*) filter (where 'UNAPPROVED_AWAY' = any(r.flags)) as "unapprovedDays"
      from public.attendance_daily_records r
      join public.employees e on e.id = r.employee_id and e.organization_id = r.organization_id
      left join public.departments d on d.id = r.department_id and d.organization_id = r.organization_id
      where r.organization_id = ${orgId}::uuid and r.attendance_date between ${from}::date and ${to}::date and r.away_minutes > 0
        ${q.branchId ? sql`and r.branch_id = ${q.branchId}::uuid` : sql``}
        ${q.departmentId ? sql`and r.department_id = ${q.departmentId}::uuid` : sql``}
        ${scope.teamOnly ? sql`and r.employee_id = any(${sql.val(scope.team.length ? scope.team : [NIL])}::uuid[])` : sql``}
      group by r.employee_id, e.employee_number, e.display_name, d.name
      order by sum(r.unapproved_away_minutes) desc, e.display_name asc
      limit 1000`.execute(trx);
    const ids = rows.rows.map((r) => r.employeeId);
    const pending = ids.length ? await trx.selectFrom('timeAwayRequests').select(['employeeId', (eb) => eb.fn.countAll<string>().as('n')]).where('organizationId', '=', orgId).where('status', '=', 'pending')
      .where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to)).where('employeeId', 'in', ids).groupBy('employeeId').execute() : [];
    const pendingOf = new Map(pending.map((p) => [p.employeeId, Number(p.n)]));
    return rows.rows.map((r) => ({
      employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, departmentName: r.departmentName, days: Number(r.days), awayMinutes: Number(r.away),
      officialDutyMinutes: Number(r.official), permissionMinutes: Number(r.permission), unapprovedAwayMinutes: Number(r.unapproved), unapprovedDays: Number(r.unapprovedDays), pendingRequests: pendingOf.get(r.employeeId) ?? 0,
    }));
  });
}


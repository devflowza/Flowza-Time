import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import {
  SHIFT_CHANGE_AHEAD_DAYS, SHIFT_CHANGE_MAX_DAYS,
  type SelfShiftChangeInput, type shiftChangeListQuerySchema, type ShiftChangeKind, type ShiftChangeOptionsDto, type ShiftChangeRequestDto, type ShiftChangeStatus,
} from '@flowza/contracts';
import { effectiveBranchIdOn } from '@flowza/database';
import { addDays, eachDate, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireAnyPermission } from '../../lib/authorize.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { requireModuleFor } from '../../middleware/module-gate.js';
import { cancelForEntity, submit } from '../approvals/engine.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';
import { isWorking, loadEmployeeCtx, localInstant, lockEmployee, portalSelf } from './common.js';
import { seatSecondaryManager } from './line-manager.js';
import { resolveDays, toShiftSummary, worksShift } from './shift-resolve.js';
import {
  additionalConflicts, compositionError, firstLockedDate, loadEngineShifts, loadShiftChange, SHIFT_CHANGE_COLUMNS, shiftChangeDtos, swapInRange, type ShiftChangeRow,
} from './shift-change-effects.js';

/**
 * Shift change requests — the employee side and the HR / manager list (Enterprise, module `shift_requests`; the module gate
 * closes `/me/shift-changes*` and `/shift-change-requests*` when it is off). An employee asks to work ANOTHER shift (CHANGE) or a
 * SECOND shift (ADDITIONAL — a double shift, which also needs `advanced_scheduling`) on a range of days, from today up to
 * SHIFT_CHANGE_AHEAD_DAYS ahead and at most SHIFT_CHANGE_MAX_DAYS long. The request is routed like a swap (SHIFT_CHANGE
 * workflow, else the line manager with the secondary standing in) and applied on approval (shift-change-effects.ts).
 *
 * The caller is always their own employee record (`portalSelf`), never an id from the client. The rows are written by the
 * system step only (the table grants clients no write); reads go through the caller's RLS (own rows, attendance.view by
 * branch, the line manager's team).
 */

const CHANGE_KEYS = ['shift.request_change'] as const;
const LIST_KEYS = ['shift.request_change', 'attendance.view_own'] as const;

const issue = (path: string, message: string) => ({ issues: [{ path, message }] });
/** The contract checks the YYYY-MM-DD shape; a day that does not exist (2026-02-30) is refused here, before any date arithmetic. */
function assertCalendarDate(value: string, path: string): void {
  if (!DateTime.fromISO(value, { zone: 'utc' }).isValid) throw errors.validation('This date does not exist.', issue(path, 'Invalid date'));
}

/** GET /me/shift-changes/options?date — the active shifts one may ask for and the shift the caller works on `date`. */
export async function getShiftChangeOptions(deps: ApiDeps, actor: Actor, orgId: string, q: { date: string }): Promise<ShiftChangeOptionsDto> {
  const self = portalSelf(actor, orgId, ...CHANGE_KEYS);
  assertCalendarDate(q.date, 'date');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const [day] = await resolveDays(trx, orgId, emp, q.date, q.date);
    const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('shifts').select(['id', 'code', 'name', 'nameAr', 'type', 'startTime', 'endTime', 'requiredMinutes', 'graceInMinutes', 'crossesMidnight', 'color', 'breaks'])
      .where('organizationId', '=', orgId).where('status', '=', 'active').orderBy('name').orderBy('id').limit(200).execute());
    const shifts = rows.map((r) => {
      const s = toShiftSummary({ ...r, code: String(r.code) });
      return { id: s.id, code: s.code, name: s.name, nameAr: r.nameAr, type: s.type, startTime: s.startTime, endTime: s.endTime, crossesMidnight: s.crossesMidnight, color: s.color };
    });
    const current = day
      ? { date: day.date, shift: day.shift, source: day.source, isOff: day.isOff, holidayName: day.holidayName, onLeave: day.onLeave }
      : { date: q.date, shift: null, source: 'NONE' as const, isOff: false, holidayName: null, onLeave: false };
    return { date: q.date, current, shifts };
  });
}

/** GET /me/shift-changes — the caller's own requests (RLS: own rows), newest range first. */
export async function listMyShiftChanges(deps: ApiDeps, actor: Actor, orgId: string, q: { status?: ShiftChangeStatus | undefined }): Promise<ShiftChangeRequestDto[]> {
  const self = portalSelf(actor, orgId, ...LIST_KEYS);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('shiftChangeRequests').select(SHIFT_CHANGE_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', self.employeeId);
    if (q.status) base = base.where('status', '=', q.status);
    const rows = (await base.orderBy('fromDate', 'desc').orderBy('createdAt', 'desc').limit(200).execute()) as ShiftChangeRow[];
    return shiftChangeDtos(trx, orgId, rows, self.employeeId);
  });
}

/** POST /me/shift-changes — validate, record (system step), route to the approval engine. */
export async function requestShiftChange(deps: ApiDeps, actor: Actor, orgId: string, input: SelfShiftChangeInput): Promise<ShiftChangeRequestDto> {
  const self = portalSelf(actor, orgId, ...CHANGE_KEYS);
  assertCalendarDate(input.fromDate, 'fromDate');
  assertCalendarDate(input.toDate, 'toDate');
  const kind: ShiftChangeKind = input.kind;
  // a double shift is part of round-the-clock scheduling as well (the route itself is gated on shift_requests)
  if (kind === 'ADDITIONAL') requireModuleFor(actor.disabledModules, orgId, 'advanced_scheduling');
  return runUser(deps.db, actor, async (trx) => {
    // one writer per employee: two requests filed at once cannot both pass the overlap check
    await lockEmployee(trx, 'shift-change', self.employeeId);
    const emp = await loadEmployeeCtx(trx, orgId, self.employeeId);
    const today = localInstant(new Date(), emp.timezone).date;
    if (!isWorking(emp, today)) throw errors.forbidden('Your employment is not active.');
    const { fromDate: from, toDate: to } = input;
    if (to < from) throw errors.validation('The last day cannot be before the first day.', issue('toDate', 'Before the first day'));
    if (from < today) throw errors.validation('A shift change can only be requested from today onwards.', issue('fromDate', 'In the past'));
    if (from > addDays(today, SHIFT_CHANGE_AHEAD_DAYS)) throw errors.validation(`A shift change can be requested at most ${SHIFT_CHANGE_AHEAD_DAYS} days ahead.`, issue('fromDate', 'Too far ahead'));
    // the span is checked before any day is enumerated (an absurd last day must cost nothing)
    if (to > addDays(from, SHIFT_CHANGE_MAX_DAYS - 1)) throw errors.validation(`One request covers at most ${SHIFT_CHANGE_MAX_DAYS} days.`, issue('toDate', 'Range too long'));
    const dates = eachDate(from, to);
    if (from < emp.joiningDate) throw errors.validation('The range starts before your joining date.', issue('fromDate', 'Before joining date'));
    if (!isWorking(emp, to)) throw errors.validation('Your employment ends before the last day of the range.', issue('toDate', 'After your last working day'));

    const requested = (await loadEngineShifts(trx, orgId, [input.shiftId])).get(input.shiftId);
    if (!requested || requested.status !== 'active') throw errors.validation('Choose an active shift of the organisation.', issue('shiftId', 'Unknown or inactive shift'));
    if (kind === 'ADDITIONAL' && requested.engine.type !== 'FIXED') throw errors.validation('Only a fixed shift can be worked as an additional shift.', { reason: 'DOUBLE_SHIFT_CONFLICT', conflicts: [], ...issue('shiftId', 'NOT_FIXED') });

    const days = await resolveDays(trx, orgId, emp, from, to);
    const working = days.filter(worksShift);
    if (working.length === 0) throw errors.validation('You have no working day in this range (days off, holidays or leave).', issue('fromDate', 'No working day'));
    if (kind === 'CHANGE' && working.every((d) => d.shiftId === requested.id)) throw errors.validation('You already work this shift on every working day of the range.', issue('shiftId', 'Same shift'));
    if (kind === 'ADDITIONAL') {
      const shifts = await loadEngineShifts(trx, orgId, working.map((d) => d.shiftId!));
      const conflicts = additionalConflicts(working, requested.engine, shifts);
      if (conflicts.length) throw compositionError(conflicts);
    }

    // one waiting request of a kind per employee and day (the exclusion constraint is the backstop)
    const clash = await withSystemScope(trx, orgId, (t) => t.selectFrom('shiftChangeRequests').select(['id', 'fromDate', 'toDate']).where('organizationId', '=', orgId).where('employeeId', '=', emp.id)
      .where('kind', '=', kind).where('status', '=', 'pending').where('fromDate', '<=', dv(to)).where('toDate', '>=', dv(from)).executeTakeFirst());
    if (clash) throw errors.conflict('A request of this kind for some of these days is already waiting for a decision.', { shiftChangeRequestId: clash.id, reason: 'PENDING_OVERLAP' });
    // a change of shift would overwrite the day of a swap (pending or approved): the swap is settled first
    if (kind === 'CHANGE') {
      const swap = await swapInRange(trx, orgId, emp.id, from, to, ['pending', 'approved']);
      if (swap) throw errors.conflict(`You have a shift swap on ${swap.date} (${swap.status}); choose other days or withdraw the swap first.`, { reason: 'SWAP_IN_RANGE', swapId: swap.id, date: swap.date });
    }
    const locked = await firstLockedDate(trx, orgId, emp, from, to);
    if (locked) throw errors.periodLocked(`The attendance period of ${locked} is locked.`);

    const branchId = (await withSystemScope(trx, orgId, (t) => effectiveBranchIdOn(t, orgId, emp.id, from))) ?? emp.branchId;
    const first = days[0];
    const row = await systemStep(trx, orgId, (t) => t.insertInto('shiftChangeRequests').values({
      organizationId: orgId, employeeId: emp.id, branchId, kind, fromDate: from, toDate: to, requestedShiftId: requested.id, currentShiftId: first?.shiftId ?? null,
      reason: input.reason, status: 'pending', createdBy: actor.userId,
    }).returning('id').executeTakeFirstOrThrow()).catch((err: unknown) => {
      if ((err as { code?: string })?.code === '23P01') throw errors.conflict('A request of this kind for some of these days is already waiting for a decision.', { reason: 'PENDING_OVERLAP' });
      throw err;
    });
    // workflow tiers (min_units) compare the number of days asked for
    const submitted = await submit(deps, trx, actor, orgId, { entityType: 'SHIFT_CHANGE', entityId: row.id, employeeId: emp.id, branchId, departmentId: emp.departmentId, units: dates.length, requestedBy: actor.userId, noWorkflow: { kind: 'MANAGER' } });
    await systemStep(trx, orgId, async (t) => {
      await seatSecondaryManager(t, actor, orgId, { requestId: submitted.requestId, entityType: 'SHIFT_CHANGE', entityId: row.id, employeeId: emp.id, secondaryManagerEmployeeId: emp.secondaryManagerEmployeeId, employeeName: emp.displayName });
      await t.updateTable('shiftChangeRequests').set({ approvalRequestId: submitted.requestId }).where('id', '=', row.id).execute();
    });
    await audit(trx, actor, orgId, 'shift.change_requested', 'shift_change_request', { entityId: row.id, branchId, newValue: { ...input, kind, days: dates.length, currentShiftId: first?.shiftId ?? null } });
    const saved = (await withSystemScope(trx, orgId, (t) => loadShiftChange(t, orgId, row.id)))!;
    return (await shiftChangeDtos(trx, orgId, [saved], emp.id))[0]!;
  });
}

/** POST /me/shift-changes/:id/cancel — the requester withdraws a pending request. */
export async function cancelMyShiftChange(deps: ApiDeps, actor: Actor, orgId: string, id: string, reason?: string): Promise<ShiftChangeRequestDto> {
  const self = portalSelf(actor, orgId, ...CHANGE_KEYS);
  const why = reason && reason.trim().length >= 3 ? reason.trim() : 'Withdrawn by the employee';
  return runUser(deps.db, actor, async (trx) => {
    await lockEmployee(trx, 'shift-change', self.employeeId);
    const before = await withSystemScope(trx, orgId, (t) => loadShiftChange(t, orgId, id));
    if (!before || before.employeeId !== self.employeeId) throw errors.notFound('Shift change request', id);
    if (before.status !== 'pending') throw errors.invalidState(`Only a pending request can be withdrawn (current: ${before.status}).`);
    await systemStep(trx, orgId, async (t) => {
      const res = await t.updateTable('shiftChangeRequests').set({ status: 'cancelled', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: why }).where('id', '=', id).where('status', '=', 'pending').executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw errors.conflict('The request changed meanwhile. Please refresh.');
      await cancelForEntity(deps, t, actor, orgId, 'SHIFT_CHANGE', id, why, { source: 'self_service' });
    });
    await audit(trx, actor, orgId, 'shift.change_withdrawn', 'shift_change_request', { entityId: id, branchId: before.branchId, reason: why });
    return (await shiftChangeDtos(trx, orgId, [(await withSystemScope(trx, orgId, (t) => loadShiftChange(t, orgId, id)))!], self.employeeId))[0]!;
  });
}

export type ShiftChangeListQuery = z.infer<typeof shiftChangeListQuerySchema>;

/**
 * GET /shift-change-requests — HR (attendance.view, branch scope) or a line manager (attendance.view_team: their team) lists the
 * requests; the rows are read under the caller's RLS, which decides which ones each key reveals. Decisions are taken in the
 * approvals inbox. Waiting requests first, then the latest ranges.
 */
export async function listShiftChangeRequests(deps: ApiDeps, actor: Actor, orgId: string, q: ShiftChangeListQuery): Promise<{ data: ShiftChangeRequestDto[]; total: number }> {
  const grant = requireAnyPermission(actor.principal, orgId, 'attendance.view', 'attendance.view_team');
  const branches = q.branchId ? branchFilter(grant, q.branchId) : null;
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('shiftChangeRequests as r').where('r.organizationId', '=', orgId);
    if (q.status) base = base.where('r.status', '=', q.status);
    if (q.kind) base = base.where('r.kind', '=', q.kind);
    if (q.employeeId) base = base.where('r.employeeId', '=', q.employeeId);
    if (branches) base = base.where('r.branchId', 'in', branches);
    // requests whose range touches [from, to]
    if (q.from) base = base.where('r.toDate', '>=', dv(q.from));
    if (q.to) base = base.where('r.fromDate', '<=', dv(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(SHIFT_CHANGE_COLUMNS.map((c) => `r.${c}` as const)).orderBy(sql`(r.status = 'pending')`, 'desc').orderBy('r.fromDate', 'desc').orderBy('r.createdAt', 'desc').orderBy('r.id')
      .limit(page.pageSize).offset(page.offset).execute()) as unknown as ShiftChangeRow[];
    return { data: await shiftChangeDtos(trx, orgId, rows, grant.employeeId ?? null), total };
  });
}

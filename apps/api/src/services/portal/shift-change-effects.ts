import { sql } from 'kysely';
import type { ApprovalContextDto, ApprovalRequestStatus, ShiftChangeKind, ShiftChangeRequestDto, ShiftChangeStatus } from '@flowza/contracts';
import { enqueueRecompute, toEngineShift, writeAudit, type Trx } from '@flowza/database';
import { composeDoubleShift, type DoubleShiftRefusal, type EngineShift } from '@flowza/domain';
import { addDays, eachDate, errors, type AppError } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { withSystemScope } from '../../lib/service.js';
import { requireModuleFor } from '../../middleware/module-gate.js';
import type { HookContext } from '../approvals/hooks/index.js';
import { orgToday } from '../features/recalc.js';
import { isWorking, loadEmployeeCtx, type EmployeeCtx } from './common.js';
import { placeAdditionalShiftRange, placeEmployeeShiftRange, runsOf, type TouchedRow } from './assignment-split.js';
import { resolveDays, worksShift, type ResolvedDay } from './shift-resolve.js';

/**
 * Shift change requests (Enterprise, module `shift_requests`; docs/enterprise/plan.md §6, §9): what the request IS (row,
 * DTO, inbox context), the checks shared by filing and approval, and what an approval DOES.
 *
 *  - CHANGE: the employee works the requested shift on every day of the range — EMPLOYEE shift assignments written by the
 *    range helper (assignment-split.ts), which trims / splits the employee's own assignments around them. A rotation pattern's
 *    REST days inside the range are left to the rotation (the range is applied in runs around them), so a change never turns
 *    a rest day into a working day; without such rest days (the usual case) it is ONE assignment for the whole range.
 *  - ADDITIONAL: the employee works the requested shift AS WELL (a double shift) — one additional shift assignment for the
 *    range; the engine input combines it with the day's shift (composeDoubleShift). Needs `advanced_scheduling` too.
 *
 * Before anything is written the request is re-validated (the shift is still active, no day is in a locked period, an
 * ADDITIONAL shift still combines with every working day): when something changed the decision is refused (409) and the
 * request stays open. The engine first asks `shiftChangeApprovalBlocker` whether the employee is still employed on the first
 * day: when not, the request is rejected by the system with that reason. Days up to today are recomputed (SHIFT_CHANGE).
 * Runs inside the engine's system step; never imports the engine.
 */

export type ShiftChangeRow = {
  id: string; organizationId: string; employeeId: string; branchId: string | null; kind: ShiftChangeKind; fromDate: Date | string; toDate: Date | string;
  requestedShiftId: string; currentShiftId: string | null; reason: string; status: ShiftChangeStatus; approvalRequestId: string | null; appliedAssignmentIds: string[];
  decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null; createdBy: string | null; createdAt: Date; updatedAt: Date;
};
export const SHIFT_CHANGE_COLUMNS = ['id', 'organizationId', 'employeeId', 'branchId', 'kind', 'fromDate', 'toDate', 'requestedShiftId', 'currentShiftId', 'reason', 'status', 'approvalRequestId', 'appliedAssignmentIds', 'decidedBy', 'decidedAt', 'decisionNote', 'createdBy', 'createdAt', 'updatedAt'] as const;

export async function loadShiftChange(t: Trx, orgId: string, id: string): Promise<ShiftChangeRow | undefined> {
  return (await t.selectFrom('shiftChangeRequests').select(SHIFT_CHANGE_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst()) as ShiftChangeRow | undefined;
}

/** DTOs of rows the caller may already read (names, shifts and request states are read in the organisation's system scope). */
export async function shiftChangeDtos(trx: Trx, orgId: string, rows: readonly ShiftChangeRow[], callerEmployeeId: string | null): Promise<ShiftChangeRequestDto[]> {
  if (rows.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
    const shiftIds = [...new Set(rows.flatMap((r) => [r.requestedShiftId, r.currentShiftId]).filter((x): x is string => !!x))];
    const requestIds = [...new Set(rows.map((r) => r.approvalRequestId).filter((x): x is string => !!x))];
    const [employees, shifts, requests] = await Promise.all([
      t.selectFrom('employees').select(['id', 'displayName', 'employeeNumber']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).execute(),
      shiftIds.length ? t.selectFrom('shifts').select(['id', 'code', 'name', 'startTime', 'endTime']).where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute() : Promise.resolve([]),
      requestIds.length ? t.selectFrom('approvalRequests').select(['id', 'status']).where('organizationId', '=', orgId).where('id', 'in', requestIds).execute() : Promise.resolve([]),
    ]);
    const empOf = new Map(employees.map((e) => [e.id, e]));
    const shiftOf = new Map(shifts.map((s) => [s.id, s]));
    const statusOf = new Map(requests.map((r) => [r.id, r.status as ApprovalRequestStatus]));
    const hhmm = (v: string | null) => (v === null ? null : v.slice(0, 5));
    return rows.map((r): ShiftChangeRequestDto => {
      const emp = empOf.get(r.employeeId); const req = shiftOf.get(r.requestedShiftId); const cur = r.currentShiftId ? shiftOf.get(r.currentShiftId) : undefined;
      return {
        id: r.id, kind: r.kind, status: r.status, employeeId: r.employeeId, employeeName: emp?.displayName ?? null, employeeNumber: emp?.employeeNumber ?? null, branchId: r.branchId,
        fromDate: isoDate(r.fromDate), toDate: isoDate(r.toDate),
        requestedShift: req ? { id: req.id, code: req.code, name: req.name, startTime: hhmm(req.startTime), endTime: hhmm(req.endTime) } : null,
        currentShift: cur ? { id: cur.id, code: cur.code, name: cur.name } : null,
        reason: r.reason, mine: !!callerEmployeeId && r.employeeId === callerEmployeeId,
        approvalRequestId: r.approvalRequestId, approvalStatus: r.approvalRequestId ? statusOf.get(r.approvalRequestId) ?? null : null,
        appliedAssignmentIds: r.appliedAssignmentIds ?? [], decidedAt: isoDateTimeOrNull(r.decidedAt), decisionNote: r.decisionNote, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt),
      };
    });
  });
}

// ----- the checks shared by filing and approval -----------------------------------------------------------------------------------

export type RequestableShift = { id: string; code: string; name: string; status: string; engine: EngineShift };

/** A shift of the organisation with the fields the engine composes (system scope: an employee's role cannot read shifts). */
export async function loadEngineShifts(trx: Trx, orgId: string, ids: readonly string[]): Promise<Map<string, RequestableShift>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('shifts')
    .select(['id', 'code', 'name', 'status', 'type', 'startTime', 'endTime', 'requiredMinutes', 'coreStart', 'coreEnd', 'dayBoundary', 'breaks', 'punchInWindowBeforeMinutes', 'punchOutWindowAfterMinutes', 'graceInMinutes', 'graceOutMinutes'])
    .where('organizationId', '=', orgId).where('id', 'in', unique).execute());
  return new Map(rows.map((r) => [r.id, { id: r.id, code: String(r.code), name: r.name, status: String(r.status), engine: toEngineShift({ ...r, type: r.type === 'FLEXIBLE' ? 'FLEXIBLE' : 'FIXED' }) }]));
}

export interface CompositionConflict { date: string; reason: DoubleShiftRefusal }

/** Every working day of the range on which the additional shift cannot be combined with the day's shift (composeDoubleShift). */
export function additionalConflicts(days: readonly ResolvedDay[], requested: EngineShift, shifts: ReadonlyMap<string, RequestableShift>): CompositionConflict[] {
  const out: CompositionConflict[] = [];
  for (const d of days) {
    if (!worksShift(d)) continue;
    const primary = shifts.get(d.shiftId!)?.engine;
    if (!primary) continue;
    const composed = composeDoubleShift(primary, requested);
    if (!composed.ok) out.push({ date: d.date, reason: composed.reason });
  }
  return out;
}

const REFUSAL_TEXT: Record<DoubleShiftRefusal, string> = {
  OVERLAP: 'the two shifts overlap',
  NOT_FIXED: 'a flexible shift cannot be combined',
  TOO_LONG: 'the two shifts together last 24 hours or more',
  SAME_SHIFT: 'it is the shift you already work',
};
/** The validation error that lists the first conflicting dates and why. */
export function compositionError(conflicts: readonly CompositionConflict[], status: 'validation' | 'state' = 'validation'): AppError {
  const first = conflicts.slice(0, 5);
  const list = first.map((c) => `${c.date} (${REFUSAL_TEXT[c.reason]})`).join(', ');
  const more = conflicts.length > first.length ? ` and ${conflicts.length - first.length} more day(s)` : '';
  const message = `The additional shift cannot be worked together with the shift of ${list}${more}.`;
  const details = { reason: 'DOUBLE_SHIFT_CONFLICT', conflicts: first, conflictCount: conflicts.length, issues: [{ path: 'shiftId', message: first.map((c) => `${c.date}: ${c.reason}`).join('; ') }] };
  return status === 'validation' ? errors.validation(message, details) : errors.invalidState(message, details);
}

/** The first day of [from, to] inside a locked attendance period, with the branch each day belonged to (employment history). */
export async function firstLockedDate(trx: Trx, orgId: string, emp: Pick<EmployeeCtx, 'id' | 'branchId'>, from: string, to: string): Promise<string | null> {
  const res = await withSystemScope(trx, orgId, (t) => sql<{ date: string }>`
    select to_char(d::date, 'YYYY-MM-DD') as date
    from generate_series(${from}::date, ${to}::date, interval '1 day') as d
    where app.is_period_locked(${orgId}::uuid, coalesce((
      select h.branch_id from public.employment_history h
      where h.organization_id = ${orgId}::uuid and h.employee_id = ${emp.id}::uuid and h.effective_from <= d::date and (h.effective_to is null or h.effective_to > d::date)
      order by h.effective_from desc limit 1), ${emp.branchId}::uuid), d::date)
    order by d limit 1`.execute(t));
  return res.rows[0]?.date ?? null;
}

/**
 * The first shift swap of the employee (as either party) on a day of [from, to] with one of `statuses`. A CHANGE writes the
 * employee's shift for the whole range, so it would silently overwrite the one-day assignment of an approved swap: such days are
 * refused (filing: pending or approved swaps; approval: approved ones — a pending swap re-validates its shifts itself).
 */
export async function swapInRange(trx: Trx, orgId: string, employeeId: string, from: string, to: string, statuses: ReadonlyArray<'pending' | 'approved'>): Promise<{ id: string; date: string; status: string } | null> {
  const row = await withSystemScope(trx, orgId, (t) => t.selectFrom('shiftSwapRequests').select(['id', 'swapDate', 'status']).where('organizationId', '=', orgId)
    .where((eb) => eb.or([eb('requesterEmployeeId', '=', employeeId), eb('targetEmployeeId', '=', employeeId)]))
    .where('status', 'in', [...statuses]).where('swapDate', '>=', sql<Date>`${from}::date`).where('swapDate', '<=', sql<Date>`${to}::date`).orderBy('swapDate').executeTakeFirst());
  return row ? { id: row.id, date: isoDate(row.swapDate), status: String(row.status) } : null;
}

/** A rotation pattern's rest day: the pattern resolved and says "off" (a CHANGE leaves it to the rotation). */
export const isPatternRestDay = (d: ResolvedDay): boolean => d.source === 'PATTERN' && !d.shiftId;

// ----- what the approval does --------------------------------------------------------------------------------------------------

/**
 * Why a pending change can no longer be approved, asked by the engine before an approval is recorded: the employee must still
 * be employed on the first day of the range (not terminated / resigned, no exit date before it, record not removed). A reason
 * makes the engine reject the request BY THE SYSTEM with it.
 */
export async function shiftChangeApprovalBlocker(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId'>): Promise<string | null> {
  const row = await loadShiftChange(t, ctx.orgId, ctx.entityId);
  if (!row || row.status !== 'pending') return null;
  const from = isoDate(row.fromDate);
  const emp = await loadEmployeeCtx(t, ctx.orgId, row.employeeId).catch(() => null);
  if (!emp) return 'The employee who asked for the change is no longer an employee of the organisation.';
  if (!isWorking(emp, from)) return `${emp.displayName} is no longer employed on ${from}, so the shift change cannot be applied.`;
  return null;
}

export async function applyShiftChangeApproval(deps: ApiDeps, t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment' | 'auto'>): Promise<void> {
  const row = await loadShiftChange(t, ctx.orgId, ctx.entityId);
  if (!row || row.status !== 'pending') return;
  // the modules decide whether a change may still be APPLIED (a pending request can always be rejected or withdrawn)
  requireModuleFor(ctx.actor.disabledModules, ctx.orgId, 'shift_requests');
  if (row.kind === 'ADDITIONAL') requireModuleFor(ctx.actor.disabledModules, ctx.orgId, 'advanced_scheduling');
  const from = isoDate(row.fromDate); const to = isoDate(row.toDate);
  const emp = await loadEmployeeCtx(t, ctx.orgId, row.employeeId);
  const requested = (await loadEngineShifts(t, ctx.orgId, [row.requestedShiftId])).get(row.requestedShiftId);
  if (!requested || requested.status !== 'active') throw errors.invalidState('The requested shift is no longer active; reject the request and ask for another shift.', { reason: 'SHIFT_INACTIVE' });
  if (row.kind === 'ADDITIONAL' && requested.engine.type !== 'FIXED') throw errors.invalidState('The requested shift is no longer a fixed shift, so it cannot be worked as an additional shift.', { reason: 'SHIFT_NOT_FIXED' });
  const locked = await firstLockedDate(t, ctx.orgId, emp, from, to);
  if (locked) throw errors.periodLocked(`The attendance period of ${locked} is locked; the change cannot be applied.`);
  if (row.kind === 'CHANGE') {
    const swap = await swapInRange(t, ctx.orgId, emp.id, from, to, ['approved']);
    if (swap) throw errors.invalidState(`A shift swap was approved for ${swap.date} since the request was made; reject the request and ask for a new range.`, { reason: 'SWAP_IN_RANGE', swapId: swap.id, date: swap.date });
  }
  const days = await resolveDays(t, ctx.orgId, emp, from, to);
  if (!days.some(worksShift)) throw errors.invalidState('The employee no longer works a shift on any day of this range; reject the request.', { reason: 'NO_WORKING_DAY' });
  if (row.kind === 'ADDITIONAL') {
    const shifts = await loadEngineShifts(t, ctx.orgId, days.map((d) => d.shiftId).filter((x): x is string => !!x));
    const conflicts = additionalConflicts(days, requested.engine, shifts);
    if (conflicts.length) throw compositionError(conflicts, 'state');
  }

  const applied: string[] = []; const touched: TouchedRow[] = [];
  const placement = { employeeId: emp.id, branchId: emp.branchId, shiftId: requested.id, actorUserId: ctx.actor.userId };
  if (row.kind === 'CHANGE') {
    const restDays = new Set(days.filter(isPatternRestDay).map((d) => d.date));
    for (const run of runsOf(eachDate(from, to), (d) => !restDays.has(d), (d) => addDays(d, 1))) {
      const placed = await placeEmployeeShiftRange(t, ctx.orgId, { ...placement, from: run.from, toExclusive: addDays(run.to, 1) });
      applied.push(placed.id); touched.push(...placed.touched);
    }
  } else {
    const placed = await placeAdditionalShiftRange(t, ctx.orgId, { ...placement, from, toExclusive: addDays(to, 1), shiftChangeRequestId: row.id });
    applied.push(placed.id); touched.push(...placed.touched);
  }
  await t.updateTable('shiftChangeRequests').set({ status: 'approved', appliedAssignmentIds: applied, decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment })
    .where('id', '=', row.id).where('status', '=', 'pending').execute();
  await writeAudit(t, {
    organizationId: ctx.orgId, actorUserId: ctx.actor.userId, action: 'shift.change_applied', entityType: 'shift_change_request', entityId: row.id, branchId: row.branchId,
    newValue: { kind: row.kind, fromDate: from, toDate: to, shiftId: requested.id, appliedAssignmentIds: applied, touched }, requestId: ctx.actor.requestId,
  });
  // the days already lived are recalculated at once (future days are calculated when they come)
  const today = await orgToday(t, ctx.orgId);
  if (from <= today) {
    for (const date of eachDate(from, to < today ? to : today)) {
      await enqueueRecompute(deps.queue, { organizationId: ctx.orgId, employeeId: emp.id, date, reason: 'SHIFT_CHANGE', triggeredBy: ctx.actor.userId, correlationId: ctx.actor.requestId }, t);
    }
  }
}

export async function applyShiftChangeClosed(t: Trx, ctx: Pick<HookContext, 'orgId' | 'entityId' | 'actor' | 'comment' | 'system'>, status: 'rejected' | 'cancelled'): Promise<void> {
  // a system rejection has no decider: the note carries the system's reason
  await t.updateTable('shiftChangeRequests').set({ status, decidedBy: ctx.system ? null : ctx.actor.userId, decidedAt: new Date(), decisionNote: ctx.comment })
    .where('organizationId', '=', ctx.orgId).where('id', '=', ctx.entityId).where('status', '=', 'pending').execute();
}

export async function shiftChangeContexts(t: Trx, orgId: string, ids: string[]): Promise<Map<string, ApprovalContextDto>> {
  const out = new Map<string, ApprovalContextDto>();
  if (ids.length === 0) return out;
  const rows = (await t.selectFrom('shiftChangeRequests').select(SHIFT_CHANGE_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as ShiftChangeRow[];
  if (rows.length === 0) return out;
  const employees = new Map((await t.selectFrom('employees').select(['id', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', [...new Set(rows.map((r) => r.employeeId))]).execute()).map((e) => [e.id, e.displayName]));
  const shiftIds = [...new Set(rows.flatMap((r) => [r.requestedShiftId, r.currentShiftId]).filter((x): x is string => !!x))];
  const shifts = new Map((await t.selectFrom('shifts').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', shiftIds).execute()).map((s) => [s.id, s.name]));
  for (const r of rows) {
    const from = isoDate(r.fromDate); const to = isoDate(r.toDate);
    const employeeName = employees.get(r.employeeId) ?? null;
    const requestedShiftName = shifts.get(r.requestedShiftId) ?? null;
    const currentShiftName = r.currentShiftId ? shifts.get(r.currentShiftId) ?? null : null;
    const range = from === to ? from : `${from} → ${to}`;
    const what = r.kind === 'ADDITIONAL' ? `+ ${requestedShiftName ?? ''}` : `${currentShiftName ?? '—'} → ${requestedShiftName ?? ''}`;
    out.set(r.id, { kind: 'SHIFT_CHANGE', summary: `${range} · ${employeeName ?? ''} · ${what}`, change: { id: r.id, kind: r.kind, fromDate: from, toDate: to, employeeName, requestedShiftName, currentShiftName, reason: r.reason, status: r.status } });
  }
  return out;
}

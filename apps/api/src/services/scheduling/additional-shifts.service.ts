import type { z } from 'zod';
import { ADDITIONAL_SHIFT_CHECK_DAYS, type AdditionalShiftAssignmentDto, type AdditionalShiftAssignmentInput, type AdditionalShiftConflictDetails, type AdditionalShiftRefusal, type additionalShiftAssignmentListQuerySchema } from '@flowza/contracts';
import { loadEmployeeWorkingCalendars, toEngineShift, type Trx } from '@flowza/database';
import { composeDoubleShift } from '@flowza/domain';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { isoDate, isoDateTime } from '../../lib/mappers.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { assignmentEndFromStored, assignmentEndToStored } from '../features/assignment-dates.js';
import { dv } from '../features/sql-helpers.js';
import { attendancePolicy } from '../portal/common.js';
import { datesFrom, minDate, recalcPastDays } from './common.js';

/*
 * Additional (double) shift assignments (Enterprise, `additional_shift_assignments`, docs/enterprise/plan.md §9): an employee
 * works a SECOND fixed shift on the dates of a range; the engine input combines it with the day's shift into one composite
 * day (packages/domain composeDoubleShift, folded in by packages/database load-inputs.ts).
 *
 * Reads `shift.view`, writes `shift.assign`, both inside the branch scope of the employee (RLS again on `branch_id`). The API
 * speaks of the INCLUSIVE last day; the table stores the exclusive bound (assignment-dates.ts).
 *
 * A new range (create, or the days an extension adds) is checked before it is written:
 *   - the additional shift is FIXED and active (a flexible shift has no position in the day to combine) → 422;
 *   - on every date of the range on which the employee works a shift (the per-date working calendar with the organisation's
 *     default shift; weekly offs, rotation off days and holidays are not worked) the two shifts form one day — no overlap,
 *     not the same shift, under 24 hours → 422 with the first conflicting dates; an open-ended range is checked over its
 *     first 92 days, a closed one over at most a year;
 *   - no other additional assignment of the employee overlaps → 409 (the exclusion constraint is the backstop).
 * Every write is audited and recalculates the employee's affected days up to today.
 */

type ListQuery = z.infer<typeof additionalShiftAssignmentListQuerySchema>;
type Row = {
  id: string; employeeId: string; branchId: string | null; shiftId: string; effectiveFrom: Date | string; effectiveTo: Date | string | null; shiftChangeRequestId: string | null; createdAt: Date;
  code: string; name: string; startTime: string | null; endTime: string | null; employeeName: string | null; employeeNumber: string | null;
};
const COLUMNS = ['a.id', 'a.employeeId', 'a.branchId', 'a.shiftId', 'a.effectiveFrom', 'a.effectiveTo', 'a.shiftChangeRequestId', 'a.createdAt', 's.code', 's.name', 's.startTime', 's.endTime', 'e.displayName as employeeName', 'e.employeeNumber'] as const;
const hhmm = (v: string | null) => (v === null ? null : v.slice(0, 5));
const toDto = (r: Row): AdditionalShiftAssignmentDto => ({
  id: r.id, employeeId: r.employeeId, employeeName: r.employeeName, employeeNumber: r.employeeNumber === null ? null : String(r.employeeNumber), branchId: r.branchId,
  shift: { id: r.shiftId, code: String(r.code), name: r.name, startTime: hhmm(r.startTime), endTime: hhmm(r.endTime) },
  effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: assignmentEndFromStored(r.effectiveTo), shiftChangeRequestId: r.shiftChangeRequestId, createdAt: isoDateTime(r.createdAt),
});
const baseQuery = (trx: Trx, orgId: string) => trx.selectFrom('additionalShiftAssignments as a').innerJoin('shifts as s', 's.id', 'a.shiftId').leftJoin('employees as e', 'e.id', 'a.employeeId').where('a.organizationId', '=', orgId);

async function loadRow(trx: Trx, orgId: string, id: string): Promise<Row> {
  const row = await baseQuery(trx, orgId).select(COLUMNS).where('a.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Additional shift assignment', id);
  return row as Row;
}

const REFUSAL_TEXT: Record<AdditionalShiftRefusal, string> = {
  SAME_SHIFT: 'it is the shift the employee already works that day',
  NOT_FIXED: 'only fixed shifts can be combined into one day',
  OVERLAP: 'the two shifts overlap',
  TOO_LONG: 'the two shifts together span 24 hours or more',
  INACTIVE: 'the shift is archived',
};

/** 422: the shift itself is refused (no dates), or the first conflicting dates (at most 10). */
function refuse(reason: AdditionalShiftRefusal, conflicts: AdditionalShiftConflictDetails['conflicts'] = []): never {
  const details: AdditionalShiftConflictDetails = { reason, conflicts: conflicts.slice(0, 10) };
  const first = conflicts[0];
  const message = first
    ? `The additional shift cannot be worked with the employee's shift on ${first.date}: ${REFUSAL_TEXT[first.reason]}.`
    : `This shift cannot be an additional shift: ${REFUSAL_TEXT[reason]}.`;
  throw errors.unprocessable(message, details as unknown as Record<string, unknown>);
}

type ShiftRow = Parameters<typeof toEngineShift>[0] & { status: string };
const SHIFT_COLUMNS = ['id', 'code', 'name', 'type', 'startTime', 'endTime', 'requiredMinutes', 'coreStart', 'coreEnd', 'dayBoundary', 'breaks', 'punchInWindowBeforeMinutes', 'punchOutWindowAfterMinutes', 'graceInMinutes', 'graceOutMinutes', 'status'] as const;

/** The additional shift itself: known, FIXED and active (422 otherwise). */
async function loadAdditionalShift(trx: Trx, orgId: string, shiftId: string): Promise<ShiftRow> {
  const shift = (await trx.selectFrom('shifts').select(SHIFT_COLUMNS).where('organizationId', '=', orgId).where('id', '=', shiftId).executeTakeFirst()) as ShiftRow | undefined;
  if (!shift) throw errors.validation('Shift not found.', { issues: [{ path: 'shiftId', message: 'Unknown shift' }] });
  if (shift.type !== 'FIXED') refuse('NOT_FIXED');
  if (shift.status !== 'active') refuse('INACTIVE');
  return shift;
}

/**
 * Every date of [from, last] (inclusive; `last` null = open-ended, checked over ADDITIONAL_SHIFT_CHECK_DAYS days; a closed
 * range over at most 366) on which the employee works a shift that cannot be combined with `additional`. System scope: the
 * employee was authorised first, and their calendar (history, assignments, settings) is not readable by every shift role.
 */
async function compositionConflicts(trx: Trx, orgId: string, employeeId: string, additional: ShiftRow, from: string, last: string | null): Promise<AdditionalShiftConflictDetails['conflicts']> {
  const dates = last === null ? datesFrom(from, addDays(from, ADDITIONAL_SHIFT_CHECK_DAYS - 1), ADDITIONAL_SHIFT_CHECK_DAYS) : datesFrom(from, last, 366);
  if (dates.length === 0) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const [{ calendars }, settings] = await Promise.all([loadEmployeeWorkingCalendars(t, orgId, [employeeId], { from: dates[0]!, to: dates[dates.length - 1]! }), attendancePolicy(t, orgId)]);
    const cal = calendars.get(employeeId);
    if (!cal) return [];
    const defaultShiftId = settings.defaultShiftId ?? null;
    const primaryOn = new Map<string, string>();
    for (const date of dates) {
      const day = cal.day(date);
      const primary = day.shift.shiftId ?? (day.shift.isPatternOff ? null : defaultShiftId);
      if (primary && !day.off) primaryOn.set(date, primary);
    }
    const ids = [...new Set(primaryOn.values())];
    const rows = ids.length ? ((await t.selectFrom('shifts').select(SHIFT_COLUMNS).where('organizationId', '=', orgId).where('id', 'in', ids).execute()) as ShiftRow[]) : [];
    const byId = new Map(rows.map((r) => [r.id, toEngineShift(r)]));
    const extra = toEngineShift(additional);
    const conflicts: AdditionalShiftConflictDetails['conflicts'] = [];
    for (const [date, primaryId] of primaryOn) {
      const primary = byId.get(primaryId);
      if (!primary) continue; // an unknown (deleted) default shift: the engine treats the day as having none
      const res = composeDoubleShift(primary, extra);
      if (!res.ok) conflicts.push({ date, reason: res.reason, shiftId: primaryId });
    }
    return conflicts;
  });
}

/** Another additional assignment of the employee overlapping [from, last] (inclusive; null = open-ended). */
async function overlapping(trx: Trx, orgId: string, employeeId: string, from: string, last: string | null, exceptId?: string): Promise<string | null> {
  let q = trx.selectFrom('additionalShiftAssignments').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId)
    .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(from))]));
  if (last !== null) q = q.where('effectiveFrom', '<=', dv(last));
  if (exceptId) q = q.where('id', '!=', exceptId);
  return (await q.executeTakeFirst())?.id ?? null;
}
const overlapError = (id: string) => errors.conflict('The employee already has an additional shift on some of these days: end or change it first.', { conflictingId: id });

export async function listAdditionalShifts(deps: ApiDeps, actor: Actor, orgId: string, q: ListQuery & { search?: string }): Promise<{ data: AdditionalShiftAssignmentDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = baseQuery(trx, orgId);
    if (scope) base = base.where('a.branchId', 'in', scope);
    if (q.employeeId) base = base.where('a.employeeId', '=', q.employeeId);
    if (q.shiftId) base = base.where('a.shiftId', '=', q.shiftId);
    if (q.activeOn) base = base.where('a.effectiveFrom', '<=', dv(q.activeOn)).where((eb) => eb.or([eb('a.effectiveTo', 'is', null), eb('a.effectiveTo', '>', dv(q.activeOn!))]));
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.employeeNumber', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(COLUMNS).orderBy('a.effectiveFrom', 'desc').orderBy('a.createdAt', 'desc').orderBy('a.id').limit(page.pageSize).offset(page.offset).execute()) as Row[];
    return { data: rows.map(toDto), total };
  });
}

export async function createAdditionalShift(deps: ApiDeps, actor: Actor, orgId: string, input: AdditionalShiftAssignmentInput): Promise<AdditionalShiftAssignmentDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    // read in system scope so an employee of another branch answers 403 (outside your scope), not "unknown"
    const emp = await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', '=', input.employeeId).where('deletedAt', 'is', null).executeTakeFirst());
    if (!emp) throw errors.validation('Employee not found.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
    requireBranchAccess(grant, emp.branchId);
    const last = input.effectiveTo ?? null;
    if (last !== null && last < input.effectiveFrom) throw errors.validation('The last day cannot be before the first day.', { issues: [{ path: 'effectiveTo', message: 'Before the first day' }] });
    const shift = await loadAdditionalShift(trx, orgId, input.shiftId);
    const clash = await overlapping(trx, orgId, emp.id, input.effectiveFrom, last);
    if (clash) throw overlapError(clash);
    const conflicts = await compositionConflicts(trx, orgId, emp.id, shift, input.effectiveFrom, last);
    if (conflicts.length) refuse(conflicts[0]!.reason, conflicts);
    const row = await trx.insertInto('additionalShiftAssignments').values({ organizationId: orgId, employeeId: emp.id, branchId: emp.branchId, shiftId: shift.id, effectiveFrom: input.effectiveFrom, effectiveTo: assignmentEndToStored(last), createdBy: actor.userId })
      .returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'shift.additional_assigned', 'additional_shift_assignment', { entityId: row.id, branchId: emp.branchId, newValue: { employeeId: emp.id, shiftId: shift.id, effectiveFrom: input.effectiveFrom, effectiveTo: last } });
    const recalculationJobId = await recalcPastDays(deps, trx, actor, orgId, input.effectiveFrom, last, { employeeIds: [emp.id], reason: `additional shift ${String(shift.code)} assigned` });
    return { ...toDto(await loadRow(trx, orgId, row.id)), recalculationJobId };
  });
}

/** End (or extend) an assignment: `effectiveTo` is the new inclusive last day, null = open-ended. The added days are checked. */
export async function updateAdditionalShift(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: { effectiveTo: string | null }): Promise<AdditionalShiftAssignmentDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    const from = isoDate(before.effectiveFrom);
    const oldLast = assignmentEndFromStored(before.effectiveTo);
    const newLast = input.effectiveTo;
    if (newLast !== null && newLast < from) throw errors.validation('The last day cannot be before the first day.', { issues: [{ path: 'effectiveTo', message: 'Before the first day' }] });
    if (oldLast === newLast) return { ...toDto(before), recalculationJobId: null };
    const extends_ = newLast === null || (oldLast !== null && newLast > oldLast);
    if (extends_ && oldLast !== null) {
      // the added days: [old last + 1, new last]
      const addedFrom = addDays(oldLast, 1);
      const clash = await overlapping(trx, orgId, before.employeeId, addedFrom, newLast, id);
      if (clash) throw overlapError(clash);
      const shift = await loadAdditionalShift(trx, orgId, before.shiftId);
      const conflicts = await compositionConflicts(trx, orgId, before.employeeId, shift, addedFrom, newLast);
      if (conflicts.length) refuse(conflicts[0]!.reason, conflicts);
    }
    await trx.updateTable('additionalShiftAssignments').set({ effectiveTo: assignmentEndToStored(newLast) }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.additional_updated', 'additional_shift_assignment', { entityId: id, branchId: before.branchId, oldValue: { effectiveTo: oldLast }, newValue: { effectiveTo: newLast } });
    // the first day whose shift changes: the day after the earlier of the two last days
    const changedFrom = addDays(oldLast !== null && newLast !== null ? minDate(oldLast, newLast) : (oldLast ?? newLast)!, 1);
    const recalculationJobId = await recalcPastDays(deps, trx, actor, orgId, changedFrom, null, { employeeIds: [before.employeeId], reason: 'additional shift end date changed' });
    return { ...toDto(await loadRow(trx, orgId, id)), recalculationJobId };
  });
}

export async function deleteAdditionalShift(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'shift.assign');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    await trx.deleteFrom('additionalShiftAssignments').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'shift.additional_removed', 'additional_shift_assignment', { entityId: id, branchId: before.branchId, oldValue: toDto(before) });
    const recalculationJobId = await recalcPastDays(deps, trx, actor, orgId, isoDate(before.effectiveFrom), assignmentEndFromStored(before.effectiveTo), { employeeIds: [before.employeeId], reason: 'additional shift removed' });
    return { recalculationJobId };
  });
}

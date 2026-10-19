import type { HourAllowanceDto, HourAllowanceInput, HourAllowanceKind, HourAllowancePosition, HourAllowanceUpdateInput, WithTimeOffRecalc } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { isoDate, isoDateOrNull, isoDateTime } from '../../lib/mappers.js';
import { dv } from '../features/sql-helpers.js';
import { loadLeaveEmployee } from '../leave/common.js';
import { recalcLeaveRange } from '../leave/lifecycle.js';
import { todayOf } from './common.js';

/**
 * Reduced hours (nursing hour, persons with disabilities) on the employee profile. Read with leave.view (the employee's branch
 * in scope; the employee reads their own in the portal), written with leave.manage — a leave entitlement HR's leave
 * administrators grant, not a change of the employee's master data (employee.update): the same people who record leave and
 * short leave, and the same key the leave tables and their RLS use. Every change recomputes the past days of the ranges it
 * touches (the engine shrinks the scheduled minutes on those days).
 */

const COLUMNS = ['id', 'employeeId', 'kind', 'minutesPerDay', 'position', 'validFrom', 'validTo', 'reference', 'notes', 'createdAt', 'updatedAt'] as const;
interface AllowanceRow { id: string; employeeId: string; kind: string; minutesPerDay: number; position: string; validFrom: Date | string; validTo: Date | string | null; reference: string | null; notes: string | null; createdAt: Date; updatedAt: Date }
function toDto(r: AllowanceRow, today: string): HourAllowanceDto {
  const validFrom = isoDate(r.validFrom); const validTo = isoDateOrNull(r.validTo);
  return {
    id: r.id, employeeId: r.employeeId, kind: r.kind as HourAllowanceKind, minutesPerDay: r.minutesPerDay, position: r.position as HourAllowancePosition, validFrom, validTo,
    reference: r.reference, notes: r.notes, createdAt: isoDateTime(r.createdAt), updatedAt: isoDateTime(r.updatedAt), active: validFrom <= today && (validTo === null || validTo >= today),
  };
}
async function rowsOf(trx: Trx, orgId: string, employeeId: string): Promise<AllowanceRow[]> {
  return (await trx.selectFrom('employeeHourAllowances').select(COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).orderBy('validFrom', 'desc').orderBy('id').execute()) as AllowanceRow[];
}
/** The employee's own allowances (portal: read under their RLS — the self policy of the table). */
export async function ownAllowances(trx: Trx, orgId: string, employeeId: string, today: string): Promise<HourAllowanceDto[]> {
  return (await rowsOf(trx, orgId, employeeId)).map((r) => toDto(r, today));
}

async function employeeInScope(trx: Trx, orgId: string, employeeId: string, grant: Parameters<typeof requireBranchAccess>[0]) {
  const emp = await loadLeaveEmployee(trx, orgId, employeeId);
  if (!emp) throw errors.notFound('Employee', employeeId);
  requireBranchAccess(grant, emp.branchId);
  return emp;
}
/** Another allowance of the same kind whose range shares a day → CONFLICT (the exclusion constraint is the backstop). */
async function assertNoOverlap(trx: Trx, orgId: string, employeeId: string, kind: string, from: string, to: string | null, excludeId?: string): Promise<void> {
  let q = trx.selectFrom('employeeHourAllowances').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('kind', '=', kind)
    .where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', dv(from))]));
  if (to) q = q.where('validFrom', '<=', dv(to));
  if (excludeId) q = q.where('id', '!=', excludeId);
  const clash = await q.executeTakeFirst();
  if (clash) throw errors.conflict('This employee already has reduced hours of this kind in that period. Change or end it first.', { reason: 'OVERLAP_ALLOWANCE', allowanceId: clash.id });
}
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string | null, b: string | null) => (a === null || b === null ? null : a > b ? a : b);

/** Recompute the employee's past days of a range (by employee, not branch: the branch on those days may have been another one). */
async function recalc(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, employeeId: string, from: string, to: string | null, reason: string) {
  return recalcLeaveRange(deps, trx, actor, orgId, from, to, { branchId: null, employeeIds: [employeeId], reason });
}

export async function listAllowances(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<HourAllowanceDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  return runUser(deps.db, actor, async (trx) => {
    await employeeInScope(trx, orgId, employeeId, grant);
    const today = await todayOf(trx, orgId);
    return (await rowsOf(trx, orgId, employeeId)).map((r) => toDto(r, today));
  });
}

export async function createAllowance(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: HourAllowanceInput): Promise<WithTimeOffRecalc<HourAllowanceDto>> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await employeeInScope(trx, orgId, employeeId, grant);
    if (input.validFrom < emp.joiningDate) throw errors.validation('Reduced hours cannot start before the joining date.', { issues: [{ path: 'validFrom', message: 'Before the joining date', code: 'BEFORE_JOINING' }] });
    await assertNoOverlap(trx, orgId, employeeId, input.kind, input.validFrom, input.validTo ?? null);
    const row = await trx.insertInto('employeeHourAllowances').values({
      organizationId: orgId, employeeId, branchId: emp.branchId, kind: input.kind, minutesPerDay: input.minutesPerDay, position: input.position,
      validFrom: input.validFrom, validTo: input.validTo ?? null, reference: input.reference ?? null, notes: input.notes ?? null, createdBy: actor.userId,
    }).returning(COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'hour_allowance.created', 'employee_hour_allowance', { entityId: row.id, branchId: emp.branchId, newValue: { employeeId, ...input } });
    const job = await recalc(deps, trx, actor, orgId, employeeId, input.validFrom, input.validTo ?? null, `reduced hours (${input.kind}) added`);
    return { ...toDto(row as AllowanceRow, await todayOf(trx, orgId)), recalculationJobId: job?.jobId ?? null };
  });
}

async function loadOne(trx: Trx, orgId: string, id: string): Promise<AllowanceRow & { branchId: string | null }> {
  const row = await trx.selectFrom('employeeHourAllowances').select([...COLUMNS, 'branchId']).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Reduced hours', id);
  return row as AllowanceRow & { branchId: string | null };
}

export async function updateAllowance(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: HourAllowanceUpdateInput): Promise<WithTimeOffRecalc<HourAllowanceDto>> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadOne(trx, orgId, id);
    const emp = await employeeInScope(trx, orgId, before.employeeId, grant);
    const beforeFrom = isoDate(before.validFrom); const beforeTo = isoDateOrNull(before.validTo);
    const next = {
      minutesPerDay: input.minutesPerDay ?? before.minutesPerDay, position: input.position ?? before.position,
      validFrom: input.validFrom ?? beforeFrom, validTo: input.validTo === undefined ? beforeTo : input.validTo,
      reference: input.reference === undefined ? before.reference : input.reference, notes: input.notes === undefined ? before.notes : input.notes,
    };
    if (next.validTo !== null && next.validTo < next.validFrom) throw errors.validation('The last day cannot be before the first day.', { issues: [{ path: 'validTo', message: 'Before validFrom' }] });
    if (before.kind === 'NURSING' && next.validTo === null) throw errors.validation('A nursing hour needs its last day.', { issues: [{ path: 'validTo', message: 'Required for a nursing hour' }] });
    if (next.validFrom < emp.joiningDate) throw errors.validation('Reduced hours cannot start before the joining date.', { issues: [{ path: 'validFrom', message: 'Before the joining date', code: 'BEFORE_JOINING' }] });
    await assertNoOverlap(trx, orgId, before.employeeId, before.kind, next.validFrom, next.validTo, id);
    const row = await trx.updateTable('employeeHourAllowances').set(next).where('organizationId', '=', orgId).where('id', '=', id).returning(COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'hour_allowance.updated', 'employee_hour_allowance', {
      entityId: id, branchId: before.branchId,
      oldValue: { minutesPerDay: before.minutesPerDay, position: before.position, validFrom: beforeFrom, validTo: beforeTo, reference: before.reference, notes: before.notes }, newValue: next,
    });
    // the days of both ranges may change
    const job = await recalc(deps, trx, actor, orgId, before.employeeId, minDate(beforeFrom, next.validFrom), maxDate(beforeTo, next.validTo), 'reduced hours changed');
    return { ...toDto(row as AllowanceRow, await todayOf(trx, orgId)), recalculationJobId: job?.jobId ?? null };
  });
}

export async function deleteAllowance(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadOne(trx, orgId, id);
    await employeeInScope(trx, orgId, before.employeeId, grant);
    await trx.deleteFrom('employeeHourAllowances').where('organizationId', '=', orgId).where('id', '=', id).execute();
    const from = isoDate(before.validFrom); const to = isoDateOrNull(before.validTo);
    await audit(trx, actor, orgId, 'hour_allowance.deleted', 'employee_hour_allowance', { entityId: id, branchId: before.branchId, oldValue: { employeeId: before.employeeId, kind: before.kind, minutesPerDay: before.minutesPerDay, position: before.position, validFrom: from, validTo: to } });
    const job = await recalc(deps, trx, actor, orgId, before.employeeId, from, to, 'reduced hours removed');
    return { recalculationJobId: job?.jobId ?? null };
  });
}

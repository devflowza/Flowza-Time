import { DateTime } from 'luxon';
import type { EmployeeLeaveBalancesDto, LeaveAllocationDto, LeaveAllocationGenerateResultDto, LeaveAllocationListQuery, LeaveAllocationRowInput, LeaveAllocationUpsertResultDto, LeaveBalancesQuery, LeaveCalendarDto, LeaveCalendarQuery, LeaveYearCloseQueuedDto } from '@flowza/contracts';
import { LEAVE_YEAR_CLOSE_JOB_TYPE, leaveYearCloseDedupeKey, loadLeaveBalances, loadLeaveTypePolicies, type Trx } from '@flowza/database';
import { clampToYear, leaveTypeAppliesTo, prorateAllowance } from '@flowza/domain';
import { AppError, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireAnyPermission, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime } from '../../lib/mappers.js';
import { toCsvDocument } from '../../lib/csv.js';
import { enqueueJob } from '../../lib/jobs.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { isCompOffType, leaveDaysOf, ownRowWrite, toBalanceDto } from './common.js';

/**
 * HR leave balances and allocations (leave v2, HR portal Prompt 7): the allocation rows HR keeps per employee × type × year
 * (allocated days, carried forward with its expiry, opening balance, adjustment), their generation from the types' yearly
 * allowance (prorated for joiners), the balances list and its CSV export (every figure through the one balance function),
 * the year close (a queued worker job) and the team calendar.
 */

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const LEAVE_BALANCE_EXPORT_MAX_EMPLOYEES = 5_000;
export const LEAVE_CALENDAR_MAX_EMPLOYEES = 300;

// ----- allocations ------------------------------------------------------------------------------------------------------------

type AllocationRow = { id: string; employeeId: string; employeeNumber: string; employeeName: string; branchId: string | null; leaveTypeId: string; leaveTypeCode: string; leaveTypeName: string; year: number; allocatedDays: unknown; carriedForwardDays: unknown; carriedForwardExpiresOn: Date | string | null; openingBalanceDays: unknown; adjustmentDays: unknown; notes: string | null; updatedAt: Date; updatedBy: string | null };
function allocationQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('leaveAllocations as a').innerJoin('employees as e', 'e.id', 'a.employeeId').innerJoin('leaveTypes as t', 't.id', 'a.leaveTypeId').where('a.organizationId', '=', orgId);
}
const ALLOCATION_COLUMNS = ['a.id', 'a.employeeId', 'e.employeeNumber', 'e.displayName as employeeName', 'a.branchId', 'a.leaveTypeId', 't.code as leaveTypeCode', 't.name as leaveTypeName', 'a.year', 'a.allocatedDays', 'a.carriedForwardDays', 'a.carriedForwardExpiresOn', 'a.openingBalanceDays', 'a.adjustmentDays', 'a.notes', 'a.updatedAt', 'a.updatedBy'] as const;
function toAllocationDto(r: AllocationRow): LeaveAllocationDto {
  return {
    id: r.id, employeeId: r.employeeId, employeeNumber: r.employeeNumber, employeeName: r.employeeName, branchId: r.branchId, leaveTypeId: r.leaveTypeId, leaveTypeCode: String(r.leaveTypeCode), leaveTypeName: r.leaveTypeName, year: r.year,
    allocatedDays: num(r.allocatedDays), carriedForwardDays: num(r.carriedForwardDays), carriedForwardExpiresOn: r.carriedForwardExpiresOn === null ? null : isoDate(r.carriedForwardExpiresOn), openingBalanceDays: num(r.openingBalanceDays), adjustmentDays: num(r.adjustmentDays),
    notes: r.notes, updatedAt: isoDateTime(r.updatedAt), updatedBy: r.updatedBy,
  };
}

export async function listAllocations(deps: ApiDeps, actor: Actor, orgId: string, q: LeaveAllocationListQuery): Promise<{ data: LeaveAllocationDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = allocationQuery(trx, orgId).where('a.year', '=', q.year);
    if (scope) base = base.where('a.branchId', 'in', scope);
    if (q.employeeId) base = base.where('a.employeeId', '=', q.employeeId);
    if (q.leaveTypeId) base = base.where('a.leaveTypeId', '=', q.leaveTypeId);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.employeeNumber', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(ALLOCATION_COLUMNS).orderBy('e.displayName').orderBy('t.name').orderBy('a.id').limit(page.pageSize).offset(page.offset).execute()) as AllocationRow[];
    return { data: rows.map(toAllocationDto), total };
  });
}

const allocationValues = (r: LeaveAllocationRowInput) => ({
  allocatedDays: r.allocatedDays, carriedForwardDays: r.carriedForwardDays ?? 0, carriedForwardExpiresOn: r.carriedForwardExpiresOn ?? null,
  openingBalanceDays: r.openingBalanceDays ?? 0, adjustmentDays: r.adjustmentDays ?? 0, notes: r.notes ?? null,
});
const comparable = (v: { allocatedDays: unknown; carriedForwardDays: unknown; carriedForwardExpiresOn: Date | string | null; openingBalanceDays: unknown; adjustmentDays: unknown; notes: string | null }) => ({
  allocatedDays: num(v.allocatedDays), carriedForwardDays: num(v.carriedForwardDays), carriedForwardExpiresOn: v.carriedForwardExpiresOn === null ? null : isoDate(v.carriedForwardExpiresOn),
  openingBalanceDays: num(v.openingBalanceDays), adjustmentDays: num(v.adjustmentDays), notes: v.notes,
});

/**
 * PUT /leave-allocations — create or replace allocation rows (full rows; omitted numbers are 0). Every row is validated
 * first (employee in scope, an active non-comp-off type — comp-off is balanced from credits), then written; each change is
 * audited with its before / after figures. Balances follow at once: nothing is stored besides the rows.
 */
export async function upsertAllocations(deps: ApiDeps, actor: Actor, orgId: string, input: { rows: LeaveAllocationRowInput[] }): Promise<LeaveAllocationUpsertResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  const keyOf = (r: { employeeId: string; leaveTypeId: string; year: number }) => `${r.employeeId}|${r.leaveTypeId}|${r.year}`;
  const seen = new Set<string>();
  const issues: Array<{ path: string; message: string }> = [];
  input.rows.forEach((r, i) => { const k = keyOf(r); if (seen.has(k)) issues.push({ path: `rows.${i}`, message: 'The same employee, type and year appear twice' }); seen.add(k); });
  if (issues.length) throw errors.validation('Each employee, type and year may appear once.', { issues });
  return runUser(deps.db, actor, async (trx) => {
    const employeeIds = [...new Set(input.rows.map((r) => r.employeeId))];
    const employees = await trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', employeeIds).where('deletedAt', 'is', null).execute();
    const empById = new Map(employees.map((e) => [e.id, e]));
    const types = await loadLeaveTypePolicies(trx, orgId, { includeInactive: true });
    const typeById = new Map(types.map((t) => [t.id, t]));
    input.rows.forEach((r, i) => {
      const e = empById.get(r.employeeId);
      if (!e) issues.push({ path: `rows.${i}.employeeId`, message: 'Unknown employee' });
      else if (!grant.allBranches && !grant.branchIds.includes(e.branchId)) issues.push({ path: `rows.${i}.employeeId`, message: 'Outside your branch scope' });
      const t = typeById.get(r.leaveTypeId);
      if (!t || t.status === 'archived') issues.push({ path: `rows.${i}.leaveTypeId`, message: 'Unknown or archived leave type' });
      else if (isCompOffType(t)) issues.push({ path: `rows.${i}.leaveTypeId`, message: 'Comp-off is balanced from its credits, not allocations' });
    });
    if (issues.length) throw errors.validation('Some allocation rows are invalid.', { issues });
    // review P0-2: nobody allocates leave to themselves; the organisation owner is the one exception (logged)
    const isOwner = grant.roleKey === 'owner';
    const own = (employeeId: string) => !!grant.employeeId && grant.employeeId === employeeId;
    if (!isOwner) {
      input.rows.forEach((r, i) => { if (own(r.employeeId)) issues.push({ path: `rows.${i}.employeeId`, message: 'Your own allocation: another HR user sets it' }); });
      if (issues.length) throw new AppError('FORBIDDEN', 'You cannot set your own leave allocation; ask another HR user.', { details: { issues } });
    }
    const existing = await trx.selectFrom('leaveAllocations').selectAll().where('organizationId', '=', orgId).where('employeeId', 'in', employeeIds).where('year', 'in', [...new Set(input.rows.map((r) => r.year))]).execute();
    const existingByKey = new Map(existing.map((a) => [keyOf(a), a]));
    let created = 0; let updated = 0; let unchanged = 0;
    const ids: string[] = [];
    for (const r of input.rows) {
      const values = allocationValues(r);
      const before = existingByKey.get(keyOf(r));
      const branchId = empById.get(r.employeeId)!.branchId;
      // the owner's own row: in the system context (the database refuses it from their session), audited as the exception
      const write = <T,>(fn: (t: Trx) => Promise<T>): Promise<T> => ownRowWrite(trx, orgId, own(r.employeeId), fn);
      let changedId: string | null = null;
      if (before) {
        ids.push(before.id);
        const old = comparable(before);
        if (JSON.stringify(old) === JSON.stringify(comparable(values))) { unchanged += 1; continue; }
        await write((t) => t.updateTable('leaveAllocations').set({ ...values, branchId, updatedBy: actor.userId }).where('id', '=', before.id).execute());
        await audit(trx, actor, orgId, 'leave_allocation.updated', 'leave_allocation', { entityId: before.id, branchId, oldValue: { ...old, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.year }, newValue: { ...comparable(values), employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.year } });
        updated += 1; changedId = before.id;
      } else {
        const row = await write((t) => t.insertInto('leaveAllocations').values({ organizationId: orgId, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, branchId, year: r.year, ...values, createdBy: actor.userId, updatedBy: actor.userId }).returning('id').executeTakeFirstOrThrow());
        ids.push(row.id);
        await audit(trx, actor, orgId, 'leave_allocation.created', 'leave_allocation', { entityId: row.id, branchId, newValue: { ...comparable(values), employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.year } });
        created += 1; changedId = row.id;
      }
      if (own(r.employeeId)) await audit(trx, actor, orgId, 'leave.sod_owner_bypass', 'leave_allocation', { entityId: changedId, branchId, newValue: { action: 'allocate', employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, year: r.year }, reason: 'the organisation owner set their own leave allocation' });
    }
    const rows = (await allocationQuery(trx, orgId).select(ALLOCATION_COLUMNS).where('a.id', 'in', ids).orderBy('e.displayName').orderBy('t.name').execute()) as AllocationRow[];
    return { created, updated, unchanged, allocations: rows.map(toAllocationDto) };
  });
}

/**
 * POST /leave-allocations/generate — create the MISSING rows of a year from the types' yearly allowance for every current
 * employee in scope (joiners prorated by service months, rounded to half days; gender-restricted types only for the
 * employees they apply to). Existing rows are never touched, so it can run again after new hires join.
 */
export async function generateAllocations(deps: ApiDeps, actor: Actor, orgId: string, input: { year: number; leaveTypeIds?: string[] | undefined }): Promise<LeaveAllocationGenerateResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const all = await loadLeaveTypePolicies(trx, orgId);
    if (input.leaveTypeIds) {
      const unknown = input.leaveTypeIds.filter((id) => !all.some((t) => t.id === id && !isCompOffType(t)));
      if (unknown.length) throw errors.validation('Unknown, archived or comp-off leave types.', { issues: unknown.map((id) => ({ path: 'leaveTypeIds', message: `Not allocatable: ${id}` })) });
    }
    const types = all.filter((t) => !isCompOffType(t) && t.annualAllowanceDays !== null && (!input.leaveTypeIds || input.leaveTypeIds.includes(t.id)));
    let q = trx.selectFrom('employees').select(['id', 'branchId', 'gender', 'employmentType', 'joiningDate']).where('organizationId', '=', orgId).where('deletedAt', 'is', null)
      .where('employmentStatus', 'not in', ['resigned', 'terminated']).where('joiningDate', '<=', dv(`${input.year}-12-31`))
      .where((eb) => eb.or([eb('exitDate', 'is', null), eb('exitDate', '>=', dv(`${input.year}-01-01`))]));
    if (!grant.allBranches) q = q.where('branchId', 'in', grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000']);
    const employees = await q.execute();
    if (!types.length || !employees.length) return { year: input.year, created: 0, skipped: 0, employees: employees.length, leaveTypes: types.length };
    const existing = new Set((await trx.selectFrom('leaveAllocations').select(['employeeId', 'leaveTypeId']).where('organizationId', '=', orgId).where('year', '=', input.year).where('leaveTypeId', 'in', types.map((t) => t.id)).execute()).map((a) => `${a.employeeId}|${a.leaveTypeId}`));
    type NewAllocation = { organizationId: string; employeeId: string; leaveTypeId: string; branchId: string; year: number; allocatedDays: number; notes: string; createdBy: string; updatedBy: string };
    const values: NewAllocation[] = [];
    const ownValues: NewAllocation[] = [];
    // review P0-2: nobody allocates leave to themselves — the caller's own rows are left for another HR user (counted in
    // `skippedOwn`); the organisation owner is the one exception, written in the system context and logged
    const isOwner = grant.roleKey === 'owner';
    let skipped = 0; let skippedOwn = 0;
    for (const e of employees) {
      const own = !!grant.employeeId && grant.employeeId === e.id;
      for (const t of types) {
        // the one applicability rule (review P1-3): gender and employment type
        if (existing.has(`${e.id}|${t.id}`) || !leaveTypeAppliesTo(t, e)) { skipped += 1; continue; }
        if (own && !isOwner) { skipped += 1; skippedOwn += 1; continue; }
        (own ? ownValues : values).push({ organizationId: orgId, employeeId: e.id, leaveTypeId: t.id, branchId: e.branchId, year: input.year, allocatedDays: prorateAllowance(t.annualAllowanceDays!, input.year, isoDate(e.joiningDate)), notes: 'Generated from the yearly allowance', createdBy: actor.userId, updatedBy: actor.userId });
      }
    }
    const insert = (t: Trx, rows: NewAllocation[]) => t.insertInto('leaveAllocations').values(rows).onConflict((oc) => oc.columns(['organizationId', 'employeeId', 'leaveTypeId', 'year']).doNothing()).returning('id').execute();
    let created = 0;
    for (let i = 0; i < values.length; i += 500) created += (await insert(trx, values.slice(i, i + 500))).length;
    if (ownValues.length) {
      const res = await ownRowWrite(trx, orgId, true, (t) => insert(t, ownValues));
      created += res.length;
      if (res.length) await audit(trx, actor, orgId, 'leave.sod_owner_bypass', 'leave_allocation', { newValue: { action: 'generate', employeeId: grant.employeeId, year: input.year, allocationIds: res.map((r) => r.id) }, reason: 'the organisation owner generated their own leave allocation' });
    }
    skipped += values.length + ownValues.length - created;
    await audit(trx, actor, orgId, 'leave_allocation.generated', 'leave_allocation', { newValue: { year: input.year, created, skipped, skippedOwn, employees: employees.length, leaveTypes: types.map((t) => t.code) } });
    return { year: input.year, created, skipped, employees: employees.length, leaveTypes: types.length, ...(skippedOwn ? { skippedOwn } : {}) };
  });
}

// ----- balances ------------------------------------------------------------------------------------------------------------------

type EmployeeRow = { id: string; employeeNumber: string; displayName: string; branchId: string | null; departmentId: string | null; joiningDate: Date | string; gender: string; employmentType: string };

function employeeQuery(trx: Trx, orgId: string, grant: ReturnType<typeof requirePermission>, q: Pick<LeaveBalancesQuery, 'branchId' | 'employeeId' | 'departmentId' | 'search'>) {
  const scope = branchFilter(grant, q.branchId);
  let base = trx.selectFrom('employees as e').where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null);
  if (scope) base = base.where('e.branchId', 'in', scope);
  if (q.employeeId) base = base.where('e.id', '=', q.employeeId);
  if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
  if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.employeeNumber', 'ilike', like)])); }
  return base;
}
const EMPLOYEE_COLUMNS = ['e.id', 'e.employeeNumber', 'e.displayName', 'e.branchId', 'e.departmentId', 'e.joiningDate', 'e.gender', 'e.employmentType'] as const;

/** Balances of a page of employees: one row per employee, one balance per active type that applies to them (or that they used). */
async function balancesFor(trx: Trx, orgId: string, rows: EmployeeRow[], year: number | undefined): Promise<EmployeeLeaveBalancesDto[]> {
  if (!rows.length) return [];
  return withSystemScope(trx, orgId, async (t) => {
    const today = await orgToday(t, orgId);
    const y = year ?? Number(today.slice(0, 4));
    const types = await loadLeaveTypePolicies(t, orgId);
    const balances = await loadLeaveBalances(t, orgId, rows.map((r) => r.id), { year: y, asOf: today, types });
    return rows.map((e) => {
      const list = balances.get(e.id) ?? [];
      return {
        employeeId: e.id, employeeNumber: e.employeeNumber, employeeName: e.displayName, branchId: e.branchId, departmentId: e.departmentId, joiningDate: isoDate(e.joiningDate), year: y, asOf: clampToYear(today, y),
        balances: types.map((type, i) => ({ type, b: list[i]! }))
          .filter(({ type, b }) => !!b && (leaveTypeAppliesTo(type, e) || b.takenDays > 0 || b.pendingDays > 0))
          .map(({ type, b }) => toBalanceDto(type, b)),
      };
    });
  });
}

/** GET /leave-balances — computed on read for a page of employees (branch-scoped), never stored. */
export async function listBalances(deps: ApiDeps, actor: Actor, orgId: string, q: LeaveBalancesQuery): Promise<{ data: EmployeeLeaveBalancesDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  return runUser(deps.db, actor, async (trx) => {
    const base = employeeQuery(trx, orgId, grant, q);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(EMPLOYEE_COLUMNS).orderBy('e.displayName').orderBy('e.id').limit(page.pageSize).offset(page.offset).execute()) as EmployeeRow[];
    return { data: await balancesFor(trx, orgId, rows, q.year), total };
  });
}

/**
 * GET /leave-balances/export — the same list as CSV (report.export): one line per employee × type, at most
 * LEAVE_BALANCE_EXPORT_MAX_EMPLOYEES employees, formula-escaped cells; every export is audited with its row count.
 */
export async function exportBalancesCsv(deps: ApiDeps, actor: Actor, orgId: string, q: LeaveBalancesQuery): Promise<{ fileName: string; csv: string; rows: number }> {
  const grant = requirePermission(actor.principal, orgId, 'leave.view');
  if (!hasPermission(grant, 'report.export')) throw errors.forbidden('Missing permission: report.export.');
  return runUser(deps.db, actor, async (trx) => {
    const rows = (await employeeQuery(trx, orgId, grant, q).select(EMPLOYEE_COLUMNS).orderBy('e.displayName').orderBy('e.id').limit(LEAVE_BALANCE_EXPORT_MAX_EMPLOYEES).execute()) as EmployeeRow[];
    const data: EmployeeLeaveBalancesDto[] = [];
    for (let i = 0; i < rows.length; i += 200) data.push(...await balancesFor(trx, orgId, rows.slice(i, i + 200), q.year));
    const f = (n: number | null) => (n === null ? '' : String(n));
    const header = ['Employee number', 'Employee', 'Year', 'As of', 'Leave type code', 'Leave type', 'Allocated', 'Carried forward', 'Carry-forward expires', 'Opening balance', 'Adjustment', 'Entitlement', 'Accrued to date', 'Taken', 'Pending', 'Available', 'Available after pending'];
    const lines = data.flatMap((e) => e.balances.map((b) => [e.employeeNumber, e.employeeName, e.year, e.asOf, b.code, b.name, f(b.allocatedDays), b.carriedForwardDays, b.carriedForwardExpiresOn, b.openingBalanceDays, b.adjustmentDays, f(b.entitlementDays), f(b.accruedToDateDays), b.takenDays, b.pendingDays, f(b.availableDays), f(b.availableAfterPendingDays)]));
    const year = data[0]?.year ?? q.year ?? Number((await withSystemScope(trx, orgId, (t) => orgToday(t, orgId))).slice(0, 4));
    await audit(trx, actor, orgId, 'leave_balance.exported', 'leave_allocation', { newValue: { year, employees: data.length, rowCount: lines.length, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null, capped: rows.length >= LEAVE_BALANCE_EXPORT_MAX_EMPLOYEES } });
    return { fileName: `leave-balances-${year}.csv`, csv: toCsvDocument(header, lines), rows: lines.length };
  });
}

// ----- year close ----------------------------------------------------------------------------------------------------------------

/**
 * POST /leave-allocations/year-close { fromYear } — queue the year close now (it also runs on its own on 1 January in the
 * organisation's timezone): the worker carries each employee's unused balance into next year's allocation rows, capped
 * per type, idempotently. One pending job per organisation and year (the queue dedupes by key).
 */
export async function queueYearClose(deps: ApiDeps, actor: Actor, orgId: string, input: { fromYear: number }): Promise<LeaveYearCloseQueuedDto> {
  requirePermission(actor.principal, orgId, 'leave.manage');
  return runUser(deps.db, actor, async (trx) => {
    const today = await withSystemScope(trx, orgId, (t) => orgToday(t, orgId));
    if (input.fromYear > Number(today.slice(0, 4))) throw errors.validation('A year can be closed once it has started; its balances carry into the next year.', { issues: [{ path: 'fromYear', message: 'In the future' }] });
    const jobId = await enqueueJob(deps.queue, trx, { queue: 'processing', jobType: LEAVE_YEAR_CLOSE_JOB_TYPE, organizationId: orgId, payload: { organizationId: orgId, fromYear: input.fromYear, requestedBy: actor.userId }, priority: 3, dedupeKey: leaveYearCloseDedupeKey(orgId, input.fromYear), maxAttempts: 3, lockTimeoutSeconds: 1_800, correlationId: actor.requestId });
    await audit(trx, actor, orgId, 'leave.year_close_requested', 'leave_allocation', { newValue: { fromYear: input.fromYear, toYear: input.fromYear + 1, jobId } });
    return { jobId, status: 'QUEUED', fromYear: input.fromYear, toYear: input.fromYear + 1 };
  });
}

// ----- team calendar --------------------------------------------------------------------------------------------------------------

/**
 * GET /leave-calendar?month — who is on leave in a month (approved, and undecided unless includePending=false), for the HR
 * Leave page's calendar and managers (leave.view or leave.view_team; rows under the caller's RLS, branch-scoped). At most
 * LEAVE_CALENDAR_MAX_EMPLOYEES employees; `truncated` says there were more.
 */
export async function leaveCalendar(deps: ApiDeps, actor: Actor, orgId: string, q: LeaveCalendarQuery): Promise<LeaveCalendarDto> {
  const grant = requireAnyPermission(actor.principal, orgId, 'leave.view', 'leave.view_team');
  const from = `${q.month}-01`;
  const to = DateTime.fromISO(from, { zone: 'utc' }).endOf('month').toISODate()!;
  const orgWide = hasPermission(grant, 'leave.view');
  const scope = orgWide ? branchFilter(grant, q.branchId) : q.branchId ? [q.branchId] : null;
  if (q.branchId && orgWide) requireBranchAccess(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('leaveRecords as l').innerJoin('employees as e', 'e.id', 'l.employeeId').innerJoin('leaveTypes as t', 't.id', 'l.leaveTypeId')
      .where('l.organizationId', '=', orgId).where('l.startDate', '<=', dv(to)).where('l.endDate', '>=', dv(from))
      .where('l.status', 'in', q.includePending ? ['APPROVED', 'PENDING', 'INFO_REQUESTED'] : ['APPROVED']);
    if (scope) base = base.where('l.branchId', 'in', scope);
    if (!orgWide) base = base.where('l.employeeId', 'in', grant.teamEmployeeIds.length ? grant.teamEmployeeIds : ['00000000-0000-0000-0000-000000000000']);
    if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
    const employeeRows = await base.select(['e.id', 'e.displayName', 'e.employeeNumber', 'e.branchId', 'e.departmentId']).distinct().orderBy('e.displayName').orderBy('e.id').limit(LEAVE_CALENDAR_MAX_EMPLOYEES + 1).execute();
    const truncated = employeeRows.length > LEAVE_CALENDAR_MAX_EMPLOYEES;
    const employees = employeeRows.slice(0, LEAVE_CALENDAR_MAX_EMPLOYEES);
    const entries = employees.length ? await base.where('l.employeeId', 'in', employees.map((e) => e.id))
      .select(['l.id', 'l.employeeId', 'e.displayName', 'e.employeeNumber', 'l.leaveTypeId', 't.name as leaveTypeName', 't.code as leaveTypeCode', 't.color', 't.countMode', 'l.startDate', 'l.endDate', 'l.isHalfDay', 'l.halfDayPart', 'l.days', 'l.status'])
      .orderBy('l.startDate').orderBy('l.id').execute() : [];
    // review P2-8: days computed on read for leave stored without them (as the balances count them), and the days inside
    // this month — the calendar's totals sum `daysInPeriod`, never the full days of a leave that merely overlaps the month
    const days = await leaveDaysOf(trx, orgId, entries, { from, to });
    return {
      month: q.month, from, to, truncated,
      employees: employees.map((e) => ({ employeeId: e.id, employeeName: e.displayName, employeeNumber: e.employeeNumber, branchId: e.branchId, departmentId: e.departmentId })),
      entries: entries.map((r) => ({ id: r.id, employeeId: r.employeeId, employeeName: r.displayName, employeeNumber: r.employeeNumber, leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName, leaveTypeCode: String(r.leaveTypeCode), color: r.color, startDate: isoDate(r.startDate), endDate: isoDate(r.endDate), isHalfDay: r.isHalfDay, halfDayPart: r.halfDayPart, days: days.get(r.id)?.days ?? null, daysInPeriod: days.get(r.id)?.daysInPeriod ?? 0, status: r.status })),
    };
  });
}


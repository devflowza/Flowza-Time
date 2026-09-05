import { type z } from 'zod';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { BulkEmployeeAction, CreateEmployeeInput, DeleteEmployeeInput, EmployeeDeviceStateDto, EmployeeDto, EmployeeListQuery, EmploymentHistoryDto, IdentityDocumentDto, UpdateEmployeeInput, identityDocumentInputSchema } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, hasPermission, requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit, diffObjects, withSystemScope } from '../lib/service.js';
import { enqueueJob } from '../lib/jobs.js';
import { hashPin } from '../lib/hashing.js';
import { loadSettings } from '../lib/settings.js';
import { assertWithinLimit } from './features/entitlements.js';
import { likeContains, pageOf, prefixTsQuery, resolveSort, toCount } from '../lib/pagination.js';
import { isoDate } from '../lib/mappers.js';
import { DOCUMENT_COLUMNS, EMPLOYEE_COLUMNS, EMPTY_SYNC_SUMMARY, HISTORY_COLUMNS, toDeviceStateDto, toDocumentDto, toEmployeeDto, toHistoryDto, type DeviceSyncSummary, type DeviceStateRow, type EmployeeRow, type HistoryRow } from './employees.mappers.js';

type IdentityDocumentInput = z.infer<typeof identityDocumentInputSchema>;

const EMPLOYEE_SORT = {
  employeeNumber: 'e.employee_number', displayName: 'e.display_name', firstName: 'e.first_name', lastName: 'e.last_name', joiningDate: 'e.joining_date', exitDate: 'e.exit_date',
  employmentStatus: 'e.employment_status', employmentType: 'e.employment_type', branch: 'b.name', department: 'd.name', designation: 'g.name', deviceUserId: 'e.device_user_id',
  createdAt: 'e.created_at', updatedAt: 'e.updated_at',
} as const;

/**
 * Sensitive personal columns (date of birth, phone) are only returned to callers holding `employee.view_sensitive`
 * (same rule as exports, AGENTS.md); everyone else sees null. Identity documents live behind their own endpoint.
 */
function maskSensitive<T extends EmployeeDto>(dto: T, grant: MembershipGrant): T {
  if (hasPermission(grant, 'employee.view_sensitive')) return dto;
  return { ...dto, dateOfBirth: null, phone: null };
}

function employeeQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('employees as e')
    .leftJoin('branches as b', 'b.id', 'e.branchId')
    .leftJoin('departments as d', 'd.id', 'e.departmentId')
    .leftJoin('designations as g', 'g.id', 'e.designationId')
    .leftJoin('employees as mgr', 'mgr.id', 'e.managerEmployeeId')
    .where('e.organizationId', '=', orgId);
}

async function syncSummaries(trx: Trx, orgId: string, employeeIds: string[]): Promise<Map<string, DeviceSyncSummary>> {
  const out = new Map<string, DeviceSyncSummary>();
  if (employeeIds.length === 0) return out;
  const rows = await trx.selectFrom('deviceEmployeeStates').select(['employeeId', 'syncStatus', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where('desired', '=', true).where('employeeId', 'in', employeeIds).groupBy(['employeeId', 'syncStatus']).execute();
  for (const r of rows) {
    if (!r.employeeId) continue;
    const s = out.get(r.employeeId) ?? { ...EMPTY_SYNC_SUMMARY };
    const n = toCount(r.n);
    s.total += n;
    if (r.syncStatus === 'IN_SYNC') s.inSync += n;
    else if (r.syncStatus === 'FAILED') s.failed += n;
    else if (r.syncStatus === 'OFFLINE') s.offline += n;
    else s.pending += n;
    out.set(r.employeeId, s);
  }
  return out;
}

export async function listEmployees(deps: ApiDeps, actor: Actor, orgId: string, q: EmployeeListQuery): Promise<{ data: EmployeeDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'employee.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(EMPLOYEE_SORT, q.sort, q.order, 'e.employee_number');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = employeeQuery(trx, orgId);
    if (!q.includeDeleted) base = base.where('e.deletedAt', 'is', null);
    if (scope) base = base.where('e.branchId', 'in', scope);
    if (q.departmentId) base = base.where('e.departmentId', '=', q.departmentId);
    if (q.designationId) base = base.where('e.designationId', '=', q.designationId);
    if (q.employmentStatus) base = base.where('e.employmentStatus', '=', q.employmentStatus);
    if (q.employmentType) base = base.where('e.employmentType', '=', q.employmentType);
    if (q.managerEmployeeId) base = base.where('e.managerEmployeeId', '=', q.managerEmployeeId);
    if (q.search) {
      const like = likeContains(q.search);
      const tsq = prefixTsQuery(q.search);
      base = base.where((eb) => eb.or([
        ...(tsq ? [sql<boolean>`e.search @@ to_tsquery('simple', ${tsq})`] : []),
        eb('e.displayName', 'ilike', like), // trigram index fallback (partial / mid-word matches)
        eb(sql`e.employee_number::text`, 'ilike', like),
        eb('e.deviceUserId', 'ilike', like),
        eb(sql`e.email::text`, 'ilike', like),
      ]));
    }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(EMPLOYEE_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('e.id').limit(page.pageSize).offset(page.offset).execute();
    const summaries = await syncSummaries(trx, orgId, rows.map((r) => r.id));
    return { data: rows.map((r) => maskSensitive(toEmployeeDto(r as EmployeeRow, summaries.get(r.id) ?? { ...EMPTY_SYNC_SUMMARY }), grant)), total };
  });
}

async function loadEmployeeRow(trx: Trx, orgId: string, id: string): Promise<EmployeeRow> {
  const row = await employeeQuery(trx, orgId).select(EMPLOYEE_COLUMNS).where('e.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Employee', id);
  return row as EmployeeRow;
}

async function loadEmployeeDto(trx: Trx, orgId: string, id: string): Promise<EmployeeDto> {
  const row = await loadEmployeeRow(trx, orgId, id);
  const summaries = await syncSummaries(trx, orgId, [id]);
  return toEmployeeDto(row, summaries.get(id) ?? { ...EMPTY_SYNC_SUMMARY });
}

async function historyRows(trx: Trx, orgId: string, employeeId: string, limit?: number): Promise<EmploymentHistoryDto[]> {
  let q = trx.selectFrom('employmentHistory as h').leftJoin('branches as b', 'b.id', 'h.branchId').leftJoin('departments as d', 'd.id', 'h.departmentId').leftJoin('designations as g', 'g.id', 'h.designationId').leftJoin('employees as m', 'm.id', 'h.managerEmployeeId')
    .select(HISTORY_COLUMNS).where('h.organizationId', '=', orgId).where('h.employeeId', '=', employeeId).orderBy('h.effectiveFrom', 'desc');
  if (limit) q = q.limit(limit);
  return (await q.execute()).map((r) => toHistoryDto(r as HistoryRow));
}

export async function getEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmployeeDto & { currentHistory: EmploymentHistoryDto | null }> {
  const grant = requirePermission(actor.principal, orgId, 'employee.view');
  return runUser(deps.db, actor, async (trx) => {
    const dto = maskSensitive(await loadEmployeeDto(trx, orgId, id), grant);
    const [current] = await historyRows(trx, orgId, id, 1);
    return { ...dto, currentHistory: current ?? null };
  });
}

export async function getEmployeeHistory(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmploymentHistoryDto[]> {
  requirePermission(actor.principal, orgId, 'employee.view');
  return runUser(deps.db, actor, async (trx) => { await loadEmployeeRow(trx, orgId, id); return historyRows(trx, orgId, id); });
}

export async function getEmployeeDevices(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmployeeDeviceStateDto[]> {
  requirePermission(actor.principal, orgId, 'employee.view');
  return runUser(deps.db, actor, async (trx) => {
    await loadEmployeeRow(trx, orgId, id);
    const rows = await trx.selectFrom('deviceEmployeeStates as s').innerJoin('devices as dv', 'dv.id', 's.deviceId')
      .select(['s.id', 's.deviceId', 'dv.code as deviceCode', 'dv.name as deviceName', 's.branchId', 'dv.connectionStatus', 's.deviceUserId', 's.syncStatus', 's.desired', 's.lastSyncAt', 's.lastSuccessAt', 's.lastErrorCode', 's.lastError', 's.fingerprintCount', 's.faceEnrolled', 's.cardEnrolled', 's.updatedAt'])
      .where('s.organizationId', '=', orgId).where('s.employeeId', '=', id).orderBy('dv.name').execute();
    return rows.map((r) => toDeviceStateDto(r as DeviceStateRow));
  });
}

// Writes ------------------------------------------------------------------------------------------

async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  return DateTime.now().setZone(org?.timezone ?? 'UTC').toISODate() ?? DateTime.utc().toISODate()!;
}

async function assertReferences(trx: Trx, orgId: string, refs: { branchId?: string; departmentId?: string | null; designationId?: string | null; managerEmployeeId?: string | null; selfId?: string }): Promise<void> {
  if (refs.branchId) {
    const b = await trx.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', refs.branchId).executeTakeFirst();
    if (!b) throw errors.validation('Branch not found in this organisation.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    if (b.status === 'archived') throw errors.validation('Branch is archived.', { issues: [{ path: 'branchId', message: 'Archived' }] });
  }
  if (refs.departmentId) {
    const d = await trx.selectFrom('departments').select('id').where('organizationId', '=', orgId).where('id', '=', refs.departmentId).executeTakeFirst();
    if (!d) throw errors.validation('Department not found in this organisation.', { issues: [{ path: 'departmentId', message: 'Unknown department' }] });
  }
  if (refs.designationId) {
    const g = await trx.selectFrom('designations').select('id').where('organizationId', '=', orgId).where('id', '=', refs.designationId).executeTakeFirst();
    if (!g) throw errors.validation('Designation not found in this organisation.', { issues: [{ path: 'designationId', message: 'Unknown designation' }] });
  }
  if (refs.managerEmployeeId) {
    if (refs.selfId && refs.managerEmployeeId === refs.selfId) throw errors.validation('An employee cannot be their own manager.', { issues: [{ path: 'managerEmployeeId', message: 'Self reference' }] });
    const m = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', '=', refs.managerEmployeeId).where('deletedAt', 'is', null).executeTakeFirst();
    if (!m) throw errors.validation('Manager not found in this organisation.', { issues: [{ path: 'managerEmployeeId', message: 'Unknown employee' }] });
  }
}

/**
 * Next numeric device user id for the organisation. Ids must be unique across ALL branches, but a branch-scoped caller
 * only sees their own employees under RLS, so the maximum is computed in the organisation's system scope (read-only,
 * returns a number only). Serialised with a transaction-level advisory lock; the unique index is the last line of defence.
 */
export async function nextDeviceUserId(trx: Trx, orgId: string): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext(${`${orgId}:device_user_id`}))`.execute(trx);
  const res = await withSystemScope(trx, orgId, (t) => sql<{ next: string }>`select coalesce(max(device_user_id::bigint), 0) + 1 as next from public.employees where organization_id = ${orgId}::uuid and device_user_id ~ '^[0-9]{1,15}$'`.execute(t));
  return String(res.rows[0]?.next ?? 1);
}

const DEVICE_USER_ID_CONSTRAINT = 'employees_organization_id_device_user_id_key';
const isDeviceUserIdClash = (err: unknown) => (err as { code?: string; constraint?: string })?.code === '23505' && (err as { constraint?: string }).constraint === DEVICE_USER_ID_CONSTRAINT;

/**
 * Insert with an auto-assigned device user id, retrying on a unique violation (ids handed out outside the advisory lock,
 * e.g. by an import running in the worker). Each attempt runs inside a savepoint so a clash does not abort the transaction.
 */
async function insertWithAutoDeviceUserId<T>(trx: Trx, orgId: string, insert: (deviceUserId: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const deviceUserId = await nextDeviceUserId(trx, orgId);
    await sql`savepoint employee_insert`.execute(trx);
    try {
      const out = await insert(deviceUserId);
      await sql`release savepoint employee_insert`.execute(trx);
      return out;
    } catch (err) {
      if (!isDeviceUserIdClash(err) || attempt >= 5) throw err;
      await sql`rollback to savepoint employee_insert`.execute(trx);
    }
  }
}

export interface EmploymentSnapshot { branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; employmentType: EmployeeDto['employmentType']; employmentStatus: EmployeeDto['employmentStatus'] }

/**
 * Effective-dated history transition: closes the current row at `effectiveFrom` (exclusive) and opens a new one.
 * A change dated on the current row's own start replaces that row in place; earlier dates are rejected (no rewrite of history).
 */
export async function applyHistoryTransition(trx: Trx, orgId: string, employeeId: string, next: EmploymentSnapshot, effectiveFrom: string, reason: string | null, actorUserId: string, joiningDate: string): Promise<void> {
  if (effectiveFrom < joiningDate) throw errors.validation('effectiveFrom cannot be before the joining date.', { issues: [{ path: 'effectiveFrom', message: `Must be on/after ${joiningDate}` }] });
  const current = await trx.selectFrom('employmentHistory').select(['id', 'effectiveFrom']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('effectiveTo', 'is', null).orderBy('effectiveFrom', 'desc').executeTakeFirst();
  const values = { ...next, reason };
  if (current) {
    const currentFrom = isoDate(current.effectiveFrom);
    if (effectiveFrom < currentFrom) throw errors.validation(`effectiveFrom cannot be before the current employment record (${currentFrom}).`, { issues: [{ path: 'effectiveFrom', message: `Must be on/after ${currentFrom}` }] });
    if (effectiveFrom === currentFrom) {
      await trx.updateTable('employmentHistory').set({ ...values, createdBy: actorUserId }).where('id', '=', current.id).execute();
      return;
    }
    await trx.updateTable('employmentHistory').set({ effectiveTo: effectiveFrom }).where('id', '=', current.id).execute();
  }
  await trx.insertInto('employmentHistory').values({ organizationId: orgId, employeeId, effectiveFrom, effectiveTo: null, ...values, createdBy: actorUserId }).execute();
}

function snapshotOf(e: { branchId: string; departmentId: string | null; designationId: string | null; managerEmployeeId: string | null; employmentType: EmployeeDto['employmentType']; employmentStatus: EmployeeDto['employmentStatus'] }): EmploymentSnapshot {
  return { branchId: e.branchId, departmentId: e.departmentId, designationId: e.designationId, managerEmployeeId: e.managerEmployeeId, employmentType: e.employmentType, employmentStatus: e.employmentStatus };
}
function snapshotChanged(a: EmploymentSnapshot, b: EmploymentSnapshot): boolean {
  return (Object.keys(a) as (keyof EmploymentSnapshot)[]).some((k) => a[k] !== b[k]);
}

async function maybeEnqueuePush(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, employeeIds: string[], force = false): Promise<string | null> {
  if (!force) {
    const settings = await loadSettings(trx, orgId);
    if (settings.sync.autoPushNewEmployees === false) return null;
  }
  return enqueueJob(deps.queue, trx, { queue: 'sync', jobType: 'PUSH_EMPLOYEES', organizationId: orgId, payload: { scope: { employeeIds }, trigger: 'SYSTEM', requestedBy: actor.userId }, correlationId: actor.requestId, priority: 6 });
}

export async function createEmployee(deps: ApiDeps, actor: Actor, orgId: string, input: CreateEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.create');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    await assertReferences(trx, orgId, { branchId: input.branchId, departmentId: input.departmentId, designationId: input.designationId, managerEmployeeId: input.managerEmployeeId });
    // plan entitlement: count active employees org-wide (system scope, since branch-restricted creators only see their branch)
    const activeCount = await withSystemScope(trx, orgId, async (t) => {
      const row = await t.selectFrom('employees').select(({ fn }) => fn.countAll<string>().as('c')).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('employmentStatus', 'not in', ['terminated', 'resigned']).executeTakeFirstOrThrow();
      return Number(row.c);
    });
    await assertWithinLimit(trx, orgId, 'employees', activeCount);
    const displayName = input.displayName ?? [input.firstName, input.lastName].filter(Boolean).join(' ');
    const pinHash = input.pin ? hashPin(input.pin) : null;
    const insert = (deviceUserId: string) => trx.insertInto('employees').values({
      organizationId: orgId, employeeNumber: input.employeeNumber, firstName: input.firstName, middleName: input.middleName ?? null, lastName: input.lastName, displayName, displayNameAr: input.displayNameAr ?? null,
      gender: input.gender, dateOfBirth: input.dateOfBirth ?? null, nationalityCode: input.nationalityCode ?? null, email: input.email ?? null, phone: input.phone ?? null,
      joiningDate: input.joiningDate, employmentStatus: input.employmentStatus, employmentType: input.employmentType, branchId: input.branchId, departmentId: input.departmentId ?? null,
      designationId: input.designationId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, deviceUserId, cardNumber: input.cardNumber ?? null, pinHash,
      weeklyOffDays: input.weeklyOffDays ?? null, customFields: JSON.stringify(input.customFields ?? {}), createdBy: actor.userId, updatedBy: actor.userId,
    }).returning(['id', 'deviceUserId']).executeTakeFirstOrThrow();
    const row = input.deviceUserId ? await insert(input.deviceUserId) : await insertWithAutoDeviceUserId(trx, orgId, insert);
    const deviceUserId = row.deviceUserId;
    await applyHistoryTransition(trx, orgId, row.id, { branchId: input.branchId, departmentId: input.departmentId ?? null, designationId: input.designationId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, employmentType: input.employmentType, employmentStatus: input.employmentStatus }, input.joiningDate, 'Joined', actor.userId, input.joiningDate);
    const dto = await loadEmployeeDto(trx, orgId, row.id);
    const { pin: _pin, ...auditable } = input;
    await audit(trx, actor, orgId, 'employee.created', 'employee', { entityId: row.id, branchId: input.branchId, newValue: { ...auditable, deviceUserId, pinSet: Boolean(input.pin) } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.created', aggregateType: 'employee', aggregateId: row.id, payload: { employeeNumber: dto.employeeNumber, branchId: dto.branchId, deviceUserId }, actorUserId: actor.userId, requestId: actor.requestId });
    await maybeEnqueuePush(deps, trx, actor, orgId, [row.id]);
    return maskSensitive(dto, grant);
  });
}

export async function updateEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadEmployeeRow(trx, orgId, id);
    if (before.deletedAt) throw errors.invalidState('The employee has been deleted.');
    requireBranchAccess(grant, before.branchId);
    await assertReferences(trx, orgId, { branchId: input.branchId, departmentId: input.departmentId, designationId: input.designationId, managerEmployeeId: input.managerEmployeeId, selfId: id });
    const { effectiveFrom: requestedFrom, changeReason, pin, customFields, ...rest } = input;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    if (customFields !== undefined) patch['customFields'] = JSON.stringify(customFields);
    if (pin !== undefined) patch['pinHash'] = hashPin(pin);
    const joiningDate = input.joiningDate ?? isoDate(before.joiningDate);
    if (input.exitDate && input.exitDate < joiningDate) throw errors.validation('exitDate cannot be before the joining date.', { issues: [{ path: 'exitDate', message: `Must be on/after ${joiningDate}` }] });
    const nextSnapshot: EmploymentSnapshot = {
      branchId: input.branchId ?? before.branchId,
      departmentId: input.departmentId === undefined ? before.departmentId : input.departmentId,
      designationId: input.designationId === undefined ? before.designationId : input.designationId,
      managerEmployeeId: input.managerEmployeeId === undefined ? before.managerEmployeeId : input.managerEmployeeId,
      employmentType: input.employmentType ?? before.employmentType,
      employmentStatus: input.employmentStatus ?? before.employmentStatus,
    };
    const transition = snapshotChanged(snapshotOf(before), nextSnapshot);
    if (transition) {
      const effectiveFrom = requestedFrom ?? (await orgToday(trx, orgId));
      await applyHistoryTransition(trx, orgId, id, nextSnapshot, effectiveFrom, changeReason ?? null, actor.userId, joiningDate);
    }
    patch['updatedBy'] = actor.userId;
    await trx.updateTable('employees').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadEmployeeDto(trx, orgId, id);
    const beforeDto = toEmployeeDto(before);
    const diff = diffObjects(beforeDto as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    if (pin !== undefined) (diff.newValue as Record<string, unknown>)['pinSet'] = true;
    await audit(trx, actor, orgId, 'employee.updated', 'employee', { entityId: id, branchId: after.branchId, ...diff, reason: changeReason ?? null });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: id, payload: { changed: Object.keys(diff.newValue), transition, branchId: after.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
    // device-relevant changes (name, card, pin, branch, status) are re-pushed when auto push is enabled
    const deviceRelevant = ['displayName', 'firstName', 'lastName', 'cardNumber', 'branchId', 'employmentStatus', 'deviceUserId'].some((k) => k in diff.newValue) || pin !== undefined;
    if (deviceRelevant) await maybeEnqueuePush(deps, trx, actor, orgId, [id]);
    return maskSensitive(after, grant);
  });
}

export async function deleteEmployee(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: DeleteEmployeeInput): Promise<EmployeeDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.delete', 'employee.update');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadEmployeeRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    if (before.deletedAt) throw errors.invalidState('The employee is already deleted.');
    const joiningDate = isoDate(before.joiningDate);
    const exitDate = input.exitDate ?? (await orgToday(trx, orgId));
    if (exitDate < joiningDate) throw errors.validation('exitDate cannot be before the joining date.', { issues: [{ path: 'exitDate', message: `Must be on/after ${joiningDate}` }] });
    await applyHistoryTransition(trx, orgId, id, { ...snapshotOf(before), employmentStatus: 'terminated' }, exitDate, input.reason ?? 'Deleted', actor.userId, joiningDate);
    await trx.updateTable('employees').set({ deletedAt: new Date(), employmentStatus: 'terminated', exitDate, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await trx.updateTable('deviceEmployeeStates').set({ desired: false }).where('organizationId', '=', orgId).where('employeeId', '=', id).execute();
    await audit(trx, actor, orgId, 'employee.deleted', 'employee', { entityId: id, branchId: before.branchId, oldValue: { employmentStatus: before.employmentStatus, exitDate: before.exitDate }, newValue: { employmentStatus: 'terminated', exitDate, deleted: true }, reason: input.reason ?? null });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.deleted', aggregateType: 'employee', aggregateId: id, payload: { employeeNumber: before.employeeNumber, branchId: before.branchId, exitDate }, actorUserId: actor.userId, requestId: actor.requestId });
    await maybeEnqueuePush(deps, trx, actor, orgId, [id]);
    return maskSensitive(await loadEmployeeDto(trx, orgId, id), grant);
  });
}

export type BulkResult = { kind: 'sync'; updated: number; employeeIds: string[] } | { kind: 'job'; jobId: string };

export async function bulkAction(deps: ApiDeps, actor: Actor, orgId: string, input: BulkEmployeeAction): Promise<BulkResult> {
  switch (input.action) {
    case 'sync_devices': {
      const grant = requirePermission(actor.principal, orgId, 'device.sync');
      return runUser(deps.db, actor, async (trx) => {
        const ids = await visibleEmployeeIds(trx, orgId, grant, input.employeeIds);
        const jobId = await enqueueJob(deps.queue, trx, { queue: 'sync', jobType: 'PUSH_EMPLOYEES', organizationId: orgId, payload: { scope: { employeeIds: ids, deviceIds: input.deviceIds ?? null }, trigger: 'MANUAL', requestedBy: actor.userId }, correlationId: actor.requestId, priority: 7 });
        await audit(trx, actor, orgId, 'employee.sync_requested', 'employee', { newValue: { employeeIds: ids, deviceIds: input.deviceIds ?? null, jobId } });
        return { kind: 'job', jobId };
      });
    }
    case 'export': {
      const grant = requirePermission(actor.principal, orgId, 'employee.export');
      return runUser(deps.db, actor, async (trx) => {
        const ids = input.employeeIds ? await visibleEmployeeIds(trx, orgId, grant, input.employeeIds) : null;
        const jobId = await enqueueJob(deps.queue, trx, { queue: 'reports', jobType: 'EXPORT_EMPLOYEES', organizationId: orgId, payload: { employeeIds: ids, branchIds: grant.allBranches ? null : grant.branchIds, format: input.format, requestedBy: actor.userId }, correlationId: actor.requestId });
        await audit(trx, actor, orgId, 'employee.exported', 'employee', { newValue: { employeeIds: ids, count: ids?.length ?? 'all', format: input.format, jobId } });
        return { kind: 'job', jobId };
      });
    }
    case 'assign_shift': {
      const grant = requirePermission(actor.principal, orgId, 'shift.assign');
      return runUser(deps.db, actor, async (trx) => {
        const shift = await trx.selectFrom('shifts').select('id').where('organizationId', '=', orgId).where('id', '=', input.shiftId).executeTakeFirst();
        if (!shift) throw errors.validation('Shift not found in this organisation.', { issues: [{ path: 'shiftId', message: 'Unknown shift' }] });
        const employees = await visibleEmployees(trx, orgId, grant, input.employeeIds);
        for (const e of employees) {
          await trx.updateTable('shiftAssignments').set({ effectiveTo: input.effectiveFrom }).where('organizationId', '=', orgId).where('targetType', '=', 'EMPLOYEE').where('targetId', '=', e.id).where('effectiveTo', 'is', null).where('effectiveFrom', '<', sql<Date>`${input.effectiveFrom}::date`).execute();
          await trx.insertInto('shiftAssignments').values({ organizationId: orgId, targetType: 'EMPLOYEE', targetId: e.id, branchId: e.branchId, shiftId: input.shiftId, shiftPatternId: null, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, createdBy: actor.userId }).execute();
        }
        await audit(trx, actor, orgId, 'employee.bulk_shift_assigned', 'employee', { newValue: { employeeIds: employees.map((e) => e.id), shiftId: input.shiftId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null } });
        return { kind: 'sync', updated: employees.length, employeeIds: employees.map((e) => e.id) };
      });
    }
    case 'assign_branch':
    case 'assign_department':
    case 'set_status': {
      const grant = requirePermission(actor.principal, orgId, 'employee.update');
      if (input.action === 'assign_branch') requireBranchAccess(grant, input.branchId);
      return runUser(deps.db, actor, async (trx) => {
        if (input.action === 'assign_branch') await assertReferences(trx, orgId, { branchId: input.branchId });
        if (input.action === 'assign_department') await assertReferences(trx, orgId, { departmentId: input.departmentId });
        const effectiveFrom = input.effectiveFrom ?? (await orgToday(trx, orgId));
        const employees = await visibleEmployees(trx, orgId, grant, input.employeeIds);
        const changed: string[] = [];
        for (const e of employees) {
          const next = snapshotOf(e);
          if (input.action === 'assign_branch') next.branchId = input.branchId;
          if (input.action === 'assign_department') next.departmentId = input.departmentId;
          if (input.action === 'set_status') next.employmentStatus = input.employmentStatus;
          if (!snapshotChanged(snapshotOf(e), next)) continue;
          await applyHistoryTransition(trx, orgId, e.id, next, effectiveFrom, `Bulk ${input.action}`, actor.userId, isoDate(e.joiningDate));
          await trx.updateTable('employees').set({ branchId: next.branchId, departmentId: next.departmentId, employmentStatus: next.employmentStatus, updatedBy: actor.userId }).where('organizationId', '=', orgId).where('id', '=', e.id).execute();
          await emitDomainEvent(trx, { organizationId: orgId, eventType: 'employee.updated', aggregateType: 'employee', aggregateId: e.id, payload: { bulk: input.action, transition: true, branchId: next.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
          changed.push(e.id);
        }
        const { employeeIds: _ids, ...rest } = input;
        await audit(trx, actor, orgId, 'employee.bulk_updated', 'employee', { newValue: { ...rest, effectiveFrom, employeeIds: changed } });
        if (changed.length && (input.action === 'assign_branch' || input.action === 'set_status')) await maybeEnqueuePush(deps, trx, actor, orgId, changed);
        return { kind: 'sync', updated: changed.length, employeeIds: changed };
      });
    }
  }
}

async function visibleEmployees(trx: Trx, orgId: string, grant: MembershipGrant, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await trx.selectFrom('employees').select(['id', 'branchId', 'departmentId', 'designationId', 'managerEmployeeId', 'employmentType', 'employmentStatus', 'joiningDate']).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('id', 'in', unique).execute();
  if (rows.length !== unique.length) throw errors.validation('One or more employees were not found or are outside your branch scope.', { missing: unique.filter((id) => !rows.some((r) => r.id === id)) });
  for (const r of rows) requireBranchAccess(grant, r.branchId);
  return rows;
}
async function visibleEmployeeIds(trx: Trx, orgId: string, grant: MembershipGrant, ids: string[]): Promise<string[]> {
  return (await visibleEmployees(trx, orgId, grant, ids)).map((r) => r.id);
}

// Identity documents (sensitive) -----------------------------------------------------------------

export async function listDocuments(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<IdentityDocumentDto[]> {
  requirePermission(actor.principal, orgId, 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    const rows = await trx.selectFrom('employeeIdentityDocuments').select(DOCUMENT_COLUMNS).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).orderBy('createdAt', 'desc').execute();
    await audit(trx, actor, orgId, 'employee.sensitive_viewed', 'employee_identity_document', { entityId: employeeId, branchId: emp.branchId, newValue: { documents: rows.length } });
    return rows.map(toDocumentDto);
  });
}

export async function addDocument(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: IdentityDocumentInput): Promise<IdentityDocumentDto> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update', 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    requireBranchAccess(grant, emp.branchId);
    const row = await trx.insertInto('employeeIdentityDocuments').values({ organizationId: orgId, employeeId, branchId: emp.branchId, type: input.type, number: input.number, issuingCountry: input.issuingCountry ?? null, issuedAt: input.issuedAt ?? null, expiresAt: input.expiresAt ?? null, notes: input.notes ?? null, createdBy: actor.userId }).returning(DOCUMENT_COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'employee.document_added', 'employee_identity_document', { entityId: row.id, branchId: emp.branchId, newValue: { employeeId, type: input.type, numberLast4: input.number.slice(-4), expiresAt: input.expiresAt ?? null } });
    return toDocumentDto(row);
  });
}

export async function deleteDocument(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, documentId: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'employee.update', 'employee.view_sensitive');
  return runUser(deps.db, actor, async (trx) => {
    const emp = await loadEmployeeRow(trx, orgId, employeeId);
    requireBranchAccess(grant, emp.branchId);
    const doc = await trx.selectFrom('employeeIdentityDocuments').select(['id', 'type']).where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('id', '=', documentId).executeTakeFirst();
    if (!doc) throw errors.notFound('Identity document', documentId);
    await trx.deleteFrom('employeeIdentityDocuments').where('id', '=', documentId).execute();
    await audit(trx, actor, orgId, 'employee.document_deleted', 'employee_identity_document', { entityId: documentId, branchId: emp.branchId, oldValue: { employeeId, type: doc.type } });
  });
}

import { sql } from 'kysely';
import type { SyncAttendanceRequest, SyncEmployeesRequest, SyncJobDto, SyncJobItemDto } from '@flowza/contracts';
import { emitDomainEvent, type Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { z } from 'zod';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import type { MembershipGrant } from '@flowza/domain';
import { pageOf, resolveSort, toCount } from '../../lib/pagination.js';
import { jsonObject } from '../../lib/mappers.js';
import type { syncJobListQuerySchema } from '@flowza/contracts';
import type { DeviceReconciliationDto, SyncDeviceScope, SyncJobAcceptedDto, SyncReconcileRequest } from '../../routes/v1/features/dto.js';
import { cancelQueueJob } from './context.js';
import { createSyncJob, MAX_SYNC_ITEMS, type CreatedSyncJob } from './sync-jobs.js';
import { SYNC_ITEM_COLUMNS, SYNC_JOB_COLUMNS, toSyncItemDto, toSyncJobDto, type SyncItemRow, type SyncJobRow } from './mappers.js';

type SyncJobListQuery = z.infer<typeof syncJobListQuerySchema>;
interface DeviceTarget { id: string; branchId: string; capabilities: Record<string, boolean>; integrationType: string }

/** Resolve devices by ids / branch / group / all within the caller's branch scope; only active devices are eligible. */
async function resolveDevices(trx: Trx, orgId: string, grant: MembershipGrant, scope: { deviceIds?: string[]; branchId?: string; groupId?: string; all?: boolean }): Promise<DeviceTarget[]> {
  const branchScope = branchFilter(grant, scope.branchId);
  let q = trx.selectFrom('devices').select(['id', 'branchId', 'capabilities', 'integrationType']).where('organizationId', '=', orgId).where('status', '=', 'active');
  if (branchScope) q = q.where('branchId', 'in', branchScope);
  if (scope.deviceIds && scope.deviceIds.length) q = q.where('id', 'in', [...new Set(scope.deviceIds)]);
  if (scope.groupId) q = q.where('id', 'in', trx.selectFrom('deviceGroupMembers').select('deviceId').where('groupId', '=', scope.groupId));
  const rows = await q.orderBy('name').execute();
  if (scope.deviceIds && scope.deviceIds.length) {
    const missing = [...new Set(scope.deviceIds)].filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw errors.validation('One or more devices were not found, are inactive, or are outside your branch scope.', { missing });
  }
  return rows.map((r) => ({ id: r.id, branchId: r.branchId, capabilities: jsonObject(r.capabilities) as Record<string, boolean>, integrationType: r.integrationType }));
}

function accepted(job: CreatedSyncJob, deviceCount: number, message: string): SyncJobAcceptedDto {
  return { jobId: job.id, status: 'QUEUED', message, itemsTotal: job.itemsTotal, deviceCount };
}

export async function syncAttendance(deps: ApiDeps, actor: Actor, orgId: string, input: SyncAttendanceRequest): Promise<SyncJobAcceptedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const devices = (await resolveDevices(trx, orgId, grant, input)).filter((d) => d.capabilities.attendancePull);
    if (!devices.length) throw errors.validation('No active devices with attendance pull capability matched the scope (push-protocol devices deliver attendance themselves).');
    const job = await createSyncJob(deps, trx, {
      organizationId: orgId, jobType: 'PULL_ATTENDANCE', trigger: 'MANUAL', scope: { deviceIds: input.deviceIds ?? null, branchId: input.branchId ?? null, groupId: input.groupId ?? null, all: input.all, fullResync: input.fullResync },
      branchId: input.branchId ?? (devices.every((d) => d.branchId === devices[0]!.branchId) ? devices[0]!.branchId : null), requestedBy: actor.userId, correlationId: actor.requestId, priority: 7,
      items: devices.map((d) => ({ deviceId: d.id, branchId: d.branchId })), options: { fullResync: input.fullResync },
    });
    await audit(trx, actor, orgId, 'sync.attendance_requested', 'sync_job', { entityId: job.id, branchId: input.branchId ?? null, newValue: { deviceCount: devices.length, fullResync: input.fullResync } });
    return accepted(job, devices.length, `Attendance sync queued for ${devices.length} device(s).`);
  });
}

export async function syncEmployees(deps: ApiDeps, actor: Actor, orgId: string, input: SyncEmployeesRequest): Promise<SyncJobAcceptedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const branchScope = branchFilter(grant, input.branchId);
    let eq = trx.selectFrom('employees').select(['id', 'branchId']).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('employmentStatus', 'in', ['active', 'on_leave']);
    if (branchScope) eq = eq.where('branchId', 'in', branchScope);
    if (input.employeeIds && input.employeeIds.length) eq = eq.where('id', 'in', [...new Set(input.employeeIds)]);
    const employees = await eq.execute();
    if (input.employeeIds && input.employeeIds.length) {
      const missing = [...new Set(input.employeeIds)].filter((id) => !employees.some((e) => e.id === id));
      if (missing.length) throw errors.validation('One or more employees were not found, are inactive, or are outside your branch scope.', { missing });
    }
    const explicitDevices = input.deviceIds && input.deviceIds.length ? await resolveDevices(trx, orgId, grant, { deviceIds: input.deviceIds }) : null;
    const branchDevices = explicitDevices ? null : (await resolveDevices(trx, orgId, grant, { branchId: input.branchId, all: true })).filter((d) => d.capabilities.employeePush);
    const pairs: { deviceId: string; employeeId: string; branchId: string }[] = [];
    for (const e of employees) {
      const targets = (explicitDevices ?? branchDevices ?? []).filter((d) => d.capabilities.employeePush && (explicitDevices ? true : d.branchId === e.branchId));
      for (const d of targets) pairs.push({ deviceId: d.id, employeeId: e.id, branchId: d.branchId });
    }
    if (pairs.length > MAX_SYNC_ITEMS) throw errors.validation(`This request would create ${pairs.length} items; the maximum is ${MAX_SYNC_ITEMS}. Narrow the scope (branch or devices).`, { max: MAX_SYNC_ITEMS, requested: pairs.length });
    if (!pairs.length) throw errors.validation('No (device, employee) pairs matched the scope.');
    const deviceCount = new Set(pairs.map((p) => p.deviceId)).size;
    const job = await createSyncJob(deps, trx, {
      organizationId: orgId, jobType: 'PUSH_EMPLOYEES', trigger: 'MANUAL', scope: { employeeIds: input.employeeIds ?? null, deviceIds: input.deviceIds ?? null, branchId: input.branchId ?? null, all: input.all, removeStale: input.removeStale },
      branchId: input.branchId ?? null, requestedBy: actor.userId, correlationId: actor.requestId, priority: 6, items: pairs.map((p) => ({ deviceId: p.deviceId, employeeId: p.employeeId, branchId: p.branchId, operation: 'PUSH_EMPLOYEE' as const })), options: { removeStale: input.removeStale },
    });
    await audit(trx, actor, orgId, 'sync.employees_requested', 'sync_job', { entityId: job.id, branchId: input.branchId ?? null, newValue: { employees: employees.length, devices: deviceCount, items: pairs.length } });
    return accepted(job, deviceCount, `Employee sync queued: ${pairs.length} item(s) across ${deviceCount} device(s).`);
  });
}

export async function healthCheck(deps: ApiDeps, actor: Actor, orgId: string, input: SyncDeviceScope): Promise<SyncJobAcceptedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const devices = await resolveDevices(trx, orgId, grant, input);
    if (!devices.length) throw errors.validation('No active devices matched the scope.');
    const job = await createSyncJob(deps, trx, { organizationId: orgId, jobType: 'DEVICE_HEALTH_CHECK', trigger: 'MANUAL', scope: { ...input }, branchId: input.branchId ?? null, requestedBy: actor.userId, correlationId: actor.requestId, priority: 3, items: devices.map((d) => ({ deviceId: d.id, branchId: d.branchId })) });
    return accepted(job, devices.length, `Health check queued for ${devices.length} device(s).`);
  });
}

export async function reconcile(deps: ApiDeps, actor: Actor, orgId: string, input: SyncReconcileRequest): Promise<SyncJobAcceptedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const devices = await resolveDevices(trx, orgId, grant, input);
    if (!devices.length) throw errors.validation('No active devices matched the scope.');
    const job = await createSyncJob(deps, trx, { organizationId: orgId, jobType: 'RECONCILIATION', trigger: 'MANUAL', scope: { deviceIds: input.deviceIds ?? null, branchId: input.branchId ?? null, groupId: input.groupId ?? null, all: input.all, repair: input.repair }, branchId: input.branchId ?? null, requestedBy: actor.userId, correlationId: actor.requestId, priority: 4, items: devices.map((d) => ({ deviceId: d.id, branchId: d.branchId })), options: { repair: input.repair } });
    await audit(trx, actor, orgId, 'sync.reconciliation_requested', 'sync_job', { entityId: job.id, branchId: input.branchId ?? null, newValue: { deviceCount: devices.length, repair: input.repair } });
    return accepted(job, devices.length, `Reconciliation queued for ${devices.length} device(s).`);
  });
}

// ----- queries ---------------------------------------------------------------------------------------------------------

const JOB_SORT = { createdAt: 'j.created_at', status: 'j.status', jobType: 'j.job_type', finishedAt: 'j.finished_at' } as const;

function jobQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('syncJobs as j').leftJoin('userProfiles as u', 'u.id', 'j.requestedBy').where('j.organizationId', '=', orgId);
}

export async function listJobs(deps: ApiDeps, actor: Actor, orgId: string, q: SyncJobListQuery): Promise<{ data: SyncJobDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(JOB_SORT, q.sort, q.order === 'asc' && !q.sort ? 'desc' : q.order, 'j.created_at');
  return runUser(deps.db, actor, async (trx) => {
    let base = jobQuery(trx, orgId);
    if (q.status) base = base.where('j.status', '=', q.status);
    if (q.jobType) base = base.where('j.jobType', '=', q.jobType);
    if (q.deviceId) base = base.where('j.id', 'in', trx.selectFrom('syncJobItems').select('syncJobId').where('deviceId', '=', q.deviceId));
    if (scope) base = base.where((eb) => eb.or([eb('j.branchId', 'in', scope), eb.and([eb('j.branchId', 'is', null), eb('j.id', 'in', trx.selectFrom('syncJobItems').select('syncJobId').where('branchId', 'in', scope))])]));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(SYNC_JOB_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('j.id').limit(page.pageSize).offset(page.offset).execute()) as SyncJobRow[];
    return { data: rows.map(toSyncJobDto), total };
  });
}

async function loadJob(trx: Trx, orgId: string, id: string): Promise<SyncJobRow> {
  const row = await jobQuery(trx, orgId).select(SYNC_JOB_COLUMNS).where('j.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Sync job', id);
  return row as SyncJobRow;
}

/**
 * Mutating a job (cancel / retry) needs the *whole* job inside the caller's branch scope. A job without a branch spans several
 * branches; RLS would let a branch-scoped caller see only their own items, so cancelling would mark the job CANCELLED while
 * other branches' items are still queued. Such callers are refused unless every item is in their scope.
 */
async function requireJobInScope(trx: Trx, grant: MembershipGrant, job: SyncJobRow): Promise<void> {
  requireBranchAccess(grant, job.branchId);
  if (grant.allBranches || job.branchId) return;
  const outside = await trx.selectFrom('syncJobItems').select((eb) => eb.fn.countAll().as('n')).where('syncJobId', '=', job.id)
    .where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', 'not in', grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000'])])).executeTakeFirst();
  // RLS already hides foreign items, so compare against the stored total as well
  if (toCount(outside?.n) > 0 || toCount((await trx.selectFrom('syncJobItems').select((eb) => eb.fn.countAll().as('n')).where('syncJobId', '=', job.id).executeTakeFirst())?.n) !== job.itemsTotal) {
    throw errors.forbidden('This job spans branches outside your access scope.');
  }
}

export async function getJob(deps: ApiDeps, actor: Actor, orgId: string, id: string, itemsQuery: { page: number; pageSize: number; status?: string }): Promise<{ job: SyncJobDto; items: { data: SyncJobItemDto[]; total: number } }> {
  requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    const items = await listItemsIn(trx, orgId, id, itemsQuery);
    return { job: toSyncJobDto(job), items };
  });
}

async function listItemsIn(trx: Trx, orgId: string, jobId: string, q: { page: number; pageSize: number; status?: string; deviceId?: string }): Promise<{ data: SyncJobItemDto[]; total: number }> {
  let base = trx.selectFrom('syncJobItems as i').leftJoin('devices as d', 'd.id', 'i.deviceId').leftJoin('employees as e', 'e.id', 'i.employeeId').where('i.organizationId', '=', orgId).where('i.syncJobId', '=', jobId);
  if (q.status) base = base.where('i.status', '=', q.status as never);
  if (q.deviceId) base = base.where('i.deviceId', '=', q.deviceId);
  const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
  const page = pageOf(q);
  const rows = (await base.select(SYNC_ITEM_COLUMNS).orderBy('i.createdAt').orderBy('i.id').limit(page.pageSize).offset(page.offset).execute()) as SyncItemRow[];
  return { data: rows.map(toSyncItemDto), total };
}

export async function listItems(deps: ApiDeps, actor: Actor, orgId: string, jobId: string, q: { page: number; pageSize: number; status?: string; deviceId?: string }) {
  requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => { await loadJob(trx, orgId, jobId); return listItemsIn(trx, orgId, jobId, q); });
}

export async function cancelJob(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<SyncJobDto & { cancelledItems: number }> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    await requireJobInScope(trx, grant, job);
    if (['SUCCESS', 'FAILED', 'CANCELLED', 'PARTIAL_SUCCESS'].includes(job.status)) throw errors.invalidState(`The job is already ${job.status}.`);
    const open = await trx.selectFrom('syncJobItems').select(['id', 'queueJobId']).where('syncJobId', '=', id).where('status', 'in', ['PENDING', 'QUEUED']).execute();
    for (const it of open) if (it.queueJobId) await cancelQueueJob(trx, String(it.queueJobId));
    if (open.length) await trx.updateTable('syncJobItems').set({ status: 'CANCELLED', finishedAt: new Date() }).where('id', 'in', open.map((i) => i.id)).execute();
    const remaining = toCount((await trx.selectFrom('syncJobItems').select((eb) => eb.fn.countAll().as('n')).where('syncJobId', '=', id).where('status', 'in', ['RUNNING', 'RETRYING']).executeTakeFirst())?.n);
    await trx.updateTable('syncJobs').set({ itemsPending: remaining, ...(remaining === 0 ? { status: 'CANCELLED', finishedAt: new Date() } : {}), summary: JSON.stringify({ ...jsonObject(job.summary), cancelledBy: actor.userId, cancelledItems: open.length, cancelledAt: new Date().toISOString() }) }).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'sync.job_cancelled', 'sync_job', { entityId: id, branchId: job.branchId, newValue: { cancelledItems: open.length, remainingRunning: remaining } });
    return { ...toSyncJobDto(await loadJob(trx, orgId, id)), cancelledItems: open.length };
  });
}

export async function retryFailed(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<SyncJobAcceptedDto & { parentJobId: string }> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const job = await loadJob(trx, orgId, id);
    await requireJobInScope(trx, grant, job);
    const failed = await trx.selectFrom('syncJobItems').select(['deviceId', 'employeeId', 'branchId', 'operation']).where('syncJobId', '=', id).where('status', 'in', ['FAILED', 'OFFLINE']).execute();
    const items = failed.filter((f): f is typeof f & { deviceId: string } => f.deviceId !== null);
    if (!items.length) throw errors.invalidState('The job has no failed or offline items to retry.');
    const activeDevices = new Set((await trx.selectFrom('devices').select('id').where('organizationId', '=', orgId).where('status', '=', 'active').where('id', 'in', [...new Set(items.map((i) => i.deviceId))]).execute()).map((d) => d.id));
    const retryable = items.filter((i) => activeDevices.has(i.deviceId));
    if (!retryable.length) throw errors.invalidState('The failed items belong to devices that are no longer active.');
    const created = await createSyncJob(deps, trx, {
      organizationId: orgId, jobType: job.jobType, trigger: 'MANUAL', scope: { ...jsonObject(job.scope), retryOf: id }, branchId: job.branchId, requestedBy: actor.userId, correlationId: actor.requestId, priority: 7, parentJobId: id,
      items: retryable.map((i) => ({ deviceId: i.deviceId, employeeId: i.employeeId, branchId: i.branchId, operation: i.operation })), options: jsonObject(jsonObject(job.scope).options),
    });
    await audit(trx, actor, orgId, 'sync.retry_requested', 'sync_job', { entityId: created.id, branchId: job.branchId, newValue: { parentJobId: id, items: retryable.length } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'sync.queued', aggregateType: 'sync_job', aggregateId: created.id, payload: { retryOf: id }, actorUserId: actor.userId, requestId: actor.requestId });
    return { ...accepted(created, new Set(retryable.map((i) => i.deviceId)).size, `Retry queued for ${retryable.length} item(s).`), parentJobId: id };
  });
}

/** Latest RECONCILIATION item per device (summary produced by the worker's reconciliation handler). */
export async function reconciliationSummary(deps: ApiDeps, actor: Actor, orgId: string, q: { branchId?: string; deviceId?: string }): Promise<DeviceReconciliationDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let dq = trx.selectFrom('devices').select(['id', 'code', 'name', 'branchId']).where('organizationId', '=', orgId).where('status', '!=', 'decommissioned');
    if (scope) dq = dq.where('branchId', 'in', scope);
    if (q.deviceId) dq = dq.where('id', '=', q.deviceId);
    const devices = await dq.orderBy('name').execute();
    if (!devices.length) return [];
    const latest = await sql<{ deviceId: string; syncJobId: string; itemId: string; status: string; finishedAt: Date | null; result: unknown; summary: unknown }>`
      select distinct on (i.device_id) i.device_id as device_id, i.sync_job_id as sync_job_id, i.id as item_id, i.status as status, i.finished_at as finished_at, i.result as result, j.summary as summary
      from public.sync_job_items i join public.sync_jobs j on j.id = i.sync_job_id
      where i.organization_id = ${orgId}::uuid and i.operation = 'RECONCILIATION' and i.device_id = any(${sql.val(devices.map((d) => d.id))}::uuid[])
      order by i.device_id, i.created_at desc`.execute(trx);
    const byDevice = new Map(latest.rows.map((r) => [r.deviceId, r]));
    return devices.map((d) => {
      const r = byDevice.get(d.id);
      return { deviceId: d.id, deviceCode: d.code, deviceName: d.name, branchId: d.branchId, syncJobId: r?.syncJobId ?? null, itemId: r?.itemId ?? null, status: r?.status ?? null, finishedAt: r?.finishedAt ? new Date(r.finishedAt).toISOString() : null, summary: r ? (r.result ? jsonObject(r.result) : r.summary ? jsonObject(r.summary) : null) : null };
    });
  });
}

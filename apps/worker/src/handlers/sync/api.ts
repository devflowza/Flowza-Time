/**
 * Sync job creation — shared by the scheduler ticks, the fan-out handlers and (by contract) the API.
 *
 * QUEUE PAYLOAD CONTRACT (the API must follow this when it enqueues sync work itself; ADR-006, docs/sync-engine.md)
 * ----------------------------------------------------------------------------------------------------------------
 *   queue:      'sync'
 *   jobType:    the item operation — one of SYNC_JOB_TYPES ('PULL_ATTENDANCE' | 'PULL_EMPLOYEES' | 'PUSH_EMPLOYEE' |
 *               'PUSH_EMPLOYEES' | 'DEVICE_HEALTH_CHECK' | 'RECONCILIATION' | 'TEST_CONNECTION' | 'DELETE_EMPLOYEE')
 *               plus the non-item type 'WEBHOOK_EVENT'.
 *   organizationId: the tenant (never taken from a request body).
 *   payload (per-item jobs): {
 *     syncJobId: uuid, syncJobItemId: uuid, organizationId: uuid, deviceId: uuid | null, employeeId: uuid | null,
 *     operation: SyncJobType, options: Record<string, unknown>
 *   }
 *     - PULL_ATTENDANCE options: { fullResync?: boolean, maxPages?: number (default 20), pageSize?: number }
 *     - PUSH_EMPLOYEE options:   { force?: boolean, pin?: string }   (pin travels in the queue payload only; never stored on results)
 *     - DELETE_EMPLOYEE options: { deviceUserId?: string }           (device-only user without an employee row)
 *     - RECONCILIATION options:  { repair?: boolean }
 *     Itemless shape { organizationId, deviceId, employeeId?, options?, trigger?, requestedBy? } is also accepted: the handler
 *     materialises a one-item sync job on first run. Prefer `createSyncJob()` so the job is visible before it runs.
 *   payload (PUSH_EMPLOYEES fan-out): { syncJobId?: uuid, employeeIds?: uuid[], deviceIds?: uuid[], scope?: { employeeIds?, deviceIds?, branchId? },
 *     trigger?: SyncTrigger, requestedBy?: uuid, options?: { force?: boolean } } — creates the sync job (when absent) and one PUSH_EMPLOYEE item per (employee, device).
 *   payload (WEBHOOK_EVENT): { webhookEventId: uuid, organizationId: uuid } — the provider_webhook_events row holds either the
 *     normalised form { vendorDeviceId, eventType?, transactions: RawTransaction[] } or the raw vendor body (+ headers) which the
 *     handler re-parses through provider.handleWebhook with the device's stored secrets.
 *   dedupeKey:  PULL_ATTENDANCE → `pull:<deviceId>`; DEVICE_HEALTH_CHECK → `health:<deviceId>`; PUSH_EMPLOYEE →
 *               `push:<deviceId>:<employeeId>:<syncJobId>`; DELETE_EMPLOYEE → `delete:<deviceId>:<employeeId|deviceUserId>:<syncJobId>`;
 *               others → `<operation lower-case>:<deviceId>:<syncJobId>`; WEBHOOK_EVENT → `webhook:<webhookEventId>`.
 *   priority:   manual 7, system 5–6, scheduled polls 4, health checks 2, reconciliation 3.
 *   maxAttempts must equal sync_job_items.max_attempts (default 6) so the item reaches a terminal state before the queue dead-letters.
 *   Always enqueue in the SAME transaction as the sync_jobs/sync_job_items insert (JobQueue.enqueue(opts, trx)).
 */
import { sql } from 'kysely';
import type { SyncJobType, SyncTrigger } from '@flowza/contracts';
import { emitDomainEvent, type JobQueue, type Trx } from '@flowza/database';
import { newCorrelationId } from '@flowza/shared';

export interface SyncJobItemInput { deviceId: string | null; employeeId?: string | null; operation: SyncJobType; branchId?: string | null; options?: Record<string, unknown> }

export interface CreateSyncJobInput {
  organizationId: string;
  jobType: SyncJobType;
  trigger: SyncTrigger;
  scope?: Record<string, unknown>;
  branchId?: string | null;
  requestedBy?: string | null;
  correlationId?: string;
  parentJobId?: string | null;
  items: SyncJobItemInput[];
  priority?: number;
  /** Default options merged into every item (item options win). */
  options?: Record<string, unknown>;
  maxAttempts?: number;
  lockTimeoutSeconds?: number;
}

export interface CreateSyncJobResult { syncJobId: string; itemIds: string[]; queued: number; skipped: number }

export function dedupeKeyFor(op: SyncJobType, deviceId: string | null, employeeId: string | null, syncJobId: string, options: Record<string, unknown> = {}): string {
  switch (op) {
    case 'PULL_ATTENDANCE': return `pull:${deviceId}`;
    case 'DEVICE_HEALTH_CHECK': return `health:${deviceId}`;
    case 'PUSH_EMPLOYEE': return `push:${deviceId}:${employeeId}:${syncJobId}`;
    case 'DELETE_EMPLOYEE': return `delete:${deviceId}:${employeeId ?? String(options['deviceUserId'] ?? '')}:${syncJobId}`;
    default: return `${op.toLowerCase()}:${deviceId}:${syncJobId}`;
  }
}

export const DEFAULT_PRIORITY: Record<SyncTrigger, number> = { MANUAL: 7, SYSTEM: 5, WEBHOOK: 6, DEVICE_PUSH: 6, SCHEDULED: 4 };

export interface AddItemsInput { organizationId: string; syncJobId: string; items: SyncJobItemInput[]; priority: number; correlationId: string; options?: Record<string, unknown>; maxAttempts?: number; lockTimeoutSeconds?: number; branchId?: string | null }
export interface AddItemsResult { itemIds: string[]; queued: number; skipped: number }

/**
 * Inserts items for an existing sync job and enqueues one queue job per item in the same transaction, then bumps
 * `items_total` / `items_pending`. An item whose dedupe key is already in flight (e.g. a manual pull while the scheduled pull
 * runs) is marked SKIPPED at once so the job can still complete; the running job's results cover it.
 */
export async function addSyncJobItems(trx: Trx, queue: JobQueue, input: AddItemsInput): Promise<AddItemsResult> {
  const now = new Date();
  const maxAttempts = input.maxAttempts ?? 6;
  const { syncJobId } = input;
  const itemIds: string[] = [];
  let queued = 0;
  let skipped = 0;
  if (input.items.length === 0) return { itemIds, queued, skipped };
  const inserted = await trx.insertInto('syncJobItems').values(input.items.map((it) => ({
    organizationId: input.organizationId, syncJobId, deviceId: it.deviceId, employeeId: it.employeeId ?? null, operation: it.operation, branchId: it.branchId ?? input.branchId ?? null, status: 'QUEUED' as const, maxAttempts,
  }))).returning(['id', 'deviceId', 'employeeId', 'operation']).execute();
  for (const [i, row] of inserted.entries()) {
    const options = { ...(input.options ?? {}), ...(input.items[i]?.options ?? {}) };
    const dedupeKey = dedupeKeyFor(row.operation, row.deviceId, row.employeeId, syncJobId, options);
    const payload = { syncJobId, syncJobItemId: row.id, organizationId: input.organizationId, deviceId: row.deviceId, employeeId: row.employeeId, operation: row.operation, options };
    const queueJobId = await queue.enqueue({ queue: 'sync', jobType: row.operation, organizationId: input.organizationId, payload, priority: input.priority, dedupeKey, maxAttempts, lockTimeoutSeconds: input.lockTimeoutSeconds ?? (row.operation === 'PULL_ATTENDANCE' ? 900 : 600), correlationId: input.correlationId }, trx);
    // jobs.enqueue returns the in-flight job when the dedupe key collides; that job carries another item id
    const owner = await sql<{ itemId: string | null }>`select payload->>'syncJobItemId' as "itemId" from jobs.queue where id = ${queueJobId}::bigint`.execute(trx);
    if (owner.rows[0]?.itemId === row.id) {
      await trx.updateTable('syncJobItems').set({ queueJobId }).where('id', '=', row.id).execute();
      queued++;
    } else {
      await trx.updateTable('syncJobItems').set({ status: 'SKIPPED', finishedAt: now, result: JSON.stringify({ skipped: 'duplicate_in_flight', queueJobId }) }).where('id', '=', row.id).execute();
      skipped++;
    }
    itemIds.push(row.id);
  }
  await trx.updateTable('syncJobs').set((eb) => ({
    itemsTotal: eb('itemsTotal', '+', inserted.length), itemsPending: eb('itemsPending', '+', queued),
    status: sql`case when status in ('PENDING', 'SUCCESS') and ${queued} > 0 then 'QUEUED'::public.sync_status else status end`, queuedAt: sql`coalesce(queued_at, ${now})`, finishedAt: queued > 0 ? null : sql`finished_at`,
  })).where('id', '=', syncJobId).execute();
  return { itemIds, queued, skipped };
}

/**
 * Inserts the user-facing sync job + its items and enqueues one queue job per item in the same transaction (§F.2).
 * Returns the job id for the `{ jobId, status: 'QUEUED' }` reply. A job without runnable items completes immediately.
 */
export async function createSyncJob(trx: Trx, queue: JobQueue, input: CreateSyncJobInput): Promise<CreateSyncJobResult> {
  const now = new Date();
  const priority = input.priority ?? DEFAULT_PRIORITY[input.trigger];
  const correlationId = input.correlationId ?? newCorrelationId('sync');
  const job = await trx.insertInto('syncJobs').values({
    organizationId: input.organizationId, jobType: input.jobType, trigger: input.trigger, scope: JSON.stringify(input.scope ?? {}), branchId: input.branchId ?? null,
    status: 'PENDING', priority, requestedBy: input.requestedBy ?? null, correlationId, parentJobId: input.parentJobId ?? null,
  }).returning('id').executeTakeFirstOrThrow();
  const syncJobId = job.id;
  const added = await addSyncJobItems(trx, queue, { organizationId: input.organizationId, syncJobId, items: input.items, priority, correlationId, options: input.options, maxAttempts: input.maxAttempts, lockTimeoutSeconds: input.lockTimeoutSeconds, branchId: input.branchId });
  if (added.queued === 0) {
    await trx.updateTable('syncJobs').set({ status: 'SUCCESS', queuedAt: now, finishedAt: now, summary: JSON.stringify({ items: input.items.length, skipped: added.skipped }) }).where('id', '=', syncJobId).execute();
  }
  await emitDomainEvent(trx, { organizationId: input.organizationId, eventType: 'sync.queued', aggregateType: 'sync_job', aggregateId: syncJobId, payload: { syncJobId, jobType: input.jobType, trigger: input.trigger, items: input.items.length }, actorUserId: input.requestedBy ?? null });
  return { syncJobId, itemIds: added.itemIds, queued: added.queued, skipped: added.skipped };
}

import { sql } from 'kysely';
import type { SyncJobType, SyncTrigger } from '@flowza/contracts';
import { newCorrelationId } from '@flowza/shared';
import type { Trx } from './context.js';
import { emitDomainEvent } from './events.js';
import type { JobQueue } from './queue.js';

/**
 * Sync job fan-out (blueprint §F.2, docs/sync-engine.md "Two layers") — the ONE implementation used by the worker (scheduler
 * ticks, PUSH_EMPLOYEES / RECONCILIATION fan-outs) and by the API (manual syncs, device actions, retry-failed).
 *
 * `createSyncJob(trx, queue, input)` inserts the user-facing `sync_jobs` row, one `sync_job_items` row per (device[, employee])
 * and one queue job per item through `queue.enqueue(opts, trx)` — all inside the caller's transaction (AGENTS.md rule 5: a
 * rollback leaves nothing behind). `queue.enqueue` goes through `app.enqueue_job` (SECURITY DEFINER), so the same code runs in
 * a system-for-org transaction (worker, API `systemStep`) and — apart from the dedupe lookup on `jobs.queue`, which needs the
 * `flowza_system` grants — in a user transaction. The API therefore wraps the call in a system step after its own permission and
 * branch-scope checks; the worker already runs in system context.
 *
 * Queue payload contract (queue `sync`, jobType = item operation): see the JSDoc in apps/worker/src/handlers/sync/api.ts.
 */

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
    // a second reboot while one is still pending is a duplicate, never a second reboot
    case 'RESTART_DEVICE': return `restart:${deviceId}`;
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
  // one enqueue per item (app.enqueue_job is a per-row function), then ONE lookup + two batched updates instead of 3 statements per item
  const queueJobByItem = new Map<string, string>();
  for (const [i, row] of inserted.entries()) {
    const options = { ...(input.options ?? {}), ...(input.items[i]?.options ?? {}) };
    const dedupeKey = dedupeKeyFor(row.operation, row.deviceId, row.employeeId, syncJobId, options);
    const payload = { syncJobId, syncJobItemId: row.id, organizationId: input.organizationId, deviceId: row.deviceId, employeeId: row.employeeId, operation: row.operation, options };
    const queueJobId = await queue.enqueue({ queue: 'sync', jobType: row.operation, organizationId: input.organizationId, payload, priority: input.priority, dedupeKey, maxAttempts, lockTimeoutSeconds: input.lockTimeoutSeconds ?? (row.operation === 'PULL_ATTENDANCE' ? 900 : 600), correlationId: input.correlationId }, trx);
    queueJobByItem.set(row.id, queueJobId);
    itemIds.push(row.id);
  }
  // jobs.enqueue returns the in-flight job when the dedupe key collides; that job carries another item id
  const owners = await sql<{ id: string; itemId: string | null }>`select id::text as id, payload->>'syncJobItemId' as "itemId" from jobs.queue where id = any(${sql.val([...queueJobByItem.values()])}::bigint[])`.execute(trx);
  const ownerOf = new Map(owners.rows.map((r) => [r.id, r.itemId]));
  const ownItems: Array<{ id: string; queueJobId: string }> = [];
  const dupItems: Array<{ id: string; queueJobId: string }> = [];
  for (const [itemId, queueJobId] of queueJobByItem) (ownerOf.get(queueJobId) === itemId ? ownItems : dupItems).push({ id: itemId, queueJobId });
  if (ownItems.length > 0) {
    await sql`update public.sync_job_items i set queue_job_id = v.queue_job_id
              from (select unnest(${sql.val(ownItems.map((o) => o.id))}::uuid[]) as id, unnest(${sql.val(ownItems.map((o) => o.queueJobId))}::bigint[]) as queue_job_id) v
              where i.id = v.id`.execute(trx);
    queued = ownItems.length;
  }
  if (dupItems.length > 0) {
    await sql`update public.sync_job_items i set status = 'SKIPPED', finished_at = ${now}, result = jsonb_build_object('skipped', 'duplicate_in_flight', 'queueJobId', v.queue_job_id::text)
              from (select unnest(${sql.val(dupItems.map((o) => o.id))}::uuid[]) as id, unnest(${sql.val(dupItems.map((o) => o.queueJobId))}::bigint[]) as queue_job_id) v
              where i.id = v.id`.execute(trx);
    skipped = dupItems.length;
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
  await emitDomainEvent(trx, { organizationId: input.organizationId, eventType: 'sync.queued', aggregateType: 'sync_job', aggregateId: syncJobId, payload: { syncJobId, jobType: input.jobType, trigger: input.trigger, items: input.items.length }, actorUserId: input.requestedBy ?? null, requestId: input.correlationId ?? null });
  return { syncJobId, itemIds: added.itemIds, queued: added.queued, skipped: added.skipped };
}

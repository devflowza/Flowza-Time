import { sql } from 'kysely';
import type { SyncJobType, SyncTrigger } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { emitDomainEvent } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { withQueueRole } from './context.js';

/**
 * Sync job fan-out (docs/sync-engine.md "Two layers"). One user-facing `sync_jobs` row, one `sync_job_items` row per
 * (device[, employee]) and one queue job per item on the `sync` queue — all in the caller's transaction so a rollback
 * leaves nothing behind (AGENTS.md rule 5).
 *
 * Queue payload contract (consumed by apps/worker/src/handlers/sync/*):
 *   { syncJobId, syncJobItemId, organizationId, deviceId, employeeId?, operation, options }
 *
 * NOTE for the integrator: the worker's own fan-out (scheduler ticks, PUSH_EMPLOYEES from employee changes) should
 * converge on this helper; it lives here (not in @flowza/database) only because package exports are frozen for this
 * work stream.
 */
export interface SyncJobItemInput { deviceId: string; employeeId?: string | null; branchId?: string | null; operation?: SyncJobType }
export interface CreateSyncJobInput {
  organizationId: string;
  jobType: SyncJobType;
  trigger: SyncTrigger;
  scope: Record<string, unknown>;
  branchId?: string | null;
  requestedBy?: string | null;
  correlationId: string;
  priority?: number;
  parentJobId?: string | null;
  items: SyncJobItemInput[];
  options?: Record<string, unknown>;
  maxAttempts?: number;
}
export interface CreatedSyncJob { id: string; itemsTotal: number; itemIds: string[]; queueJobIds: string[] }

export const MAX_SYNC_ITEMS = 50_000;
const ITEM_CHUNK = 500;

export async function createSyncJob(deps: ApiDeps, trx: Trx, input: CreateSyncJobInput): Promise<CreatedSyncJob> {
  if (input.items.length === 0) throw errors.validation('No devices matched the requested scope.');
  if (input.items.length > MAX_SYNC_ITEMS) throw errors.validation(`A sync job may contain at most ${MAX_SYNC_ITEMS} items (requested ${input.items.length}).`, { max: MAX_SYNC_ITEMS, requested: input.items.length });
  const priority = input.priority ?? 5;
  const options = input.options ?? {};
  const job = await trx.insertInto('syncJobs').values({
    organizationId: input.organizationId,
    jobType: input.jobType,
    trigger: input.trigger,
    // options travel with the scope so `retry-failed` can replay them (fullResync, repair, removeStale)
    scope: JSON.stringify({ ...input.scope, options }),
    branchId: input.branchId ?? null,
    status: 'QUEUED',
    priority,
    itemsTotal: input.items.length,
    itemsPending: input.items.length,
    requestedBy: input.requestedBy ?? null,
    correlationId: input.correlationId,
    parentJobId: input.parentJobId ?? null,
    queuedAt: new Date(),
  }).returning('id').executeTakeFirstOrThrow();

  const itemIds: string[] = [];
  const queueJobIds: string[] = [];
  for (let i = 0; i < input.items.length; i += ITEM_CHUNK) {
    const chunk = input.items.slice(i, i + ITEM_CHUNK);
    const rows = await trx.insertInto('syncJobItems').values(chunk.map((it) => ({
      organizationId: input.organizationId,
      syncJobId: job.id,
      deviceId: it.deviceId,
      branchId: it.branchId ?? null,
      employeeId: it.employeeId ?? null,
      operation: it.operation ?? input.jobType,
      status: 'QUEUED',
      maxAttempts: input.maxAttempts ?? 6,
    }))).returning(['id', 'deviceId', 'employeeId', 'operation']).execute();
    // bulk enqueue: one queue job per item, inserted directly (jobs.enqueue is per-row; 50k round trips would be too slow)
    const queued = await withQueueRole(trx, (t) => t.insertInto('jobs.queue').values(rows.map((r) => ({
      queueName: 'sync',
      jobType: r.operation,
      organizationId: input.organizationId,
      payload: JSON.stringify({ syncJobId: job.id, syncJobItemId: r.id, organizationId: input.organizationId, deviceId: r.deviceId, ...(r.employeeId ? { employeeId: r.employeeId } : {}), operation: r.operation, options }),
      priority,
      runAt: new Date(),
      maxAttempts: input.maxAttempts ?? 6,
      lockTimeoutSeconds: 600,
      correlationId: input.correlationId,
    }))).returning(['id', 'payload']).execute());
    const byItem = new Map<string, string>();
    for (const q of queued) {
      const p = q.payload as { syncJobItemId?: string };
      if (p.syncJobItemId) byItem.set(p.syncJobItemId, String(q.id));
    }
    for (const r of rows) {
      const qid = byItem.get(r.id);
      itemIds.push(r.id);
      if (qid) {
        queueJobIds.push(qid);
        await trx.updateTable('syncJobItems').set({ queueJobId: qid }).where('id', '=', r.id).execute();
      }
    }
  }
  await emitDomainEvent(trx, { organizationId: input.organizationId, eventType: 'sync.queued', aggregateType: 'sync_job', aggregateId: job.id, payload: { jobType: input.jobType, itemsTotal: input.items.length, trigger: input.trigger }, actorUserId: input.requestedBy ?? null, requestId: input.correlationId });
  return { id: job.id, itemsTotal: input.items.length, itemIds, queueJobIds };
}

/** Count helper used by list endpoints (bigint → number). */
export function count(value: unknown): number { return typeof value === 'number' ? value : Number(value ?? 0); }

/** Rows of `sync_job_items` grouped per status for one job (refreshes the counters if the worker has not yet). */
export async function itemStatusCounts(trx: Trx, syncJobId: string): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: string }>`select status, count(*) as n from public.sync_job_items where sync_job_id = ${syncJobId}::uuid group by status`.execute(trx);
  return Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]));
}

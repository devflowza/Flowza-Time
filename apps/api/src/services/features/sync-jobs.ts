import { sql } from 'kysely';
import type { SyncJobType, SyncTrigger } from '@flowza/contracts';
import { createSyncJob as createSyncJobShared, type Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { systemStep } from './context.js';

/**
 * Sync job fan-out for the API (docs/sync-engine.md "Two layers"). The implementation is the shared
 * `createSyncJob` from `@flowza/database` (packages/database/src/sync-jobs.ts) — the same code the worker's scheduler and
 * fan-out handlers use — so both sides produce identical `sync_jobs` / `sync_job_items` rows, dedupe keys and queue payloads:
 *   { syncJobId, syncJobItemId, organizationId, deviceId, employeeId, operation, options }   (queue `sync`, jobType = operation)
 *
 * The API adds request-level validation (empty scope, item cap) and runs the fan-out as a *system step inside the caller's
 * transaction*: the service has already checked the permission and resolved devices/employees under the caller's RLS, and the
 * shared code reads `jobs.queue` (dedupe collisions → SKIPPED items), which only `flowza_system` may do. Everything still
 * commits or rolls back together with the caller's writes (AGENTS.md rule 5).
 */
export interface SyncJobItemInput { deviceId: string; employeeId?: string | null; branchId?: string | null; operation?: SyncJobType; options?: Record<string, unknown> }
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
export interface CreatedSyncJob { id: string; itemsTotal: number; itemIds: string[]; queued: number; skipped: number }

export const MAX_SYNC_ITEMS = 50_000;

export async function createSyncJob(deps: ApiDeps, trx: Trx, input: CreateSyncJobInput): Promise<CreatedSyncJob> {
  if (input.items.length === 0) throw errors.validation('No devices matched the requested scope.');
  if (input.items.length > MAX_SYNC_ITEMS) throw errors.validation(`A sync job may contain at most ${MAX_SYNC_ITEMS} items (requested ${input.items.length}).`, { max: MAX_SYNC_ITEMS, requested: input.items.length });
  const options = input.options ?? {};
  const created = await systemStep(trx, input.organizationId, (t) => createSyncJobShared(t, deps.queue, {
    organizationId: input.organizationId,
    jobType: input.jobType,
    trigger: input.trigger,
    // options travel with the scope so `retry-failed` can replay them (fullResync, repair, removeStale)
    scope: { ...input.scope, options },
    branchId: input.branchId ?? null,
    requestedBy: input.requestedBy ?? null,
    correlationId: input.correlationId,
    priority: input.priority ?? 5,
    parentJobId: input.parentJobId ?? null,
    items: input.items.map((it) => ({ deviceId: it.deviceId, employeeId: it.employeeId ?? null, branchId: it.branchId ?? null, operation: it.operation ?? input.jobType, ...(it.options ? { options: it.options } : {}) })),
    options,
    maxAttempts: input.maxAttempts ?? 6,
  }));
  return { id: created.syncJobId, itemsTotal: input.items.length, itemIds: created.itemIds, queued: created.queued, skipped: created.skipped };
}

/** Count helper used by list endpoints (bigint → number). */
export function count(value: unknown): number { return typeof value === 'number' ? value : Number(value ?? 0); }

/** Rows of `sync_job_items` grouped per status for one job (refreshes the counters if the worker has not yet). */
export async function itemStatusCounts(trx: Trx, syncJobId: string): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: string }>`select status, count(*) as n from public.sync_job_items where sync_job_id = ${syncJobId}::uuid group by status`.execute(trx);
  return Object.fromEntries(rows.rows.map((r) => [r.status, Number(r.n)]));
}

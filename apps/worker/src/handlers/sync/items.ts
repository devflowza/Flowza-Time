import { sql } from 'kysely';
import { SYNC_JOB_TYPES, SYNC_TRIGGERS, type SyncJobType, type SyncTrigger } from '@flowza/contracts';
import { emitDomainEvent, withContext, type SyncItemStatus, type SyncStatus, type Trx } from '@flowza/database';
import { ProviderError } from '@flowza/device-providers';
import { DEFAULT_RETRY_POLICY, decideRetry, type RetryDecision, type SyncErrorCode } from '@flowza/domain';
import { AppError, event, newCorrelationId } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { FINAL_ITEM_STATUSES, type SyncItemPayload, type SyncJobItemRow } from './types.js';

export type { SyncItemPayload };

const SYNC_CODES = new Set<string>(['AUTH_FAILED', 'DEVICE_OFFLINE', 'RATE_LIMITED', 'TIMEOUT', 'UNSUPPORTED', 'NOT_FOUND', 'INVALID_CONFIG', 'VENDOR_ERROR', 'NOT_IMPLEMENTED', 'PROTOCOL_ERROR', 'CONFLICT']);

/** Maps any thrown error to the provider-agnostic retry vocabulary of packages/domain sync/retry.ts. */
export function toSyncError(err: unknown): { code: SyncErrorCode; message: string; retryAfterMs: number | null } {
  if (ProviderError.is(err)) return { code: (SYNC_CODES.has(err.code) ? err.code : 'VENDOR_ERROR') as SyncErrorCode, message: err.message, retryAfterMs: err.retryAfterMs ?? null };
  if (AppError.is(err)) {
    const map: Partial<Record<string, SyncErrorCode>> = {
      NOT_FOUND: 'NOT_FOUND', DEVICE_UNSUPPORTED_OPERATION: 'UNSUPPORTED', PROVIDER_NOT_IMPLEMENTED: 'NOT_IMPLEMENTED', INVALID_STATE: 'INVALID_CONFIG', VALIDATION_ERROR: 'INVALID_CONFIG',
      CONFLICT: 'CONFLICT', DEVICE_OFFLINE: 'DEVICE_OFFLINE', PROVIDER_TIMEOUT: 'TIMEOUT', PROVIDER_RATE_LIMITED: 'RATE_LIMITED', PROVIDER_AUTH_FAILED: 'AUTH_FAILED', PROVIDER_ERROR: 'VENDOR_ERROR', DEPENDENCY_UNAVAILABLE: 'VENDOR_ERROR',
    };
    const code = map[err.code] ?? (err.retryable ? 'INTERNAL' : 'INVALID_CONFIG');
    return { code, message: err.message, retryAfterMs: err.retryAfterMs ?? null };
  }
  // AbortSignal.timeout() rejects with a DOMException('TimeoutError'); treat like a provider timeout
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return { code: 'TIMEOUT', message: err.message, retryAfterMs: null };
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err), retryAfterMs: null };
}

function str(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null; }

/** Parses the queue payload; tolerates the "itemless" shape ({ deviceId, employeeId?, options }) the API may enqueue directly. */
export function parseItemPayload(ctx: JobContext): Omit<SyncItemPayload, 'syncJobId' | 'syncJobItemId'> & { syncJobId: string | null; syncJobItemId: string | null } {
  const p = ctx.job.payload;
  const organizationId = str(p['organizationId']) ?? ctx.job.organizationId;
  if (!organizationId) throw new AppError('VALIDATION_ERROR', 'sync job payload requires organizationId');
  const op = str(p['operation']) ?? ctx.job.jobType;
  if (!(SYNC_JOB_TYPES as readonly string[]).includes(op)) throw new AppError('VALIDATION_ERROR', `unknown sync operation ${op}`);
  const options = p['options'] && typeof p['options'] === 'object' && !Array.isArray(p['options']) ? (p['options'] as Record<string, unknown>) : {};
  return { syncJobId: str(p['syncJobId']), syncJobItemId: str(p['syncJobItemId']), organizationId, deviceId: str(p['deviceId']), employeeId: str(p['employeeId']), operation: op as SyncJobType, options };
}

export interface ItemSuccess {
  result?: Record<string, unknown>;
  recordsIngested?: number;
  /** Terminal failure decided by the handler itself (e.g. a connection test that answered "not ok"): item FAILED, result kept. */
  failure?: { code: string; message: string };
}
export type ItemWork = (item: SyncJobItemRow, payload: SyncItemPayload) => Promise<ItemSuccess | void>;

type StartOutcome = { item: SyncJobItemRow; payload: SyncItemPayload; skipped: false } | { skipped: true; reason: string };

/**
 * Loads the item, creates it on the fly for itemless payloads, refuses to re-run a final item (queue re-delivery after a crash),
 * marks it RUNNING (attempts + 1) and moves the parent job to RUNNING on its first item.
 */
async function startItem(trx: Trx, ctx: JobContext, parsed: ReturnType<typeof parseItemPayload>, now: Date): Promise<StartOutcome> {
  let itemId = parsed.syncJobItemId;
  let syncJobId = parsed.syncJobId;
  if (!itemId) {
    // itemless payload → materialise a one-item sync job so progress/results are visible like any other sync
    const job = await trx.insertInto('syncJobs').values({
      organizationId: parsed.organizationId, jobType: parsed.operation, trigger: ((SYNC_TRIGGERS as readonly string[]).includes(str(ctx.job.payload['trigger']) ?? '') ? str(ctx.job.payload['trigger']) : 'SYSTEM') as SyncTrigger, scope: JSON.stringify({ deviceIds: parsed.deviceId ? [parsed.deviceId] : [], employeeIds: parsed.employeeId ? [parsed.employeeId] : [] }),
      status: 'QUEUED', priority: ctx.job.priority, itemsTotal: 1, itemsPending: 1, requestedBy: str(ctx.job.payload['requestedBy']), correlationId: ctx.job.correlationId ?? newCorrelationId('sync'), queuedAt: now,
    }).returning('id').executeTakeFirstOrThrow();
    syncJobId = job.id;
    const item = await trx.insertInto('syncJobItems').values({
      organizationId: parsed.organizationId, syncJobId, deviceId: parsed.deviceId, employeeId: parsed.employeeId, operation: parsed.operation, status: 'QUEUED', maxAttempts: ctx.job.maxAttempts, queueJobId: ctx.job.id,
    }).returning('id').executeTakeFirstOrThrow();
    itemId = item.id;
  }
  const item = await trx.selectFrom('syncJobItems').selectAll().where('id', '=', itemId).forUpdate().executeTakeFirst();
  if (!item) return { skipped: true, reason: 'item_missing' };
  if ((FINAL_ITEM_STATUSES as readonly string[]).includes(item.status)) return { skipped: true, reason: `already_${item.status.toLowerCase()}` };
  const updated = await trx.updateTable('syncJobItems').set({ status: 'RUNNING', attempts: item.attempts + 1, startedAt: item.startedAt ?? now, nextAttemptAt: null, queueJobId: ctx.job.id }).where('id', '=', item.id).returningAll().executeTakeFirstOrThrow();
  await trx.updateTable('syncJobs').set({ status: 'RUNNING', startedAt: sql`coalesce(started_at, ${now})` }).where('id', '=', item.syncJobId).where('status', 'in', ['PENDING', 'QUEUED', 'RETRYING']).execute();
  const payload: SyncItemPayload = { ...parsed, syncJobId: item.syncJobId, syncJobItemId: item.id, deviceId: parsed.deviceId ?? item.deviceId, employeeId: parsed.employeeId ?? item.employeeId, operation: item.operation };
  return { item: updated, payload, skipped: false };
}

export interface FinalizeInput {
  item: SyncJobItemRow;
  status: SyncItemStatus;
  /** false when the item will be retried (status RETRYING / OFFLINE while retrying): counters are not rolled up yet. */
  final: boolean;
  result?: Record<string, unknown> | null;
  recordsIngested?: number;
  error?: { code: string; message: string } | null;
  nextAttemptAt?: Date | null;
  durationMs: number;
  workerId: string;
  responseMeta?: Record<string, unknown> | null;
}

/**
 * Records the attempt, updates the item and — for final states — atomically rolls the parent job's counters up. The single
 * UPDATE that drives `items_pending` to 0 also decides the job status (SUCCESS / PARTIAL_SUCCESS / FAILED) and emits the
 * `sync.completed` / `sync.failed` outbox event, so the event is produced exactly once per job however many workers finish items.
 */
export async function finalizeItem(trx: Trx, input: FinalizeInput, now: Date): Promise<{ jobStatus: SyncStatus | null; jobFinished: boolean }> {
  const { item } = input;
  const attemptNo = item.attempts;
  const { final } = input;
  await trx.insertInto('syncAttempts').values({
    organizationId: item.organizationId, syncJobItemId: item.id, attemptNo, status: input.status, errorCode: input.error?.code ?? null, errorMessage: input.error?.message.slice(0, 1000) ?? null,
    durationMs: Math.round(input.durationMs), workerId: input.workerId, startedAt: new Date(now.getTime() - input.durationMs), finishedAt: now, responseMeta: input.responseMeta ? JSON.stringify(input.responseMeta) : null,
  }).execute();
  await trx.updateTable('syncJobItems').set({
    status: input.status, lastErrorCode: input.error?.code ?? null, lastError: input.error?.message.slice(0, 1000) ?? null, result: input.result ? JSON.stringify(input.result) : null,
    recordsIngested: item.recordsIngested + (input.recordsIngested ?? 0), finishedAt: final ? now : null, nextAttemptAt: input.nextAttemptAt ?? null,
  }).where('id', '=', item.id).execute();
  await trx.insertInto('syncLogs').values({
    organizationId: item.organizationId, syncJobId: item.syncJobId, syncJobItemId: item.id, deviceId: item.deviceId, level: input.error ? (final ? 'error' : 'warn') : 'info',
    event: final ? 'item_finished' : 'item_retry_scheduled', message: input.error ? `${input.error.code}: ${input.error.message.slice(0, 300)}` : `${item.operation} ${input.status.toLowerCase()}`,
    details: JSON.stringify({ status: input.status, attempt: attemptNo, durationMs: Math.round(input.durationMs), recordsIngested: input.recordsIngested ?? 0, nextAttemptAt: input.nextAttemptAt?.toISOString() ?? null }),
  }).execute();
  if (!final) return { jobStatus: null, jobFinished: false };

  const s = input.status === 'SUCCESS' ? 1 : 0;
  const f = input.status === 'FAILED' ? 1 : 0;
  const o = input.status === 'OFFLINE' ? 1 : 0;
  const u = input.status === 'UNSUPPORTED' ? 1 : 0;
  const n = input.recordsIngested ?? 0;
  const rolled = await sql<{ status: SyncStatus; itemsPending: number; itemsSuccess: number; itemsFailed: number; itemsOffline: number; itemsUnsupported: number; jobType: string }>`
    update public.sync_jobs set
      items_success = items_success + ${s}, items_failed = items_failed + ${f}, items_offline = items_offline + ${o}, items_unsupported = items_unsupported + ${u},
      items_pending = greatest(0, items_pending - 1), records_ingested = records_ingested + ${n},
      status = case when items_pending - 1 <= 0 then
          case when items_failed + ${f} + items_offline + ${o} + items_unsupported + ${u} = 0 then 'SUCCESS'::public.sync_status
               when items_success + ${s} = 0 then 'FAILED'::public.sync_status
               else 'PARTIAL_SUCCESS'::public.sync_status end
        else 'RUNNING'::public.sync_status end,
      finished_at = case when items_pending - 1 <= 0 then ${now}::timestamptz else finished_at end,
      error_code = case when items_pending - 1 <= 0 and items_success + ${s} = 0 then ${input.error?.code ?? null} else error_code end,
      error = case when items_pending - 1 <= 0 and items_success + ${s} = 0 then ${input.error?.message.slice(0, 500) ?? null} else error end
    where id = ${item.syncJobId}::uuid and items_pending > 0 and status not in ('CANCELLED')
    returning status, items_pending as "itemsPending", items_success as "itemsSuccess", items_failed as "itemsFailed", items_offline as "itemsOffline", items_unsupported as "itemsUnsupported", job_type as "jobType"`.execute(trx);
  const job = rolled.rows[0];
  if (!job) return { jobStatus: null, jobFinished: false };
  if (job.itemsPending === 0) {
    const failed = job.status === 'FAILED';
    await emitDomainEvent(trx, {
      organizationId: item.organizationId, eventType: failed ? 'sync.failed' : 'sync.completed', aggregateType: 'sync_job', aggregateId: item.syncJobId,
      payload: { syncJobId: item.syncJobId, jobType: job.jobType, status: job.status, itemsSuccess: job.itemsSuccess, itemsFailed: job.itemsFailed + job.itemsOffline, itemsUnsupported: job.itemsUnsupported, ...(failed && input.error ? { error: `${input.error.code}: ${input.error.message.slice(0, 300)}` } : {}) },
    });
    return { jobStatus: job.status, jobFinished: true };
  }
  return { jobStatus: job.status, jobFinished: false };
}

/**
 * Runs `work` for the sync item addressed by the queue job. Success → item SUCCESS (+ rollup). Failure → `decideRetry`:
 * retryable → item RETRYING (OFFLINE for DEVICE_OFFLINE), `next_attempt_at` set, and a *retryable* error is thrown so the
 * runner re-schedules the queue job after `retryAfterMs`; terminal → item FAILED / UNSUPPORTED (+ rollup) and a normal return.
 */
export async function runItem(ctx: JobContext, work: ItemWork): Promise<Record<string, unknown>> {
  const { deps, log } = ctx;
  const parsed = parseItemPayload(ctx);
  const now = deps.now();
  const started = Date.now();
  const start = await withContext(deps.db, { kind: 'system', organizationId: parsed.organizationId, jobId: ctx.job.id }, (trx) => startItem(trx, ctx, parsed, now));
  if (start.skipped) { log.info(event('sync_item_skipped', { reason: start.reason })); return { skipped: start.reason }; }
  const { item, payload } = start;
  const itemLog = log.child({ syncJobId: item.syncJobId, syncJobItemId: item.id, deviceId: payload.deviceId, operation: payload.operation });
  try {
    const out = (await work(item, payload)) ?? {};
    const finishedAt = deps.now();
    const status: SyncItemStatus = out.failure ? 'FAILED' : 'SUCCESS';
    const roll = await withContext(deps.db, { kind: 'system', organizationId: parsed.organizationId, jobId: ctx.job.id }, (trx) =>
      finalizeItem(trx, { item, status, final: true, result: out.result ?? null, error: out.failure ?? null, recordsIngested: out.recordsIngested ?? 0, durationMs: Date.now() - started, workerId: deps.config.workerId, responseMeta: out.result ?? null }, finishedAt));
    if (out.failure) itemLog.warn(event('sync_item_failed', { code: out.failure.code, message: out.failure.message, jobStatus: roll.jobStatus }));
    else itemLog.info(event('sync_item_succeeded', { recordsIngested: out.recordsIngested ?? 0, jobStatus: roll.jobStatus }));
    return { syncJobId: item.syncJobId, syncJobItemId: item.id, status, ...(out.failure ? { errorCode: out.failure.code, error: out.failure.message } : {}), ...(out.result ?? {}) };
  } catch (err) {
    const mapped = toSyncError(err);
    let decision: RetryDecision = decideRetry(mapped.code, item.attempts, { ...DEFAULT_RETRY_POLICY, maxAttempts: item.maxAttempts }, mapped.retryAfterMs, `${item.id}:${item.attempts}`);
    // The queue counts attempts per delivery, the item per started run; they drift when a delivery fails before startItem commits
    // (transient DB error, payload problem). Once the queue is about to dead-letter, the item MUST reach a terminal state or the
    // sync job would stay RUNNING forever with an item that is never re-delivered.
    if (decision.retry && ctx.job.attempts >= ctx.job.maxAttempts) {
      decision = { retry: false, delayMs: 0, itemStatus: decision.itemStatus === 'OFFLINE' ? 'OFFLINE' : 'FAILED' };
      itemLog.warn(event('sync_item_queue_exhausted', { code: mapped.code, queueAttempts: ctx.job.attempts, queueMaxAttempts: ctx.job.maxAttempts, itemAttempts: item.attempts }));
    }
    const finishedAt = deps.now();
    const nextAttemptAt = decision.retry ? new Date(finishedAt.getTime() + decision.delayMs) : null;
    await withContext(deps.db, { kind: 'system', organizationId: parsed.organizationId, jobId: ctx.job.id }, (trx) =>
      finalizeItem(trx, { item, status: decision.itemStatus, final: !decision.retry, error: { code: mapped.code, message: mapped.message }, nextAttemptAt, durationMs: Date.now() - started, workerId: deps.config.workerId }, finishedAt));
    if (decision.retry) {
      itemLog.warn(event('sync_item_retry', { code: mapped.code, message: mapped.message, attempt: item.attempts, delayMs: decision.delayMs, itemStatus: decision.itemStatus }));
      throw new AppError('PROVIDER_ERROR', `${mapped.code}: ${mapped.message}`, { retryable: true, retryAfterMs: decision.delayMs, details: { code: mapped.code, syncJobItemId: item.id }, cause: err });
    }
    itemLog.error(event('sync_item_failed', { code: mapped.code, message: mapped.message, attempt: item.attempts, itemStatus: decision.itemStatus }));
    return { syncJobId: item.syncJobId, syncJobItemId: item.id, status: decision.itemStatus, errorCode: mapped.code, error: mapped.message };
  }
}

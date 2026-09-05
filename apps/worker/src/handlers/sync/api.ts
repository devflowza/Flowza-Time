/**
 * Sync job creation — the implementation lives in `@flowza/database` (`packages/database/src/sync-jobs.ts`) and is shared by
 * the scheduler ticks, the fan-out handlers and the API (`apps/api/src/services/features/sync-jobs.ts`). This module keeps the
 * worker-side contract documentation and re-exports the shared functions under their historical import path.
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
 *   payload (WEBHOOK_EVENT): { webhookEventId: uuid, organizationId: uuid, deviceId?: uuid } — the provider_webhook_events row
 *     holds the NORMALISED form { vendorDeviceId, eventType?, transactions: RawTransaction[], rawBodySha256, rawBodyBytes,
 *     verifiedAt } written by the API after it verified the vendor signature over the original raw bytes (exactly once; the
 *     worker never re-verifies — a re-serialised body would not reproduce those bytes). Rows without `transactions` are marked
 *     `failed`.
 *   dedupeKey:  PULL_ATTENDANCE → `pull:<deviceId>`; DEVICE_HEALTH_CHECK → `health:<deviceId>`; PUSH_EMPLOYEE →
 *               `push:<deviceId>:<employeeId>:<syncJobId>`; DELETE_EMPLOYEE → `delete:<deviceId>:<employeeId|deviceUserId>:<syncJobId>`;
 *               others → `<operation lower-case>:<deviceId>:<syncJobId>`; WEBHOOK_EVENT → `webhook:<webhookEventId>`.
 *   priority:   manual 7, system 5–6, scheduled polls 4, health checks 2, reconciliation 3.
 *   maxAttempts must equal sync_job_items.max_attempts (default 6) so the item reaches a terminal state before the queue dead-letters.
 *   Always enqueue in the SAME transaction as the sync_jobs/sync_job_items insert (JobQueue.enqueue(opts, trx)).
 */
export { addSyncJobItems, createSyncJob, dedupeKeyFor, DEFAULT_PRIORITY } from '@flowza/database';
export type { AddItemsInput, AddItemsResult, CreateSyncJobInput, CreateSyncJobResult, SyncJobItemInput } from '@flowza/database';

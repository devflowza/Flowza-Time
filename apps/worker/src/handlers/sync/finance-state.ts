import { sql } from 'kysely';
import { FLOWZA_FINANCE_PROVIDER_KEY, type FinanceSyncDirection } from '@flowza/contracts';
import { emitDomainEvent, withContext, type Trx } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { DeviceRow } from './types.js';

/** Consecutive pull/push failures of one connector device after which `sync.finance.failed` is emitted (once per streak). */
export const FINANCE_FAILURE_ALERT_THRESHOLD = 3;

export const isFinanceConnector = (device: Pick<DeviceRow, 'providerKey'>): boolean => device.providerKey === FLOWZA_FINANCE_PROVIDER_KEY;

type ConnectorRef = Pick<DeviceRow, 'id' | 'organizationId'>;

/** One `finance_sync_state` row per connector device; created lazily by whichever side runs first (or by the API on save). */
export async function ensureFinanceState(trx: Trx, device: ConnectorRef): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id) values (${device.id}::uuid, ${device.organizationId}::uuid) on conflict (device_id) do nothing`.execute(trx);
}

/** A successful pull page loop: stamps the pull side and closes any failure streak. */
export async function recordFinancePull(trx: Trx, device: ConnectorRef, count: number, now: Date): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id, last_pull_at, last_pull_count)
    values (${device.id}::uuid, ${device.organizationId}::uuid, ${now}, ${count})
    on conflict (device_id) do update set last_pull_at = excluded.last_pull_at, last_pull_count = excluded.last_pull_count, consecutive_failures = 0, last_error = null, last_error_at = null`.execute(trx);
}

export interface PushProgress {
  /** Punches delivered in this batch. */
  count: number;
  /** Keyset position of the last event covered by the batch (advanced ONLY after Finance answered 2xx); `createdAt` is the timestamptz as Postgres text. */
  lastEvent: { id: string; createdAt: string } | null;
  now: Date;
  nextPushAt?: Date | null;
}

/** One delivered push batch: advances the keyset position and the counters in the caller's transaction. */
export async function recordFinancePush(trx: Trx, device: ConnectorRef, progress: PushProgress): Promise<void> {
  const last = progress.lastEvent;
  await sql`insert into public.finance_sync_state (device_id, organization_id, last_push_at, last_push_count, last_pushed_event_id, last_pushed_event_at, next_push_at)
    values (${device.id}::uuid, ${device.organizationId}::uuid, ${progress.now}, ${progress.count}, ${last?.id ?? null}::uuid, ${last?.createdAt ?? null}::timestamptz, ${progress.nextPushAt ?? null}::timestamptz)
    on conflict (device_id) do update set
      last_push_at = excluded.last_push_at,
      last_push_count = excluded.last_push_count,
      last_pushed_event_id = coalesce(excluded.last_pushed_event_id, finance_sync_state.last_pushed_event_id),
      last_pushed_event_at = coalesce(excluded.last_pushed_event_at, finance_sync_state.last_pushed_event_at),
      next_push_at = coalesce(excluded.next_push_at, finance_sync_state.next_push_at),
      consecutive_failures = 0, last_error = null, last_error_at = null`.execute(trx);
}

export async function scheduleNextFinancePush(trx: Trx, device: ConnectorRef, nextPushAt: Date): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id, next_push_at) values (${device.id}::uuid, ${device.organizationId}::uuid, ${nextPushAt})
    on conflict (device_id) do update set next_push_at = excluded.next_push_at`.execute(trx);
}

/**
 * Failure bookkeeping for either direction, in its OWN transaction (the failing work's transaction is gone) and never
 * throwing (bookkeeping must not mask the original error). Increments the streak; when it reaches the threshold exactly,
 * emits `sync.finance.failed` (routed to device.sync holders by the outbox) — once per streak, a success resets it.
 */
export async function recordFinanceFailure(deps: WorkerDeps, device: Pick<DeviceRow, 'id' | 'organizationId' | 'name' | 'code'>, direction: FinanceSyncDirection, failure: { code: string; message: string }, jobId: string | null): Promise<{ consecutiveFailures: number; alerted: boolean }> {
  const now = deps.now();
  const message = `${failure.code}: ${failure.message}`.slice(0, 2000);
  try {
    return await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, ...(jobId ? { jobId } : {}) }, async (trx) => {
      const res = await sql<{ consecutiveFailures: number }>`insert into public.finance_sync_state (device_id, organization_id, consecutive_failures, last_error, last_error_at)
        values (${device.id}::uuid, ${device.organizationId}::uuid, 1, ${message}, ${now})
        on conflict (device_id) do update set consecutive_failures = finance_sync_state.consecutive_failures + 1, last_error = excluded.last_error, last_error_at = excluded.last_error_at
        returning consecutive_failures as "consecutiveFailures"`.execute(trx);
      const consecutiveFailures = res.rows[0]?.consecutiveFailures ?? 1;
      const alerted = consecutiveFailures === FINANCE_FAILURE_ALERT_THRESHOLD;
      if (alerted) {
        await emitDomainEvent(trx, {
          organizationId: device.organizationId, eventType: 'sync.finance.failed', aggregateType: 'device', aggregateId: device.id,
          payload: { deviceId: device.id, deviceName: device.name, deviceCode: device.code, direction, consecutiveFailures, code: failure.code, error: failure.message.slice(0, 500) },
        });
        deps.log.warn(event('finance_sync_failing', { deviceId: device.id, direction, consecutiveFailures, code: failure.code }));
      }
      return { consecutiveFailures, alerted };
    });
  } catch (bookkeepingErr) {
    deps.log.error(event('finance_failure_bookkeeping_failed', { deviceId: device.id, direction, err: (bookkeepingErr as Error).message }));
    return { consecutiveFailures: -1, alerted: false };
  }
}

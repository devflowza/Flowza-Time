import { sql } from 'kysely';
import { FLOWZA_FINANCE_PROVIDER_KEY, type FinanceSyncDirection } from '@flowza/contracts';
import { emitDomainEvent, withContext, type Trx } from '@flowza/database';
import { isThrottleWaitAborted } from '@flowza/device-providers';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { DeviceRow } from './types.js';

/** Consecutive pull/push failures of one connector device after which `sync.finance.failed` is emitted (once per streak). */
export const FINANCE_FAILURE_ALERT_THRESHOLD = 3;

export const isFinanceConnector = (device: Pick<DeviceRow, 'providerKey'>): boolean => device.providerKey === FLOWZA_FINANCE_PROVIDER_KEY;

/**
 * A throttle wait that timed out is local queueing inside this worker (another conversation held the connector's slot), not an
 * answer — or silence — from Finance: it must count neither towards the connector's failure streak nor towards its circuit.
 */
export const isLocalThrottleWait = (err: unknown): boolean => isThrottleWaitAborted(err);

type ConnectorRef = Pick<DeviceRow, 'id' | 'organizationId'>;

/** One `finance_sync_state` row per connector device; created lazily by whichever side runs first (or by the API on save). */
export async function ensureFinanceState(trx: Trx, device: ConnectorRef): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id) values (${device.id}::uuid, ${device.organizationId}::uuid) on conflict (device_id) do nothing`.execute(trx);
}

/**
 * True when the connector still has the generation a run started with. The API bumps `devices.generation` when the connector is
 * re-pointed (base URL / serial) or disconnected and clears its cursor, push position and ledger; a run that started before must not
 * write any of them back. `for share` holds off a concurrent re-pointing until this transaction commits, so the check and the
 * write that follows it are one decision.
 */
export async function connectorGenerationIs(trx: Trx, deviceId: string, generation: number): Promise<boolean> {
  const row = await sql<{ generation: number }>`select generation from public.devices where id = ${deviceId}::uuid for share`.execute(trx);
  return row.rows[0]?.generation === generation;
}

/** A successful pull (Finance answered every page): stamps the pull side and closes any failure streak. */
export async function recordFinancePull(trx: Trx, device: ConnectorRef, count: number, now: Date): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id, last_pull_at, last_pull_count)
    values (${device.id}::uuid, ${device.organizationId}::uuid, ${now}, ${count})
    on conflict (device_id) do update set last_pull_at = excluded.last_pull_at, last_pull_count = excluded.last_pull_count, consecutive_failures = 0, last_error = null, last_error_at = null`.execute(trx);
}

/**
 * Only an actual successful Finance answer closes a failure streak (review D5): a push run with nothing to send never contacted
 * Finance and says nothing about whether the credential, the function or the network work.
 */
export async function recordFinanceSuccess(trx: Trx, device: ConnectorRef): Promise<void> {
  await sql`update public.finance_sync_state set consecutive_failures = 0, last_error = null, last_error_at = null where device_id = ${device.id}::uuid`.execute(trx);
}

export interface PushRunResult {
  /** Punches delivered in this run. */
  count: number;
  /** Last event the run handled (delivered or skipped), in creation order; null = the run handled nothing (keeps the previous one). */
  lastEvent: { id: string; createdAt: string } | null;
  /** New window anchor (Postgres timestamptz text); null keeps the stored one. Never moves backwards. */
  positionAt: string | null;
  now: Date;
  nextPushAt: Date;
}

/** Bookkeeping of one push run: counters, informational last event, the window anchor and the next due time — never the failure streak. */
export async function recordFinancePushRun(trx: Trx, device: ConnectorRef, run: PushRunResult): Promise<void> {
  const last = run.lastEvent;
  await sql`update public.finance_sync_state set
      last_push_at = ${run.now},
      last_push_count = ${run.count},
      last_pushed_event_id = coalesce(${last?.id ?? null}::uuid, last_pushed_event_id),
      last_pushed_event_at = case when ${last?.id ?? null}::uuid is null then last_pushed_event_at else ${last?.createdAt ?? null}::timestamptz end,
      push_position_at = case when ${run.positionAt}::timestamptz is null then push_position_at else greatest(coalesce(push_position_at, ${run.positionAt}::timestamptz), ${run.positionAt}::timestamptz) end,
      next_push_at = ${run.nextPushAt}
    where device_id = ${device.id}::uuid`.execute(trx);
}

/**
 * Events the push handled — `pushed` (Finance acknowledged them), `no_pin` (skipped, counted) or `poison_skipped` — go to the ledger,
 * so no later run sends them again; a retry marker for this batch is cleared at the same time.
 */
export async function recordHandledEvents(trx: Trx, device: ConnectorRef, rows: ReadonlyArray<{ id: string; outcome: 'pushed' | 'no_pin' | 'poison_skipped' }>): Promise<void> {
  if (rows.length === 0) return;
  await sql`insert into public.finance_pushed_events (organization_id, device_id, event_id, outcome)
    select ${device.organizationId}::uuid, ${device.id}::uuid, x.event_id, x.outcome
    from unnest(${sql.val(rows.map((r) => r.id))}::uuid[], ${sql.val(rows.map((r) => r.outcome))}::text[]) as x(event_id, outcome)
    on conflict (device_id, event_id) do nothing`.execute(trx);
  await sql`update public.finance_sync_state set push_retry_event_id = null, push_retry_attempts = 0
    where device_id = ${device.id}::uuid and push_retry_event_id = any(${sql.val(rows.map((r) => r.id))}::uuid[])`.execute(trx);
}

/** A batch Finance answered with per-punch errors: remember which batch and how often, and come back soon (not after the full interval). */
export async function recordPushRetry(trx: Trx, device: ConnectorRef, retry: { firstEventId: string; attempts: number; nextPushAt: Date }): Promise<void> {
  await sql`update public.finance_sync_state set push_retry_event_id = ${retry.firstEventId}::uuid, push_retry_attempts = ${retry.attempts}, next_push_at = ${retry.nextPushAt}
    where device_id = ${device.id}::uuid`.execute(trx);
}

/** Ledger rows are only needed while their events can still fall inside a run's window. */
export async function pruneFinanceLedger(trx: Trx, device: ConnectorRef, keepHours: number, overlapMinutes: number): Promise<number> {
  const res = await sql`delete from public.finance_pushed_events l
    using public.finance_sync_state s
    where l.device_id = ${device.id}::uuid and s.device_id = l.device_id
      and l.pushed_at < least(now() - make_interval(hours => ${keepHours}), coalesce(s.push_position_at, now()) - make_interval(mins => ${overlapMinutes}))`.execute(trx);
  return Number(res.numAffectedRows ?? 0);
}

export async function scheduleNextFinancePush(trx: Trx, device: ConnectorRef, nextPushAt: Date): Promise<void> {
  await sql`insert into public.finance_sync_state (device_id, organization_id, next_push_at) values (${device.id}::uuid, ${device.organizationId}::uuid, ${nextPushAt})
    on conflict (device_id) do update set next_push_at = excluded.next_push_at`.execute(trx);
}

export interface FinanceFailureOptions {
  /** `always`: alert regardless of the streak position (a skipped batch means punches Finance does not hold). Default: at the threshold only. */
  alert?: 'threshold' | 'always';
  /** Why this alert (payload `reason`), e.g. `batch_skipped`. */
  reason?: string;
  extra?: Record<string, unknown>;
}

/**
 * Failure bookkeeping for either direction, in its OWN transaction (the failing work's transaction is gone) and never
 * throwing (bookkeeping must not mask the original error). Increments the streak; when it reaches the threshold exactly,
 * emits `sync.finance.failed` (routed to integration.manage holders by the outbox) — once per streak, and again only after a
 * real success reset it. `alert: 'always'` emits for this failure whatever the streak (one event even when both apply).
 */
export async function recordFinanceFailure(deps: WorkerDeps, device: Pick<DeviceRow, 'id' | 'organizationId' | 'name' | 'code'>, direction: FinanceSyncDirection, failure: { code: string; message: string }, jobId: string | null, opts: FinanceFailureOptions = {}): Promise<{ consecutiveFailures: number; alerted: boolean }> {
  const now = deps.now();
  const message = `${failure.code}: ${failure.message}`.slice(0, 2000);
  try {
    return await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, ...(jobId ? { jobId } : {}) }, async (trx) => {
      const res = await sql<{ consecutiveFailures: number }>`insert into public.finance_sync_state (device_id, organization_id, consecutive_failures, last_error, last_error_at)
        values (${device.id}::uuid, ${device.organizationId}::uuid, 1, ${message}, ${now})
        on conflict (device_id) do update set consecutive_failures = finance_sync_state.consecutive_failures + 1, last_error = excluded.last_error, last_error_at = excluded.last_error_at
        returning consecutive_failures as "consecutiveFailures"`.execute(trx);
      const consecutiveFailures = res.rows[0]?.consecutiveFailures ?? 1;
      const alerted = consecutiveFailures === FINANCE_FAILURE_ALERT_THRESHOLD || opts.alert === 'always';
      if (alerted) {
        await emitDomainEvent(trx, {
          organizationId: device.organizationId, eventType: 'sync.finance.failed', aggregateType: 'device', aggregateId: device.id,
          payload: { deviceId: device.id, deviceName: device.name, deviceCode: device.code, direction, consecutiveFailures, code: failure.code, error: failure.message.slice(0, 500), ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.extra ?? {}) },
        });
        deps.log.warn(event('finance_sync_failing', { deviceId: device.id, direction, consecutiveFailures, code: failure.code, reason: opts.reason ?? 'streak' }));
      }
      return { consecutiveFailures, alerted };
    });
  } catch (bookkeepingErr) {
    deps.log.error(event('finance_failure_bookkeeping_failed', { deviceId: device.id, direction, err: (bookkeepingErr as Error).message }));
    return { consecutiveFailures: -1, alerted: false };
  }
}

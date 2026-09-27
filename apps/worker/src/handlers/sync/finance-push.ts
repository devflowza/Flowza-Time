import { sql } from 'kysely';
import { FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_SYNC_DIRECTIONS, type AttendanceEventType, type FinancePinKey, type FinanceSyncDirection, type VerificationMethod } from '@flowza/contracts';
import { withContext, type Trx } from '@flowza/database';
import { FINANCE_INGEST_MAX_BATCH, FINANCE_STATE_BY_EVENT_TYPE, hasFinancePush, toFinanceVerify, type FinancePunchInput } from '@flowza/device-providers';
import { AppError, event } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { checkCircuit } from './circuit.js';
import { circuitOpenError, handleProviderFailure, handleProviderSuccess, loadDeviceOrThrow } from './common.js';
import { buildProviderContext, deviceConfig } from './context.js';
import { ensureFinanceState, isFinanceConnector, recordFinanceFailure, recordFinancePush } from './finance-state.js';
import { applyHealth } from './health.js';
import { runItem, toSyncError } from './items.js';
import type { DeviceRow } from './types.js';

export const FINANCE_PUSH_MAX_BATCHES = 20;
/**
 * Events younger than this are left for the next run. The keyset walks `(created_at, id)` in creation order, and a transaction
 * that started earlier can still commit an event with an OLDER created_at after we moved past it; waiting a few seconds before
 * an event becomes eligible closes that window for ordinary transactions (tests set 0).
 */
export const FINANCE_PUSH_SETTLE_SECONDS = 5;
/** Sources that are FlowZa Time's own observations. MANUAL entries are HR's bookkeeping, not punches, and stay here. */
const PUSHED_SOURCES = ['DEVICE', 'MOBILE', 'IMPORT', 'CORRECTION'] as const;

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

export interface FinanceConnectorSettings { direction: FinanceSyncDirection; pinKey: FinancePinKey; pollMinutes: number }

/** Connector settings as stored on the device row (validated by the API; unknown values fall back to the defaults). */
export function financeSettingsOf(device: Pick<DeviceRow, 'config' | 'syncIntervalMinutes'>): FinanceConnectorSettings {
  const cfg = deviceConfig(device);
  const direction = (FINANCE_SYNC_DIRECTIONS as readonly string[]).includes(String(cfg['direction'])) ? (cfg['direction'] as FinanceSyncDirection) : 'both';
  const pinKey = (FINANCE_PIN_KEYS as readonly string[]).includes(String(cfg['pinKey'])) ? (cfg['pinKey'] as FinancePinKey) : 'employee_number';
  const raw = typeof cfg['pollMinutes'] === 'number' ? cfg['pollMinutes'] : typeof cfg['pollMinutes'] === 'string' && /^\d+$/.test(cfg['pollMinutes']) ? Number(cfg['pollMinutes']) : device.syncIntervalMinutes;
  const pollMinutes = num(raw, FINANCE_POLL_MINUTES.default, FINANCE_POLL_MINUTES.min, FINANCE_POLL_MINUTES.max);
  return { direction, pinKey, pollMinutes };
}

/**
 * Keyset position. `createdAt` is Postgres's own text rendering of the timestamptz (microseconds intact): a JS Date keeps
 * milliseconds only, and a truncated bound re-selects the row it came from — forever.
 */
export interface PushCursor { createdAt: string; id: string }
interface PushRow { id: string; createdAt: string; punchedAt: Date; eventType: AttendanceEventType; verificationMethod: VerificationMethod; pin: string | null; lat: number | null; lng: number | null; accuracy: number | null }

/**
 * The next batch of pushable events in creation order: not voided, of a pushed source, not produced by the connector device
 * itself (directly or through its raw transaction — the loop guard: a Finance punch we pulled must never travel back), settled,
 * and after the keyset position. The PIN is the employee field the connector is configured to send; an employee without one
 * cannot be represented in Finance and is skipped (counted, never invented).
 */
export async function loadPushBatch(trx: Trx, device: Pick<DeviceRow, 'id' | 'organizationId'>, pinKey: FinancePinKey, cursor: PushCursor | null, limit: number, now: Date, settleSeconds: number): Promise<PushRow[]> {
  const pinExpr = pinKey === 'employee_number' ? sql`emp.employee_number::text` : pinKey === 'device_user_id' ? sql`emp.device_user_id` : sql`emp.card_number`;
  const numeric = (key: string) => sql`case when r.raw_payload->>${key} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (r.raw_payload->>${key})::double precision end`;
  const res = await sql<PushRow>`
    select e.id::text as id, e.created_at::text as "createdAt", e.punched_at as "punchedAt", e.event_type as "eventType", e.verification_method as "verificationMethod",
           nullif(btrim(${pinExpr}), '') as pin, ${numeric('lat')} as lat, ${numeric('lng')} as lng, ${numeric('accuracy')} as accuracy
    from public.attendance_events e
    join public.employees emp on emp.id = e.employee_id and emp.organization_id = e.organization_id
    left join public.attendance_raw_transactions r on r.id = e.raw_transaction_id and r.punched_at = e.punched_at and r.organization_id = e.organization_id
    where e.organization_id = ${device.organizationId}::uuid
      and e.voided_at is null
      and e.source = any(${sql.val([...PUSHED_SOURCES])}::public.event_source[])
      and (e.device_id is null or e.device_id <> ${device.id}::uuid)
      and (r.id is null or r.device_id <> ${device.id}::uuid)
      and e.created_at <= ${now}::timestamptz - make_interval(secs => ${settleSeconds})
      and (${cursor === null} or (e.created_at, e.id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
    order by e.created_at asc, e.id asc
    limit ${limit}`.execute(trx);
  return res.rows.map((r) => ({ ...r, punchedAt: r.punchedAt instanceof Date ? r.punchedAt : new Date(r.punchedAt) }));
}

export function toFinancePunch(row: PushRow & { pin: string }): FinancePunchInput {
  return {
    pin: row.pin,
    time: row.punchedAt.toISOString(),
    verify: toFinanceVerify(row.verificationMethod),
    state: FINANCE_STATE_BY_EVENT_TYPE[row.eventType] ?? null,
    workcode: null,
    lat: row.lat, lng: row.lng, accuracy: row.accuracy,
  };
}

/**
 * PUSH_ATTENDANCE for one Flowza Finance connector device: circuit check → keyset batches of ≤ 500 events → `attendance-ingest`
 * (provider.pushAttendance, outside any transaction) → the position advances in its own transaction only after Finance answered
 * 2xx. Bounded per run; when more remains the state is left due immediately so the scheduler continues next tick. Failures use
 * the standard sync retry policy, feed the provider circuit and the connector's failure streak (`sync.finance.failed` at 3).
 */
export async function pushAttendance(ctx: JobContext) {
  const { deps, log } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const settleSeconds = num(payload.options['settleSeconds'], FINANCE_PUSH_SETTLE_SECONDS, 0, 3600);
    const maxBatches = num(payload.options['maxBatches'], FINANCE_PUSH_MAX_BATCHES, 1, 500);
    const batchSize = num(payload.options['batchSize'], FINANCE_INGEST_MAX_BATCH, 1, FINANCE_INGEST_MAX_BATCH);
    const prep = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      if (!isFinanceConnector(device)) throw new AppError('INVALID_STATE', `device ${device.code} is not a Flowza Finance connector`);
      const provider = deps.providers.get(device.providerKey);
      if (!hasFinancePush(provider)) throw new AppError('DEVICE_UNSUPPORTED_OPERATION', `provider ${device.providerKey} cannot push attendance`);
      const settings = financeSettingsOf(device);
      if (settings.direction === 'pull') return { skip: 'direction_pull' as const, device };
      const built = await buildProviderContext(trx, deps, device, ctx.job.id, ctx.signal, { log, provider });
      const circuit = await checkCircuit(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey }, now);
      await ensureFinanceState(trx, device);
      // read the position as text so the microsecond part of the timestamp survives the round trip (see PushCursor)
      const state = (await sql<{ id: string | null; at: string | null }>`select last_pushed_event_id::text as id, last_pushed_event_at::text as at from public.finance_sync_state where device_id = ${device.id}::uuid`.execute(trx)).rows[0];
      const cursor: PushCursor | null = state?.id && state.at ? { id: state.id, createdAt: state.at } : null;
      return { skip: null, device, settings, built: { ...built, provider }, circuit, cursor };
    });
    if (prep.skip) return { result: { skipped: prep.skip, direction: 'pull' } };
    const { device, settings, built } = prep;
    if (!prep.circuit.allow) { built.dispose(); throw circuitOpenError(prep.circuit.halfOpenAt, now); }
    const totals = { batches: 0, requests: 0, events: 0, pushed: 0, ingested: 0, duplicates: 0, unmapped: 0, errors: 0, skippedNoPin: 0 };
    let cursor = prep.cursor;
    let hasMore = false;
    const sys = <T>(fn: (trx: Trx) => Promise<T>) => withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, fn);
    try {
      for (let b = 0; b < maxBatches; b++) {
        const rows = await sys((trx) => loadPushBatch(trx, device, settings.pinKey, cursor, batchSize, deps.now(), settleSeconds));
        if (rows.length === 0) break;
        const withPin = rows.filter((r): r is PushRow & { pin: string } => r.pin !== null);
        totals.skippedNoPin += rows.length - withPin.length;
        if (withPin.length > 0) {
          const res = await built.provider.pushAttendance(built.ctx, withPin.map(toFinancePunch));
          totals.requests += 1; totals.pushed += withPin.length; totals.ingested += res.ingested; totals.duplicates += res.duplicates; totals.unmapped += res.unmapped; totals.errors += res.errors;
        }
        const last = rows[rows.length - 1]!;
        cursor = { id: last.id, createdAt: last.createdAt };
        await sys((trx) => recordFinancePush(trx, device, { count: withPin.length, lastEvent: cursor, now: deps.now() }));
        totals.batches += 1;
        totals.events += rows.length;
        if (rows.length < batchSize) break;
        if (b === maxBatches - 1) hasMore = true;
        ctx.signal.throwIfAborted();
      }
      const at = deps.now();
      const nextPushAt = new Date(at.getTime() + (hasMore ? 0 : settings.pollMinutes * 60_000));
      await sys(async (trx) => {
        await recordFinancePush(trx, device, { count: totals.pushed, lastEvent: null, now: at, nextPushAt });
        // health and the circuit only learn from a conversation that happened: a run with nothing to send never contacted Finance
        // (a push-only connector with no new punches is then probed by the ordinary health check instead)
        if (totals.requests > 0) {
          await applyHealth(trx, device, { online: true, lastSeenAt: at, event: 'attendance_pushed', jobId: item.syncJobId, details: { pushed: totals.pushed, ingested: totals.ingested, duplicates: totals.duplicates, unmapped: totals.unmapped, skippedNoPin: totals.skippedNoPin, batches: totals.batches, hasMore } }, at);
          await handleProviderSuccess(trx, device, built.accountKey);
        }
      });
      if (totals.unmapped > 0) log.warn(event('finance_push_unmapped_pins', { deviceId: device.id, unmapped: totals.unmapped, pinKey: settings.pinKey }));
      return { recordsIngested: totals.pushed, result: { ...totals, hasMore, pinKey: settings.pinKey, nextPushAt: nextPushAt.toISOString(), lastPushedEventId: cursor?.id ?? null } };
    } catch (err) {
      await recordFinanceFailure(deps, device, 'push', toSyncError(err), ctx.job.id);
      await handleProviderFailure(ctx, device, built.accountKey, err);
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new AppError('PROVIDER_TIMEOUT', err.message, { retryable: true, cause: err });
      throw err;
    } finally {
      built.dispose();
    }
  });
}

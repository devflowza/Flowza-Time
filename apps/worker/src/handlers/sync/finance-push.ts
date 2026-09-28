import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'kysely';
import { FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_PUSH_BATCH_MAX_ATTEMPTS, FINANCE_SYNC_DIRECTIONS, type AttendanceEventType, type FinancePinKey, type FinanceSyncDirection, type VerificationMethod } from '@flowza/contracts';
import { withContext, type Database, type Trx } from '@flowza/database';
import { FINANCE_INGEST_MAX_BATCH, FINANCE_STATE_BY_EVENT_TYPE, financeSyncFromStart, hasFinancePush, toFinanceVerify, type FinancePunchInput, type FinancePushResult } from '@flowza/device-providers';
import { AppError, event } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { checkCircuit } from './circuit.js';
import { circuitOpenError, handleProviderFailure, handleProviderSuccess, loadDeviceOrThrow } from './common.js';
import { buildProviderContext, deviceConfig } from './context.js';
import {
  connectorGenerationIs, ensureFinanceState, isFinanceConnector, isLocalThrottleWait, pruneFinanceLedger, recordFinanceFailure, recordFinancePushRun, recordFinanceSuccess, recordHandledEvents, recordPushRetry,
} from './finance-state.js';
import { applyHealth } from './health.js';
import { runItem, toSyncError } from './items.js';
import type { DeviceRow } from './types.js';

export const FINANCE_PUSH_MAX_BATCHES = 20;
/** Events younger than this are left for the next run (bursts are pushed together). Not load-bearing any more: late commits are
 * caught by the overlap window below. Measured against the DATABASE clock, like `created_at`. */
export const FINANCE_PUSH_SETTLE_SECONDS = 5;
/**
 * Each run looks again at the 15 minutes before its stored position (review D4). `attendance_events.created_at` is the inserting
 * TRANSACTION's start time, so an event can become visible after a run has moved past its `created_at`; any transaction shorter
 * than this overlap is therefore still pushed. What the overlap re-reads is filtered out by the ledger (`finance_pushed_events`).
 */
export const FINANCE_PUSH_OVERLAP_MINUTES = 15;
/** Ledger rows live this long (and never while inside a run's window). */
export const FINANCE_LEDGER_KEEP_HOURS = 48;
/**
 * A batch Finance answers with per-punch errors (a 2xx whose `errors` > 0) is not delivered: it is retried — Finance dedupes the
 * punches it did store — with a short back-off, and after this many consecutive attempts it is skipped (recorded as
 * `poison_skipped`, counted as a failure, alerted) so one punch Finance cannot store never blocks the connector (review D3).
 */
export const FINANCE_POISON_MAX_ATTEMPTS = FINANCE_PUSH_BATCH_MAX_ATTEMPTS;
/** Sources that are FlowZa Time's own observations. MANUAL entries are HR's bookkeeping, not punches, and stay here. */
const PUSHED_SOURCES = ['DEVICE', 'MOBILE', 'IMPORT', 'CORRECTION'] as const;
/** How far a correction chain (an edit of an edit of …) is followed back to its original punch. */
const CORRECTION_CHAIN_DEPTH = 10;

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;
}

export interface FinanceConnectorSettings { direction: FinanceSyncDirection; pinKey: FinancePinKey; pollMinutes: number; syncFrom: string | null }

/** Connector settings as stored on the device row (validated by the API; unknown values fall back to the defaults). */
export function financeSettingsOf(device: Pick<DeviceRow, 'config' | 'syncIntervalMinutes' | 'timezone'>): FinanceConnectorSettings {
  const cfg = deviceConfig(device);
  const direction = (FINANCE_SYNC_DIRECTIONS as readonly string[]).includes(String(cfg['direction'])) ? (cfg['direction'] as FinanceSyncDirection) : 'both';
  const pinKey = (FINANCE_PIN_KEYS as readonly string[]).includes(String(cfg['pinKey'])) ? (cfg['pinKey'] as FinancePinKey) : 'employee_number';
  const raw = typeof cfg['pollMinutes'] === 'number' ? cfg['pollMinutes'] : typeof cfg['pollMinutes'] === 'string' && /^\d+$/.test(cfg['pollMinutes']) ? Number(cfg['pollMinutes']) : device.syncIntervalMinutes;
  const pollMinutes = num(raw, FINANCE_POLL_MINUTES.default, FINANCE_POLL_MINUTES.min, FINANCE_POLL_MINUTES.max);
  return { direction, pinKey, pollMinutes, syncFrom: financeSyncFromStart(cfg['syncFrom'], device.timezone) };
}

/**
 * Position inside a run: `createdAt` is Postgres's own text rendering of the timestamptz (microseconds intact) — a JS Date keeps
 * milliseconds only, and a truncated bound re-selects the row it came from.
 */
export interface PushCursor { createdAt: string; id: string }
interface PushRow { id: string; createdAt: string; punchedAt: Date; eventType: AttendanceEventType; verificationMethod: VerificationMethod; pin: string | null; lat: number | null; lng: number | null; accuracy: number | null }

export interface PushWindow {
  /** Stored window anchor (Postgres text); the scan starts FINANCE_PUSH_OVERLAP_MINUTES before it. Null = first run. */
  position: string | null;
  /** Upper bound (Postgres text, database clock minus the settle window), fixed for the whole run. */
  upper: string;
  /** In-run keyset: the last event already handled by this run. */
  after: PushCursor | null;
  /** Start date instant (ISO): punches before it are never pushed; the first run starts there. */
  syncFrom: string | null;
}

/**
 * The next batch of pushable events in creation order, inside the run's window and NOT yet in the ledger: not voided, of a pushed
 * source, not produced by the connector device itself (directly or through its raw transaction — the loop guard: a Finance punch
 * we pulled never travels back), not a correction whose chain leads back to a pulled punch (an EDIT of a punch that came from
 * Finance, review D8), punched on or after the start date. The PIN is the employee field the connector is configured to send; an
 * employee without one cannot be represented in Finance (skipped, counted — never invented).
 */
export async function loadPushBatch(trx: Trx, device: Pick<DeviceRow, 'id' | 'organizationId'>, pinKey: FinancePinKey, window: PushWindow, limit: number): Promise<PushRow[]> {
  const pinExpr = pinKey === 'employee_number' ? sql`emp.employee_number::text` : pinKey === 'device_user_id' ? sql`emp.device_user_id` : sql`emp.card_number`;
  const numeric = (key: string) => sql`case when r.raw_payload->>${key} ~ '^-?[0-9]+(\\.[0-9]+)?$' then (r.raw_payload->>${key})::double precision end`;
  const lower = window.position !== null
    ? sql`e.created_at >= ${window.position}::timestamptz - make_interval(mins => ${FINANCE_PUSH_OVERLAP_MINUTES})`
    : window.syncFrom !== null ? sql`e.created_at >= ${window.syncFrom}::timestamptz` : sql`true`;
  const res = await sql<PushRow>`
    select e.id::text as id, e.created_at::text as "createdAt", e.punched_at as "punchedAt", e.event_type as "eventType", e.verification_method as "verificationMethod",
           nullif(btrim(${pinExpr}), '') as pin, ${numeric('lat')} as lat, ${numeric('lng')} as lng, ${numeric('accuracy')} as accuracy
    from public.attendance_events e
    join public.employees emp on emp.id = e.employee_id and emp.organization_id = e.organization_id
    left join public.attendance_raw_transactions r on r.id = e.raw_transaction_id and r.punched_at = e.punched_at and r.organization_id = e.organization_id
    where e.organization_id = ${device.organizationId}::uuid
      and ${lower}
      and e.created_at <= ${window.upper}::timestamptz
      and (${window.after === null} or (e.created_at, e.id) > (${window.after?.createdAt ?? null}::timestamptz, ${window.after?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
      and (${window.syncFrom === null} or e.punched_at >= ${window.syncFrom}::timestamptz)
      and e.voided_at is null
      and e.source = any(${sql.val([...PUSHED_SOURCES])}::public.event_source[])
      and (e.device_id is null or e.device_id <> ${device.id}::uuid)
      and (r.id is null or r.device_id <> ${device.id}::uuid)
      and not exists (select 1 from public.finance_pushed_events l where l.device_id = ${device.id}::uuid and l.event_id = e.id)
      and (e.source <> 'CORRECTION' or not exists (
        with recursive chain (device_id, raw_transaction_id, punched_at, correction_id, depth) as (
          select e.device_id, e.raw_transaction_id, e.punched_at, e.correction_id, 0
          union all
          select o.device_id, o.raw_transaction_id, o.punched_at, o.correction_id, ch.depth + 1
          from chain ch
          join public.attendance_corrections c on c.id = ch.correction_id and c.organization_id = ${device.organizationId}::uuid
          join public.attendance_events o on o.id = c.original_event_id and o.organization_id = ${device.organizationId}::uuid
            and (c.original_punched_at is null or o.punched_at = c.original_punched_at)
          where ch.depth < ${CORRECTION_CHAIN_DEPTH}
        )
        select 1 from chain ch
        where ch.device_id = ${device.id}::uuid
           or exists (select 1 from public.attendance_raw_transactions xr where xr.id = ch.raw_transaction_id and xr.punched_at = ch.punched_at and xr.device_id = ${device.id}::uuid)
      ))
      and not exists (select 1 from public.attendance_corrections sc where sc.id = e.correction_id and sc.type = 'SET_STATUS')
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
 * Punches Finance did NOT store in a 2xx answer: `errors` + `skipped` (its per-punch failures), or whatever the counters fail to
 * account for (`ingested + duplicates` short of what was sent).
 */
export function rejectedPunches(sent: number, res: Pick<FinancePushResult, 'ingested' | 'duplicates' | 'errors' | 'skipped'>): number {
  return Math.max(0, res.errors + res.skipped, sent - (res.ingested + res.duplicates));
}

/**
 * One push run per connector at a time (review D11): a session-level advisory lock on a dedicated connection, held for the whole
 * run (the run spans several transactions and HTTP calls). A second run that finds it taken exits as a no-op. A crashed worker's
 * connection closes and releases the lock.
 */
/**
 * How long a MANUAL push ("Sync now") waits for a run of the same connector that is already in progress (HR portal Prompt 11,
 * end-to-end matrix flow 10). The running run's window ended when that run started, so the punches that made somebody press
 * "Sync now" are not in it: exiting at once reported SUCCESS with nothing pushed and left them for the next scheduled run — up
 * to the poll interval, 60 minutes at most. Waiting keeps D11's rule (one run per connector at a time, nothing sent twice —
 * the ledger filters what the first run delivered); the wait is bounded, and a SCHEDULED run still exits at once (the
 * scheduler plans the next one, and the running run leaves the connector due immediately when it is cut by the batch cap).
 */
export const FINANCE_PUSH_MANUAL_WAIT_MS = 120_000;
const CONNECTOR_LOCK_POLL_MS = 250;

/**
 * One push per connector at a time: a session-level advisory lock on a dedicated connection, held for the whole run (a crashed
 * worker's connection releases it). `wait` retries the lock for a bounded time (manual runs); without it a busy lock is
 * reported at once.
 */
async function withConnectorLock<T>(db: Database, deviceId: string, fn: () => Promise<T>, wait: { ms: number; signal: AbortSignal } | null = null): Promise<{ acquired: true; value: T; waitedMs: number } | { acquired: false; waitedMs: number }> {
  const key = `finance-push:${deviceId}`;
  return db.connection().execute(async (conn) => {
    const started = Date.now();
    for (;;) {
      const got = await sql<{ locked: boolean }>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as locked`.execute(conn);
      if (got.rows[0]?.locked === true) break;
      const left = wait ? started + wait.ms - Date.now() : 0;
      if (left <= 0 || wait?.signal.aborted) return { acquired: false as const, waitedMs: Date.now() - started };
      await sleep(Math.min(CONNECTOR_LOCK_POLL_MS, left), undefined, { signal: wait!.signal }).catch(() => undefined);
    }
    const waitedMs = Date.now() - started;
    try {
      return { acquired: true as const, value: await fn(), waitedMs };
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(conn).catch(() => undefined);
    }
  });
}

/**
 * PUSH_ATTENDANCE for one Flowza Finance connector device:
 *   single-flight lock → circuit check → window [position − 15 min, db now − settle] → batches of ≤ 500 events not yet in the
 *   ledger → `attendance-ingest` (outside any transaction) → the batch goes to the ledger ONLY when Finance stored every punch
 *   (a 2xx with per-punch errors is retried, and skipped as poison after 5 attempts) → the position advances to the window's end.
 * Bounded per run; when more remains the connector is left due immediately. Failures use the standard sync retry policy, feed the
 * provider circuit and the connector's failure streak (`sync.finance.failed` at 3). A run whose connector was re-pointed meanwhile
 * (generation changed) stops without writing anything.
 */
export async function pushAttendance(ctx: JobContext) {
  const { deps, log } = ctx;
  return runItem(ctx, async (item, payload) => {
    const settleSeconds = num(payload.options['settleSeconds'], FINANCE_PUSH_SETTLE_SECONDS, 0, 3600);
    const maxBatches = num(payload.options['maxBatches'], FINANCE_PUSH_MAX_BATCHES, 1, 500);
    const batchSize = num(payload.options['batchSize'], FINANCE_INGEST_MAX_BATCH, 1, FINANCE_INGEST_MAX_BATCH);
    const sys = <T>(organizationId: string, fn: (trx: Trx) => Promise<T>) => withContext(deps.db, { kind: 'system', organizationId, jobId: ctx.job.id }, fn);
    const prep = await sys(payload.organizationId, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      if (!isFinanceConnector(device)) throw new AppError('INVALID_STATE', `device ${device.code} is not a Flowza Finance connector`);
      const provider = deps.providers.get(device.providerKey);
      if (!hasFinancePush(provider)) throw new AppError('DEVICE_UNSUPPORTED_OPERATION', `provider ${device.providerKey} cannot push attendance`);
      const settings = financeSettingsOf(device);
      if (settings.direction === 'pull') return { skip: 'direction_pull' as const };
      const built = await buildProviderContext(trx, deps, device, ctx.job.id, ctx.signal, { log, provider });
      await ensureFinanceState(trx, device);
      // who asked: "Sync now" (MANUAL) waits for a run in progress, anything else exits at once (FINANCE_PUSH_MANUAL_WAIT_MS)
      const trigger = (await trx.selectFrom('syncJobs').select('trigger').where('id', '=', item.syncJobId).executeTakeFirst())?.trigger ?? null;
      return { skip: null, device, settings, trigger, built: { ...built, provider } };
    });
    if (prep.skip) return { result: { skipped: prep.skip, direction: 'pull' } };
    const { device, settings, built } = prep;
    const lockWait = prep.trigger === 'MANUAL' ? { ms: num(payload.options['lockWaitMs'], FINANCE_PUSH_MANUAL_WAIT_MS, 0, 10 * 60_000), signal: ctx.signal } : null;
    const generation = device.generation;
    const inDevice = <T>(fn: (trx: Trx) => Promise<T>) => sys(device.organizationId, fn);
    try {
      const locked = await withConnectorLock(deps.db, device.id, async () => {
        // the circuit is checked under the lock, so a run that is about to be a no-op never takes the half-open probe
        const start = await inDevice(async (trx) => {
          const circuit = await checkCircuit(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey }, deps.now());
          const st = (await sql<{ position: string | null; retryEventId: string | null; retryAttempts: number; upper: string }>`
            select push_position_at::text as position, push_retry_event_id::text as "retryEventId", push_retry_attempts as "retryAttempts",
                   (now() - make_interval(secs => ${settleSeconds}))::text as upper
            from public.finance_sync_state where device_id = ${device.id}::uuid`.execute(trx)).rows[0];
          return { circuit, st };
        });
        if (!start.circuit.allow) throw circuitOpenError(start.circuit.halfOpenAt, deps.now());
        return runPush(start.st ?? { position: null, retryEventId: null, retryAttempts: 0, upper: new Date().toISOString() });
      }, lockWait);
      if (!locked.acquired) {
        log.info(event('finance_push_already_running', { deviceId: device.id, trigger: prep.trigger, waitedMs: locked.waitedMs }));
        return { result: { skipped: 'already_running', ...(lockWait ? { waitedMs: locked.waitedMs } : {}) } };
      }
      if (locked.waitedMs >= CONNECTOR_LOCK_POLL_MS) {
        log.info(event('finance_push_waited_for_running_push', { deviceId: device.id, waitedMs: locked.waitedMs }));
        return { ...locked.value, result: { ...locked.value.result, waitedMs: locked.waitedMs } };
      }
      return locked.value;
    } finally {
      built.dispose();
    }

    async function runPush(st: { position: string | null; retryEventId: string | null; retryAttempts: number; upper: string }) {
      const totals = { batches: 0, requests: 0, events: 0, pushed: 0, ingested: 0, duplicates: 0, unmapped: 0, errors: 0, skippedNoPin: 0, poisonSkipped: 0 };
      const window: PushWindow = { position: st.position, upper: st.upper, after: null, syncFrom: settings.syncFrom };
      let lastHandled: PushCursor | null = null;
      let drained = false;
      let hasMore = false;
      let retry: { attempts: number; rejected: number; sent: number } | null = null;
      let superseded = false;
      try {
        for (let b = 0; b < maxBatches; b++) {
          const rows = await inDevice((trx) => loadPushBatch(trx, device, settings.pinKey, window, batchSize));
          if (rows.length === 0) { drained = true; break; }
          const withPin = rows.filter((r): r is PushRow & { pin: string } => r.pin !== null);
          let outcome: 'pushed' | 'poison_skipped' = 'pushed';
          if (withPin.length > 0) {
            const res = await built.provider.pushAttendance(built.ctx, withPin.map(toFinancePunch));
            totals.requests += 1; totals.ingested += res.ingested; totals.duplicates += res.duplicates; totals.unmapped += res.unmapped; totals.errors += res.errors;
            const rejected = rejectedPunches(withPin.length, res);
            if (rejected > 0) {
              const firstEventId = rows[0]!.id;
              const attempts = (st.retryEventId === firstEventId ? st.retryAttempts : 0) + 1;
              if (attempts < FINANCE_POISON_MAX_ATTEMPTS) {
                // not delivered: nothing of this batch is recorded, the position does not move; come back soon (1, 2, 4, 8 min)
                const backoffMinutes = Math.min(settings.pollMinutes, 2 ** (attempts - 1));
                const current = await inDevice(async (trx) => {
                  if (!(await connectorGenerationIs(trx, device.id, generation))) return false;
                  await recordPushRetry(trx, device, { firstEventId, attempts, nextPushAt: new Date(deps.now().getTime() + backoffMinutes * 60_000) });
                  return true;
                });
                if (!current) { superseded = true; break; }
                retry = { attempts, rejected, sent: withPin.length };
                await recordFinanceFailure(deps, device, 'push', { code: 'VENDOR_ERROR', message: `Flowza Finance rejected ${rejected} of ${withPin.length} ${withPin.length === 1 ? 'punch' : 'punches'} of a batch; retrying it (attempt ${attempts} of ${FINANCE_POISON_MAX_ATTEMPTS})` }, ctx.job.id);
                break;
              }
              // poison: the same batch failed FINANCE_POISON_MAX_ATTEMPTS times in a row — record it, alert, and move past it
              outcome = 'poison_skipped';
              totals.poisonSkipped += withPin.length;
              await recordFinanceFailure(deps, device, 'push', { code: 'VENDOR_ERROR', message: `Flowza Finance kept rejecting ${rejected} of ${withPin.length} ${withPin.length === 1 ? 'punch' : 'punches'} after ${attempts} attempts; the batch was skipped (first event ${firstEventId})` }, ctx.job.id, { alert: 'always', reason: 'batch_skipped', extra: { skippedPunches: withPin.length, rejectedPunches: rejected, firstEventId } });
              log.warn(event('finance_push_batch_skipped', { deviceId: device.id, firstEventId, punches: withPin.length, rejected, attempts }));
            } else {
              totals.pushed += withPin.length;
            }
          }
          totals.skippedNoPin += rows.length - withPin.length;
          const handled = rows.map((r) => ({ id: r.id, outcome: r.pin === null ? ('no_pin' as const) : outcome }));
          const current = await inDevice(async (trx) => {
            if (!(await connectorGenerationIs(trx, device.id, generation))) return false;
            await recordHandledEvents(trx, device, handled);
            return true;
          });
          if (!current) { superseded = true; break; }
          const last = rows[rows.length - 1]!;
          lastHandled = { id: last.id, createdAt: last.createdAt };
          window.after = lastHandled;
          totals.batches += 1;
          totals.events += rows.length;
          if (rows.length < batchSize) { drained = true; break; }
          if (b === maxBatches - 1) hasMore = true;
          ctx.signal.throwIfAborted();
        }
      } catch (err) {
        if (!isLocalThrottleWait(err)) {
          await recordFinanceFailure(deps, device, 'push', toSyncError(err), ctx.job.id);
          await handleProviderFailure(ctx, device, built.accountKey, err);
        }
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new AppError('PROVIDER_TIMEOUT', err.message, { retryable: true, cause: err });
        throw err;
      }
      if (superseded) {
        log.info(event('finance_push_superseded', { deviceId: device.id, generation }));
        return { result: { ...totals, superseded: true } };
      }
      const at = deps.now();
      // A finished window moves the position to its end; a run cut short by the batch cap stops at the last event it handled; a
      // batch being retried leaves the position where it was (its events stay out of the ledger and are re-read next run).
      const positionAt = retry ? null : drained ? st.upper : lastHandled?.createdAt ?? null;
      const nextPushAt = retry ? null : new Date(at.getTime() + (hasMore ? 0 : settings.pollMinutes * 60_000));
      await inDevice(async (trx) => {
        if (!(await connectorGenerationIs(trx, device.id, generation))) return;
        if (nextPushAt) await recordFinancePushRun(trx, device, { count: totals.pushed, lastEvent: lastHandled, positionAt, now: at, nextPushAt });
        // health and the circuit only learn from a conversation that happened: a run with nothing to send never contacted Finance
        // (a push-only connector with no new punches is then probed by the ordinary health check instead)
        if (totals.requests > 0) {
          await applyHealth(trx, device, { online: true, lastSeenAt: at, event: 'attendance_pushed', jobId: item.syncJobId, details: { pushed: totals.pushed, ingested: totals.ingested, duplicates: totals.duplicates, unmapped: totals.unmapped, errors: totals.errors, skippedNoPin: totals.skippedNoPin, poisonSkipped: totals.poisonSkipped, batches: totals.batches, hasMore } }, at);
          await handleProviderSuccess(trx, device, built.accountKey);
          // only a run in which Finance stored everything it was sent closes a failure streak (review D5)
          if (!retry && totals.poisonSkipped === 0) await recordFinanceSuccess(trx, device);
        }
        await pruneFinanceLedger(trx, device, FINANCE_LEDGER_KEEP_HOURS, FINANCE_PUSH_OVERLAP_MINUTES);
      });
      if (totals.unmapped > 0) log.warn(event('finance_push_unmapped_pins', { deviceId: device.id, unmapped: totals.unmapped, pinKey: settings.pinKey }));
      const result = { ...totals, hasMore, pinKey: settings.pinKey, nextPushAt: nextPushAt?.toISOString() ?? null, lastPushedEventId: lastHandled?.id ?? null, ...(retry ? { retryAttempt: retry.attempts } : {}) };
      if (retry) return { recordsIngested: totals.pushed, result, failure: { code: 'VENDOR_ERROR', message: `Flowza Finance rejected ${retry.rejected} of ${retry.sent} punches; the batch will be retried (attempt ${retry.attempts} of ${FINANCE_POISON_MAX_ATTEMPTS})` } };
      if (totals.poisonSkipped > 0) return { recordsIngested: totals.pushed, result, failure: { code: 'VENDOR_ERROR', message: `Skipped ${totals.poisonSkipped} punches Flowza Finance kept rejecting after ${FINANCE_POISON_MAX_ATTEMPTS} attempts` } };
      return { recordsIngested: totals.pushed, result };
    }
  });
}

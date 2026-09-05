import { rawTransactionSchema, type RawTransaction } from '@flowza/contracts';
import { redactForAudit, withContext, type Trx } from '@flowza/database';
import type { ProviderError, DeviceInfo, DeviceStatus } from '@flowza/device-providers';
import { AppError, event } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { checkCircuit } from './circuit.js';
import { capabilitiesOf, handleProviderFailure, handleProviderSuccess, isProviderCode, loadDeviceOrThrow } from './common.js';
import { buildProviderContext, loadDevice } from './context.js';
import { applyHealth, type HealthObservation } from './health.js';
import { ingestRawTransactions } from './ingest.js';
import { runItem } from './items.js';
import type { DeviceRow } from './types.js';

const skewSeconds = (deviceTime: string | undefined, now: Date): number | null => {
  if (!deviceTime) return null;
  const t = Date.parse(deviceTime);
  return Number.isNaN(t) ? null : Math.round((t - now.getTime()) / 1000);
};

function heartbeatObservation(device: DeviceRow, now: Date): HealthObservation {
  const seen = device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt) : null;
  const online = !!seen && now.getTime() - seen.getTime() <= device.offlineThresholdMinutes * 60_000;
  return { online, lastSeenAt: seen, errorCode: online ? null : 'DEVICE_OFFLINE', error: online ? null : `no heartbeat for more than ${device.offlineThresholdMinutes} min`, details: { mode: 'push', lastHeartbeatAt: seen?.toISOString() ?? null } };
}

/**
 * DEVICE_HEALTH_CHECK: `getDeviceStatus` (+ `getDeviceInfo` when reachable) → connection status with hysteresis, heartbeat,
 * firmware, clock skew, device_logs and `device.offline` / `device.online` on transitions only. Push devices are judged by
 * their last heartbeat instead of a provider call. An unreachable device is a *successful* check (the observation is the result).
 */
export async function deviceHealthCheck(ctx: JobContext) {
  const { deps, log } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const prep = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      if (device.integrationType === 'DEVICE_PUSH') return { device, push: true as const };
      const provider = deps.providers.get(device.providerKey);
      const built = await buildProviderContext(trx, deps, device, ctx.job.id, ctx.signal, { log, provider, timeoutMs: 60_000 });
      const circuit = await checkCircuit(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey: built.accountKey }, now);
      return { device, push: false as const, built, circuit, caps: capabilitiesOf(device, provider) };
    });
    const { device } = prep;
    let obs: HealthObservation;
    if (prep.push) obs = heartbeatObservation(device, now);
    else {
      const { built } = prep;
      if (!prep.circuit.allow) { built.dispose(); return { result: { skipped: 'circuit_open', connectionStatus: device.connectionStatus, halfOpenAt: prep.circuit.halfOpenAt?.toISOString() ?? null } }; }
      try {
        let status: DeviceStatus;
        let info: DeviceInfo | undefined;
        try {
          status = await built.provider.getDeviceStatus(built.ctx);
          if (status.online) info = await built.provider.getDeviceInfo(built.ctx).catch(() => undefined);
        } catch (err) {
          if (!isProviderCode(err, 'DEVICE_OFFLINE', 'TIMEOUT')) throw err;
          status = { online: false, details: { code: (err as ProviderError).code, reason: (err as Error).message } };
        }
        const deviceTime = status.deviceTime ?? info?.deviceTime;
        obs = {
          online: status.online, lastSeenAt: status.lastSeenAt ? new Date(status.lastSeenAt) : status.online ? now : null,
          clockSkewSeconds: status.clockSkewSeconds ?? skewSeconds(deviceTime, now), firmwareVersion: info?.firmwareVersion ?? null,
          errorCode: status.online ? null : String(status.details?.['code'] ?? 'DEVICE_OFFLINE'), error: status.online ? null : String(status.details?.['reason'] ?? 'device reported offline'),
          details: { ...(status.details ?? {}), ...(info ? { model: info.model ?? null, userCount: info.userCount ?? null, transactionCount: info.transactionCount ?? null } : {}) },
        };
      } catch (err) {
        await handleProviderFailure(ctx, device, built.accountKey, err);
        throw err;
      } finally {
        built.dispose();
      }
    }
    const outcome = await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
      const o = await applyHealth(trx, device, { ...obs, event: 'health_check', jobId: item.syncJobId }, now);
      if (obs.online && !prep.push) await handleProviderSuccess(trx, device, prep.built.accountKey);
      return o;
    });
    return { result: { online: obs.online, connectionStatus: outcome.current, previous: outcome.previous, transition: outcome.transition, consecutiveFailures: outcome.consecutiveFailures, clockSkewSeconds: obs.clockSkewSeconds ?? null, firmwareVersion: obs.firmwareVersion ?? null } };
  });
}

/**
 * TEST_CONNECTION: uses the credentials stored for the device (never credentials from the payload); the sanitised
 * ConnectionResult is the item result. A negative answer is a terminal FAILED item with the result kept.
 */
export async function testConnection(ctx: JobContext) {
  const { deps, log } = ctx;
  return runItem(ctx, async (item, payload) => {
    const now = deps.now();
    const built = await withContext(deps.db, { kind: 'system', organizationId: payload.organizationId, jobId: ctx.job.id }, async (trx) => {
      const device = await loadDeviceOrThrow(trx, payload.deviceId);
      return buildProviderContext(trx, deps, device, ctx.job.id, ctx.signal, { log, timeoutMs: 60_000 });
    });
    try {
      const res = await built.provider.testConnection(built.ctx);
      const result = redactForAudit({ ok: res.ok, message: res.message, latencyMs: res.latencyMs, deviceInfo: res.deviceInfo ?? null, details: res.details ?? null }) as Record<string, unknown>;
      await withContext(deps.db, { kind: 'system', organizationId: built.device.organizationId, jobId: ctx.job.id }, async (trx) => {
        if (res.ok) {
          await applyHealth(trx, built.device, { online: true, lastSeenAt: now, firmwareVersion: res.deviceInfo?.firmwareVersion ?? null, clockSkewSeconds: skewSeconds(res.deviceInfo?.deviceTime, now), event: 'test_connection', jobId: item.syncJobId, details: { latencyMs: res.latencyMs } }, now);
          await handleProviderSuccess(trx, built.device, built.accountKey);
        } else {
          await trx.insertInto('deviceLogs').values({ organizationId: built.device.organizationId, deviceId: built.device.id, level: 'warn', event: 'test_connection', jobId: item.syncJobId, message: res.message.slice(0, 300), details: JSON.stringify(result['details'] ?? {}) }).execute();
        }
      });
      if (!res.ok) return { result, failure: { code: String(res.details?.['code'] ?? 'CONNECTION_FAILED'), message: res.message } };
      return { result };
    } catch (err) {
      await handleProviderFailure(ctx, built.device, built.accountKey, err);
      throw err;
    } finally {
      built.dispose();
    }
  });
}

interface WebhookRow { id: string; organizationId: string | null; providerKey: string; deviceId: string | null; payload: unknown; headers: unknown; status: string }

async function resolveWebhookDevice(trx: Trx, organizationId: string, row: WebhookRow, vendorDeviceId: string | null): Promise<DeviceRow | null> {
  if (row.deviceId) return loadDevice(trx, row.deviceId);
  if (!vendorDeviceId) return null;
  const d = await trx.selectFrom('devices').selectAll().where('organizationId', '=', organizationId).where('status', '=', 'active')
    .where((eb) => eb.or([eb('serialNumber', '=', vendorDeviceId), eb('vendorDeviceId', '=', vendorDeviceId)])).executeTakeFirst();
  return d ?? null;
}

/**
 * WEBHOOK_EVENT: turns a stored `provider_webhook_events` row into raw transactions (source WEBHOOK). The API stores either the
 * normalised `{ vendorDeviceId, transactions }` form or the raw vendor body, which is re-parsed here through
 * `provider.handleWebhook` with the mapped device's stored secrets. Outcome is written back to the row (processed / failed).
 */
export async function webhookEvent(ctx: JobContext) {
  const { deps, log } = ctx;
  const webhookEventId = String(ctx.job.payload['webhookEventId'] ?? '');
  const organizationId = typeof ctx.job.payload['organizationId'] === 'string' ? ctx.job.payload['organizationId'] : ctx.job.organizationId;
  if (!webhookEventId || !organizationId) throw new AppError('VALIDATION_ERROR', 'WEBHOOK_EVENT requires webhookEventId and organizationId');
  const markFailed = (error: string, status: 'failed' | 'rejected' = 'failed') => withContext(deps.db, { kind: 'system', organizationId, jobId: ctx.job.id }, async (trx) => {
    await trx.updateTable('providerWebhookEvents').set({ status, error: error.slice(0, 500), processedAt: deps.now() }).where('id', '=', webhookEventId).execute();
    log.warn(event('webhook_event_failed', { webhookEventId, error, status }));
    return { status, error };
  });
  try {
    return await withContext(deps.db, { kind: 'system', organizationId, jobId: ctx.job.id }, async (trx) => {
      const row = (await trx.selectFrom('providerWebhookEvents').select(['id', 'organizationId', 'providerKey', 'deviceId', 'payload', 'headers', 'status']).where('id', '=', webhookEventId).forUpdate().executeTakeFirst()) as WebhookRow | undefined;
      if (!row) return { skipped: 'event_missing' };
      if (row.status === 'processed' || row.status === 'duplicate' || row.status === 'rejected') return { skipped: `already_${row.status}` };
      const body = row.payload as Record<string, unknown> | null;
      let transactions: RawTransaction[] = [];
      let vendorDeviceId: string | null = null;
      let device: DeviceRow | null = null;
      if (body && Array.isArray(body['transactions'])) {
        vendorDeviceId = typeof body['vendorDeviceId'] === 'string' ? body['vendorDeviceId'] : typeof body['deviceSerial'] === 'string' ? body['deviceSerial'] : null;
        transactions = (body['transactions'] as unknown[]).flatMap((t) => { const p = rawTransactionSchema.safeParse(t); return p.success ? [p.data] : []; });
        device = await resolveWebhookDevice(trx, organizationId, row, vendorDeviceId);
      } else {
        const provider = deps.providers.tryGet(row.providerKey);
        if (!provider?.handleWebhook) throw new WebhookFailure(`provider ${row.providerKey} cannot parse webhooks`, 'rejected');
        device = await resolveWebhookDevice(trx, organizationId, row, null);
        if (!device) throw new WebhookFailure('raw webhook payload requires device_id to look up the signing secret');
        const secrets = (await deps.credentials.get(trx, { organizationId, deviceId: device.id })) ?? {};
        const headers = row.headers && typeof row.headers === 'object' ? (row.headers as Record<string, string>) : {};
        const parsed = await provider.handleWebhook({ headers, rawBody: JSON.stringify(row.payload), body: row.payload, query: {} }, secrets);
        if (!parsed.accepted) throw new WebhookFailure(`webhook rejected by provider (${parsed.response.status})`, 'rejected');
        transactions = parsed.transactions;
        vendorDeviceId = parsed.vendorDeviceId ?? null;
      }
      if (!device) throw new WebhookFailure(`no active device matches vendor device ${vendorDeviceId ?? '(unknown)'}`);
      const ingested = await ingestRawTransactions(trx, { organizationId, device, source: 'WEBHOOK', syncJobId: null, transactions, now: deps.now(), queue: deps.queue });
      await trx.updateTable('providerWebhookEvents').set({ status: 'processed', deviceId: device.id, processedAt: deps.now(), error: null }).where('id', '=', row.id).execute();
      log.info(event('webhook_event_processed', { webhookEventId, deviceId: device.id, inserted: ingested.inserted, duplicates: ingested.duplicates, quarantined: ingested.quarantined, held: ingested.held }));
      return { status: 'processed', deviceId: device.id, inserted: ingested.inserted, duplicates: ingested.duplicates, quarantined: ingested.quarantined, held: ingested.held };
    });
  } catch (err) {
    // the processing transaction rolled back; record the outcome in a fresh one
    if (err instanceof WebhookFailure) return markFailed(err.message, err.status);
    return markFailed((err as Error).message);
  }
}

class WebhookFailure extends Error {
  constructor(message: string, readonly status: 'failed' | 'rejected' = 'failed') { super(message); this.name = 'WebhookFailure'; }
}

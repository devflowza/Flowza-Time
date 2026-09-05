import type { DeviceCapabilities } from '@flowza/contracts';
import { withContext, type Trx } from '@flowza/database';
import { ProviderError, type DeviceProvider } from '@flowza/device-providers';
import { AppError, event } from '@flowza/shared';
import type { JobContext } from '../types.js';
import { recordFailure, recordSuccess, VENDOR_ERROR_CODES } from './circuit.js';
import { loadDevice } from './context.js';
import { applyHealth } from './health.js';
import type { DeviceRow } from './types.js';

export async function loadDeviceOrThrow(trx: Trx, deviceId: string | null): Promise<DeviceRow> {
  if (!deviceId) throw new AppError('VALIDATION_ERROR', 'sync item has no device');
  const device = await loadDevice(trx, deviceId);
  if (!device) throw new AppError('NOT_FOUND', `device ${deviceId} not found`);
  if (device.status !== 'active') throw new AppError('INVALID_STATE', `device ${device.code} is ${device.status}`);
  return device;
}

/** Effective capabilities: the provider's declared matrix narrowed/overridden by `devices.capabilities`. */
export function capabilitiesOf(device: Pick<DeviceRow, 'capabilities'>, provider: DeviceProvider): DeviceCapabilities {
  const caps: DeviceCapabilities = { ...provider.definition.capabilities };
  const own = device.capabilities;
  if (own && typeof own === 'object' && !Array.isArray(own)) {
    for (const [k, v] of Object.entries(own as Record<string, unknown>)) if (typeof v === 'boolean' && k in caps) (caps as Record<string, boolean>)[k] = v;
  }
  return caps;
}

export function requireCapability(caps: DeviceCapabilities, key: keyof DeviceCapabilities, operation: string): void {
  if (!caps[key]) throw new ProviderError('UNSUPPORTED', `${operation} is not supported by this device (capability ${key})`, { retryable: false, details: { capability: key } });
}

export function isProviderCode(err: unknown, ...codes: string[]): boolean { return ProviderError.is(err) && codes.includes(err.code); }

/**
 * Failure bookkeeping after a provider call (own transaction — the failing work's transaction is gone):
 *  - vendor-level codes feed the circuit breaker for (org, provider, account);
 *  - device-level codes (offline/timeout) count towards the device's offline hysteresis;
 *  - credential/config errors flag the device `error` so the UI shows what to fix.
 * Never throws (a bookkeeping failure must not mask the original error).
 */
export async function handleProviderFailure(ctx: JobContext, device: DeviceRow, accountKey: string, err: unknown): Promise<void> {
  const { deps, log } = ctx;
  const code = ProviderError.is(err) ? err.code : AppError.is(err) ? err.code : (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'TIMEOUT' : 'INTERNAL');
  const message = err instanceof Error ? err.message : String(err);
  const now = deps.now();
  try {
    await withContext(deps.db, { kind: 'system', organizationId: device.organizationId, jobId: ctx.job.id }, async (trx) => {
      if (VENDOR_ERROR_CODES.has(code)) {
        const c = await recordFailure(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey }, { code, message }, now);
        if (c.opened) log.warn(event('provider_circuit_opened', { providerKey: device.providerKey, accountKey, failureCount: c.failureCount }));
      }
      if (code === 'DEVICE_OFFLINE' || code === 'TIMEOUT') {
        await applyHealth(trx, device, { online: false, errorCode: code, error: message, event: 'sync_failed', jobId: null }, now);
      } else {
        const flag = code === 'AUTH_FAILED' || code === 'INVALID_CONFIG' || code === 'PROTOCOL_ERROR';
        await trx.updateTable('devices').set({ lastErrorCode: code, lastError: message.slice(0, 500), lastErrorAt: now, ...(flag ? { connectionStatus: 'error' as const } : {}) }).where('id', '=', device.id).execute();
        await trx.insertInto('deviceLogs').values({ organizationId: device.organizationId, deviceId: device.id, level: flag ? 'error' : 'warn', event: 'sync_failed', message: `${code}: ${message.slice(0, 300)}`, details: JSON.stringify({ code }) }).execute();
      }
    });
  } catch (bookkeepingErr) {
    log.error(event('sync_failure_bookkeeping_failed', { err: (bookkeepingErr as Error).message, originalCode: code }));
  }
}

/** Success bookkeeping: closes an open/half-open circuit for the account. */
export async function handleProviderSuccess(trx: Trx, device: DeviceRow, accountKey: string): Promise<void> {
  await recordSuccess(trx, { organizationId: device.organizationId, providerKey: device.providerKey, accountKey });
}

/** Open circuit → the item waits for the half-open probe time (retry honours `retryAfterMs`; never counted as a vendor failure). */
export function circuitOpenError(halfOpenAt: Date | null, now: Date): ProviderError {
  const wait = Math.max(5_000, (halfOpenAt?.getTime() ?? now.getTime() + 60_000) - now.getTime());
  return new ProviderError('RATE_LIMITED', 'vendor circuit is open; waiting for the half-open probe', { retryable: true, retryAfterMs: wait, details: { circuit: 'open', halfOpenAt: halfOpenAt?.toISOString() ?? null } });
}

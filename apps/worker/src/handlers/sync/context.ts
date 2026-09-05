import { createThrottler, type DeviceProvider, type ProviderContext, type ThrottleLease, type Throttler } from '@flowza/device-providers';
import { sha256Hex, type Logger } from '@flowza/shared';
import type { Trx } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import { DEFAULT_ORG_SYNC_SETTINGS, type DeviceRow, type OrgSyncSettings } from './types.js';

/** Default wall-clock budget for one provider conversation (all pages of a pull share it). */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 5 * 60_000;

/** Process-wide throttlers keyed by provider key (§F.6): one token bucket per provider, semaphores per account/device. */
const throttlers = new Map<string, Throttler>();
export function throttlerFor(provider: DeviceProvider): Throttler {
  let t = throttlers.get(provider.definition.key);
  if (!t) { t = createThrottler(provider.definition.throttling); throttlers.set(provider.definition.key, t); }
  return t;
}

export async function loadDevice(trx: Trx, deviceId: string): Promise<DeviceRow | null> {
  const row = await trx.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirst();
  return row ?? null;
}

export function deviceConfig(device: Pick<DeviceRow, 'config'>): Record<string, unknown> {
  const c = device.config;
  return c && typeof c === 'object' && !Array.isArray(c) ? { ...(c as Record<string, unknown>) } : {};
}

/**
 * Vendor account identity used for throttling and the circuit breaker: the same cloud account (base URL + app key)
 * or the same on-prem server is one account; devices without any of those fields share the provider-wide default.
 * Only a hash of the identifying fields is kept so account keys can be logged/stored safely.
 */
export function accountKeyFor(device: Pick<DeviceRow, 'config' | 'endpointUrl' | 'serialNumber' | 'integrationType'>): string {
  const cfg = deviceConfig(device);
  const parts = ['baseUrl', 'appKey', 'accountId', 'tenant', 'host', 'serverUrl'].map((k) => cfg[k]).filter((v) => typeof v === 'string' && v.length > 0) as string[];
  if (device.endpointUrl) parts.push(device.endpointUrl);
  if (parts.length === 0 && device.integrationType === 'DEVICE_PUSH' && device.serialNumber) parts.push(device.serialNumber);
  if (parts.length === 0 && typeof cfg['serial'] === 'string') parts.push(cfg['serial']);
  return parts.length === 0 ? 'default' : sha256Hex(parts.join('|')).slice(0, 16);
}

export async function loadOrgSyncSettings(trx: Trx, organizationId: string): Promise<OrgSyncSettings> {
  const row = await trx.selectFrom('organizationSettings').select('sync').where('organizationId', '=', organizationId).executeTakeFirst();
  const raw = (row?.sync && typeof row.sync === 'object' && !Array.isArray(row.sync) ? row.sync : {}) as Record<string, unknown>;
  const num = (k: keyof OrgSyncSettings): number => { const v = raw[k]; return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_ORG_SYNC_SETTINGS[k] as number; };
  return {
    defaultIntervalMinutes: num('defaultIntervalMinutes'),
    adaptivePolling: typeof raw['adaptivePolling'] === 'boolean' ? raw['adaptivePolling'] : DEFAULT_ORG_SYNC_SETTINGS.adaptivePolling,
    offlineThresholdMinutes: num('offlineThresholdMinutes'),
    reconciliationIntervalHours: num('reconciliationIntervalHours'),
    maxIntervalMinutes: num('maxIntervalMinutes'),
    maxClockSkewMinutes: num('maxClockSkewMinutes'),
  };
}

export interface BuiltProviderContext {
  ctx: ProviderContext;
  provider: DeviceProvider;
  device: DeviceRow;
  accountKey: string;
  /** Releases the throttle lease and the timeout timer. Always call (try/finally). */
  dispose(): void;
}

export interface BuildContextOptions { timeoutMs?: number; log?: Logger; provider?: DeviceProvider }

/**
 * Assembles the ProviderContext for one device: decrypted credentials (in memory only, never logged), non-secret config,
 * device timezone/endpoint/serial, a child logger, an AbortSignal carrying the operation timeout and `acquire()` bound to
 * the provider's process-wide throttler. A context is a *sequential* conversation with the device: `acquire()` releases
 * the previous lease before taking a new one, so page loops never deadlock on `maxConcurrentPerDevice = 1`.
 */
export async function buildProviderContext(trx: Trx, deps: WorkerDeps, device: DeviceRow, jobId: string | null, signal: AbortSignal, opts: BuildContextOptions = {}): Promise<BuiltProviderContext> {
  const provider = opts.provider ?? deps.providers.get(device.providerKey);
  const credentials = (await deps.credentials.get(trx, { organizationId: device.organizationId, deviceId: device.id })) ?? {};
  const config = deviceConfig(device);
  // Push devices only know liveness from their last contact; providers read it from config (never a secret).
  if (device.lastHeartbeatAt && config['lastSeenAt'] === undefined) config['lastSeenAt'] = new Date(device.lastHeartbeatAt).toISOString();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  const throttler = throttlerFor(provider);
  const accountKey = accountKeyFor(device);
  let lease: ThrottleLease | null = null;
  const release = (): void => { lease?.release(); lease = null; };
  const logger = (opts.log ?? deps.log).child({ jobId, organizationId: device.organizationId, deviceId: device.id, deviceCode: device.code, providerKey: device.providerKey, accountKey });
  const ctx: ProviderContext = {
    organizationId: device.organizationId,
    deviceId: device.id,
    deviceCode: device.code,
    timezone: device.timezone,
    config,
    credentials,
    endpointUrl: device.endpointUrl,
    serialNumber: device.serialNumber,
    logger,
    signal: combined,
    acquire: async () => {
      release();
      lease = await throttler.acquire(accountKey, { deviceKey: device.id, signal: combined });
    },
  };
  return { ctx, provider, device, accountKey, dispose: release };
}

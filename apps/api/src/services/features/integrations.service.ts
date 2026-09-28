import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import { DateTime, IANAZone } from 'luxon';
import {
  FINANCE_DEFAULT_BASE_URL, FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_SYNC_DIRECTIONS, FINANCE_SYNC_FROM_DEFAULT_DAYS, FLOWZA_FINANCE_PROVIDER_KEY,
  type FinanceIntegrationDto, type FinanceIntegrationInput, type FinanceIntegrationStatusDto, type FinanceIntegrationTestDto, type FinanceIntegrationTestInput, type FinancePinKey, type FinanceRecentJobDto, type FinanceSyncDirection, type FinanceSyncNowDto,
} from '@flowza/contracts';
import { emitDomainEvent, maskCredentials, type Devices, type Trx } from '@flowza/database';
import {
  createThrottler, financeAccountKey, financePreviousSerials, hasFinanceBaseUrlVetting, ProviderError, resolveFinanceBaseUrl, type DeviceProvider, type ProviderContext, type Throttler,
} from '@flowza/device-providers';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requirePermission } from '../../lib/authorize.js';
import { jsonObject } from '../../lib/mappers.js';
import { type Actor, audit, runUser } from '../../lib/service.js';
import { toCount } from '../../lib/pagination.js';
import { systemStep } from './context.js';
import { assertEndpointAllowed, splitConfig } from './devices.service.js';
import { createSyncJob } from './sync-jobs.js';

/**
 * Flowza Finance connector (docs/integrations/flowza-finance.md). One `devices` row per organisation with provider
 * `flowza_finance` carries the connector; the Finance push token lives in `device_credentials` and is only ever returned masked.
 * Everything here runs behind `integration.manage` and touches the connector row as a system step — it is platform-owned
 * plumbing, not a terminal a branch manager administers — so a role holding only `integration.manage` can configure it.
 */
export const CONNECTOR_CODE = 'FLOWZA-FINANCE';
export const CONNECTOR_NAME = 'Flowza Finance connector';
const TEST_TIMEOUT_MS = 10_000;
/** Budget for the DNS half of the base-URL check on save / test (the provider re-checks and pins on every call anyway). */
const VET_TIMEOUT_MS = 5_000;
const RECENT_JOBS = 5;
const MAX_PREVIOUS_SERIALS = 20;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

type ConnectorRow = Selectable<Devices>;

function provider(deps: ApiDeps): DeviceProvider {
  const p = deps.providers.tryGet(FLOWZA_FINANCE_PROVIDER_KEY);
  if (!p) throw errors.featureDisabled(`provider:${FLOWZA_FINANCE_PROVIDER_KEY}`);
  return p;
}

/**
 * Authorization twice (AGENTS rule 2): the service checked `integration.manage` on the principal; the database re-checks the
 * caller's LIVE grant in the caller's own context before any system step, so a stale or forged principal stops here — before the
 * connector row, the token or an outbound call is touched.
 */
async function assertLiveGrant(trx: Trx, orgId: string): Promise<void> {
  const { rows } = await sql<{ ok: boolean }>`select app.has_permission(${orgId}::uuid, 'integration.manage') as ok`.execute(trx);
  if (rows[0]?.ok !== true) throw errors.forbidden('Missing permission: integration.manage.');
}
/** The caller's transaction: live-grant re-check, then the connector rows as a system step (platform plumbing, see CONNECTOR_CODE). */
function asManager<T>(deps: ApiDeps, actor: Actor, orgId: string, fn: (t: Trx) => Promise<T>): Promise<T> {
  return runUser(deps.db, actor, async (trx) => { await assertLiveGrant(trx, orgId); return systemStep(trx, orgId, fn); });
}

async function loadConnector(trx: Trx, orgId: string): Promise<ConnectorRow | undefined> {
  return trx.selectFrom('devices').selectAll().where('organizationId', '=', orgId).where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).where('status', '!=', 'decommissioned').orderBy('createdAt', 'asc').executeTakeFirst();
}

const zoneOf = (tz: string | null | undefined): string => (tz && IANAZone.isValidZone(tz) ? tz : 'UTC');
/** Today's calendar day (`YYYY-MM-DD`) in the connector's timezone. */
function localDay(at: Date, timezone: string | null | undefined): string {
  return DateTime.fromJSDate(at).setZone(zoneOf(timezone)).toISODate() ?? at.toISOString().slice(0, 10);
}
/** Default start date: FINANCE_SYNC_FROM_DEFAULT_DAYS before `at` (the day the connector is set up), in its timezone. */
export function defaultFinanceSyncFrom(at: Date, timezone: string | null | undefined): string {
  return DateTime.fromJSDate(at).setZone(zoneOf(timezone)).minus({ days: FINANCE_SYNC_FROM_DEFAULT_DAYS }).toISODate() ?? at.toISOString().slice(0, 10);
}
async function orgTimezone(trx: Trx, orgId: string): Promise<string> {
  return (await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst())?.timezone ?? 'UTC';
}

interface ConnectorSettings { baseUrl: string; deviceSerial: string | null; direction: FinanceSyncDirection; pinKey: FinancePinKey; pollMinutes: number; syncFrom: string }
function settingsOf(device: ConnectorRow): ConnectorSettings {
  const cfg = jsonObject(device.config);
  const direction = (FINANCE_SYNC_DIRECTIONS as readonly string[]).includes(String(cfg['direction'])) ? (cfg['direction'] as FinanceSyncDirection) : 'both';
  const pinKey = (FINANCE_PIN_KEYS as readonly string[]).includes(String(cfg['pinKey'])) ? (cfg['pinKey'] as FinancePinKey) : 'employee_number';
  const poll = typeof cfg['pollMinutes'] === 'number' ? cfg['pollMinutes'] : device.syncIntervalMinutes;
  const storedFrom = typeof cfg['syncFrom'] === 'string' && ISO_DAY.test(cfg['syncFrom']) ? cfg['syncFrom'] : null;
  return {
    baseUrl: typeof cfg['baseUrl'] === 'string' && cfg['baseUrl'] ? cfg['baseUrl'] : (device.endpointUrl ?? FINANCE_DEFAULT_BASE_URL),
    deviceSerial: typeof cfg['deviceSerial'] === 'string' && cfg['deviceSerial'] ? cfg['deviceSerial'] : device.serialNumber,
    direction, pinKey,
    pollMinutes: Math.min(FINANCE_POLL_MINUTES.max, Math.max(FINANCE_POLL_MINUTES.min, Math.floor(Number(poll) || FINANCE_POLL_MINUTES.default))),
    // a row written before the start date existed (the 000450 migration backfills it; this is the same rule as a fallback)
    syncFrom: storedFrom ?? defaultFinanceSyncFrom(new Date(device.createdAt), device.timezone),
  };
}

/** Pull-capable only when the connector pulls: the capability is what sync-all, the device page and the worker read (review D6). */
function connectorCapabilities(def: DeviceProvider['definition'], direction: FinanceSyncDirection): Record<string, boolean> {
  return { ...def.capabilities, attendancePull: direction !== 'push' };
}

/**
 * The connector's egress rule on save and test (review D1): the provider's own `vetBaseUrl` — https, no credentials, IP literals in
 * every spelling and reserved names refused, trailing dot stripped, and every address the host RESOLVES to must be public — so a
 * name pointing at loopback / a private range is refused before any request is made. Every call then re-checks and connects to the
 * address it checked. `FLOWZA_ALLOW_PRIVATE_EGRESS` (local development) relaxes it through the provider's own option. A refusal is
 * a 400 carrying the provider's generic message, never a resolver answer.
 */
export async function validateFinanceBaseUrl(deps: ApiDeps, raw: string | undefined): Promise<string> {
  const p = provider(deps);
  try {
    if (hasFinanceBaseUrlVetting(p)) return await p.vetBaseUrl(raw, AbortSignal.timeout(VET_TIMEOUT_MS));
    const allowPrivateHosts = deps.config.FLOWZA_ALLOW_PRIVATE_EGRESS === true;
    const baseUrl = resolveFinanceBaseUrl(raw, { allowPrivateHosts });
    if (!allowPrivateHosts) assertEndpointAllowed(p.definition, baseUrl);
    return baseUrl;
  } catch (err) {
    if (ProviderError.is(err)) throw errors.validation(err.message, { issues: [{ path: 'baseUrl', message: err.message }] });
    throw err;
  }
}

async function toDto(deps: ApiDeps, trx: Trx, orgId: string, device: ConnectorRow | undefined): Promise<FinanceIntegrationDto> {
  if (!device) {
    return {
      configured: false, enabled: false, deviceId: null, branchId: null, baseUrl: FINANCE_DEFAULT_BASE_URL, deviceSerial: null, direction: 'both', pinKey: 'employee_number', pollMinutes: FINANCE_POLL_MINUTES.default,
      syncFrom: defaultFinanceSyncFrom(new Date(), await orgTimezone(trx, orgId)), hasToken: false, tokenMasked: null, connectionStatus: null, lastErrorCode: null, lastError: null, updatedAt: null,
    };
  }
  const s = settingsOf(device);
  const masked = await deps.credentials.masked(trx, device.id).catch(() => ({} as Record<string, unknown>));
  const tokenMasked = typeof masked['token'] === 'string' ? masked['token'] : null;
  return {
    configured: true, enabled: device.status === 'active', deviceId: device.id, branchId: device.branchId, baseUrl: s.baseUrl, deviceSerial: s.deviceSerial, direction: s.direction, pinKey: s.pinKey, pollMinutes: s.pollMinutes,
    syncFrom: s.syncFrom, hasToken: tokenMasked !== null, tokenMasked, connectionStatus: device.connectionStatus, lastErrorCode: device.lastErrorCode, lastError: device.lastError, updatedAt: new Date(device.updatedAt).toISOString(),
  };
}

export async function getFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return asManager(deps, actor, orgId, async (t) => toDto(deps, t, orgId, await loadConnector(t, orgId)));
}

/**
 * Forgets what the connector knew about its Finance: the pull cursor is emptied (kept as `previous_cursor` for the record — unless
 * it was already empty, so a second reset does not overwrite the real one), and the push position, the retry of a rejected batch
 * and the pushed-events ledger are cleared (plus, with `clearFailures`, the failure streak). The next pull and the next push start
 * at the start date again and send everything from it (Finance dedupes what it already holds). Callers bump `devices.generation`
 * in the same transaction, so a run in flight writes nothing afterwards.
 */
async function resetConnectorProgress(t: Trx, deviceId: string, orgId: string, reason: string, actorUserId: string, now: Date, opts: { clearFailures: boolean; stopPush?: boolean }): Promise<void> {
  await sql`update public.sync_cursors
      set previous_cursor = case when cursor = '{}'::jsonb then previous_cursor else cursor end, cursor = '{}'::jsonb,
          rewind_reason = ${reason}, rewound_at = ${now}, rewound_by = ${actorUserId}::uuid, invalid_since = null
    where device_id = ${deviceId}::uuid and stream = 'attendance'`.execute(t);
  await sql`insert into public.finance_sync_state (device_id, organization_id) values (${deviceId}::uuid, ${orgId}::uuid) on conflict (device_id) do nothing`.execute(t);
  await t.updateTable('financeSyncState').set({
    pushPositionAt: null, lastPushedEventId: null, lastPushedEventAt: null, pushRetryEventId: null, pushRetryAttempts: 0,
    ...(opts.clearFailures ? { consecutiveFailures: 0, lastError: null, lastErrorAt: null } : {}),
    ...(opts.stopPush ? { nextPushAt: null } : {}),
  }).where('deviceId', '=', deviceId).execute();
  await t.deleteFrom('financePushedEvents').where('deviceId', '=', deviceId).execute();
}

/**
 * Creates or replaces the connector. The connector row is not counted against the plan's device limit (it is not a terminal) and
 * is never a target for employee sync.
 *
 *  - Token: required on creation and whenever the connector is enabled without a usable stored token. A stored token belongs to
 *    the base URL + serial it was entered for: when either changes, a new one must be supplied (enabled) or the stored one is
 *    DELETED (disabled) — it is never kept for, nor sent to, another Finance.
 *  - Re-pointing (base URL or serial changed, review D9): the pull cursor, the push position and ledger and the failure streak are
 *    reset, `devices.generation` is bumped (runs in flight write nothing afterwards), the old serial joins `previousSerials` (Finance
 *    punches pushed under it are recognised as our own on pull) and the change is audited as `integration.finance_repointed`.
 *  - Start date (`syncFrom`): never in the future; omitted keeps the stored one (default on creation: 30 days back). Moving it
 *    EARLIER re-reads Finance and re-sends FlowZa Time punches from the new date (cursor, push position and ledger reset, generation
 *    bumped, audited as `integration.finance_sync_from_moved`; both sides dedupe). Moving it later only narrows what is
 *    synchronised from now on.
 *  - Direction: a push-only connector is not pull-capable and is never polled (review D6).
 */
export async function putFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string, input: FinanceIntegrationInput): Promise<FinanceIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  // the live grant is re-checked before the base URL is even resolved (and again, in the write transaction, by asManager)
  await runUser(deps.db, actor, (trx) => assertLiveGrant(trx, orgId));
  const p = provider(deps);
  const def = p.definition;
  const baseUrl = await validateFinanceBaseUrl(deps, input.baseUrl);
  const { config } = splitConfig(def, { baseUrl, deviceSerial: input.deviceSerial, direction: input.direction, pinKey: input.pinKey, pollMinutes: input.pollMinutes, ...(input.token ? { token: input.token } : {}) }, { requireRequired: input.token !== undefined });
  const now = new Date();
  const autoSync = input.enabled && input.direction !== 'push';
  return asManager(deps, actor, orgId, async (t) => {
    const existing = await loadConnector(t, orgId);
    const previous = existing ? settingsOf(existing) : null;
    const repointed = !!previous && (previous.baseUrl !== baseUrl || previous.deviceSerial !== input.deviceSerial);
    const stored = existing ? await deps.credentials.masked(t, existing.id).catch(() => ({} as Record<string, unknown>)) : {};
    const hasStoredToken = typeof stored['token'] === 'string';
    const storedTokenUsable = hasStoredToken && !repointed;
    if (!input.token && (!existing || (input.enabled && !storedTokenUsable))) {
      throw errors.validation(existing && repointed ? 'Enter the Finance push token again when the base URL or device serial changes.' : 'The Finance push token is required.', { issues: [{ path: 'token', message: 'Required' }] });
    }
    const timezone = existing?.timezone ?? (await orgTimezone(t, orgId));
    if (input.syncFrom !== undefined && input.syncFrom > localDay(now, timezone)) {
      throw errors.validation('The start date cannot be in the future.', { issues: [{ path: 'syncFrom', message: 'Must be today or earlier' }] });
    }
    const syncFrom = input.syncFrom ?? previous?.syncFrom ?? defaultFinanceSyncFrom(now, timezone);
    const syncFromEarlier = !!previous && syncFrom < previous.syncFrom;
    const branchId = input.branchId ?? existing?.branchId ?? (await t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('status', '=', 'active').orderBy('createdAt', 'asc').executeTakeFirst())?.id;
    if (!branchId) throw errors.validation('Create a branch before configuring the connector.', { issues: [{ path: 'branchId', message: 'No active branch' }] });
    if (input.branchId) {
      const branch = await t.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst();
      if (!branch || branch.status === 'archived') throw errors.validation('Branch not found in this organisation.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    }
    // serials this connector used before: Finance only loop-guards the CURRENT connector device, so punches pushed under an older
    // serial would otherwise come back on pull as Finance punches
    const knownSerials = existing ? financePreviousSerials(jsonObject(existing.config)) : [];
    const oldSerial = previous?.deviceSerial ?? null;
    const previousSerials = (oldSerial && oldSerial !== input.deviceSerial ? [...knownSerials.filter((s) => s !== oldSerial), oldSerial] : knownSerials)
      .filter((s) => s !== input.deviceSerial).slice(-MAX_PREVIOUS_SERIALS);
    const model = await t.selectFrom('deviceModels').select('id').where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).orderBy('model', 'asc').executeTakeFirst();
    const patch = {
      branchId, name: CONNECTOR_NAME, modelId: model?.id ?? null, manufacturer: def.vendor, modelName: CONNECTOR_NAME, serialNumber: input.deviceSerial, endpointUrl: baseUrl,
      config: JSON.stringify({ ...config, syncFrom, ...(previousSerials.length ? { previousSerials } : {}) }),
      capabilities: JSON.stringify(connectorCapabilities(def, input.direction)), status: input.enabled ? ('active' as const) : ('disabled' as const), autoSyncEnabled: autoSync, syncIntervalMinutes: input.pollMinutes,
      nextAttendanceSyncAt: autoSync ? now : null, tags: ['integration', 'flowza-finance'],
    };
    const resetProgress = repointed || syncFromEarlier;
    let deviceId: string;
    let generation: number;
    if (existing) {
      const row = await t.updateTable('devices').set({ ...patch, ...(resetProgress ? { generation: sql<number>`generation + 1` } : {}) }).where('id', '=', existing.id).returning('generation').executeTakeFirstOrThrow();
      deviceId = existing.id;
      generation = row.generation;
    } else {
      const row = await t.insertInto('devices').values({ ...patch, organizationId: orgId, code: CONNECTOR_CODE, providerKey: FLOWZA_FINANCE_PROVIDER_KEY, integrationType: def.integrationType, timezone, offlineThresholdMinutes: 60, createdBy: actor.userId }).returning(['id', 'generation']).executeTakeFirstOrThrow();
      deviceId = row.id;
      generation = row.generation;
    }
    let tokenDeleted = false;
    if (input.token) await deps.credentials.put(t, { organizationId: orgId, deviceId }, { token: input.token }, maskCredentials({ token: input.token }, ['token']), actor.userId);
    else if (repointed && hasStoredToken) tokenDeleted = await deps.credentials.delete(t, deviceId); // disabled + re-pointed: the old Finance's token is not kept
    // the push side wakes up on the next scheduler tick; a disabled or pull-only connector is simply never admitted
    await sql`insert into public.finance_sync_state (device_id, organization_id, next_push_at) values (${deviceId}::uuid, ${orgId}::uuid, ${now})
      on conflict (device_id) do update set next_push_at = least(coalesce(finance_sync_state.next_push_at, excluded.next_push_at), excluded.next_push_at)`.execute(t);
    if (existing && resetProgress) {
      await resetConnectorProgress(t, deviceId, orgId, repointed ? 'connector_repointed' : 'sync_from_changed', actor.userId, now, { clearFailures: repointed });
    }
    const newValue = { enabled: input.enabled, baseUrl, deviceSerial: input.deviceSerial, direction: input.direction, pinKey: input.pinKey, pollMinutes: input.pollMinutes, syncFrom, branchId, tokenReplaced: !!input.token };
    const oldValue = previous ? { enabled: existing!.status === 'active', ...previous, branchId: existing!.branchId } : undefined;
    await audit(t, actor, orgId, existing ? 'integration.finance_updated' : 'integration.finance_created', 'integration', { entityId: deviceId, branchId, newValue, ...(oldValue ? { oldValue } : {}) });
    if (existing && repointed) {
      await audit(t, actor, orgId, 'integration.finance_repointed', 'integration', {
        entityId: deviceId, branchId,
        oldValue: { baseUrl: previous!.baseUrl, deviceSerial: previous!.deviceSerial, generation: existing.generation },
        newValue: { baseUrl, deviceSerial: input.deviceSerial, tokenReplaced: !!input.token, tokenDeleted, cursorReset: true, pushPositionReset: true, ledgerCleared: true, generation },
      });
    } else if (existing && syncFromEarlier) {
      await audit(t, actor, orgId, 'integration.finance_sync_from_moved', 'integration', {
        entityId: deviceId, branchId, oldValue: { syncFrom: previous!.syncFrom, generation: existing.generation }, newValue: { syncFrom, cursorReset: true, pushPositionReset: true, ledgerCleared: true, generation },
      });
    }
    await emitDomainEvent(t, { organizationId: orgId, eventType: existing ? 'device.updated' : 'device.created', aggregateType: 'device', aggregateId: deviceId, payload: { code: CONNECTOR_CODE, providerKey: FLOWZA_FINANCE_PROVIDER_KEY, branchId, integration: 'flowza_finance' }, actorUserId: actor.userId, requestId: actor.requestId });
    return toDto(deps, t, orgId, await loadConnector(t, orgId));
  });
}

/**
 * Disconnect: the connector stops (disabled, no auto-sync, no scheduled push), its Finance token is deleted, and what it knew about
 * Finance — pull cursor, push position, retry, ledger, failure streak — is cleared; the generation is bumped so a run in flight
 * writes nothing. The row and its settings stay (Finance punches already imported keep their device), so reconnecting is saving the
 * settings again with a token; the next pull and push then start at the start date. Punches already imported are not touched.
 * Idempotent: an absent connector answers the unconfigured state.
 */
export async function disconnectFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  const now = new Date();
  return asManager(deps, actor, orgId, async (t) => {
    const existing = await loadConnector(t, orgId);
    if (!existing) return toDto(deps, t, orgId, undefined);
    const row = await t.updateTable('devices').set({ status: 'disabled', autoSyncEnabled: false, nextAttendanceSyncAt: null, generation: sql<number>`generation + 1` }).where('id', '=', existing.id).returning('generation').executeTakeFirstOrThrow();
    const tokenDeleted = await deps.credentials.delete(t, existing.id);
    await resetConnectorProgress(t, existing.id, orgId, 'connector_disconnected', actor.userId, now, { clearFailures: true, stopPush: true });
    await audit(t, actor, orgId, 'integration.finance_disconnected', 'integration', {
      entityId: existing.id, branchId: existing.branchId,
      oldValue: { enabled: existing.status === 'active', generation: existing.generation },
      newValue: { enabled: false, tokenDeleted, cursorReset: true, pushPositionReset: true, ledgerCleared: true, generation: row.generation },
    });
    await emitDomainEvent(t, { organizationId: orgId, eventType: 'device.updated', aggregateType: 'device', aggregateId: existing.id, payload: { code: CONNECTOR_CODE, providerKey: FLOWZA_FINANCE_PROVIDER_KEY, branchId: existing.branchId, integration: 'flowza_finance', disconnected: true }, actorUserId: actor.userId, requestId: actor.requestId });
    return toDto(deps, t, orgId, await loadConnector(t, orgId));
  });
}

const throttlers = new Map<string, Throttler>();
function throttlerFor(def: DeviceProvider['definition']): Throttler {
  let t = throttlers.get(def.key);
  if (!t) { t = createThrottler(def.throttling); throttlers.set(def.key, t); }
  return t;
}

/**
 * Calls Finance's attendance-export with limit 1 through the provider's `testConnection`. Values not supplied come from the
 * stored connector; the stored token is reused only for the stored base URL + serial (a request cannot aim the secret at another
 * host). The base URL passes the same egress check as on save before anything is sent. The response never carries the token, and a
 * transport failure is reported generically (unreachable / TLS / timeout / refused), never with a socket code or a response body.
 */
export async function testFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string, input: FinanceIntegrationTestInput): Promise<FinanceIntegrationTestDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  const p = provider(deps);
  const def = p.definition;
  const existing = await asManager(deps, actor, orgId, (t) => loadConnector(t, orgId));
  const stored = existing ? settingsOf(existing) : null;
  const baseUrl = await validateFinanceBaseUrl(deps, input.baseUrl ?? stored?.baseUrl);
  const deviceSerial = input.deviceSerial ?? stored?.deviceSerial ?? null;
  if (!deviceSerial) throw errors.validation('The Finance device serial is required.', { issues: [{ path: 'deviceSerial', message: 'Required' }] });
  let token = input.token ?? null;
  let usedStored = false;
  if (!token && existing && stored && stored.baseUrl === baseUrl && stored.deviceSerial === deviceSerial) {
    const creds = await asManager(deps, actor, orgId, (t) => deps.credentials.get(t, { organizationId: orgId, deviceId: existing.id }));
    if (creds && typeof creds['token'] === 'string') { token = creds['token']; usedStored = true; }
  }
  if (!token) throw errors.validation('Enter the Finance push token to test this connection.', { issues: [{ path: 'token', message: 'Required' }] });
  const deviceId = existing?.id ?? 'new';
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const throttler = throttlerFor(def);
  const leases: { release(): void }[] = [];
  const ctx: ProviderContext = {
    organizationId: orgId, deviceId, deviceCode: existing?.code ?? CONNECTOR_CODE, timezone: existing?.timezone ?? 'UTC',
    config: { baseUrl, deviceSerial, direction: stored?.direction ?? 'both', pinKey: stored?.pinKey ?? 'employee_number' },
    credentials: { token }, endpointUrl: baseUrl, serialNumber: deviceSerial,
    logger: deps.log.child({ requestId: actor.requestId, deviceId }), signal,
    // the connector's own throttle account (organisation + connector device, review D12), never one shared across tenants
    acquire: async () => { leases.push(await throttler.acquire(financeAccountKey(orgId, deviceId), { deviceKey: deviceId, signal })); },
  };
  const started = Date.now();
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  try {
    const r = await p.testConnection(ctx);
    return { ok: r.ok, message: r.message, latencyMs: r.latencyMs, code: r.ok ? null : str(r.details?.['code']) ?? 'CONNECTION_FAILED', retryable: r.details?.['retryable'] === true, serverTime: str(r.details?.['serverTime']), firstPunchAt: str(r.details?.['firstPunchAt']), usedStoredCredentials: usedStored };
  } catch (err) {
    if (ProviderError.is(err)) return { ok: false, message: err.message, latencyMs: Date.now() - started, code: err.code, retryable: err.retryable, serverTime: null, firstPunchAt: null, usedStoredCredentials: usedStored };
    if ((err as Error)?.name === 'TimeoutError' || signal.aborted) return { ok: false, message: 'Flowza Finance did not answer within 10 seconds.', latencyMs: Date.now() - started, code: 'TIMEOUT', retryable: true, serverTime: null, firstPunchAt: null, usedStoredCredentials: usedStored };
    deps.log.warn({ event: 'finance_test_connection_failed', requestId: actor.requestId, organizationId: orgId, err: (err as Error).message });
    return { ok: false, message: 'Connection test failed.', latencyMs: Date.now() - started, code: 'PROVIDER_ERROR', retryable: false, serverTime: null, firstPunchAt: null, usedStoredCredentials: usedStored };
  } finally {
    for (const l of leases) l.release();
  }
}

/** Queues a pull and/or a push (per the configured direction) as MANUAL sync jobs; returns their ids (visible in Sync pages). */
export async function syncFinanceNow(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceSyncNowDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => {
    await assertLiveGrant(trx, orgId);
    const device = await systemStep(trx, orgId, (t) => loadConnector(t, orgId));
    if (!device) throw errors.invalidState('The Flowza Finance connector is not configured.');
    if (device.status !== 'active') throw errors.invalidState('The Flowza Finance connector is disabled; enable it before syncing.');
    const s = settingsOf(device);
    const scope = { integration: 'flowza_finance', deviceIds: [device.id] };
    let pullJobId: string | null = null;
    let pushJobId: string | null = null;
    if (s.direction !== 'push') {
      pullJobId = (await createSyncJob(deps, trx, { organizationId: orgId, jobType: 'PULL_ATTENDANCE', trigger: 'MANUAL', scope, branchId: device.branchId, requestedBy: actor.userId, correlationId: actor.requestId, priority: 7, items: [{ deviceId: device.id, branchId: device.branchId }] })).id;
    }
    if (s.direction !== 'pull') {
      pushJobId = (await createSyncJob(deps, trx, { organizationId: orgId, jobType: 'PUSH_ATTENDANCE', trigger: 'MANUAL', scope, branchId: device.branchId, requestedBy: actor.userId, correlationId: actor.requestId, priority: 7, items: [{ deviceId: device.id, branchId: device.branchId }] })).id;
    }
    await audit(trx, actor, orgId, 'integration.finance_sync_requested', 'integration', { entityId: device.id, branchId: device.branchId, newValue: { pullJobId, pushJobId, direction: s.direction } });
    const parts = [pullJobId ? 'pull' : null, pushJobId ? 'push' : null].filter(Boolean);
    return { pullJobId, pushJobId, message: `Queued Flowza Finance ${parts.join(' and ')}.` };
  });
}

export async function getFinanceStatus(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceIntegrationStatusDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return asManager(deps, actor, orgId, async (t) => {
    const device = await loadConnector(t, orgId);
    if (!device) return { configured: false, enabled: false, deviceId: null, connectionStatus: null, state: null, cursor: null, circuit: null, unmatchedCount: 0, pendingCount: 0, lastJobs: [] };
    const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
    const [state, cursor, circuit, counts, jobs] = await Promise.all([
      t.selectFrom('financeSyncState').selectAll().where('deviceId', '=', device.id).executeTakeFirst(),
      t.selectFrom('syncCursors').select(['lastPulledAt', 'lastTransactionAt']).where('deviceId', '=', device.id).where('stream', '=', 'attendance').executeTakeFirst(),
      // this connector's own circuit (organisation + connector device, review D12)
      t.selectFrom('providerCircuitStates').select(['state', 'halfOpenAt', 'failureCount']).where('organizationId', '=', orgId).where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).where('accountKey', '=', financeAccountKey(orgId, device.id)).executeTakeFirst(),
      t.selectFrom('attendanceRawTransactions').select(['processingStatus', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('deviceId', '=', device.id).where('processingStatus', 'in', ['unmatched', 'pending']).groupBy('processingStatus').execute(),
      sql<{ id: string; jobType: FinanceRecentJobDto['jobType']; trigger: FinanceRecentJobDto['trigger']; status: FinanceRecentJobDto['status']; createdAt: Date; finishedAt: Date | null; recordsIngested: number; errorCode: string | null; error: string | null; itemResult: Record<string, unknown> | null }>`
        select j.id, j.job_type as "jobType", j.trigger, j.status, j.created_at as "createdAt", coalesce(i.finished_at, j.finished_at) as "finishedAt", i.records_ingested as "recordsIngested",
               coalesce(i.last_error_code, j.error_code) as "errorCode", coalesce(i.last_error, j.error) as "error", i.result as "itemResult"
        from public.sync_job_items i join public.sync_jobs j on j.id = i.sync_job_id
        where i.organization_id = ${orgId}::uuid and i.device_id = ${device.id}::uuid and i.operation in ('PULL_ATTENDANCE', 'PUSH_ATTENDANCE')
        order by j.created_at desc, i.created_at desc limit ${RECENT_JOBS}`.execute(t),
    ]);
    const countOf = (status: string) => toCount(counts.find((c) => c.processingStatus === status)?.n);
    return {
      configured: true, enabled: device.status === 'active', deviceId: device.id, connectionStatus: device.connectionStatus,
      state: state ? {
        lastPushedEventId: state.lastPushedEventId, lastPushedEventAt: iso(state.lastPushedEventAt), pushPositionAt: iso(state.pushPositionAt), pushRetryAttempts: state.pushRetryAttempts,
        lastPushAt: iso(state.lastPushAt), lastPushCount: state.lastPushCount, nextPushAt: iso(state.nextPushAt),
        lastPullAt: iso(state.lastPullAt), lastPullCount: state.lastPullCount, lastError: state.lastError, lastErrorAt: iso(state.lastErrorAt), consecutiveFailures: state.consecutiveFailures, updatedAt: iso(state.updatedAt)!,
      } : null,
      cursor: cursor ? { lastPulledAt: iso(cursor.lastPulledAt), lastTransactionAt: iso(cursor.lastTransactionAt) } : null,
      circuit: circuit ? { state: circuit.state, halfOpenAt: iso(circuit.halfOpenAt), failureCount: circuit.failureCount } : null,
      unmatchedCount: countOf('unmatched'), pendingCount: countOf('pending'),
      lastJobs: jobs.rows.map((j) => ({ id: j.id, jobType: j.jobType, trigger: j.trigger, status: j.status, createdAt: iso(j.createdAt)!, finishedAt: iso(j.finishedAt), recordsIngested: Number(j.recordsIngested ?? 0), errorCode: j.errorCode, error: j.error, itemResult: j.itemResult })),
    };
  });
}

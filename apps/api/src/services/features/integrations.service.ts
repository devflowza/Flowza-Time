import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import {
  FINANCE_DEFAULT_BASE_URL, FINANCE_PIN_KEYS, FINANCE_POLL_MINUTES, FINANCE_SYNC_DIRECTIONS, FLOWZA_FINANCE_PROVIDER_KEY,
  type FinanceIntegrationDto, type FinanceIntegrationInput, type FinanceIntegrationStatusDto, type FinanceIntegrationTestDto, type FinanceIntegrationTestInput, type FinancePinKey, type FinanceRecentJobDto, type FinanceSyncDirection, type FinanceSyncNowDto,
} from '@flowza/contracts';
import { emitDomainEvent, maskCredentials, type Devices, type Trx } from '@flowza/database';
import { createThrottler, ProviderError, resolveFinanceBaseUrl, type DeviceProvider, type ProviderContext, type Throttler } from '@flowza/device-providers';
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
const RECENT_JOBS = 5;

type ConnectorRow = Selectable<Devices>;

function provider(deps: ApiDeps): DeviceProvider {
  const p = deps.providers.tryGet(FLOWZA_FINANCE_PROVIDER_KEY);
  if (!p) throw errors.featureDisabled(`provider:${FLOWZA_FINANCE_PROVIDER_KEY}`);
  return p;
}

async function loadConnector(trx: Trx, orgId: string): Promise<ConnectorRow | undefined> {
  return trx.selectFrom('devices').selectAll().where('organizationId', '=', orgId).where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).where('status', '!=', 'decommissioned').orderBy('createdAt', 'asc').executeTakeFirst();
}

interface ConnectorSettings { baseUrl: string; deviceSerial: string | null; direction: FinanceSyncDirection; pinKey: FinancePinKey; pollMinutes: number }
function settingsOf(device: ConnectorRow): ConnectorSettings {
  const cfg = jsonObject(device.config);
  const direction = (FINANCE_SYNC_DIRECTIONS as readonly string[]).includes(String(cfg['direction'])) ? (cfg['direction'] as FinanceSyncDirection) : 'both';
  const pinKey = (FINANCE_PIN_KEYS as readonly string[]).includes(String(cfg['pinKey'])) ? (cfg['pinKey'] as FinancePinKey) : 'employee_number';
  const poll = typeof cfg['pollMinutes'] === 'number' ? cfg['pollMinutes'] : device.syncIntervalMinutes;
  return {
    baseUrl: typeof cfg['baseUrl'] === 'string' && cfg['baseUrl'] ? cfg['baseUrl'] : (device.endpointUrl ?? FINANCE_DEFAULT_BASE_URL),
    deviceSerial: typeof cfg['deviceSerial'] === 'string' && cfg['deviceSerial'] ? cfg['deviceSerial'] : device.serialNumber,
    direction, pinKey,
    pollMinutes: Math.min(FINANCE_POLL_MINUTES.max, Math.max(FINANCE_POLL_MINUTES.min, Math.floor(Number(poll) || FINANCE_POLL_MINUTES.default))),
  };
}

/** Validates the base URL with the connector's own rule (https + public host, unless the local-development flag allows otherwise) AND the generic egress helper. */
function validateBaseUrl(deps: ApiDeps, def: DeviceProvider['definition'], raw: string | undefined): string {
  const allowPrivateHosts = deps.config.FLOWZA_ALLOW_PRIVATE_EGRESS === true;
  let baseUrl: string;
  try { baseUrl = resolveFinanceBaseUrl(raw, { allowPrivateHosts }); } catch (err) {
    if (ProviderError.is(err)) throw errors.validation(err.message, { issues: [{ path: 'baseUrl', message: err.message }] });
    throw err;
  }
  if (!allowPrivateHosts) assertEndpointAllowed(def, baseUrl);
  return baseUrl;
}

async function toDto(deps: ApiDeps, trx: Trx, device: ConnectorRow | undefined): Promise<FinanceIntegrationDto> {
  if (!device) {
    return { configured: false, enabled: false, deviceId: null, branchId: null, baseUrl: FINANCE_DEFAULT_BASE_URL, deviceSerial: null, direction: 'both', pinKey: 'employee_number', pollMinutes: FINANCE_POLL_MINUTES.default, hasToken: false, tokenMasked: null, connectionStatus: null, lastErrorCode: null, lastError: null, updatedAt: null };
  }
  const s = settingsOf(device);
  const masked = await deps.credentials.masked(trx, device.id).catch(() => ({} as Record<string, unknown>));
  const tokenMasked = typeof masked['token'] === 'string' ? masked['token'] : null;
  return {
    configured: true, enabled: device.status === 'active', deviceId: device.id, branchId: device.branchId, baseUrl: s.baseUrl, deviceSerial: s.deviceSerial, direction: s.direction, pinKey: s.pinKey, pollMinutes: s.pollMinutes,
    hasToken: tokenMasked !== null, tokenMasked, connectionStatus: device.connectionStatus, lastErrorCode: device.lastErrorCode, lastError: device.lastError, updatedAt: new Date(device.updatedAt).toISOString(),
  };
}

export async function getFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, (trx) => systemStep(trx, orgId, async (t) => toDto(deps, t, await loadConnector(t, orgId))));
}

/**
 * Creates or replaces the connector. The token is required on creation and whenever the base URL or serial changes (a stored
 * credential belongs to the endpoint identity it was entered for); otherwise an omitted token keeps the stored one. The
 * connector row is not counted against the plan's device limit (it is not a terminal) and is never a target for employee sync.
 */
export async function putFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string, input: FinanceIntegrationInput): Promise<FinanceIntegrationDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  const p = provider(deps);
  const def = p.definition;
  const baseUrl = validateBaseUrl(deps, def, input.baseUrl);
  const { config } = splitConfig(def, { baseUrl, deviceSerial: input.deviceSerial, direction: input.direction, pinKey: input.pinKey, pollMinutes: input.pollMinutes, ...(input.token ? { token: input.token } : {}) }, { requireRequired: input.token !== undefined });
  const now = new Date();
  const autoSync = input.enabled && input.direction !== 'push';
  const result = await runUser(deps.db, actor, (trx) => systemStep(trx, orgId, async (t) => {
    const existing = await loadConnector(t, orgId);
    const previous = existing ? settingsOf(existing) : null;
    const identityChanged = !!previous && (previous.baseUrl !== baseUrl || previous.deviceSerial !== input.deviceSerial);
    const stored = existing ? await deps.credentials.masked(t, existing.id).catch(() => ({} as Record<string, unknown>)) : {};
    const hasStoredToken = typeof stored['token'] === 'string';
    if (!input.token && (!existing || identityChanged || !hasStoredToken)) {
      throw errors.validation(existing && identityChanged ? 'Enter the Finance push token again when the base URL or device serial changes.' : 'The Finance push token is required.', { issues: [{ path: 'token', message: 'Required' }] });
    }
    const branchId = input.branchId ?? existing?.branchId ?? (await t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('status', '=', 'active').orderBy('createdAt', 'asc').executeTakeFirst())?.id;
    if (!branchId) throw errors.validation('Create a branch before configuring the connector.', { issues: [{ path: 'branchId', message: 'No active branch' }] });
    if (input.branchId) {
      const branch = await t.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst();
      if (!branch || branch.status === 'archived') throw errors.validation('Branch not found in this organisation.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    }
    const model = await t.selectFrom('deviceModels').select('id').where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).orderBy('model', 'asc').executeTakeFirst();
    const patch = {
      branchId, name: CONNECTOR_NAME, modelId: model?.id ?? null, manufacturer: def.vendor, modelName: CONNECTOR_NAME, serialNumber: input.deviceSerial, endpointUrl: baseUrl, config: JSON.stringify(config),
      capabilities: JSON.stringify(def.capabilities), status: input.enabled ? ('active' as const) : ('disabled' as const), autoSyncEnabled: autoSync, syncIntervalMinutes: input.pollMinutes,
      nextAttendanceSyncAt: autoSync ? now : null, tags: ['integration', 'flowza-finance'],
    };
    let deviceId: string;
    if (existing) {
      await t.updateTable('devices').set(patch).where('id', '=', existing.id).execute();
      deviceId = existing.id;
    } else {
      const orgTz = (await t.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst())?.timezone ?? 'UTC';
      const row = await t.insertInto('devices').values({ ...patch, organizationId: orgId, code: CONNECTOR_CODE, providerKey: FLOWZA_FINANCE_PROVIDER_KEY, integrationType: def.integrationType, timezone: orgTz, offlineThresholdMinutes: 60, createdBy: actor.userId }).returning('id').executeTakeFirstOrThrow();
      deviceId = row.id;
    }
    if (input.token) await deps.credentials.put(t, { organizationId: orgId, deviceId }, { token: input.token }, maskCredentials({ token: input.token }, ['token']), actor.userId);
    // the push side wakes up on the next scheduler tick; a disabled or pull-only connector is simply never admitted
    await sql`insert into public.finance_sync_state (device_id, organization_id, next_push_at) values (${deviceId}::uuid, ${orgId}::uuid, ${now})
      on conflict (device_id) do update set next_push_at = least(coalesce(finance_sync_state.next_push_at, excluded.next_push_at), excluded.next_push_at)`.execute(t);
    const newValue = { enabled: input.enabled, baseUrl, deviceSerial: input.deviceSerial, direction: input.direction, pinKey: input.pinKey, pollMinutes: input.pollMinutes, branchId, tokenReplaced: !!input.token };
    const oldValue = previous ? { enabled: existing!.status === 'active', ...previous, branchId: existing!.branchId } : undefined;
    await audit(t, actor, orgId, existing ? 'integration.finance_updated' : 'integration.finance_created', 'integration', { entityId: deviceId, branchId, newValue, ...(oldValue ? { oldValue } : {}) });
    await emitDomainEvent(t, { organizationId: orgId, eventType: existing ? 'device.updated' : 'device.created', aggregateType: 'device', aggregateId: deviceId, payload: { code: CONNECTOR_CODE, providerKey: FLOWZA_FINANCE_PROVIDER_KEY, branchId, integration: 'flowza_finance' }, actorUserId: actor.userId, requestId: actor.requestId });
    return toDto(deps, t, await loadConnector(t, orgId));
  }));
  return result;
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
 * host). The response never carries the token.
 */
export async function testFinanceIntegration(deps: ApiDeps, actor: Actor, orgId: string, input: FinanceIntegrationTestInput): Promise<FinanceIntegrationTestDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  const p = provider(deps);
  const def = p.definition;
  const resolved = await runUser(deps.db, actor, (trx) => systemStep(trx, orgId, async (t) => {
    const existing = await loadConnector(t, orgId);
    const stored = existing ? settingsOf(existing) : null;
    const baseUrl = validateBaseUrl(deps, def, input.baseUrl ?? stored?.baseUrl);
    const deviceSerial = input.deviceSerial ?? stored?.deviceSerial ?? null;
    if (!deviceSerial) throw errors.validation('The Finance device serial is required.', { issues: [{ path: 'deviceSerial', message: 'Required' }] });
    let token = input.token ?? null;
    let usedStored = false;
    if (!token && existing && stored && stored.baseUrl === baseUrl && stored.deviceSerial === deviceSerial) {
      const creds = await deps.credentials.get(t, { organizationId: orgId, deviceId: existing.id });
      if (creds && typeof creds['token'] === 'string') { token = creds['token']; usedStored = true; }
    }
    if (!token) throw errors.validation('Enter the Finance push token to test this connection.', { issues: [{ path: 'token', message: 'Required' }] });
    return { baseUrl, deviceSerial, token, usedStored, deviceId: existing?.id ?? 'new', deviceCode: existing?.code ?? CONNECTOR_CODE, timezone: existing?.timezone ?? 'UTC', stored };
  }));
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const throttler = throttlerFor(def);
  const leases: { release(): void }[] = [];
  const ctx: ProviderContext = {
    organizationId: orgId, deviceId: resolved.deviceId, deviceCode: resolved.deviceCode, timezone: resolved.timezone,
    config: { baseUrl: resolved.baseUrl, deviceSerial: resolved.deviceSerial, direction: resolved.stored?.direction ?? 'both', pinKey: resolved.stored?.pinKey ?? 'employee_number' },
    credentials: { token: resolved.token }, endpointUrl: resolved.baseUrl, serialNumber: resolved.deviceSerial,
    logger: deps.log.child({ requestId: actor.requestId, deviceId: resolved.deviceId }), signal,
    acquire: async () => { leases.push(await throttler.acquire(`${orgId}:${def.key}`, { deviceKey: resolved.deviceId, signal })); },
  };
  const started = Date.now();
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  try {
    const r = await p.testConnection(ctx);
    return { ok: r.ok, message: r.message, latencyMs: r.latencyMs, code: r.ok ? null : str(r.details?.['code']) ?? 'CONNECTION_FAILED', retryable: r.details?.['retryable'] === true, serverTime: str(r.details?.['serverTime']), firstPunchAt: str(r.details?.['firstPunchAt']), usedStoredCredentials: resolved.usedStored };
  } catch (err) {
    if (ProviderError.is(err)) return { ok: false, message: err.message, latencyMs: Date.now() - started, code: err.code, retryable: err.retryable, serverTime: null, firstPunchAt: null, usedStoredCredentials: resolved.usedStored };
    if ((err as Error)?.name === 'TimeoutError' || signal.aborted) return { ok: false, message: 'Flowza Finance did not answer within 10 seconds.', latencyMs: Date.now() - started, code: 'TIMEOUT', retryable: true, serverTime: null, firstPunchAt: null, usedStoredCredentials: resolved.usedStored };
    deps.log.warn({ event: 'finance_test_connection_failed', requestId: actor.requestId, organizationId: orgId, err: (err as Error).message });
    return { ok: false, message: 'Connection test failed.', latencyMs: Date.now() - started, code: 'PROVIDER_ERROR', retryable: false, serverTime: null, firstPunchAt: null, usedStoredCredentials: resolved.usedStored };
  } finally {
    for (const l of leases) l.release();
  }
}

/** Queues a pull and/or a push (per the configured direction) as MANUAL sync jobs; returns their ids (visible in Sync pages). */
export async function syncFinanceNow(deps: ApiDeps, actor: Actor, orgId: string): Promise<FinanceSyncNowDto> {
  requirePermission(actor.principal, orgId, 'integration.manage');
  return runUser(deps.db, actor, async (trx) => {
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
  return runUser(deps.db, actor, (trx) => systemStep(trx, orgId, async (t) => {
    const device = await loadConnector(t, orgId);
    if (!device) return { configured: false, enabled: false, deviceId: null, connectionStatus: null, state: null, cursor: null, circuit: null, unmatchedCount: 0, pendingCount: 0, lastJobs: [] };
    const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
    const [state, cursor, circuit, counts, jobs] = await Promise.all([
      t.selectFrom('financeSyncState').selectAll().where('deviceId', '=', device.id).executeTakeFirst(),
      t.selectFrom('syncCursors').select(['lastPulledAt', 'lastTransactionAt']).where('deviceId', '=', device.id).where('stream', '=', 'attendance').executeTakeFirst(),
      t.selectFrom('providerCircuitStates').select(['state', 'halfOpenAt', 'failureCount']).where('organizationId', '=', orgId).where('providerKey', '=', FLOWZA_FINANCE_PROVIDER_KEY).orderBy('updatedAt', 'desc').executeTakeFirst(),
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
        lastPushedEventId: state.lastPushedEventId, lastPushedEventAt: iso(state.lastPushedEventAt), lastPushAt: iso(state.lastPushAt), lastPushCount: state.lastPushCount, nextPushAt: iso(state.nextPushAt),
        lastPullAt: iso(state.lastPullAt), lastPullCount: state.lastPullCount, lastError: state.lastError, lastErrorAt: iso(state.lastErrorAt), consecutiveFailures: state.consecutiveFailures, updatedAt: iso(state.updatedAt)!,
      } : null,
      cursor: cursor ? { lastPulledAt: iso(cursor.lastPulledAt), lastTransactionAt: iso(cursor.lastTransactionAt) } : null,
      circuit: circuit ? { state: circuit.state, halfOpenAt: iso(circuit.halfOpenAt), failureCount: circuit.failureCount } : null,
      unmatchedCount: countOf('unmatched'), pendingCount: countOf('pending'),
      lastJobs: jobs.rows.map((j) => ({ id: j.id, jobType: j.jobType, trigger: j.trigger, status: j.status, createdAt: iso(j.createdAt)!, finishedAt: iso(j.finishedAt), recordsIngested: Number(j.recordsIngested ?? 0), errorCode: j.errorCode, error: j.error, itemResult: j.itemResult })),
    };
  }));
}

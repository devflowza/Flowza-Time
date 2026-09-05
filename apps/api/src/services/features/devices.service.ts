import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { ClaimPendingDeviceInput, CreateDeviceInput, DeviceCredentialsInput, DeviceGroupDto, DeviceGroupInput, DeviceListQuery, DeviceModelDto, DeviceProviderDto, DevicePushCredentials, TestConnectionInput, TestConnectionResultDto, UpdateDeviceInput } from '@flowza/contracts';
import { emitDomainEvent, maskCredentials, type Trx } from '@flowza/database';
import { createThrottler, ProviderError, type DeviceProvider, type ProviderContext, type ProviderDefinition, type Throttler } from '@flowza/device-providers';
import { AppError, errors, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireBranchAccess, requireMembership, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runSystem, runUser } from '../../lib/service.js';
import { loadFeatureFlags, loadSettings } from '../../lib/settings.js';
import { likeContains, pageOf, resolveSort, toCount } from '../../lib/pagination.js';
import { jsonObject } from '../../lib/mappers.js';
import { assertWithinLimit } from './entitlements.js';
import { systemStep } from './context.js';
import { createSyncJob, type CreatedSyncJob } from './sync-jobs.js';
import { DEVICE_COLUMNS, toDeviceCommandDto, toDeviceDto, toDeviceGroupDto, toDeviceLogDto, toPendingDeviceDto, type DeviceDtoExt, type DeviceRow } from './mappers.js';

// ----- providers & models --------------------------------------------------------------------------------------------

/** `provider_<x>` flags gate providers whose key starts with `<x>` (provider_hikvision → hikvision_isapi, hikvision_hpp …). */
export function providerAllowedByFlags(def: ProviderDefinition, flags: Record<string, boolean>): boolean {
  for (const [key, enabled] of Object.entries(flags)) {
    if (!key.startsWith('provider_')) continue;
    const prefix = key.slice('provider_'.length);
    if (def.key === prefix || def.key.startsWith(`${prefix}_`)) return enabled;
  }
  return true;
}

export type DeviceProviderDtoExt = DeviceProviderDto & { secretFields: string[]; throttling: ProviderDefinition['throttling']; supportsWebhook: boolean; pushProtocolKey: string | null };

export function toProviderDto(p: DeviceProvider): DeviceProviderDtoExt {
  const d = p.definition;
  return {
    key: d.key, vendor: d.vendor, name: d.name, description: d.description || null, integrationType: d.integrationType, status: d.status, capabilities: d.capabilities,
    configSchema: { fields: d.configSchema.fields.map((f) => ({ ...f, secret: f.secret === true || f.type === 'password' })) },
    verificationStatus: d.verificationStatus, docsUrl: d.docsUrl ?? null, secretFields: d.secretFields, throttling: d.throttling, supportsWebhook: typeof p.handleWebhook === 'function', pushProtocolKey: p.pushProtocol?.protocolKey ?? null,
  };
}

export async function listProviders(deps: ApiDeps, actor: Actor, orgId: string | undefined): Promise<DeviceProviderDtoExt[]> {
  if (orgId) requireMembership(actor.principal, orgId);
  const flags = await runUser(deps.db, actor, async (trx) => (await loadFeatureFlags(trx, orgId ? [orgId] : [])).get(orgId ?? '') ?? Object.fromEntries((await trx.selectFrom('featureFlags').select(['key', 'defaultEnabled']).execute()).map((f) => [f.key, f.defaultEnabled])));
  return deps.providers.list().filter((d) => d.status !== 'deprecated' && providerAllowedByFlags(d, flags)).map((d) => toProviderDto(deps.providers.get(d.key)));
}

export async function listModels(deps: ApiDeps, actor: Actor, providerKey: string | undefined): Promise<DeviceModelDto[]> {
  return runUser(deps.db, actor, async (trx) => {
    let q = trx.selectFrom('deviceModels').selectAll().orderBy('vendor').orderBy('model');
    if (providerKey) q = q.where('providerKey', '=', providerKey);
    return (await q.execute()).map((m) => ({ id: m.id, providerKey: m.providerKey, vendor: m.vendor, model: m.model, family: m.family, capabilities: jsonObject(m.capabilities) as DeviceModelDto['capabilities'], verification: m.verification, notes: m.notes }));
  });
}

// ----- config handling -----------------------------------------------------------------------------------------------

type ConfigValue = string | number | boolean;

/** Split wizard config into non-secret config (stored in devices.config) and secrets (DeviceCredentialsStore). */
export function splitConfig(def: ProviderDefinition, input: Record<string, ConfigValue>, opts: { requireRequired?: boolean } = {}): { config: Record<string, ConfigValue>; secrets: Record<string, ConfigValue> } {
  const fields = new Map(def.configSchema.fields.map((f) => [f.key, f]));
  const issues: { path: string; message: string }[] = [];
  const config: Record<string, ConfigValue> = {};
  const secrets: Record<string, ConfigValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const f = fields.get(key);
    if (!f) { issues.push({ path: `config.${key}`, message: 'Unknown configuration field for this provider' }); continue; }
    if (f.type === 'number' && typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) issues.push({ path: `config.${key}`, message: 'Expected a number' });
    if (f.type === 'boolean' && typeof value !== 'boolean') issues.push({ path: `config.${key}`, message: 'Expected a boolean' });
    if (f.type === 'select' && f.options && !f.options.includes(String(value))) issues.push({ path: `config.${key}`, message: `Expected one of ${f.options.join(', ')}` });
    if (f.type === 'url' && typeof value === 'string' && !/^https?:\/\//i.test(value)) issues.push({ path: `config.${key}`, message: 'Expected an http(s) URL' });
    if (def.secretFields.includes(key)) secrets[key] = value; else config[key] = value;
  }
  if (opts.requireRequired !== false) {
    for (const f of def.configSchema.fields) {
      if (f.required && input[f.key] === undefined && f.default === undefined) issues.push({ path: `config.${f.key}`, message: 'Required' });
      if (input[f.key] === undefined && f.default !== undefined && !def.secretFields.includes(f.key)) config[f.key] = f.default;
    }
  }
  if (issues.length) throw errors.validation('Invalid provider configuration.', { issues });
  return { config, secrets };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|fc|fd|fe80)/i;
/** Cloud providers must point at public hosts (SSRF guard); LAN/on-prem providers legitimately use private ranges over VPN. */
export function assertEndpointAllowed(def: ProviderDefinition, endpointUrl: string | null | undefined): void {
  if (!endpointUrl) return;
  let url: URL;
  try { url = new URL(endpointUrl); } catch { throw errors.validation('endpointUrl must be a valid URL.', { issues: [{ path: 'endpointUrl', message: 'Invalid URL' }] }); }
  if (!/^https?:$/.test(url.protocol)) throw errors.validation('endpointUrl must use http or https.', { issues: [{ path: 'endpointUrl', message: 'Unsupported scheme' }] });
  if ((def.integrationType === 'VENDOR_CLOUD_PULL' || def.integrationType === 'VENDOR_WEBHOOK') && PRIVATE_HOST.test(url.hostname)) {
    throw errors.validation('Cloud providers cannot target private or loopback addresses.', { issues: [{ path: 'endpointUrl', message: 'Private address' }] });
  }
}

export function newPushToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}
export function pushTokenMatches(token: string | undefined | null, hash: string | null): boolean {
  if (!token || !hash) return false;
  const a = Buffer.from(sha256Hex(token), 'hex'); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export function pushUrls(deps: ApiDeps, provider: DeviceProvider, deviceId: string, token: string | null): Pick<DevicePushCredentials, 'pushUrl' | 'webhookUrl'> {
  const base = deps.config.API_PUBLIC_URL.replace(/\/$/, '');
  const pushUrl = provider.pushProtocol && provider.definition.integrationType === 'DEVICE_PUSH' && token ? `${base}/device-push/${provider.pushProtocol.protocolKey}/~${token}` : null;
  const webhookUrl = typeof provider.handleWebhook === 'function' && token ? `${base}/webhooks/providers/${provider.definition.key}/${deviceId}/${token}` : null;
  return { pushUrl, webhookUrl };
}
function needsToken(p: DeviceProvider): boolean {
  return p.definition.integrationType === 'DEVICE_PUSH' || p.definition.integrationType === 'VENDOR_WEBHOOK' || typeof p.handleWebhook === 'function';
}

function getProvider(deps: ApiDeps, key: string): DeviceProvider {
  const p = deps.providers.tryGet(key);
  if (!p) throw errors.validation(`Unknown device provider "${key}".`, { issues: [{ path: 'providerKey', message: 'Unknown provider' }] });
  if (p.definition.status === 'deprecated') throw errors.validation(`Provider "${key}" is deprecated.`, { issues: [{ path: 'providerKey', message: 'Deprecated' }] });
  return p;
}
async function assertProviderEnabled(trx: Trx, orgId: string, def: ProviderDefinition): Promise<void> {
  const flags = (await loadFeatureFlags(trx, [orgId])).get(orgId) ?? {};
  if (!providerAllowedByFlags(def, flags)) throw errors.featureDisabled(`provider:${def.key}`);
}

// ----- queries ---------------------------------------------------------------------------------------------------------

const DEVICE_SORT = { name: 'd.name', code: 'd.code', status: 'd.status', connectionStatus: 'd.connection_status', branch: 'b.name', provider: 'd.provider_key', lastHeartbeatAt: 'd.last_heartbeat_at', createdAt: 'd.created_at', updatedAt: 'd.updated_at' } as const;

function deviceQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('devices as d').innerJoin('branches as b', 'b.id', 'd.branchId').leftJoin('deviceProviders as p', 'p.key', 'd.providerKey').where('d.organizationId', '=', orgId);
}
async function employeeCounts(trx: Trx, orgId: string, deviceIds: string[]): Promise<Map<string, number>> {
  if (deviceIds.length === 0) return new Map();
  const rows = await trx.selectFrom('deviceEmployeeStates').select(['deviceId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('desired', '=', true).where('deviceId', 'in', deviceIds).groupBy('deviceId').execute();
  return new Map(rows.map((r) => [r.deviceId, toCount(r.n)]));
}
export async function loadDeviceRow(trx: Trx, orgId: string, id: string): Promise<DeviceRow> {
  const row = await deviceQuery(trx, orgId).select(DEVICE_COLUMNS).where('d.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Device', id);
  return row as DeviceRow;
}

export async function listDevices(deps: ApiDeps, actor: Actor, orgId: string, q: DeviceListQuery): Promise<{ data: DeviceDtoExt[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(DEVICE_SORT, q.sort, q.order, 'd.name');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = deviceQuery(trx, orgId);
    if (scope) base = base.where('d.branchId', 'in', scope);
    if (q.status) base = base.where('d.status', '=', q.status); else if (!q.includeDecommissioned) base = base.where('d.status', '!=', 'decommissioned');
    if (q.connectionStatus) base = base.where('d.connectionStatus', '=', q.connectionStatus);
    if (q.providerKey) base = base.where('d.providerKey', '=', q.providerKey);
    if (q.tag) base = base.where(sql<boolean>`${sql.val(q.tag)} = any (d.tags)`);
    if (q.groupId) base = base.where('d.id', 'in', trx.selectFrom('deviceGroupMembers').select('deviceId').where('groupId', '=', q.groupId));
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('d.name', 'ilike', like), eb('d.code', 'ilike', like), eb('d.serialNumber', 'ilike', like), eb('d.modelName', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = (await base.select(DEVICE_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('d.id').limit(page.pageSize).offset(page.offset).execute()) as DeviceRow[];
    const counts = await employeeCounts(trx, orgId, rows.map((r) => r.id));
    return { data: rows.map((r) => toDeviceDto(r, { employeeCount: counts.get(r.id) ?? 0 })), total };
  });
}

export async function getDevice(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DeviceDtoExt & { pushProtocolKey: string | null; groupIds: string[] }> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => {
    const row = await loadDeviceRow(trx, orgId, id);
    requireBranchAccess(grant, row.branchId);
    const counts = await employeeCounts(trx, orgId, [id]);
    const masked = await deps.credentials.masked(trx, id).catch(() => ({}));
    const groups = await trx.selectFrom('deviceGroupMembers').select('groupId').where('deviceId', '=', id).execute();
    const provider = deps.providers.tryGet(row.providerKey);
    return { ...toDeviceDto(row, { employeeCount: counts.get(id) ?? 0, maskedCredentials: masked }), pushProtocolKey: provider?.pushProtocol?.protocolKey ?? null, groupIds: groups.map((g) => g.groupId) };
  });
}

// ----- registration --------------------------------------------------------------------------------------------------

export interface DeviceCreatedDto { device: DeviceDtoExt; pushToken: string | null; pushUrl: string | null; webhookUrl: string | null; credentialsStored: boolean; credentialsError: string | null; testConnectionJobId: string | null }

async function insertDevice(deps: ApiDeps, trx: Trx, actor: Actor, orgId: string, provider: DeviceProvider, input: CreateDeviceInput & { serialNumber?: string }, extra: { pushTokenHash: string | null; secretsProvided: string[]; config: Record<string, ConfigValue>; integrationType?: DeviceProvider['definition']['integrationType'] }): Promise<{ id: string; testJob: CreatedSyncJob | null }> {
  const def = provider.definition;
  const integrationType = extra.integrationType ?? def.integrationType;
  const branch = await trx.selectFrom('branches').select(['id', 'timezone', 'status']).where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst();
  if (!branch) throw errors.validation('Branch not found in this organisation.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
  if (branch.status === 'archived') throw errors.validation('Branch is archived.', { issues: [{ path: 'branchId', message: 'Archived' }] });
  if (input.modelId) {
    const model = await trx.selectFrom('deviceModels').select(['id', 'providerKey']).where('id', '=', input.modelId).executeTakeFirst();
    if (!model || model.providerKey !== def.key) throw errors.validation('Model does not belong to this provider.', { issues: [{ path: 'modelId', message: 'Unknown model' }] });
  }
  const activeCount = toCount((await trx.selectFrom('devices').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('status', '!=', 'decommissioned').executeTakeFirst())?.n);
  await assertWithinLimit(trx, orgId, 'devices', activeCount);
  const settings = await loadSettings(trx, orgId);
  const row = await trx.insertInto('devices').values({
    organizationId: orgId, branchId: input.branchId, code: input.code, name: input.name, providerKey: def.key, modelId: input.modelId ?? null, manufacturer: input.manufacturer, modelName: input.modelName ?? null,
    serialNumber: input.serialNumber ?? null, timezone: input.timezone ?? branch.timezone, integrationType, endpointUrl: input.endpointUrl ?? null, config: JSON.stringify(extra.config),
    capabilities: JSON.stringify(def.capabilities), offlineThresholdMinutes: input.offlineThresholdMinutes ?? settings.sync.offlineThresholdMinutes ?? 15,
    autoSyncEnabled: input.autoSyncEnabled ?? (integrationType !== 'DEVICE_PUSH' && def.capabilities.attendancePull), syncIntervalMinutes: input.syncIntervalMinutes ?? settings.sync.defaultIntervalMinutes ?? 5,
    tags: input.tags ?? [], notes: input.notes ?? null, pushTokenHash: extra.pushTokenHash, pushTokenRotatedAt: extra.pushTokenHash ? new Date() : null, createdBy: actor.userId,
    nextAttendanceSyncAt: integrationType !== 'DEVICE_PUSH' && def.capabilities.attendancePull && (input.autoSyncEnabled ?? true) ? new Date() : null,
  }).returning('id').executeTakeFirstOrThrow();
  await audit(trx, actor, orgId, 'device.created', 'device', { entityId: row.id, branchId: input.branchId, newValue: { code: input.code, name: input.name, providerKey: def.key, branchId: input.branchId, serialNumber: input.serialNumber ?? null, endpointUrl: input.endpointUrl ?? null, config: extra.config, secretFieldsProvided: extra.secretsProvided, pushTokenIssued: extra.pushTokenHash !== null } });
  await emitDomainEvent(trx, { organizationId: orgId, eventType: 'device.created', aggregateType: 'device', aggregateId: row.id, payload: { code: input.code, providerKey: def.key, branchId: input.branchId }, actorUserId: actor.userId, requestId: actor.requestId });
  let testJob: CreatedSyncJob | null = null;
  if (integrationType !== 'DEVICE_PUSH' && def.status !== 'placeholder') {
    testJob = await createSyncJob(deps, trx, { organizationId: orgId, jobType: 'TEST_CONNECTION', trigger: 'SYSTEM', scope: { deviceIds: [row.id], reason: 'device.created' }, branchId: input.branchId, requestedBy: actor.userId, correlationId: actor.requestId, priority: 7, items: [{ deviceId: row.id, branchId: input.branchId }] });
  }
  return { id: row.id, testJob };
}

async function storeSecrets(deps: ApiDeps, actor: Actor, orgId: string, deviceId: string, def: ProviderDefinition, secrets: Record<string, ConfigValue>): Promise<{ stored: boolean; error: string | null }> {
  if (Object.keys(secrets).length === 0) return { stored: false, error: null };
  try {
    await runSystem(deps.db, orgId, actor.requestId, async (trx) => { await deps.credentials.put(trx, { organizationId: orgId, deviceId }, secrets, maskCredentials(secrets, def.secretFields), actor.userId); });
    return { stored: true, error: null };
  } catch (err) {
    deps.log.error({ event: 'device_credentials_store_failed', organizationId: orgId, deviceId, requestId: actor.requestId, err: (err as Error).message });
    return { stored: false, error: 'Credentials could not be stored; re-enter them via POST /devices/:id/credentials.' };
  }
}

export async function createDevice(deps: ApiDeps, actor: Actor, orgId: string, input: CreateDeviceInput): Promise<DeviceCreatedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.create');
  requireBranchAccess(grant, input.branchId);
  const provider = getProvider(deps, input.providerKey);
  const def = provider.definition;
  assertEndpointAllowed(def, input.endpointUrl);
  const { config, secrets } = splitConfig(def, input.config);
  const serialNumber = input.serialNumber ?? (typeof config.serialNumber === 'string' ? config.serialNumber : undefined);
  if (def.integrationType === 'DEVICE_PUSH' && !serialNumber) throw errors.validation('Push-protocol devices need a serial number.', { issues: [{ path: 'serialNumber', message: 'Required for DEVICE_PUSH providers' }] });
  const token = needsToken(provider) ? newPushToken() : null;
  const created = await runUser(deps.db, actor, async (trx) => {
    await assertProviderEnabled(trx, orgId, def);
    return insertDevice(deps, trx, actor, orgId, provider, { ...input, serialNumber }, { pushTokenHash: token?.hash ?? null, secretsProvided: Object.keys(secrets), config });
  });
  const stored = await storeSecrets(deps, actor, orgId, created.id, def, secrets);
  const device = await runUser(deps.db, actor, (trx) => loadDeviceRow(trx, orgId, created.id));
  return { device: toDeviceDto(device, { employeeCount: 0 }), pushToken: token?.token ?? null, ...pushUrls(deps, provider, created.id, token?.token ?? null), credentialsStored: stored.stored, credentialsError: stored.error, testConnectionJobId: created.testJob?.id ?? null };
}

const ENDPOINT_KEYS = ['endpointUrl', 'baseUrl', 'host', 'serverUrl', 'port', 'protocol'];

export async function updateDevice(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateDeviceInput): Promise<DeviceDtoExt & { credentialsRequired: boolean }> {
  const grant = requirePermission(actor.principal, orgId, 'device.update');
  if (input.status !== undefined) requirePermission(actor.principal, orgId, 'device.manage');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDeviceRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    if (before.status === 'decommissioned') throw errors.invalidState('A decommissioned device cannot be edited.');
    const provider = deps.providers.tryGet(before.providerKey);
    if (input.endpointUrl !== undefined && provider) assertEndpointAllowed(provider.definition, input.endpointUrl);
    if (input.branchId) {
      const branch = await trx.selectFrom('branches').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', input.branchId).executeTakeFirst();
      if (!branch || branch.status === 'archived') throw errors.validation('Branch not found or archived.', { issues: [{ path: 'branchId', message: 'Unknown branch' }] });
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    const endpointChanged = input.endpointUrl !== undefined && (input.endpointUrl ?? null) !== before.endpointUrl;
    let credentialsRequired = false;
    await trx.updateTable('devices').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    if (endpointChanged) {
      const deleted = await systemStep(trx, orgId, (t) => deps.credentials.delete(t, id));
      credentialsRequired = true;
      await audit(trx, actor, orgId, 'device.credentials_invalidated', 'device', { entityId: id, branchId: before.branchId, oldValue: { endpointUrl: before.endpointUrl }, newValue: { endpointUrl: input.endpointUrl ?? null, credentialsDeleted: deleted }, reason: 'endpoint changed' });
    }
    const after = await loadDeviceRow(trx, orgId, id);
    const diff = diffObjects(toDeviceDto(before) as unknown as Record<string, unknown>, toDeviceDto(after) as unknown as Record<string, unknown>);
    await audit(trx, actor, orgId, 'device.updated', 'device', { entityId: id, branchId: after.branchId, ...diff });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'device.updated', aggregateType: 'device', aggregateId: id, payload: { changed: Object.keys(diff.newValue), credentialsRequired }, actorUserId: actor.userId, requestId: actor.requestId });
    const counts = await employeeCounts(trx, orgId, [id]);
    return { ...toDeviceDto(after, { employeeCount: counts.get(id) ?? 0 }), credentialsRequired };
  });
}

export async function putCredentials(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: DeviceCredentialsInput): Promise<{ version: number; masked: Record<string, unknown> }> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id);
    requireBranchAccess(grant, device.branchId);
    if (device.status === 'decommissioned') throw errors.invalidState('A decommissioned device cannot receive credentials.');
    const def = getProvider(deps, device.providerKey).definition;
    const unknown = Object.keys(input).filter((k) => !def.secretFields.includes(k));
    if (unknown.length) throw errors.validation('Only secret configuration fields may be stored as credentials.', { issues: unknown.map((k) => ({ path: k, message: `Not a secret field of ${def.key}` })), secretFields: def.secretFields });
    const masked = maskCredentials(input, def.secretFields);
    const version = await systemStep(trx, orgId, (t) => deps.credentials.put(t, { organizationId: orgId, deviceId: id }, input, masked, actor.userId));
    await audit(trx, actor, orgId, 'device.credentials_changed', 'device', { entityId: id, branchId: device.branchId, newValue: { fields: Object.keys(input), version } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'device.credentials_changed', aggregateType: 'device', aggregateId: id, payload: { version }, actorUserId: actor.userId, requestId: actor.requestId });
    return { version, masked };
  });
}

export async function rotatePushToken(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DevicePushCredentials> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id);
    requireBranchAccess(grant, device.branchId);
    const provider = getProvider(deps, device.providerKey);
    if (!needsToken(provider)) throw errors.invalidState('This provider does not use push tokens.');
    const token = newPushToken();
    await trx.updateTable('devices').set({ pushTokenHash: token.hash, pushTokenRotatedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'device.push_token_rotated', 'device', { entityId: id, branchId: device.branchId });
    return { pushToken: token.token, ...pushUrls(deps, provider, id, token.token) };
  });
}

export async function removeDevice(deps: ApiDeps, actor: Actor, orgId: string, id: string, decommission: boolean): Promise<DeviceDtoExt> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDeviceRow(trx, orgId, id);
    requireBranchAccess(grant, before.branchId);
    if (before.status === 'decommissioned') throw errors.invalidState('The device is already decommissioned.');
    const status = decommission ? 'decommissioned' : 'disabled';
    await trx.updateTable('devices').set({ status, autoSyncEnabled: false, nextAttendanceSyncAt: null }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await systemStep(trx, orgId, async (t) => {
      await t.updateTable('deviceCommands').set({ status: 'expired' }).where('deviceId', '=', id).where('status', 'in', ['pending', 'sent']).execute();
      if (decommission) await deps.credentials.delete(t, id);
    });
    await audit(trx, actor, orgId, decommission ? 'device.decommissioned' : 'device.disabled', 'device', { entityId: id, branchId: before.branchId, oldValue: { status: before.status }, newValue: { status } });
    await emitDomainEvent(trx, { organizationId: orgId, eventType: 'device.updated', aggregateType: 'device', aggregateId: id, payload: { status }, actorUserId: actor.userId, requestId: actor.requestId });
    return toDeviceDto(await loadDeviceRow(trx, orgId, id));
  });
}

// ----- test connection -----------------------------------------------------------------------------------------------

const throttlers = new Map<string, Throttler>();
function throttlerFor(def: ProviderDefinition): Throttler {
  let t = throttlers.get(def.key);
  if (!t) { t = createThrottler(def.throttling); throttlers.set(def.key, t); }
  return t;
}
export const TEST_CONNECTION_TIMEOUT_MS = 10_000;

export async function testConnection(deps: ApiDeps, actor: Actor, orgId: string, input: TestConnectionInput): Promise<TestConnectionResultDto> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'device.create') && !hasPermission(grant, 'device.update') && !hasPermission(grant, 'device.manage')) throw errors.forbidden('Missing permission: device.create or device.update.');
  const provider = getProvider(deps, input.providerKey);
  const def = provider.definition;
  const { config: requestConfig, secrets: requestSecrets } = splitConfig(def, input.config, { requireRequired: !input.deviceId });
  let config: Record<string, unknown> = requestConfig;
  let credentials: Record<string, unknown> = requestSecrets;
  let usedStored = false;
  let deviceId = 'new';
  let deviceCode = 'new-device';
  let timezone = 'UTC';
  let endpointUrl: string | null = typeof requestConfig.endpointUrl === 'string' ? requestConfig.endpointUrl : null;
  let serialNumber: string | null = typeof requestConfig.serialNumber === 'string' ? requestConfig.serialNumber : null;
  if (input.deviceId) {
    const device = await runUser(deps.db, actor, async (trx) => { const d = await loadDeviceRow(trx, orgId, input.deviceId!); requireBranchAccess(grant, d.branchId); return d; });
    if (device.providerKey !== def.key) throw errors.validation('providerKey does not match the stored device.', { issues: [{ path: 'providerKey', message: 'Mismatch' }] });
    const storedConfig = jsonObject(device.config);
    // stored credentials may only be reused for the *unchanged* endpoint (AGENTS.md service-level rules): generic endpoint keys
    // plus every provider field typed `url`, so a request cannot point the stored secret at another host
    const endpointKeys = [...new Set([...ENDPOINT_KEYS, ...def.configSchema.fields.filter((f) => f.type === 'url').map((f) => f.key)])];
    const endpointUnchanged = endpointKeys.every((k) => requestConfig[k] === undefined || String(requestConfig[k]) === String(storedConfig[k] ?? (k === 'endpointUrl' ? device.endpointUrl ?? '' : '')));
    config = { ...storedConfig, ...requestConfig };
    deviceId = device.id; deviceCode = device.code; timezone = device.timezone; endpointUrl = device.endpointUrl; serialNumber = device.serialNumber;
    if (endpointUnchanged) {
      const stored = await runSystem(deps.db, orgId, actor.requestId, (trx) => deps.credentials.get(trx, { organizationId: orgId, deviceId: device.id }));
      if (stored) { credentials = { ...stored, ...requestSecrets }; usedStored = true; }
    }
  } else {
    assertEndpointAllowed(def, endpointUrl);
  }
  const signal = AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS);
  const throttler = throttlerFor(def);
  const leases: { release(): void }[] = [];
  const ctx: ProviderContext = {
    organizationId: orgId, deviceId, deviceCode, timezone, config, credentials, endpointUrl, serialNumber, logger: deps.log.child({ requestId: actor.requestId, deviceId }), signal,
    acquire: async () => { leases.push(await throttler.acquire(`${orgId}:${def.key}`, { deviceKey: deviceId, signal })); },
  };
  const started = Date.now();
  try {
    const result = await provider.testConnection(ctx);
    return { ok: result.ok, message: result.message, latencyMs: result.latencyMs, code: result.ok ? null : (typeof result.details?.code === 'string' ? result.details.code : 'CONNECTION_FAILED'), retryable: Boolean(result.details?.retryable), deviceInfo: result.deviceInfo ? { ...result.deviceInfo } : null, details: result.details ? { ...result.details } : null, usedStoredCredentials: usedStored };
  } catch (err) {
    if (ProviderError.is(err)) return { ok: false, message: err.message, latencyMs: Date.now() - started, code: err.code, retryable: err.retryable, deviceInfo: null, details: err.details ? { ...err.details } : null, usedStoredCredentials: usedStored };
    if ((err as Error)?.name === 'TimeoutError' || signal.aborted) return { ok: false, message: 'The device did not answer within 10 seconds.', latencyMs: Date.now() - started, code: 'TIMEOUT', retryable: true, deviceInfo: null, details: null, usedStoredCredentials: usedStored };
    deps.log.warn({ event: 'test_connection_failed', requestId: actor.requestId, organizationId: orgId, providerKey: def.key, err: (err as Error).message });
    return { ok: false, message: 'Connection test failed.', latencyMs: Date.now() - started, code: 'PROVIDER_ERROR', retryable: false, deviceInfo: null, details: null, usedStoredCredentials: usedStored };
  } finally {
    for (const l of leases) l.release();
  }
}

// ----- sub-resources -------------------------------------------------------------------------------------------------

export async function listDeviceLogs(deps: ApiDeps, actor: Actor, orgId: string, id: string, q: { page: number; pageSize: number; level?: string; event?: string; from?: string; to?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id); requireBranchAccess(grant, device.branchId);
    let base = trx.selectFrom('deviceLogs').where('organizationId', '=', orgId).where('deviceId', '=', id);
    if (q.level) base = base.where('level', '=', q.level as never);
    if (q.event) base = base.where('event', '=', q.event);
    if (q.from) base = base.where('createdAt', '>=', new Date(q.from));
    if (q.to) base = base.where('createdAt', '<=', new Date(q.to));
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll().orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toDeviceLogDto), total };
  });
}

export async function listDeviceEmployees(deps: ApiDeps, actor: Actor, orgId: string, id: string, q: { page: number; pageSize: number; syncStatus?: string; desired?: boolean; search?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id); requireBranchAccess(grant, device.branchId);
    let base = trx.selectFrom('deviceEmployeeStates as s').leftJoin('employees as e', 'e.id', 's.employeeId').where('s.organizationId', '=', orgId).where('s.deviceId', '=', id);
    if (q.syncStatus) base = base.where('s.syncStatus', '=', q.syncStatus as never);
    if (q.desired !== undefined) base = base.where('s.desired', '=', q.desired);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('s.deviceUserId', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.select(['s.id', 's.deviceId', 's.employeeId', 'e.employeeNumber', 'e.displayName as employeeName', 'e.employmentStatus', 's.deviceUserId', 's.syncStatus', 's.desired', 's.cloudHash', 's.deviceHash', 's.lastSyncAt', 's.lastSuccessAt', 's.lastErrorCode', 's.lastError', 's.fingerprintCount', 's.faceEnrolled', 's.cardEnrolled', 's.deviceRecord', 's.updatedAt'])
      .orderBy('s.deviceUserId').limit(page.pageSize).offset(page.offset).execute();
    return {
      data: rows.map((r) => ({ id: r.id, deviceId: r.deviceId, employeeId: r.employeeId, employeeNumber: r.employeeNumber ?? null, employeeName: r.employeeName ?? null, employmentStatus: r.employmentStatus ?? null, deviceUserId: r.deviceUserId, syncStatus: r.syncStatus, desired: r.desired, inSync: r.cloudHash !== null && r.cloudHash === r.deviceHash, deviceOnly: r.employeeId === null, lastSyncAt: r.lastSyncAt?.toISOString() ?? null, lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null, lastErrorCode: r.lastErrorCode, lastError: r.lastError, fingerprintCount: r.fingerprintCount, faceEnrolled: r.faceEnrolled, cardEnrolled: r.cardEnrolled, deviceRecord: r.deviceRecord === null ? null : jsonObject(r.deviceRecord), updatedAt: r.updatedAt.toISOString() })),
      total,
    };
  });
}

export async function listDeviceCommands(deps: ApiDeps, actor: Actor, orgId: string, id: string, q: { page: number; pageSize: number; status?: string }) {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id); requireBranchAccess(grant, device.branchId);
    let base = trx.selectFrom('deviceCommands').where('organizationId', '=', orgId).where('deviceId', '=', id);
    if (q.status) base = base.where('status', '=', q.status as never);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll().orderBy('sequence', 'desc').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toDeviceCommandDto), total };
  });
}

export type DeviceAction = 'sync-attendance' | 'sync-employees' | 'health-check' | 'reconcile';

export async function runDeviceAction(deps: ApiDeps, actor: Actor, orgId: string, id: string, action: DeviceAction): Promise<CreatedSyncJob> {
  const grant = requirePermission(actor.principal, orgId, 'device.sync');
  return runUser(deps.db, actor, async (trx) => {
    const device = await loadDeviceRow(trx, orgId, id); requireBranchAccess(grant, device.branchId);
    if (device.status !== 'active') throw errors.invalidState('The device is not active.');
    const caps = jsonObject(device.capabilities) as Record<string, boolean>;
    const base = { organizationId: orgId, trigger: 'MANUAL' as const, branchId: device.branchId, requestedBy: actor.userId, correlationId: actor.requestId, priority: 7 };
    let job: CreatedSyncJob;
    switch (action) {
      case 'sync-attendance':
        if (!caps.attendancePull) throw errorUnsupported('attendancePull');
        job = await createSyncJob(deps, trx, { ...base, jobType: 'PULL_ATTENDANCE', scope: { deviceIds: [id] }, items: [{ deviceId: id, branchId: device.branchId }] });
        break;
      case 'sync-employees': {
        if (!caps.employeePush) throw errorUnsupported('employeePush');
        const employees = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('branchId', '=', device.branchId).where('employmentStatus', 'in', ['active', 'on_leave']).where('deletedAt', 'is', null).execute();
        job = await createSyncJob(deps, trx, { ...base, jobType: 'PUSH_EMPLOYEES', scope: { deviceIds: [id], branchId: device.branchId }, items: employees.map((e) => ({ deviceId: id, employeeId: e.id, branchId: device.branchId, operation: 'PUSH_EMPLOYEE' as const })) });
        break;
      }
      case 'health-check':
        job = await createSyncJob(deps, trx, { ...base, jobType: 'DEVICE_HEALTH_CHECK', scope: { deviceIds: [id] }, items: [{ deviceId: id, branchId: device.branchId }], priority: 3 });
        break;
      case 'reconcile':
        job = await createSyncJob(deps, trx, { ...base, jobType: 'RECONCILIATION', scope: { deviceIds: [id] }, items: [{ deviceId: id, branchId: device.branchId }], priority: 4 });
        break;
    }
    await audit(trx, actor, orgId, `device.action_${action.replace(/-/g, '_')}`, 'device', { entityId: id, branchId: device.branchId, newValue: { syncJobId: job.id, itemsTotal: job.itemsTotal } });
    return job;
  });
}
function errorUnsupported(capability: string): AppError {
  return new AppError('DEVICE_UNSUPPORTED_OPERATION', `The device does not support ${capability}.`, { details: { capability } });
}

// ----- groups ------------------------------------------------------------------------------------------------------------

async function groupCounts(trx: Trx, groupIds: string[]): Promise<Map<string, number>> {
  if (!groupIds.length) return new Map();
  const rows = await trx.selectFrom('deviceGroupMembers').select(['groupId', (eb) => eb.fn.countAll().as('n')]).where('groupId', 'in', groupIds).groupBy('groupId').execute();
  return new Map(rows.map((r) => [r.groupId, toCount(r.n)]));
}
const GROUP_COLUMNS = ['g.id', 'g.organizationId', 'g.name', 'g.description', 'g.branchId', 'b.name as branchName', 'g.color', 'g.createdAt', 'g.updatedAt'] as const;

export async function listGroups(deps: ApiDeps, actor: Actor, orgId: string): Promise<DeviceGroupDto[]> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  const scope = branchFilter(grant);
  return runUser(deps.db, actor, async (trx) => {
    let q = trx.selectFrom('deviceGroups as g').leftJoin('branches as b', 'b.id', 'g.branchId').select(GROUP_COLUMNS).where('g.organizationId', '=', orgId).orderBy('g.name');
    if (scope) q = q.where((eb) => eb.or([eb('g.branchId', 'is', null), eb('g.branchId', 'in', scope)]));
    const rows = await q.execute();
    const counts = await groupCounts(trx, rows.map((r) => r.id));
    return rows.map((r) => toDeviceGroupDto(r, counts.get(r.id) ?? 0));
  });
}
async function loadGroup(trx: Trx, orgId: string, id: string) {
  const g = await trx.selectFrom('deviceGroups as g').leftJoin('branches as b', 'b.id', 'g.branchId').select(GROUP_COLUMNS).where('g.organizationId', '=', orgId).where('g.id', '=', id).executeTakeFirst();
  if (!g) throw errors.notFound('Device group', id);
  return g;
}
async function groupDto(trx: Trx, orgId: string, id: string): Promise<DeviceGroupDto> {
  const g = await loadGroup(trx, orgId, id);
  const members = await trx.selectFrom('deviceGroupMembers').select('deviceId').where('groupId', '=', id).execute();
  return toDeviceGroupDto(g, members.length, members.map((m) => m.deviceId));
}
export async function getGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DeviceGroupDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.view');
  return runUser(deps.db, actor, async (trx) => { const g = await loadGroup(trx, orgId, id); requireBranchAccess(grant, g.branchId); return groupDto(trx, orgId, id); });
}
export async function createGroup(deps: ApiDeps, actor: Actor, orgId: string, input: DeviceGroupInput): Promise<DeviceGroupDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('deviceGroups').values({ organizationId: orgId, name: input.name, description: input.description ?? null, branchId: input.branchId ?? null, color: input.color ?? null }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'device_group.created', 'device_group', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    return groupDto(trx, orgId, row.id);
  });
}
export async function updateGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<DeviceGroupInput>): Promise<DeviceGroupDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  requireBranchAccess(grant, input.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadGroup(trx, orgId, id); requireBranchAccess(grant, before.branchId);
    const patch: Record<string, unknown> = {}; for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('deviceGroups').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'device_group.updated', 'device_group', { entityId: id, branchId: before.branchId, newValue: patch });
    return groupDto(trx, orgId, id);
  });
}
export async function deleteGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  return runUser(deps.db, actor, async (trx) => {
    const g = await loadGroup(trx, orgId, id); requireBranchAccess(grant, g.branchId);
    await trx.deleteFrom('deviceGroupMembers').where('groupId', '=', id).execute();
    await trx.deleteFrom('deviceGroups').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'device_group.deleted', 'device_group', { entityId: id, branchId: g.branchId, oldValue: { name: g.name } });
  });
}
export async function setGroupMembers(deps: ApiDeps, actor: Actor, orgId: string, id: string, deviceIds: string[], mode: 'add' | 'remove'): Promise<DeviceGroupDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.manage');
  return runUser(deps.db, actor, async (trx) => {
    const g = await loadGroup(trx, orgId, id); requireBranchAccess(grant, g.branchId);
    const unique = [...new Set(deviceIds)];
    const devices = await trx.selectFrom('devices').select(['id', 'branchId']).where('organizationId', '=', orgId).where('id', 'in', unique).execute();
    if (devices.length !== unique.length) throw errors.validation('One or more devices were not found.', { missing: unique.filter((d) => !devices.some((x) => x.id === d)) });
    for (const d of devices) { requireBranchAccess(grant, d.branchId); if (g.branchId && d.branchId !== g.branchId) throw errors.validation('Devices must belong to the group branch.', { deviceId: d.id }); }
    if (mode === 'add') await trx.insertInto('deviceGroupMembers').values(unique.map((deviceId) => ({ organizationId: orgId, groupId: id, deviceId }))).onConflict((oc) => oc.doNothing()).execute();
    else await trx.deleteFrom('deviceGroupMembers').where('groupId', '=', id).where('deviceId', 'in', unique).execute();
    await audit(trx, actor, orgId, mode === 'add' ? 'device_group.members_added' : 'device_group.members_removed', 'device_group', { entityId: id, branchId: g.branchId, newValue: { deviceIds: unique } });
    return groupDto(trx, orgId, id);
  });
}

// ----- pending (zero-touch) devices -----------------------------------------------------------------------------------------

export async function listPending(deps: ApiDeps, actor: Actor, orgId: string, serialNumber: string | undefined) {
  requirePermission(actor.principal, orgId, 'device.create');
  // rows already attributed to the organisation are visible through RLS; an exact serial lookup (printed on the device)
  // finds unattributed rows so the admin can claim a device that contacted the push endpoint without an org token.
  const own = await runUser(deps.db, actor, (trx) => trx.selectFrom('pendingDevices').selectAll().where('organizationId', '=', orgId).where('claimedDeviceId', 'is', null).orderBy('lastSeenAt', 'desc').execute());
  const rows = [...own];
  if (serialNumber) {
    const found = await runSystem(deps.db, orgId, actor.requestId, (trx) => trx.selectFrom('pendingDevices').selectAll().where('serialNumber', '=', serialNumber).where('claimedDeviceId', 'is', null).where((eb) => eb.or([eb('organizationId', 'is', null), eb('organizationId', '=', orgId)])).execute());
    for (const f of found) if (!rows.some((r) => r.id === f.id)) rows.push(f);
  }
  return rows.map(toPendingDeviceDto);
}

export async function claimPending(deps: ApiDeps, actor: Actor, orgId: string, pendingId: string, input: ClaimPendingDeviceInput): Promise<DeviceCreatedDto> {
  const grant = requirePermission(actor.principal, orgId, 'device.create');
  requireBranchAccess(grant, input.branchId);
  const pending = await runSystem(deps.db, orgId, actor.requestId, (trx) => trx.selectFrom('pendingDevices').selectAll().where('id', '=', pendingId).where((eb) => eb.or([eb('organizationId', 'is', null), eb('organizationId', '=', orgId)])).executeTakeFirst());
  if (!pending) throw errors.notFound('Pending device', pendingId);
  if (pending.claimedDeviceId) throw errors.invalidState('This device has already been claimed.');
  const provider = getProvider(deps, pending.providerKey);
  const def = provider.definition;
  const info = jsonObject(pending.deviceInfo);
  const token = needsToken(provider) ? newPushToken() : null;
  const created = await runUser(deps.db, actor, async (trx) => {
    await assertProviderEnabled(trx, orgId, def);
    const { config } = splitConfig(def, { ...(def.configSchema.fields.some((f) => f.key === 'serialNumber') ? { serialNumber: pending.serialNumber } : {}) }, { requireRequired: false });
    return insertDevice(deps, trx, actor, orgId, provider, {
      code: input.code, name: input.name, branchId: input.branchId, providerKey: def.key, modelId: input.modelId, manufacturer: def.vendor, modelName: typeof info.model === 'string' ? info.model : undefined,
      serialNumber: pending.serialNumber, timezone: input.timezone, config: {}, tags: input.tags,
    }, { pushTokenHash: token?.hash ?? null, secretsProvided: [], config, integrationType: 'DEVICE_PUSH' }); // it announced itself over a push protocol
  });
  await runSystem(deps.db, orgId, actor.requestId, async (trx) => {
    // the claim is a one-shot: a concurrent claim that won the race keeps its link (the unique serial per provider on `devices` is the hard stop)
    await trx.updateTable('pendingDevices').set({ claimedDeviceId: created.id, organizationId: orgId }).where('id', '=', pendingId).where('claimedDeviceId', 'is', null).execute();
    if (typeof info.firmwareVersion === 'string') await trx.updateTable('devices').set({ firmwareVersion: info.firmwareVersion }).where('id', '=', created.id).execute();
  });
  const device = await runUser(deps.db, actor, async (trx) => { await audit(trx, actor, orgId, 'device.claimed', 'device', { entityId: created.id, branchId: input.branchId, newValue: { pendingId, serialNumber: pending.serialNumber, providerKey: def.key } }); return loadDeviceRow(trx, orgId, created.id); });
  return { device: toDeviceDto(device, { employeeCount: 0 }), pushToken: token?.token ?? null, ...pushUrls(deps, provider, created.id, token?.token ?? null), credentialsStored: false, credentialsError: null, testConnectionJobId: created.testJob?.id ?? null };
}

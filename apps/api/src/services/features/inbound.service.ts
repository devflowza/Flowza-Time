import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { DeviceEmployee } from '@flowza/contracts';
import { withContext, type Database, type Trx } from '@flowza/database';
import { ProtocolError, ProviderError, type DevicePushInbound, type DevicePushProtocolHandler, type DevicePushRequest, type DevicePushResponse, type WebhookRequest } from '@flowza/device-providers';
import { sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { enqueueJob } from '../../lib/jobs.js';
import { jsonObject } from '../../lib/mappers.js';
import { pushTokenMatches } from './devices.service.js';
import { enqueueNormalize, ingestRawTransactions } from './ingest.js';

/**
 * Inbound device traffic (docs/device-integrations.md §1, blueprint §F.3). Everything here must stay cheap: one platform
 * lookup to find the device, one system-for-org transaction for bookkeeping + raw insert + command rendering. Errors are
 * mapped to protocol-appropriate text and never carry stack traces or SQL.
 */
export const INBOUND_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PER_SERIAL_LIMIT_PER_MINUTE = 60;
const PENDING_COMMAND_BATCH = 20;
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newClaimCode(): string { let s = ''; for (let i = 0; i < 6; i += 1) s += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)]; return s; }

/** In-memory sliding-window limiter keyed by serial (per API instance; the IP limiter runs in front of it). */
export class SerialRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = PER_SERIAL_LIMIT_PER_MINUTE, private readonly windowMs = 60_000) {}
  allow(serial: string, now = Date.now()): boolean {
    const arr = (this.hits.get(serial) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(serial, arr); return false; }
    arr.push(now); this.hits.set(serial, arr);
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export interface PushDeviceRow { id: string; organizationId: string; branchId: string; code: string; timezone: string; generation: number; providerKey: string; pushTokenHash: string | null; serialNumber: string | null; config: unknown; status: string }

/**
 * Active DEVICE_PUSH devices announcing `serialNumber` over this protocol. Serials are unique per provider, but the same
 * serial may legitimately exist under another provider (or protocol), so the lookup is restricted to the providers that speak
 * this protocol and the route picks the candidate whose push token matches.
 */
export async function findPushDevices(deps: ApiDeps, handler: DevicePushProtocolHandler, serialNumber: string, requestId: string): Promise<PushDeviceRow[]> {
  const providerKeys = providerKeysForProtocol(deps, handler);
  if (providerKeys.length === 0) return [];
  return withContext(deps.db, { kind: 'platform', requestId }, (trx) => trx.selectFrom('devices').select(['id', 'organizationId', 'branchId', 'code', 'timezone', 'generation', 'providerKey', 'pushTokenHash', 'serialNumber', 'config', 'status'])
    .where('serialNumber', '=', serialNumber).where('integrationType', '=', 'DEVICE_PUSH').where('status', '=', 'active').where('providerKey', 'in', providerKeys).orderBy('createdAt').execute());
}

export function providerKeysForProtocol(deps: ApiDeps, handler: DevicePushProtocolHandler): string[] {
  const keys: string[] = [];
  for (const def of deps.providers.list()) { const p = deps.providers.tryGet(def.key); if (p?.pushProtocol === handler || p?.pushProtocol?.protocolKey === handler.protocolKey) keys.push(def.key); }
  return keys;
}
export function providerKeyForProtocol(deps: ApiDeps, handler: DevicePushProtocolHandler): string {
  return providerKeysForProtocol(deps, handler)[0] ?? 'mock';
}

/** Unknown serial → pending_devices (zero-touch onboarding). Platform context; the row has no organisation yet. */
export async function recordPendingDevice(deps: ApiDeps, handler: DevicePushProtocolHandler, serialNumber: string, req: DevicePushRequest, requestId: string, deviceInfo: Record<string, unknown>): Promise<void> {
  const providerKey = providerKeyForProtocol(deps, handler);
  await withContext(deps.db, { kind: 'platform', requestId }, async (trx) => {
    await trx.insertInto('pendingDevices').values({ providerKey, serialNumber, claimCode: newClaimCode(), remoteIp: req.remoteIp ?? null, deviceInfo: JSON.stringify(deviceInfo), lastSeenAt: new Date() })
      .onConflict((oc) => oc.columns(['providerKey', 'serialNumber']).doUpdateSet({ lastSeenAt: new Date(), remoteIp: req.remoteIp ?? null, deviceInfo: sql`public.pending_devices.device_info || ${JSON.stringify(deviceInfo)}::jsonb` })).execute();
  });
}

export function protocolErrorResponse(err: unknown): DevicePushResponse {
  if (ProtocolError.is(err)) return { status: (err as ProtocolError).httpStatus ?? 400, body: 'ERROR', headers: { 'content-type': 'text/plain; charset=utf-8' } };
  if (ProviderError.is(err) && err.code === 'INVALID_CONFIG') return { status: 500, body: 'ERROR', headers: { 'content-type': 'text/plain; charset=utf-8' } };
  return { status: 500, body: 'ERROR', headers: { 'content-type': 'text/plain; charset=utf-8' } };
}

export interface PushOutcome { response: DevicePushResponse; kind: DevicePushInbound['kind'] | 'duplicate' | 'error'; inserted: number; commandsSent: number }

/** Everything after device authentication, in one system-for-org transaction. */
export async function handleDevicePush(deps: ApiDeps, device: PushDeviceRow, handler: DevicePushProtocolHandler, req: DevicePushRequest, requestId: string): Promise<PushOutcome> {
  const orgId = device.organizationId;
  const serialNumber = device.serialNumber ?? '';
  return withContext(deps.db, { kind: 'system', organizationId: orgId, requestId }, async (trx) => {
    const cursor = await trx.selectFrom('syncCursors').select(['id', 'cursor']).where('deviceId', '=', device.id).where('stream', '=', 'attendance').executeTakeFirst();
    const cursorObj = jsonObject(cursor?.cursor);
    const stamps = jsonObject(cursorObj.stamps) as Record<string, string>;
    let inbound: DevicePushInbound;
    try {
      inbound = handler.parseInbound(req, { timezone: device.timezone, serialNumber, stamps });
    } catch (err) {
      await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'warn', event: 'push.protocol_error', message: (err as Error).message.slice(0, 500), details: JSON.stringify({ path: req.path, method: req.method }) }).execute();
      return { response: protocolErrorResponse(err), kind: 'error', inserted: 0, commandsSent: 0 };
    }
    const now = new Date();
    const hasData = inbound.transactions.length > 0 || (inbound.employees?.length ?? 0) > 0 || (inbound.commandResults?.length ?? 0) > 0;
    let duplicate = false;
    if (hasData || inbound.kind === 'handshake') {
      // Replay protection: data-bearing posts are unique per (provider, body|path|query); a handshake repeats legitimately so
      // its hash carries the minute. Heartbeat polls are not stored (they would be pure noise at 500 devices × 10 s).
      const hashInput = `${req.rawBody}|${req.path}|${JSON.stringify(req.query)}${inbound.kind === 'handshake' ? `|${Math.floor(now.getTime() / 60_000)}` : ''}`;
      // status 'processed': the API ingests push data inline, so no worker must ever pick these rows up as pending work
      const stored = await trx.insertInto('providerWebhookEvents').values({
        providerKey: device.providerKey, organizationId: orgId, deviceId: device.id, eventType: `device_push:${inbound.kind}`, payloadHash: sha256Hex(hashInput), remoteIp: req.remoteIp ?? null, signatureValid: device.pushTokenHash ? true : null,
        // the body itself is never stored: OPERLOG/BIODATA uploads carry biometric templates (AGENTS.md: strip, keep a sha256)
        payload: JSON.stringify({ method: req.method, path: req.path, query: req.query, bodySha256: sha256Hex(req.rawBody), bodyBytes: Buffer.byteLength(req.rawBody, 'utf8'), kind: inbound.kind, meta: inbound.meta ?? null, transactionCount: inbound.transactions.length, employeeCount: inbound.employees?.length ?? 0, commandResultCount: inbound.commandResults?.length ?? 0 }),
        headers: JSON.stringify({ 'user-agent': req.headers['user-agent'] ?? null, 'content-type': req.headers['content-type'] ?? null }), status: 'processed', processedAt: now,
      }).onConflict((oc) => oc.columns(['providerKey', 'payloadHash']).doNothing()).returning('id').executeTakeFirst();
      duplicate = hasData && !stored;
      if (duplicate) await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'info', event: 'push.duplicate', message: `duplicate ${inbound.kind} upload ignored`, details: JSON.stringify({ path: req.path, transactions: inbound.transactions.length }) }).execute();
    }
    // heartbeat / liveness bookkeeping (config.lastSeenAt feeds the ZKTeco provider's testConnection/getDeviceStatus)
    const devicePatch: Record<string, unknown> = { lastHeartbeatAt: now, lastSuccessfulCommunicationAt: now, connectionStatus: 'online', consecutiveFailures: 0, lastErrorCode: null, lastError: null, config: sql`config || ${JSON.stringify({ lastSeenAt: now.toISOString() })}::jsonb` };
    if (inbound.deviceInfo) {
      if (typeof inbound.deviceInfo.firmwareVersion === 'string') devicePatch.firmwareVersion = inbound.deviceInfo.firmwareVersion.slice(0, 80);
      if (inbound.kind === 'handshake' && typeof inbound.deviceInfo.model === 'string') devicePatch.modelName = inbound.deviceInfo.model.slice(0, 120);
      const extra = { ...(inbound.deviceInfo.extra ?? {}), ...(inbound.deviceInfo.userCount !== undefined ? { userCount: inbound.deviceInfo.userCount } : {}), ...(inbound.deviceInfo.fingerprintCount !== undefined ? { fingerprintCount: inbound.deviceInfo.fingerprintCount } : {}), ...(inbound.deviceInfo.transactionCount !== undefined ? { transactionCount: inbound.deviceInfo.transactionCount } : {}) };
      if (Object.keys(extra).length) devicePatch.config = sql`config || ${JSON.stringify({ lastSeenAt: now.toISOString(), deviceInfo: extra })}::jsonb`;
    }
    if (inbound.transactions.length && !duplicate) devicePatch.lastAttendanceSyncAt = now;
    if (inbound.employees?.length && !duplicate) devicePatch.lastEmployeeSyncAt = now;
    await trx.updateTable('devices').set(devicePatch as never).where('id', '=', device.id).execute();
    // protocol stamps → sync_cursors (fed back on the next handshake)
    const meta = inbound.meta ?? {};
    const metaStamps = jsonObject(meta.stamps) as Record<string, string>;
    if (typeof meta.stamp === 'string' && typeof meta.table === 'string') metaStamps[meta.table] = meta.stamp;
    if (Object.keys(metaStamps).length && !duplicate) {
      const nextCursor = { ...cursorObj, stamps: { ...stamps, ...metaStamps } };
      if (cursor) await trx.updateTable('syncCursors').set({ cursor: JSON.stringify(nextCursor), lastPulledAt: now, ...(inbound.transactions.length ? { lastTransactionAt: now } : {}) }).where('id', '=', cursor.id).execute();
      else await trx.insertInto('syncCursors').values({ organizationId: orgId, deviceId: device.id, stream: 'attendance', cursor: JSON.stringify(nextCursor), lastPulledAt: now }).execute();
    }
    let inserted = 0;
    if (inbound.transactions.length && !duplicate) {
      const res = await ingestRawTransactions(trx, { id: device.id, organizationId: orgId, generation: device.generation, providerKey: device.providerKey, branchId: device.branchId, timezone: device.timezone }, inbound.transactions, { source: 'DEVICE_PUSH', now });
      inserted = res.inserted;
      if (res.inserted) await enqueueNormalize(deps, trx, orgId, device.id, requestId);
      await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'info', event: 'push.attendance', message: `${res.inserted} new / ${res.duplicates} duplicate punches`, details: JSON.stringify({ received: res.received, inserted: res.inserted, duplicates: res.duplicates, quarantined: res.quarantined, held: res.held }) }).execute();
    }
    if (inbound.employees?.length && !duplicate) await upsertDeviceEmployees(trx, device, inbound.employees, now);
    if (inbound.commandResults?.length && !duplicate) await applyCommandResults(trx, device, inbound.commandResults, now);
    let response = inbound.response;
    let commandsSent = 0;
    if (inbound.kind === 'heartbeat') {
      // FOR UPDATE SKIP LOCKED: two overlapping polls from the same terminal never hand out the same command twice
      const pending = await trx.selectFrom('deviceCommands').select(['id', 'sequence', 'commandType', 'payload']).where('deviceId', '=', device.id).where('status', '=', 'pending').where('expiresAt', '>', now).orderBy('sequence').limit(PENDING_COMMAND_BATCH).forUpdate().skipLocked().execute();
      if (pending.length) {
        // Render one by one so a single unrenderable command fails alone; the rest is rendered together and only then marked sent.
        const renderable: typeof pending = [];
        for (const c of pending) {
          const cmd = { id: String(c.sequence), commandType: c.commandType, payload: jsonObject(c.payload) };
          try { handler.renderCommands([cmd], { serialNumber }); renderable.push(c); } catch (err) {
            const message = (err as Error).message.slice(0, 500);
            await trx.updateTable('deviceCommands').set({ status: 'failed', result: JSON.stringify({ error: message }) }).where('id', '=', c.id).execute();
            await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'error', event: 'push.command_render_failed', message, details: JSON.stringify({ commandId: String(c.sequence), commandType: c.commandType }) }).execute();
          }
        }
        if (renderable.length) {
          response = handler.renderCommands(renderable.map((c) => ({ id: String(c.sequence), commandType: c.commandType, payload: jsonObject(c.payload) })), { serialNumber });
          await trx.updateTable('deviceCommands').set({ status: 'sent', sentAt: now }).where('id', 'in', renderable.map((c) => c.id)).execute();
          commandsSent = renderable.length;
        }
      }
    }
    return { response, kind: duplicate ? 'duplicate' : inbound.kind, inserted, commandsSent };
  });
}

/** OPERLOG-style user data from the device → device_employee_states (device-only rows when the user is unknown). */
async function upsertDeviceEmployees(trx: Trx, device: PushDeviceRow, employees: DeviceEmployee[], now: Date): Promise<void> {
  const ids = [...new Set(employees.map((e) => e.deviceUserId))];
  const known = await trx.selectFrom('employees').select(['id', 'deviceUserId', 'branchId']).where('organizationId', '=', device.organizationId).where('deviceUserId', 'in', ids).where('deletedAt', 'is', null).execute();
  const byDeviceUser = new Map(known.map((k) => [k.deviceUserId, k]));
  for (const e of employees) {
    const emp = byDeviceUser.get(e.deviceUserId);
    const record = JSON.stringify({ name: e.name, cardNumber: e.cardNumber ?? null, privilege: e.privilege, enabled: e.enabled, hasPin: !!e.pin, extra: e.extra });
    const existing = await trx.selectFrom('deviceEmployeeStates').select(['id', 'employeeId']).where('deviceId', '=', device.id).where('deviceUserId', '=', e.deviceUserId).executeTakeFirst();
    if (existing) {
      await trx.updateTable('deviceEmployeeStates').set({ deviceRecord: record, lastSyncAt: now, cardEnrolled: !!e.cardNumber, ...(existing.employeeId === null && emp ? { employeeId: emp.id, branchId: emp.branchId } : {}) }).where('id', '=', existing.id).execute();
    } else {
      await trx.insertInto('deviceEmployeeStates').values({ organizationId: device.organizationId, deviceId: device.id, deviceUserId: e.deviceUserId, employeeId: emp?.id ?? null, branchId: emp?.branchId ?? device.branchId, desired: !!emp, syncStatus: emp ? 'OUT_OF_SYNC' : 'OUT_OF_SYNC', deviceRecord: record, lastSyncAt: now, cardEnrolled: !!e.cardNumber }).onConflict((oc) => oc.columns(['deviceId', 'deviceUserId']).doUpdateSet({ deviceRecord: record, lastSyncAt: now })).execute();
    }
  }
}

/** devicecmd results → device_commands acked/failed, linked sync items SUCCESS/FAILED, device_employee_states IN_SYNC/FAILED. */
async function applyCommandResults(trx: Trx, device: PushDeviceRow, results: NonNullable<DevicePushInbound['commandResults']>, now: Date): Promise<void> {
  for (const r of results) {
    if (!/^\d{1,18}$/.test(r.commandId)) continue;
    const cmd = await trx.selectFrom('deviceCommands').select(['id', 'commandType', 'payload', 'syncJobItemId', 'status']).where('deviceId', '=', device.id).where('sequence', '=', r.commandId).executeTakeFirst();
    if (!cmd || cmd.status === 'acked' || cmd.status === 'failed') continue;
    await trx.updateTable('deviceCommands').set({ status: r.ok ? 'acked' : 'failed', ackedAt: now, result: JSON.stringify({ ok: r.ok, message: r.message ?? null, receivedAt: now.toISOString() }) }).where('id', '=', cmd.id).execute();
    const payload = jsonObject(cmd.payload);
    const deviceUserId = typeof payload.deviceUserId === 'string' ? payload.deviceUserId : typeof payload.pin === 'string' ? payload.pin : typeof (jsonObject(payload.employee).deviceUserId) === 'string' ? String(jsonObject(payload.employee).deviceUserId) : null;
    if (cmd.syncJobItemId) {
      const item = await trx.selectFrom('syncJobItems').select(['id', 'syncJobId', 'status', 'employeeId']).where('id', '=', cmd.syncJobItemId).executeTakeFirst();
      if (item && !['SUCCESS', 'FAILED', 'CANCELLED'].includes(item.status)) {
        await trx.updateTable('syncJobItems').set({ status: r.ok ? 'SUCCESS' : 'FAILED', finishedAt: now, lastErrorCode: r.ok ? null : 'DEVICE_REJECTED', lastError: r.ok ? null : (r.message ?? 'device returned an error').slice(0, 500), result: JSON.stringify({ commandId: r.commandId, ok: r.ok, message: r.message ?? null }) }).where('id', '=', item.id).execute();
        await sql`update public.sync_jobs set items_pending = greatest(items_pending - 1, 0), items_success = items_success + ${r.ok ? 1 : 0}, items_failed = items_failed + ${r.ok ? 0 : 1},
          status = case when items_pending - 1 <= 0 then (case when items_failed + ${r.ok ? 0 : 1} = 0 then 'SUCCESS'::public.sync_status when items_success + ${r.ok ? 1 : 0} = 0 then 'FAILED'::public.sync_status else 'PARTIAL_SUCCESS'::public.sync_status end) else status end,
          finished_at = case when items_pending - 1 <= 0 then now() else finished_at end where id = ${item.syncJobId}::uuid`.execute(trx);
        if (item.employeeId) {
          const state = cmd.commandType === 'DELETE_EMPLOYEE'
            ? (r.ok ? { syncStatus: 'REMOVED' as const, desired: false, deviceHash: null, lastSuccessAt: now, lastErrorCode: null, lastError: null } : { syncStatus: 'FAILED' as const, lastErrorCode: 'DEVICE_REJECTED', lastError: (r.message ?? 'rejected').slice(0, 500) })
            : (r.ok ? { syncStatus: 'IN_SYNC' as const, deviceHash: typeof payload.cloudHash === 'string' ? payload.cloudHash : sql<string>`cloud_hash`, lastSuccessAt: now, lastErrorCode: null, lastError: null } : { syncStatus: 'FAILED' as const, lastErrorCode: 'DEVICE_REJECTED', lastError: (r.message ?? 'rejected').slice(0, 500) });
          await trx.updateTable('deviceEmployeeStates').set({ ...state, lastSyncAt: now } as never).where('deviceId', '=', device.id).where('employeeId', '=', item.employeeId).execute();
        }
      }
    } else if (deviceUserId && (cmd.commandType === 'UPSERT_EMPLOYEE' || cmd.commandType === 'DELETE_EMPLOYEE')) {
      await trx.updateTable('deviceEmployeeStates').set(cmd.commandType === 'DELETE_EMPLOYEE' && r.ok ? { syncStatus: 'REMOVED', desired: false, lastSyncAt: now } : r.ok ? { syncStatus: 'IN_SYNC', lastSyncAt: now, lastSuccessAt: now, ...(typeof payload.cloudHash === 'string' ? { deviceHash: payload.cloudHash } : {}) } : { syncStatus: 'FAILED', lastSyncAt: now, lastErrorCode: 'DEVICE_REJECTED', lastError: (r.message ?? 'rejected').slice(0, 500) }).where('deviceId', '=', device.id).where('deviceUserId', '=', deviceUserId).execute();
    }
  }
}

// ----- vendor webhooks --------------------------------------------------------------------------------------------------------

export interface WebhookOutcome { status: number; body: unknown; headers?: Record<string, string> }

export async function findWebhookDevice(db: Database, deviceId: string, providerKey: string, requestId: string): Promise<PushDeviceRow | null> {
  const row = await withContext(db, { kind: 'platform', requestId }, (trx) => trx.selectFrom('devices').select(['id', 'organizationId', 'branchId', 'code', 'timezone', 'generation', 'providerKey', 'pushTokenHash', 'serialNumber', 'config', 'status'])
    .where('id', '=', deviceId).where('providerKey', '=', providerKey).where('status', '=', 'active').executeTakeFirst());
  return row ?? null;
}

export async function handleWebhook(deps: ApiDeps, device: PushDeviceRow, token: string, req: WebhookRequest, requestId: string): Promise<WebhookOutcome> {
  if (!pushTokenMatches(token, device.pushTokenHash)) return { status: 401, body: { error: 'invalid_token' } };
  const provider = deps.providers.tryGet(device.providerKey);
  if (!provider?.handleWebhook) return { status: 404, body: { error: 'webhooks_not_supported' } };
  const orgId = device.organizationId;
  return withContext(deps.db, { kind: 'system', organizationId: orgId, requestId }, async (trx) => {
    const secrets = (await deps.credentials.get(trx, { organizationId: orgId, deviceId: device.id }).catch(() => null)) ?? {};
    const result = await provider.handleWebhook!(req, secrets);
    const payloadHash = sha256Hex(req.rawBody);
    const base = { providerKey: device.providerKey, organizationId: orgId, deviceId: device.id, eventId: result.eventId, eventType: result.eventType ?? null, payloadHash, remoteIp: req.remoteIp ?? null, signatureValid: result.signatureValid, headers: JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/authorization|cookie|token|secret|api-?key/i.test(k)))), payload: JSON.stringify({ rawBody: req.rawBody.length > 65_536 ? `${req.rawBody.slice(0, 65_536)}…` : req.rawBody, transactionCount: result.transactions.length }) };
    if (result.signatureValid === false || !result.accepted) {
      await trx.insertInto('providerWebhookEvents').values({ ...base, status: 'rejected', error: typeof (result.response.body as { error?: unknown })?.error === 'string' ? String((result.response.body as { error: string }).error) : 'rejected' }).onConflict((oc) => oc.doNothing()).execute();
      await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'warn', event: 'webhook.rejected', message: result.signatureValid === false ? 'invalid signature' : 'payload rejected', details: JSON.stringify({ status: result.response.status }) }).execute();
      return { status: result.signatureValid === false ? 401 : result.response.status, body: result.response.body ?? { error: 'rejected' }, headers: result.response.headers };
    }
    const stored = await trx.insertInto('providerWebhookEvents').values({ ...base, status: 'queued' }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
    if (!stored) {
      await trx.insertInto('deviceLogs').values({ organizationId: orgId, deviceId: device.id, level: 'info', event: 'webhook.duplicate', message: `replayed event ${result.eventId ?? payloadHash.slice(0, 12)} ignored` }).execute();
      return { status: 200, body: { received: 0, duplicate: true } };
    }
    await trx.updateTable('devices').set({ lastHeartbeatAt: new Date(), lastSuccessfulCommunicationAt: new Date(), connectionStatus: 'online', consecutiveFailures: 0 }).where('id', '=', device.id).execute();
    await enqueueJob(deps.queue, trx, { queue: 'sync', jobType: 'WEBHOOK_EVENT', organizationId: orgId, payload: { organizationId: orgId, webhookEventId: stored.id, deviceId: device.id }, correlationId: requestId, priority: 7 });
    return { status: result.response.status, body: result.response.body ?? { received: result.transactions.length }, headers: result.response.headers };
  });
}

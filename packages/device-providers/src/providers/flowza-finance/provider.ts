import { DateTime } from 'luxon';
import type { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, FinancePinKey, FinanceSyncDirection, RawTransaction } from '@flowza/contracts';
import { FINANCE_PIN_KEYS, FINANCE_SYNC_DIRECTIONS } from '@flowza/contracts';
import { EgressError, egressRequest, vetEgressUrl, type EgressLookup, type EgressPolicy, type EgressResponse } from '../../egress.js';
import { unsupported } from '../../errors.js';
import { boundedText } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { FLOWZA_FINANCE_DEFINITION } from './definition.js';
import {
  FINANCE_EXPORT_DEFAULT_LIMIT, FINANCE_EXPORT_MAX_LIMIT, FINANCE_EXPORT_PATH, FINANCE_INGEST_MAX_BATCH, FINANCE_INGEST_PATH, FINANCE_MAX_RESPONSE_BYTES,
  financeCursorFromTime, financeExportPageSchema, financeExportPunchSchema, financeIngestResultSchema, financePreviousSerials, financeSyncFromStart, invalidBaseUrl, mapFinancePunch, parseFinanceCursor, resolveFinanceBaseUrl,
  type FinanceExportPage, type FinancePunchInput, type FinancePushResult,
} from './mapping.js';

export interface FlowzaFinanceProviderOptions {
  definition?: ProviderDefinition;
  clock?: () => Date;
  /** Local development / tests only (FLOWZA_ALLOW_PRIVATE_EGRESS): accept http:// and private hosts as the Finance base URL. */
  allowPrivateHosts?: boolean;
  /** DNS resolver of the egress guard (tests inject a fixed table; production uses the system resolver). */
  lookup?: EgressLookup;
  /** Budget for opening the TCP connection of one request (default 10 s). */
  connectTimeoutMs?: number;
  /** Budget for one whole request, connect to last body byte (default 60 s; the job's own signal still applies). */
  requestTimeoutMs?: number;
}

/** Everything one Finance conversation needs, resolved from the device row + decrypted credentials (never logged). */
export interface FinanceConnectorConfig {
  baseUrl: string;
  deviceSerial: string;
  token: string;
  direction: FinanceSyncDirection;
  pinKey: FinancePinKey;
}

/** The push half is provider-specific (not part of the DeviceProvider contract); the worker's PUSH_ATTENDANCE handler duck-types it. */
export interface FinancePushCapable {
  pushAttendance(ctx: ProviderContext, punches: FinancePunchInput[]): Promise<FinancePushResult>;
}
export function hasFinancePush(p: DeviceProvider | undefined | null): p is DeviceProvider & FinancePushCapable {
  return !!p && typeof (p as Partial<FinancePushCapable>).pushAttendance === 'function';
}

/** The API validates a base URL with the provider's own egress policy (the same one every call uses). */
export interface FinanceBaseUrlVetting {
  vetBaseUrl(raw: unknown, signal?: AbortSignal): Promise<string>;
}
export function hasFinanceBaseUrlVetting(p: DeviceProvider | undefined | null): p is DeviceProvider & FinanceBaseUrlVetting {
  return !!p && typeof (p as Partial<FinanceBaseUrlVetting>).vetBaseUrl === 'function';
}

const DEFAULT_RETRY_AFTER_MS = 60_000;
const MODEL = 'Flowza Finance connector';

function str(v: unknown): string | undefined { return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined; }

/**
 * Transport failure → ProviderError with a GENERIC message: which of unreachable / TLS / timeout / refused happened, never the socket
 * error code or anything the far end sent (the test endpoint returns the message, and a message that distinguishes ECONNREFUSED from
 * a TLS error is a port scanner).
 */
function transportError(err: unknown, path: string, signal: AbortSignal): ProviderError {
  const reason = EgressError.is(err) ? err.reason : signal.aborted ? 'timeout' : 'unreachable';
  const details = { path, reason };
  switch (reason) {
    case 'refused_by_policy': return new ProviderError('INVALID_CONFIG', 'The Flowza Finance base URL is refused by the egress policy: it must be an https URL on a public host', { retryable: false, details });
    case 'timeout': return new ProviderError('TIMEOUT', `Flowza Finance did not answer ${path} in time`, { retryable: true, details });
    case 'tls_error': return new ProviderError('VENDOR_ERROR', `The secure connection to Flowza Finance (${path}) could not be established`, { retryable: true, details });
    case 'too_large': return new ProviderError('PROTOCOL_ERROR', `Flowza Finance ${path} response is too large (limit ${FINANCE_MAX_RESPONSE_BYTES} bytes)`, { retryable: false, details: { ...details, maxBytes: FINANCE_MAX_RESPONSE_BYTES } });
    default: return new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} is unreachable`, { retryable: true, details: { path, reason: 'unreachable' } });
  }
}

/**
 * Flowza Finance connector: a cloud-API style provider whose "device" is Finance's virtual device. Pull = `attendance-export`
 * (keyset cursor issued by Finance, stored verbatim), push = `attendance-ingest` (batches ≤ 500, idempotent on Finance's side).
 * Every outbound call goes through one `post()` helper on the shared egress guard (`egressRequest`: DNS-vetted, connection pinned to
 * the vetted address, no redirects, streamed body capped at 16 MB, connect + total timeouts), throttled (`ctx.acquire`) and bounded
 * by `ctx.signal`; HTTP status mapped to ProviderError codes; the token and the response body never appear in a message.
 */
export class FlowzaFinanceProvider implements DeviceProvider, FinancePushCapable, FinanceBaseUrlVetting {
  readonly definition: ProviderDefinition;
  private readonly clock: () => Date;
  private readonly allowPrivateHosts: boolean;
  private readonly egress: EgressPolicy;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: FlowzaFinanceProviderOptions = {}) {
    this.definition = options.definition ?? FLOWZA_FINANCE_DEFINITION;
    this.clock = options.clock ?? (() => new Date());
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.egress = { allowPrivate: this.allowPrivateHosts, ...(options.lookup ? { lookup: options.lookup } : {}) };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  /**
   * Full egress check of a base URL before it is stored or tested (syntax + DNS: every address the host resolves to must be public).
   * A host that does not resolve right now is accepted — the call reports it as unreachable, and every call re-checks and pins.
   */
  async vetBaseUrl(raw: unknown, signal?: AbortSignal): Promise<string> {
    const baseUrl = resolveFinanceBaseUrl(raw, { allowPrivateHosts: this.allowPrivateHosts });
    try {
      await vetEgressUrl(baseUrl, this.egress, signal);
    } catch (err) {
      if (EgressError.is(err) && err.reason === 'refused_by_policy') throw invalidBaseUrl('Finance base URL must point at a public host');
      if (!EgressError.is(err)) throw err;
    }
    return baseUrl;
  }

  /** Validates config + credentials for one call. INVALID_CONFIG is terminal: the sync engine flags the device instead of retrying. */
  resolveConfig(ctx: ProviderContext): FinanceConnectorConfig {
    const baseUrl = resolveFinanceBaseUrl(ctx.config['baseUrl'] ?? ctx.endpointUrl ?? undefined, { allowPrivateHosts: this.allowPrivateHosts });
    const deviceSerial = str(ctx.config['deviceSerial']) ?? str(ctx.serialNumber);
    if (!deviceSerial) throw new ProviderError('INVALID_CONFIG', 'Finance device serial is not configured', { retryable: false, details: { field: 'deviceSerial' } });
    const token = str(ctx.credentials['token']);
    if (!token) throw new ProviderError('INVALID_CONFIG', 'Finance push token is not configured; re-enter it under Settings → Integrations', { retryable: false, details: { field: 'token' } });
    const direction = (FINANCE_SYNC_DIRECTIONS as readonly string[]).includes(String(ctx.config['direction'])) ? (ctx.config['direction'] as FinanceSyncDirection) : 'both';
    const pinKey = (FINANCE_PIN_KEYS as readonly string[]).includes(String(ctx.config['pinKey'])) ? (ctx.config['pinKey'] as FinancePinKey) : 'employee_number';
    return { baseUrl, deviceSerial, token, direction, pinKey };
  }

  // ----- transport ----------------------------------------------------------------------------------------------------------

  /**
   * One Finance exchange. Status mapping (docs/integrations/flowza-finance.md §5): 401/403 AUTH_FAILED (terminal), 429 RATE_LIMITED
   * with Retry-After; 400, 404, 405, 3xx, 5xx, any other non-2xx and an unreadable body are VENDOR_ERROR and RETRYABLE — a gateway
   * hiccup is not a configuration verdict, and none of them may move a cursor (only `parseFinanceCursor` flags a cursor problem).
   */
  private async post<S extends z.ZodType>(ctx: ProviderContext, cfg: FinanceConnectorConfig, path: string, payload: Record<string, unknown>, schema: S): Promise<{ data: z.infer<S>; latencyMs: number }> {
    const url = `${cfg.baseUrl}/${path}`;
    const body = JSON.stringify({ device_serial: cfg.deviceSerial, token: cfg.token, ...payload });
    await ctx.acquire();
    const started = Date.now();
    let res: EgressResponse;
    try {
      res = await egressRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: ctx.signal, maxBytes: FINANCE_MAX_RESPONSE_BYTES, connectTimeoutMs: this.connectTimeoutMs, timeoutMs: this.requestTimeoutMs }, this.egress);
    } catch (err) {
      const mapped = transportError(err, path, ctx.signal);
      ctx.logger.warn({ event: 'finance_transport_failed', path, reason: mapped.details?.['reason'] }, 'Flowza Finance request failed before an HTTP answer');
      throw mapped;
    }
    const latencyMs = Date.now() - started;
    const status = res.status;
    if (status >= 300 && status < 400) throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} answered with a redirect (HTTP ${status}); redirects are not followed`, { retryable: true, details: { path, status } });
    let json: unknown = null;
    try { json = res.body.length > 0 ? JSON.parse(res.body.toString('utf8')) : null; } catch { json = null; }
    if (status < 200 || status >= 300) {
      // Finance's own error text is logged (bounded) for operators; it is never part of the message a caller sees.
      const serverError = json && typeof json === 'object' ? boundedText(String((json as { error?: unknown }).error ?? ''), 200) : null;
      ctx.logger.warn({ event: 'finance_http_error', path, status, financeError: serverError }, 'Flowza Finance answered with an error status');
      const details = { path, status };
      switch (status) {
        case 401: case 403: throw new ProviderError('AUTH_FAILED', 'Flowza Finance rejected the device credential (unknown serial, wrong token or the device is disabled)', { retryable: false, details });
        case 429: throw new ProviderError('RATE_LIMITED', 'Flowza Finance is rate limiting the connector', { retryable: true, retryAfterMs: retryAfterMs(headerOf(res, 'retry-after'), this.clock()), details });
        case 404: case 405: throw new ProviderError('VENDOR_ERROR', `Flowza Finance function ${path} was not found at the configured base URL (HTTP ${status})`, { retryable: true, details });
        case 400: throw new ProviderError('VENDOR_ERROR', `Flowza Finance rejected the ${path} request (HTTP 400)`, { retryable: true, details });
        default: throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} failed (HTTP ${status})`, { retryable: true, details });
      }
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      ctx.logger.warn({ event: 'finance_unexpected_response', path, status, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }, 'Flowza Finance returned an unexpected response shape');
      throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} returned an unexpected response`, { retryable: true, details: { path, status } });
    }
    return { data: parsed.data, latencyMs };
  }

  private async exportPage(ctx: ProviderContext, cfg: FinanceConnectorConfig, opts: { since?: string; limit: number }): Promise<{ page: FinanceExportPage; latencyMs: number }> {
    const { data, latencyMs } = await this.post(ctx, cfg, FINANCE_EXPORT_PATH, { ...(opts.since ? { since: opts.since } : {}), limit: opts.limit }, financeExportPageSchema);
    return { page: data, latencyMs };
  }

  // ----- DeviceProvider -----------------------------------------------------------------------------------------------------

  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = Date.now();
    try {
      const cfg = this.resolveConfig(ctx);
      const { page, latencyMs } = await this.exportPage(ctx, cfg, { limit: 1 });
      const first = financeExportPunchSchema.safeParse(page.punches[0]);
      return {
        ok: true,
        message: `Connected to Flowza Finance as ${cfg.deviceSerial}`,
        latencyMs,
        deviceInfo: { serialNumber: cfg.deviceSerial, model: MODEL, ...(page.server_time ? { deviceTime: page.server_time } : {}) },
        details: { serverTime: page.server_time ?? null, firstPunchAt: first.success ? first.data.time_utc : null, organizationId: page.organization_id ?? null, connectorDeviceId: page.device_id ?? null, hasPunches: page.punches.length > 0 },
      };
    } catch (err) {
      if (!ProviderError.is(err)) throw err;
      return { ok: false, message: err.message, latencyMs: Date.now() - started, details: { code: err.code, retryable: err.retryable, ...(err.details ?? {}) } };
    }
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.resolveConfig(ctx);
    return { serialNumber: cfg.deviceSerial, model: MODEL, extra: { baseUrl: cfg.baseUrl, direction: cfg.direction, pinKey: cfg.pinKey } };
  }

  async getCapabilities(_ctx: ProviderContext): Promise<DeviceCapabilities> {
    return { ...this.definition.capabilities };
  }

  /** A one-row export is the liveness probe: Finance answering (even with no punches) means the credential and the function work. Nothing is imported. */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolveConfig(ctx);
    const { page, latencyMs } = await this.exportPage(ctx, cfg, { limit: 1 });
    const now = this.clock();
    const serverTime = page.server_time ? DateTime.fromISO(page.server_time, { setZone: true }) : null;
    const skew = serverTime?.isValid ? Math.round((serverTime.toMillis() - now.getTime()) / 1000) : undefined;
    return { online: true, lastSeenAt: now.toISOString(), ...(page.server_time ? { deviceTime: page.server_time } : {}), ...(skew !== undefined ? { clockSkewSeconds: skew } : {}), details: { latencyMs, connectorDeviceId: page.device_id ?? null } };
  }

  /**
   * One export page. Without a stored cursor the page starts at the connector's start date (`config.syncFrom`) — or at `opts.since`
   * (rewind / full re-sync) when that is later — instead of at the beginning of Finance's history; the cursor is Finance's
   * created_at-based token, so rows whose PUNCH time is before the start date are additionally dropped (counted). Rows produced by
   * this connector under an earlier serial (`config.previousSerials`) are dropped too: Finance only loop-guards the current device.
   */
  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const cfg = this.resolveConfig(ctx);
    const stored = parseFinanceCursor(cursor);
    const syncFrom = financeSyncFromStart(ctx.config['syncFrom'], ctx.timezone);
    const syncFromMs = syncFrom ? Date.parse(syncFrom) : null;
    const startAt = [opts.since, syncFrom].filter((v): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    const since = stored ?? (startAt ? financeCursorFromTime(startAt) : undefined);
    const limit = Math.min(FINANCE_EXPORT_MAX_LIMIT, Math.max(1, Math.floor(opts.pageSize ?? FINANCE_EXPORT_DEFAULT_LIMIT)));
    const ownSerials = new Set([cfg.deviceSerial, ...financePreviousSerials(ctx.config)].map((s) => s.trim().toLowerCase()));
    const { page, latencyMs } = await this.exportPage(ctx, cfg, { ...(since ? { since } : {}), limit });
    const transactions: RawTransaction[] = [];
    const skipped = { invalid: 0, noIdentity: 0, badTime: 0, beforeSyncFrom: 0, ownPunches: 0 };
    for (const raw of page.punches) {
      const parsed = financeExportPunchSchema.safeParse(raw);
      if (!parsed.success) { skipped.invalid += 1; continue; }
      if (parsed.data.device_serial && ownSerials.has(parsed.data.device_serial.trim().toLowerCase())) { skipped.ownPunches += 1; continue; }
      const mapped = mapFinancePunch(parsed.data, cfg.deviceSerial);
      if (!mapped.transaction) { if (mapped.reason === 'no_identity') skipped.noIdentity += 1; else skipped.badTime += 1; continue; }
      if (syncFromMs !== null && Date.parse(mapped.transaction.punchedAt) < syncFromMs) { skipped.beforeSyncFrom += 1; continue; }
      transactions.push(mapped.transaction);
    }
    const dropped = skipped.invalid + skipped.noIdentity + skipped.badTime + skipped.beforeSyncFrom + skipped.ownPunches;
    if (skipped.invalid + skipped.noIdentity + skipped.badTime > 0) ctx.logger.warn({ event: 'finance_export_rows_skipped', ...skipped }, 'Flowza Finance export rows skipped (unattributable or malformed)');
    // Finance's next_cursor is null on an empty page: keep the position we asked from (a page without new data must not move
    // it — and after a rewind that position is the synthesised one, never "from the beginning of time").
    const nextCursor: SyncCursor = page.next_cursor ? { since: page.next_cursor } : since ? { since } : {};
    // `has_more` is only honoured while the cursor actually advances: a page that repeats its own cursor would otherwise keep the
    // engine re-reading the same rows until its page cap, and re-polling a minute later forever.
    const advanced = page.next_cursor !== null && page.next_cursor !== since;
    if (page.has_more === true && page.punches.length > 0 && !advanced) ctx.logger.warn({ event: 'finance_export_cursor_stalled' }, 'Flowza Finance reported more rows but did not advance the cursor');
    return {
      transactions,
      nextCursor,
      hasMore: page.has_more === true && page.punches.length > 0 && advanced,
      meta: { serverTime: page.server_time ?? null, organizationId: page.organization_id ?? null, connectorDeviceId: page.device_id ?? null, received: page.punches.length, limit, latencyMs, ...(dropped > 0 ? { skipped } : {}) },
    };
  }

  async listEmployees(_ctx: ProviderContext, _page: PageCursor): Promise<DeviceEmployeePage> {
    throw unsupported('listEmployees', 'Flowza Finance maps punches to its own employees (PIN Mapping); FlowZa Time never reads or writes them');
  }
  async upsertEmployee(_ctx: ProviderContext, _employee: DeviceEmployee): Promise<DeviceOperationResult> {
    throw unsupported('upsertEmployee', 'employees are not pushed to Flowza Finance');
  }
  async deleteEmployee(_ctx: ProviderContext, _deviceUserId: string): Promise<DeviceOperationResult> {
    throw unsupported('deleteEmployee', 'employees are not pushed to Flowza Finance');
  }

  // ----- push (FlowZa Time → Finance) ---------------------------------------------------------------------------------------

  /**
   * POSTs one batch (1–500 punches) to `attendance-ingest`. Finance dedupes on serial|pin|time|state, so re-sending after a failure is
   * safe. A 2xx whose `errors` is non-zero means Finance did not store every punch: the caller must not treat the batch as delivered.
   */
  async pushAttendance(ctx: ProviderContext, punches: FinancePunchInput[]): Promise<FinancePushResult> {
    if (punches.length === 0) throw new ProviderError('PROTOCOL_ERROR', 'A Flowza Finance push needs at least one punch', { retryable: false });
    if (punches.length > FINANCE_INGEST_MAX_BATCH) throw new ProviderError('PROTOCOL_ERROR', `A Flowza Finance push carries at most ${FINANCE_INGEST_MAX_BATCH} punches (got ${punches.length})`, { retryable: false, details: { count: punches.length } });
    const cfg = this.resolveConfig(ctx);
    const { data } = await this.post(ctx, cfg, FINANCE_INGEST_PATH, { punches }, financeIngestResultSchema);
    return data;
  }
}

function headerOf(res: EgressResponse, name: string): string | null {
  const v = res.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** `Retry-After` is seconds or an HTTP date; unknown/absent → a conservative minute. */
function retryAfterMs(header: string | null, now: Date): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30 * 60_000, Math.round(seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(30 * 60_000, Math.max(1000, at - now.getTime()));
  return DEFAULT_RETRY_AFTER_MS;
}

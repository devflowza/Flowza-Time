import { DateTime } from 'luxon';
import type { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee, FinancePinKey, FinanceSyncDirection, RawTransaction } from '@flowza/contracts';
import { FINANCE_PIN_KEYS, FINANCE_SYNC_DIRECTIONS } from '@flowza/contracts';
import { unsupported } from '../../errors.js';
import { boundedText } from '../../protocol-utils.js';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type ProviderDefinition, type SyncCursor } from '../../types.js';
import { FLOWZA_FINANCE_DEFINITION } from './definition.js';
import {
  FINANCE_EXPORT_DEFAULT_LIMIT, FINANCE_EXPORT_MAX_LIMIT, FINANCE_EXPORT_PATH, FINANCE_INGEST_MAX_BATCH, FINANCE_INGEST_PATH,
  financeCursorFromTime, financeExportPageSchema, financeExportPunchSchema, financeIngestResultSchema, mapFinancePunch, parseFinanceCursor, resolveFinanceBaseUrl,
  type FinanceExportPage, type FinancePunchInput, type FinancePushResult,
} from './mapping.js';

export interface FlowzaFinanceProviderOptions {
  definition?: ProviderDefinition;
  /** Transport override for tests. */
  fetch?: typeof fetch;
  clock?: () => Date;
  /** Local development / tests only: accept http:// and private hosts as the Finance base URL. */
  allowPrivateHosts?: boolean;
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

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MODEL = 'Flowza Finance connector';

function str(v: unknown): string | undefined { return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined; }

/**
 * Flowza Finance connector: a cloud-API style provider whose "device" is Finance's virtual device. Pull = `attendance-export`
 * (keyset cursor issued by Finance, stored verbatim), push = `attendance-ingest` (batches ≤ 500, idempotent on Finance's side).
 * Every outbound call goes through one `post()` helper: throttled (`ctx.acquire`), bounded by `ctx.signal`, no redirects
 * (a redirect could carry the credential to another host), HTTP status mapped to ProviderError codes, token never in a message.
 */
export class FlowzaFinanceProvider implements DeviceProvider, FinancePushCapable {
  readonly definition: ProviderDefinition;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly allowPrivateHosts: boolean;

  constructor(options: FlowzaFinanceProviderOptions = {}) {
    this.definition = options.definition ?? FLOWZA_FINANCE_DEFINITION;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? (() => new Date());
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
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

  private async post<S extends z.ZodType>(ctx: ProviderContext, cfg: FinanceConnectorConfig, path: string, payload: Record<string, unknown>, schema: S): Promise<{ data: z.infer<S>; latencyMs: number }> {
    const url = `${cfg.baseUrl}/${path}`;
    const body = JSON.stringify({ device_serial: cfg.deviceSerial, token: cfg.token, ...payload });
    await ctx.acquire();
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: ctx.signal, redirect: 'manual' });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (ctx.signal.aborted || e.name === 'AbortError' || e.name === 'TimeoutError') throw new ProviderError('TIMEOUT', `Flowza Finance did not answer ${path} in time`, { retryable: true, cause: err });
      throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} is unreachable${e.cause?.code ? ` (${e.cause.code})` : ''}`, { retryable: true, details: { path }, cause: err });
    }
    const latencyMs = Date.now() - started;
    if (res.status >= 300 && res.status < 400) throw new ProviderError('PROTOCOL_ERROR', `Flowza Finance ${path} answered with a redirect (${res.status}); redirects are not followed`, { retryable: false, details: { path, status: res.status } });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError('PROTOCOL_ERROR', `Flowza Finance ${path} response is too large`, { retryable: false, details: { path, bytes: text.length } });
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const serverError = json && typeof json === 'object' ? boundedText(String((json as { error?: unknown }).error ?? ''), 200) : null;
    if (!res.ok) {
      const details = { path, status: res.status, ...(serverError ? { error: serverError } : {}) };
      switch (res.status) {
        case 401: case 403: throw new ProviderError('AUTH_FAILED', 'Flowza Finance rejected the device credential (unknown serial, wrong token or the device is disabled)', { retryable: false, details });
        case 400: throw new ProviderError('PROTOCOL_ERROR', `Flowza Finance rejected the request: ${serverError ?? 'bad request'}`, { retryable: false, details });
        case 404: case 405: throw new ProviderError('INVALID_CONFIG', `Flowza Finance function ${path} was not found at the configured base URL`, { retryable: false, details });
        case 429: throw new ProviderError('RATE_LIMITED', 'Flowza Finance is rate limiting the connector', { retryable: true, retryAfterMs: retryAfterMs(res.headers.get('retry-after'), this.clock()), details });
        default:
          if (res.status >= 500) throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} failed (HTTP ${res.status}${serverError ? `: ${serverError}` : ''})`, { retryable: true, details });
          throw new ProviderError('VENDOR_ERROR', `Flowza Finance ${path} answered HTTP ${res.status}`, { retryable: false, details });
      }
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ProviderError('PROTOCOL_ERROR', `Flowza Finance ${path} returned an unexpected response shape`, { retryable: false, details: { path, issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) } });
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

  /** A one-row export is the liveness probe: Finance answering (even with no punches) means the credential and the function work. */
  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.resolveConfig(ctx);
    const { page, latencyMs } = await this.exportPage(ctx, cfg, { limit: 1 });
    const now = this.clock();
    const serverTime = page.server_time ? DateTime.fromISO(page.server_time, { setZone: true }) : null;
    const skew = serverTime?.isValid ? Math.round((serverTime.toMillis() - now.getTime()) / 1000) : undefined;
    return { online: true, lastSeenAt: now.toISOString(), ...(page.server_time ? { deviceTime: page.server_time } : {}), ...(skew !== undefined ? { clockSkewSeconds: skew } : {}), details: { latencyMs, connectorDeviceId: page.device_id ?? null } };
  }

  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const cfg = this.resolveConfig(ctx);
    const stored = parseFinanceCursor(cursor);
    const since = stored ?? (opts.since ? financeCursorFromTime(opts.since) : undefined);
    const limit = Math.min(FINANCE_EXPORT_MAX_LIMIT, Math.max(1, Math.floor(opts.pageSize ?? FINANCE_EXPORT_DEFAULT_LIMIT)));
    const { page, latencyMs } = await this.exportPage(ctx, cfg, { ...(since ? { since } : {}), limit });
    const transactions: RawTransaction[] = [];
    const skipped = { invalid: 0, noIdentity: 0, badTime: 0 };
    for (const raw of page.punches) {
      const parsed = financeExportPunchSchema.safeParse(raw);
      if (!parsed.success) { skipped.invalid += 1; continue; }
      const mapped = mapFinancePunch(parsed.data, cfg.deviceSerial);
      if (!mapped.transaction) { if (mapped.reason === 'no_identity') skipped.noIdentity += 1; else skipped.badTime += 1; continue; }
      transactions.push(mapped.transaction);
    }
    const dropped = skipped.invalid + skipped.noIdentity + skipped.badTime;
    if (dropped > 0) ctx.logger.warn({ event: 'finance_export_rows_skipped', ...skipped }, 'Flowza Finance export rows skipped (unattributable or malformed)');
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

  /** POSTs one batch (1–500 punches) to `attendance-ingest`. Finance dedupes on serial|pin|time|state, so re-sending after a failure is safe. */
  async pushAttendance(ctx: ProviderContext, punches: FinancePunchInput[]): Promise<FinancePushResult> {
    if (punches.length === 0) throw new ProviderError('PROTOCOL_ERROR', 'A Flowza Finance push needs at least one punch', { retryable: false });
    if (punches.length > FINANCE_INGEST_MAX_BATCH) throw new ProviderError('PROTOCOL_ERROR', `A Flowza Finance push carries at most ${FINANCE_INGEST_MAX_BATCH} punches (got ${punches.length})`, { retryable: false, details: { count: punches.length } });
    const cfg = this.resolveConfig(ctx);
    const { data } = await this.post(ctx, cfg, FINANCE_INGEST_PATH, { punches }, financeIngestResultSchema);
    return data;
  }
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

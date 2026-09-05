import { performance } from 'node:perf_hooks';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { DeviceCapabilities, DeviceEmployee } from '@flowza/contracts';
import { ProviderError, type AttendancePullResult, type ConnectionResult, type DeviceEmployeePage, type DeviceInfo, type DeviceOperationResult, type DeviceProvider, type DeviceStatus, type PageCursor, type ProviderContext, type SyncCursor, type WebhookHandlingResult, type WebhookRequest } from '../../types.js';
import { MOCK_DEFINITION, MOCK_SCENARIOS, type MockScenario } from './definition.js';
import { assertTimezone } from '../../protocol-utils.js';
import { countStream, employeeId, employeeName, seqAtOrAfter, sliceStream, unit, type MockStreamConfig } from './stream.js';
import { handleMockWebhook } from './webhook.js';
import { createMockPushProtocol } from './push-protocol.js';

/** Shared in-memory state so the worker, API and tests observe the same simulated devices. */
export interface MockState {
  /** deviceId → (deviceUserId → employee) */
  employees: Map<string, Map<string, DeviceEmployee>>;
  /** deviceId → number of simulated calls (drives flaky / rate_limited alternation) */
  calls: Map<string, number>;
  restarts: Map<string, number>;
  /** devices whose employee store has been seeded with the simulated roster */
  seeded: Set<string>;
}
export const createMockState = (): MockState => ({ employees: new Map(), calls: new Map(), restarts: new Map(), seeded: new Set() });

export interface MockProviderOptions { clock?: () => Date; state?: MockState }

export const mockConfigSchema = z.object({
  scenario: z.enum(MOCK_SCENARIOS).default('healthy'),
  employeeCount: z.coerce.number().int().min(0).max(100_000).optional(),
  seed: z.coerce.number().int().default(42),
  transactionsPerEmployeePerDay: z.coerce.number().int().min(0).max(20).default(0),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  latencyMs: z.coerce.number().int().min(0).max(600_000).default(2000),
  retryAfterMs: z.coerce.number().int().min(0).max(600_000).default(1000),
  pageSize: z.coerce.number().int().min(1).max(5000).default(200),
  listPageSize: z.coerce.number().int().min(1).max(1000).default(50),
  model: z.string().max(64).optional(),
});
export type MockConfig = z.infer<typeof mockConfigSchema>;

export const LARGE_BATCH_PAGE_SIZE = 5000;
const DEFAULT_EMPLOYEES = 25;
const LARGE_BATCH_EMPLOYEES = 500;
const DEFAULT_HISTORY_DAYS = 30;

const timeoutError = (message: string): ProviderError => new ProviderError('TIMEOUT', message, { retryable: true });

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(timeoutError('Operation aborted before the simulated device answered')); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(timeoutError(`Simulated device did not answer within the timeout (latency ${ms}ms)`)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Mock sync cursor. `lastSeq` is an offset into the deterministic stream; `startDate` pins the day the stream is
 * anchored on. Without it the default anchor ("30 days before now") would move every day and `lastSeq` would
 * silently point at different punches (a whole day skipped per day). A cursor's own `startDate` therefore always
 * wins over the configured one — changing the anchor requires an operator cursor rewind.
 */
export interface MockCursor { lastSeq: number; startDate?: string }

export function parseMockCursor(cursor: SyncCursor | null): MockCursor {
  if (cursor === null) return { lastSeq: 0 };
  const lastSeq = cursor.lastSeq;
  if (typeof lastSeq !== 'number' || !Number.isInteger(lastSeq) || lastSeq < 0) {
    throw new ProviderError('INVALID_CONFIG', 'Invalid mock cursor: expected { lastSeq: non-negative integer }', { details: { cursor } });
  }
  const startDate = cursor.startDate;
  if (startDate === undefined) return { lastSeq };
  if (typeof startDate !== 'string' || !ISO_DATE.test(startDate) || !DateTime.fromISO(startDate, { zone: 'utc' }).isValid) {
    throw new ProviderError('INVALID_CONFIG', 'Invalid mock cursor: startDate must be YYYY-MM-DD', { details: { cursor } });
  }
  return { lastSeq, startDate };
}

function parseListCursor(page: PageCursor): number {
  if (page === null) return 0;
  const m = /^offset:(\d{1,9})$/.exec(page);
  if (!m) throw new ProviderError('INVALID_CONFIG', 'Invalid employee page cursor', { details: { page } });
  return Number(m[1]);
}

/**
 * Deterministic simulator covering every integration mode: cursor-based pulls, in-memory employee store,
 * vendor webhook and a tiny device-push line protocol. Behaviour is driven by `ctx.config.scenario`.
 */
export class MockAttendanceProvider implements DeviceProvider {
  readonly definition = MOCK_DEFINITION;
  readonly pushProtocol = createMockPushProtocol();
  readonly state: MockState;
  private readonly clock: () => Date;

  constructor(options: MockProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.state = options.state ?? createMockState();
  }

  // ----- configuration & simulation ----------------------------------------------------------------
  parseConfig(ctx: ProviderContext): MockConfig {
    const parsed = mockConfigSchema.safeParse(ctx.config);
    if (!parsed.success) throw new ProviderError('INVALID_CONFIG', 'Invalid mock provider configuration', { details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    return parsed.data;
  }

  private now(): DateTime { return DateTime.fromJSDate(this.clock(), { zone: 'utc' }); }

  private streamConfig(ctx: ProviderContext, cfg: MockConfig, anchor?: string): MockStreamConfig {
    assertTimezone(ctx.timezone);
    const now = this.now();
    const startDate = anchor ?? cfg.startDate ?? now.setZone(ctx.timezone).minus({ days: DEFAULT_HISTORY_DAYS }).toISODate() ?? '';
    return {
      seed: cfg.seed,
      employeeCount: cfg.employeeCount ?? (cfg.scenario === 'large_batches' ? LARGE_BATCH_EMPLOYEES : DEFAULT_EMPLOYEES),
      punchesPerDay: cfg.transactionsPerEmployeePerDay,
      startDate,
      timezone: ctx.timezone,
      now,
      unknownEmployees: cfg.scenario === 'unknown_employees',
      deviceCode: ctx.deviceCode,
      scenario: cfg.scenario,
    };
  }

  private nextCall(ctx: ProviderContext): number {
    const n = (this.state.calls.get(ctx.deviceId) ?? 0) + 1;
    this.state.calls.set(ctx.deviceId, n);
    return n;
  }

  /** One simulated round trip to the device: throttle, count the call, apply the scenario. */
  private async simulate(ctx: ProviderContext, cfg: MockConfig, operation: string): Promise<void> {
    await ctx.acquire();
    // A real HTTP client would fail immediately on an aborted signal; do the same in every scenario.
    if (ctx.signal.aborted) throw timeoutError(`Operation ${operation} aborted before the simulated device was contacted`);
    const n = this.nextCall(ctx);
    const scenario: MockScenario = cfg.scenario;
    if (scenario === 'auth_failed' && ctx.credentials.apiKey !== 'valid') {
      throw new ProviderError('AUTH_FAILED', 'Simulated authentication failure (apiKey must be "valid")', { details: { operation } });
    }
    if (scenario === 'offline') throw new ProviderError('DEVICE_OFFLINE', 'Simulated device is offline', { retryable: true, details: { operation } });
    if (scenario === 'flaky' && n % 3 === 0) {
      if ((n / 3) % 2 === 0) throw timeoutError(`Simulated timeout on call ${n}`);
      throw new ProviderError('VENDOR_ERROR', `Simulated vendor error on call ${n}`, { retryable: true, details: { operation, call: n } });
    }
    if (scenario === 'rate_limited' && n % 2 === 0) {
      throw new ProviderError('RATE_LIMITED', 'Simulated rate limit', { retryable: true, retryAfterMs: cfg.retryAfterMs, details: { operation, call: n } });
    }
    if (scenario === 'slow') await delay(cfg.latencyMs, ctx.signal);
  }

  // ----- employee store ------------------------------------------------------------------------------
  private store(ctx: ProviderContext, stream: MockStreamConfig): Map<string, DeviceEmployee> {
    let map = this.state.employees.get(ctx.deviceId);
    if (!map) { map = new Map(); this.state.employees.set(ctx.deviceId, map); }
    if (!this.state.seeded.has(ctx.deviceId)) {
      this.state.seeded.add(ctx.deviceId);
      for (let i = 1; i <= stream.employeeCount; i += 1) {
        const id = employeeId(i);
        if (map.has(id)) continue;
        map.set(id, {
          deviceUserId: id,
          name: employeeName(stream.seed, i),
          cardNumber: unit(stream.seed, 9, i) < 0.5 ? String(100000 + i) : null,
          pin: null,
          privilege: i === 1 ? 'admin' : 'user',
          enabled: true,
          photoUrl: null,
          extra: { simulated: true },
        });
      }
    }
    return map;
  }

  // ----- DeviceProvider ------------------------------------------------------------------------------
  async testConnection(ctx: ProviderContext): Promise<ConnectionResult> {
    const started = performance.now();
    const cfg = this.parseConfig(ctx);
    try {
      await this.simulate(ctx, cfg, 'testConnection');
      const info = await this.buildDeviceInfo(ctx, cfg);
      return { ok: true, message: `Mock device reachable (scenario: ${cfg.scenario})`, latencyMs: Math.round(performance.now() - started), deviceInfo: info, details: { scenario: cfg.scenario } };
    } catch (e) {
      if (!ProviderError.is(e)) throw e;
      return { ok: false, message: e.message, latencyMs: Math.round(performance.now() - started), details: { code: e.code, retryable: e.retryable, scenario: cfg.scenario } };
    }
  }

  private async buildDeviceInfo(ctx: ProviderContext, cfg: MockConfig): Promise<DeviceInfo> {
    const stream = this.streamConfig(ctx, cfg);
    const employees = this.store(ctx, stream);
    const caps = await this.getCapabilities(ctx);
    return {
      serialNumber: ctx.serialNumber ?? `MOCK-${ctx.deviceCode}`,
      model: cfg.model ?? 'SIM-100',
      firmwareVersion: 'mock-1.0.0',
      deviceTime: this.now().toISO({ suppressMilliseconds: true }) ?? undefined,
      userCount: employees.size,
      fingerprintCount: caps.fingerprint ? employees.size : 0,
      faceCount: caps.face ? Math.floor(employees.size / 2) : 0,
      transactionCount: countStream(stream),
      extra: { scenario: cfg.scenario, restarts: this.state.restarts.get(ctx.deviceId) ?? 0 },
    };
  }

  async getDeviceInfo(ctx: ProviderContext): Promise<DeviceInfo> {
    const cfg = this.parseConfig(ctx);
    await this.simulate(ctx, cfg, 'getDeviceInfo');
    return this.buildDeviceInfo(ctx, cfg);
  }

  async getCapabilities(ctx: ProviderContext): Promise<DeviceCapabilities> {
    const cfg = this.parseConfig(ctx);
    const caps: DeviceCapabilities = { ...this.definition.capabilities };
    if (cfg.model === 'SIM-200-FACE') caps.fingerprint = false;
    return caps;
  }

  async getDeviceStatus(ctx: ProviderContext): Promise<DeviceStatus> {
    const cfg = this.parseConfig(ctx);
    try {
      await this.simulate(ctx, cfg, 'getDeviceStatus');
    } catch (e) {
      if (ProviderError.is(e) && e.code === 'DEVICE_OFFLINE') return { online: false, details: { scenario: cfg.scenario, reason: e.message } };
      throw e;
    }
    const now = this.now().toISO({ suppressMilliseconds: true }) ?? undefined;
    return { online: true, lastSeenAt: now, deviceTime: now, clockSkewSeconds: 0, details: { scenario: cfg.scenario } };
  }

  async pullAttendance(ctx: ProviderContext, cursor: SyncCursor | null, opts: { pageSize?: number; since?: string } = {}): Promise<AttendancePullResult> {
    const cfg = this.parseConfig(ctx);
    const parsed = parseMockCursor(cursor); // validate before touching the device
    await this.simulate(ctx, cfg, 'pullAttendance');
    const stream = this.streamConfig(ctx, cfg, parsed.startDate);
    const pageSize = cfg.scenario === 'large_batches' ? LARGE_BATCH_PAGE_SIZE : Math.min(LARGE_BATCH_PAGE_SIZE, Math.max(1, opts.pageSize ?? cfg.pageSize));
    let from = parsed.lastSeq;
    if (cursor === null && opts.since !== undefined) {
      const since = DateTime.fromISO(opts.since, { setZone: true });
      if (!since.isValid) throw new ProviderError('INVALID_CONFIG', 'Invalid `since` timestamp', { details: { since: opts.since } });
      from = seqAtOrAfter(stream, since.toUTC());
    }
    const { items, total } = sliceStream(stream, from, pageSize);
    const next = from + items.length;
    let transactions = items;
    let duplicatesInjected = 0;
    if (cfg.scenario === 'duplicates' && from > 0) {
      const prevFrom = Math.max(0, from - pageSize);
      const replay = sliceStream(stream, prevFrom, from - prevFrom).items.filter((_, i) => i % 10 === 0);
      duplicatesInjected = replay.length;
      transactions = [...replay, ...items];
    }
    const nextCursor: MockCursor = { lastSeq: next, startDate: stream.startDate };
    return {
      transactions,
      nextCursor: { ...nextCursor },
      hasMore: next < total,
      meta: { scenario: cfg.scenario, pageSize, total, from, duplicatesInjected, startDate: stream.startDate },
    };
  }

  async listEmployees(ctx: ProviderContext, page: PageCursor): Promise<DeviceEmployeePage> {
    const cfg = this.parseConfig(ctx);
    const offset = parseListCursor(page);
    await this.simulate(ctx, cfg, 'listEmployees');
    const all = [...this.store(ctx, this.streamConfig(ctx, cfg)).values()].sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId));
    const employees = all.slice(offset, offset + cfg.listPageSize).map((e) => ({ ...e }));
    const end = offset + employees.length;
    return { employees, nextCursor: end < all.length ? `offset:${end}` : null };
  }

  async upsertEmployee(ctx: ProviderContext, employee: DeviceEmployee): Promise<DeviceOperationResult> {
    const cfg = this.parseConfig(ctx);
    if (typeof employee.deviceUserId !== 'string' || employee.deviceUserId.length === 0) throw new ProviderError('INVALID_CONFIG', 'deviceUserId is required');
    await this.simulate(ctx, cfg, 'upsertEmployee');
    const store = this.store(ctx, this.streamConfig(ctx, cfg));
    const existed = store.has(employee.deviceUserId);
    store.set(employee.deviceUserId, { ...employee, extra: { ...employee.extra } });
    return { ok: true, deviceUserId: employee.deviceUserId, message: existed ? 'Employee updated on simulated device' : 'Employee created on simulated device', details: { created: !existed } };
  }

  async deleteEmployee(ctx: ProviderContext, deviceUserId: string): Promise<DeviceOperationResult> {
    const cfg = this.parseConfig(ctx);
    await this.simulate(ctx, cfg, 'deleteEmployee');
    const store = this.store(ctx, this.streamConfig(ctx, cfg));
    if (!store.delete(deviceUserId)) throw new ProviderError('NOT_FOUND', `Employee ${deviceUserId} does not exist on the simulated device`, { retryable: false, details: { deviceUserId } });
    return { ok: true, deviceUserId, message: 'Employee removed from simulated device' };
  }

  async restart(ctx: ProviderContext): Promise<DeviceOperationResult> {
    const cfg = this.parseConfig(ctx);
    await this.simulate(ctx, cfg, 'restart');
    this.state.restarts.set(ctx.deviceId, (this.state.restarts.get(ctx.deviceId) ?? 0) + 1);
    return { ok: true, message: 'Simulated device restarted' };
  }

  async handleWebhook(req: WebhookRequest, secrets: Record<string, unknown>): Promise<WebhookHandlingResult> {
    return handleMockWebhook(req, secrets);
  }
}

/** Factory so tests and the worker can share one simulated world (`state`) and a controllable clock. */
export const createMockProvider = (options: MockProviderOptions = {}): MockAttendanceProvider => new MockAttendanceProvider(options);

import type { ProviderThrottling } from '@flowza/contracts';
import { ProviderError } from './types.js';

/**
 * Per-provider throttler (§F.6): a concurrency semaphore per vendor account + a token bucket per provider
 * (`requestsPerMinute`). The worker calls `acquire(accountKey)` before talking to a vendor and releases when done;
 * `tryAcquire` is the non-blocking variant so a worker can re-schedule a job instead of holding a slot.
 * Timers go through the injectable `timers` so tests can use fake timers; the default uses globalThis.
 */
export interface Throttler {
  /** Waits for a slot + token. Rejects with ProviderError('TIMEOUT') when `signal` aborts while waiting. */
  acquire(accountKey: string, opts?: AcquireOptions): Promise<ThrottleLease>;
  /** Non-blocking: returns a lease or the delay (ms) after which a retry is likely to succeed. */
  tryAcquire(accountKey: string, opts?: { deviceKey?: string }): { ok: true; lease: ThrottleLease } | { ok: false; retryAfterMs: number; reason: 'account_concurrency' | 'device_concurrency' | 'rate_limit' };
  stats(accountKey?: string): ThrottlerStats;
  readonly limits: Required<ProviderThrottling>;
}
export interface AcquireOptions { deviceKey?: string; signal?: AbortSignal }
export interface ThrottleLease { release(): void; readonly accountKey: string; readonly deviceKey: string | undefined }
export interface ThrottlerStats { inFlight: number; waiting: number; tokens: number; perAccount: Record<string, { inFlight: number; waiting: number }> }
export interface ThrottlerTimers { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }

export const DEFAULT_THROTTLING: Required<ProviderThrottling> = { maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 4, requestsPerMinute: 120 };

const defaultTimers: ThrottlerTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

interface Bucket { tokens: number; lastRefillAt: number }
interface Counter { inFlight: number; waiting: number }

export function resolveThrottling(throttling: ProviderThrottling | undefined): Required<ProviderThrottling> {
  const merged = { ...DEFAULT_THROTTLING, ...(throttling ?? {}) };
  for (const [k, v] of Object.entries(merged)) {
    if (!Number.isInteger(v) || v < 1) throw new ProviderError('INVALID_CONFIG', `Throttling ${k} must be a positive integer`);
  }
  return merged;
}

export function createThrottler(throttling: ProviderThrottling | undefined, timers: Partial<ThrottlerTimers> = {}): Throttler {
  const limits = resolveThrottling(throttling);
  const t: ThrottlerTimers = { ...defaultTimers, ...timers };
  const accounts = new Map<string, Counter>();
  const devices = new Map<string, Counter>();
  const bucket: Bucket = { tokens: limits.requestsPerMinute, lastRefillAt: t.now() };
  const refillPerMs = limits.requestsPerMinute / 60_000;
  /** FIFO of waiters; each is woken (in order) whenever capacity may have changed. */
  const waiters: Array<() => void> = [];

  const counter = (map: Map<string, Counter>, key: string): Counter => {
    let c = map.get(key);
    if (!c) { c = { inFlight: 0, waiting: 0 }; map.set(key, c); }
    return c;
  };
  const refill = (): void => {
    const now = t.now();
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    bucket.tokens = Math.min(limits.requestsPerMinute, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillAt = now;
  };
  const msUntilToken = (): number => {
    refill();
    if (bucket.tokens >= 1) return 0;
    return Math.ceil((1 - bucket.tokens) / refillPerMs);
  };
  /**
   * A release may free an account slot, a device slot and nothing else — which waiter can use it depends on its
   * own device key and the bucket. Waking only the head would leave capacity idle (until that waiter's poll timer)
   * whenever the head is blocked on a different device than the one just freed, so every waiter re-checks in FIFO
   * order; each one that still cannot proceed simply stays queued.
   */
  const wake = (): void => { for (const attempt of [...waiters]) attempt(); };
  const lease = (accountKey: string, deviceKey: string | undefined): ThrottleLease => {
    const acc = counter(accounts, accountKey);
    acc.inFlight += 1;
    if (deviceKey !== undefined) counter(devices, deviceKey).inFlight += 1;
    let released = false;
    return {
      accountKey,
      deviceKey,
      release: () => {
        if (released) return;
        released = true;
        acc.inFlight -= 1;
        if (deviceKey !== undefined) counter(devices, deviceKey).inFlight -= 1;
        wake();
      },
    };
  };

  const tryAcquire: Throttler['tryAcquire'] = (accountKey, opts = {}) => {
    const acc = counter(accounts, accountKey);
    if (acc.inFlight >= limits.maxConcurrentPerAccount) return { ok: false, retryAfterMs: 250, reason: 'account_concurrency' };
    if (opts.deviceKey !== undefined && counter(devices, opts.deviceKey).inFlight >= limits.maxConcurrentPerDevice) return { ok: false, retryAfterMs: 250, reason: 'device_concurrency' };
    const wait = msUntilToken();
    if (wait > 0) return { ok: false, retryAfterMs: wait, reason: 'rate_limit' };
    bucket.tokens -= 1;
    return { ok: true, lease: lease(accountKey, opts.deviceKey) };
  };

  const acquire: Throttler['acquire'] = (accountKey, opts = {}) => {
    const acc = counter(accounts, accountKey);
    return new Promise<ThrottleLease>((resolve, reject) => {
      let timer: unknown;
      let settled = false;
      const cleanup = (): void => {
        if (timer !== undefined) { t.clearTimeout(timer); timer = undefined; }
        opts.signal?.removeEventListener('abort', onAbort);
        const idx = waiters.indexOf(attempt);
        if (idx >= 0) waiters.splice(idx, 1);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        acc.waiting -= 1;
        cleanup();
        reject(new ProviderError('TIMEOUT', `Throttle wait for account ${accountKey} aborted`, { retryable: true, details: { accountKey } }));
      };
      const attempt = (): void => {
        if (settled) return;
        const r = tryAcquire(accountKey, { deviceKey: opts.deviceKey });
        if (r.ok) {
          settled = true;
          acc.waiting -= 1;
          cleanup();
          resolve(r.lease);
          return;
        }
        // Not yet: queue for the next release and also poll when the bucket refills.
        if (!waiters.includes(attempt)) waiters.push(attempt);
        if (timer !== undefined) t.clearTimeout(timer);
        timer = t.setTimeout(() => { timer = undefined; attempt(); }, Math.max(1, r.retryAfterMs));
      };
      if (opts.signal?.aborted) {
        reject(new ProviderError('TIMEOUT', `Throttle wait for account ${accountKey} aborted`, { retryable: true, details: { accountKey } }));
        return;
      }
      acc.waiting += 1;
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      attempt();
    });
  };

  const stats: Throttler['stats'] = (accountKey) => {
    refill();
    const perAccount: Record<string, { inFlight: number; waiting: number }> = {};
    let inFlight = 0;
    let waiting = 0;
    for (const [k, c] of accounts) {
      if (accountKey !== undefined && k !== accountKey) continue;
      perAccount[k] = { inFlight: c.inFlight, waiting: c.waiting };
      inFlight += c.inFlight;
      waiting += c.waiting;
    }
    return { inFlight, waiting, tokens: Math.floor(bucket.tokens), perAccount };
  };

  return { acquire, tryAcquire, stats, limits };
}

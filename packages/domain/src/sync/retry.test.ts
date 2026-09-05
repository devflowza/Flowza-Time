import { describe, expect, it } from 'vitest';
import { applyJitter, baseBackoffMs, decideRetry, nextAdaptiveInterval, unitHash } from './retry.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type SyncErrorCode } from './types.js';

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0 };

describe('decideRetry', () => {
  it.each<[SyncErrorCode, boolean, string]>([
    ['AUTH_FAILED', false, 'FAILED'],
    ['INVALID_CONFIG', false, 'FAILED'],
    ['PROTOCOL_ERROR', false, 'FAILED'],
    ['NOT_FOUND', false, 'FAILED'],
    ['CONFLICT', false, 'FAILED'],
    ['UNSUPPORTED', false, 'UNSUPPORTED'],
    ['NOT_IMPLEMENTED', false, 'UNSUPPORTED'],
    ['DEVICE_OFFLINE', true, 'OFFLINE'],
    ['RATE_LIMITED', true, 'RETRYING'],
    ['TIMEOUT', true, 'RETRYING'],
    ['VENDOR_ERROR', true, 'RETRYING'],
    ['INTERNAL', true, 'RETRYING'],
  ])('%s on attempt 1 → retry=%s status=%s', (code, retry, status) => {
    const d = decideRetry(code, 1, policy);
    expect(d.retry).toBe(retry);
    expect(d.itemStatus).toBe(status);
    if (!retry) expect(d.delayMs).toBe(0);
  });

  it('backs off exponentially from the base delay and caps at maxDelayMs', () => {
    expect(decideRetry('TIMEOUT', 1, policy).delayMs).toBe(30_000);
    expect(decideRetry('TIMEOUT', 2, policy).delayMs).toBe(60_000);
    expect(decideRetry('TIMEOUT', 3, policy).delayMs).toBe(120_000);
    expect(baseBackoffMs(20, policy)).toBe(1_800_000);
  });

  it('stops after maxAttempts (FAILED, or OFFLINE for offline devices)', () => {
    expect(decideRetry('TIMEOUT', 6, policy)).toEqual({ retry: false, delayMs: 0, itemStatus: 'FAILED' });
    expect(decideRetry('DEVICE_OFFLINE', 6, policy)).toEqual({ retry: false, delayMs: 0, itemStatus: 'OFFLINE' });
    expect(decideRetry('DEVICE_OFFLINE', 5, policy).retry).toBe(true);
  });

  it('honours retryAfterMs for RATE_LIMITED and never shortens it', () => {
    expect(decideRetry('RATE_LIMITED', 1, policy, 90_000).delayMs).toBe(90_000);
    expect(decideRetry('RATE_LIMITED', 1, policy, 5_000).delayMs).toBe(30_000);
    expect(decideRetry('RATE_LIMITED', 1, policy, null).delayMs).toBe(30_000);
    expect(decideRetry('TIMEOUT', 1, policy, 90_000).delayMs).toBe(30_000);
  });

  it('applies deterministic jitter within ±jitterRatio when a seed is given', () => {
    const jittered = DEFAULT_RETRY_POLICY; // 20 % jitter
    const a = decideRetry('TIMEOUT', 1, jittered, undefined, 'job-1:1');
    const b = decideRetry('TIMEOUT', 1, jittered, undefined, 'job-1:1');
    const c = decideRetry('TIMEOUT', 1, jittered, undefined, 'job-2:1');
    expect(a).toEqual(b);
    expect(a.delayMs).toBeGreaterThanOrEqual(24_000);
    expect(a.delayMs).toBeLessThanOrEqual(36_000);
    expect(c.delayMs).not.toBe(a.delayMs);
    expect(decideRetry('TIMEOUT', 1, jittered).delayMs).toBe(30_000); // no seed → no jitter
  });

  it('exposes a stable unit hash', () => {
    expect(unitHash('abc')).toBe(unitHash('abc'));
    expect(unitHash('abc')).toBeGreaterThanOrEqual(0);
    expect(unitHash('abc')).toBeLessThan(1);
    expect(applyJitter(1000, 0.5, undefined)).toBe(1000);
  });
});

describe('nextAdaptiveInterval', () => {
  const base = { baseIntervalMinutes: 5, emptyPollCount: 0, maxIntervalMinutes: 60 };

  it('keeps the base interval for the first empty polls, then doubles every three', () => {
    let state = base;
    const intervals: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const next = nextAdaptiveInterval(state, false);
      state = next.state;
      intervals.push(next.intervalMinutes);
    }
    expect(intervals).toEqual([5, 5, 10, 10, 10, 20, 20, 20, 40, 40, 40, 60]);
    expect(state.emptyPollCount).toBe(12);
  });

  it('resets to the base interval when data arrives', () => {
    const r = nextAdaptiveInterval({ ...base, emptyPollCount: 9 }, true);
    expect(r).toEqual({ state: { ...base, emptyPollCount: 0 }, intervalMinutes: 5 });
  });

  it('never exceeds the maximum', () => {
    expect(nextAdaptiveInterval({ ...base, emptyPollCount: 99 }, false).intervalMinutes).toBe(60);
  });
});

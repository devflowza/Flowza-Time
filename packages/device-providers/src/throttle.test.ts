import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottler, resolveThrottling } from './throttle.js';
import { ProviderError } from './types.js';

describe('createThrottler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-01T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('fills defaults and rejects bad limits', () => {
    expect(resolveThrottling(undefined)).toEqual({ maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 4, requestsPerMinute: 120 });
    expect(resolveThrottling({ maxConcurrentPerAccount: 2 }).maxConcurrentPerAccount).toBe(2);
    expect(() => resolveThrottling({ requestsPerMinute: 0 })).toThrow(ProviderError);
  });

  it('caps concurrency per account and releases in FIFO order', async () => {
    const t = createThrottler({ maxConcurrentPerAccount: 2, requestsPerMinute: 6000 });
    const a = await t.acquire('acc');
    const b = await t.acquire('acc');
    let third = false;
    const p = t.acquire('acc').then((l) => { third = true; return l; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(third).toBe(false);
    expect(t.stats('acc').perAccount.acc).toEqual({ inFlight: 2, waiting: 1 });
    expect(t.tryAcquire('acc')).toMatchObject({ ok: false, reason: 'account_concurrency' });
    // a different account is not blocked
    const other = t.tryAcquire('other');
    expect(other.ok).toBe(true);
    a.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toBe(true);
    const c = await p;
    b.release(); c.release(); if (other.ok) other.lease.release();
    expect(t.stats().inFlight).toBe(0);
    a.release(); // double release is a no-op
    expect(t.stats().inFlight).toBe(0);
  });

  it('caps concurrency per device', () => {
    const t = createThrottler({ maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 10, requestsPerMinute: 6000 });
    const first = t.tryAcquire('acc', { deviceKey: 'd1' });
    expect(first.ok).toBe(true);
    expect(t.tryAcquire('acc', { deviceKey: 'd1' })).toMatchObject({ ok: false, reason: 'device_concurrency' });
    expect(t.tryAcquire('acc', { deviceKey: 'd2' }).ok).toBe(true);
  });

  it('a release wakes every waiter that can proceed, not only the head of the queue', async () => {
    const t = createThrottler({ maxConcurrentPerDevice: 1, maxConcurrentPerAccount: 2, requestsPerMinute: 6000 });
    const h1 = await t.acquire('acc', { deviceKey: 'd1' });
    const h2 = await t.acquire('acc', { deviceKey: 'd2' });
    let w1 = false; let w2 = false;
    const p1 = t.acquire('acc', { deviceKey: 'd1' }).then((l) => { w1 = true; return l; }); // head: blocked by device d1
    const p2 = t.acquire('acc', { deviceKey: 'd2' }).then((l) => { w2 = true; return l; });
    await vi.advanceTimersByTimeAsync(0);
    expect([w1, w2]).toEqual([false, false]);
    h2.release(); // frees an account slot and device d2: only the second waiter can use it
    await vi.advanceTimersByTimeAsync(0);
    expect([w1, w2]).toEqual([false, true]);
    expect(t.stats('acc').perAccount.acc).toEqual({ inFlight: 2, waiting: 1 });
    h1.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(w1).toBe(true);
    (await p1).release(); (await p2).release();
    expect(t.stats()).toMatchObject({ inFlight: 0, waiting: 0 });
  });

  it('rate limits with a token bucket that refills over time', async () => {
    const t = createThrottler({ maxConcurrentPerAccount: 100, requestsPerMinute: 60 }); // 1 token per second
    const leases = [];
    for (let i = 0; i < 60; i += 1) { const r = t.tryAcquire('acc'); expect(r.ok).toBe(true); if (r.ok) leases.push(r.lease); }
    const denied = t.tryAcquire('acc');
    expect(denied).toMatchObject({ ok: false, reason: 'rate_limit' });
    if (!denied.ok) expect(denied.retryAfterMs).toBeGreaterThan(0);
    let got = false;
    const waiting = t.acquire('acc').then((l) => { got = true; return l; });
    await vi.advanceTimersByTimeAsync(500);
    expect(got).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(got).toBe(true);
    (await waiting).release();
    for (const l of leases) l.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.stats().tokens).toBe(60); // never exceeds capacity
  });

  it('rejects with TIMEOUT when the signal aborts while waiting', async () => {
    const t = createThrottler({ maxConcurrentPerAccount: 1, requestsPerMinute: 6000 });
    const held = await t.acquire('acc');
    const ac = new AbortController();
    const p = t.acquire('acc', { signal: ac.signal });
    const failure = p.catch((e: unknown) => e);
    ac.abort();
    const err = await failure;
    expect(ProviderError.is(err) && err.code === 'TIMEOUT' && err.retryable).toBe(true);
    expect(t.stats('acc').perAccount.acc?.waiting).toBe(0);
    held.release();
    const pre = new AbortController(); pre.abort();
    await expect(t.acquire('acc', { signal: pre.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

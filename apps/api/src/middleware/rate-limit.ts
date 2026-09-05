import type { MiddlewareHandler } from 'hono';
import { AppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

export interface RateLimitOptions { windowMs: number; max: number; keyFn: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string; name?: string }

/**
 * In-memory sliding-window limiter suitable for a single API instance (§119). For multi-instance deployments
 * put the limiter at the edge (Cloudflare/Fly) or back it with Redis; the interface stays the same.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      for (const [k, arr] of hits) { const kept = arr.filter((t) => now - t < opts.windowMs); if (kept.length) hits.set(k, kept); else hits.delete(k); }
      lastSweep = now;
    }
    const key = `${opts.name ?? 'default'}:${opts.keyFn(c)}`;
    const arr = (hits.get(key) ?? []).filter((t) => now - t < opts.windowMs);
    if (arr.length >= opts.max) {
      const retryAfter = Math.ceil((opts.windowMs - (now - arr[0]!)) / 1000);
      c.header('retry-after', String(retryAfter));
      throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', { retryAfterMs: retryAfter * 1000 });
    }
    arr.push(now);
    hits.set(key, arr);
    c.header('x-ratelimit-limit', String(opts.max));
    c.header('x-ratelimit-remaining', String(Math.max(0, opts.max - arr.length)));
    await next();
  };
}

import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { AppError } from '@flowza/shared';
import type { AppEnv } from './request-context.js';

interface StoredResponse { status: number; body: string; contentType: string | null; requestHash: string; expiresAt: number; inFlight: boolean }

/**
 * Idempotency-Key support for job-creating POSTs (§H.6). The first response for (user, method, path, key) is stored
 * for `ttlMs` and replayed for identical retries; a different body under the same key is IDEMPOTENCY_CONFLICT.
 * Storage is an in-memory LRU, correct for a single API instance; multi-instance deployments must back this with
 * Redis (same interface: get/set with TTL) so retries that land on another instance are also deduplicated.
 */
export function idempotency(opts: { ttlMs?: number; maxEntries?: number } = {}): MiddlewareHandler<AppEnv> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const maxEntries = opts.maxEntries ?? 5000;
  const store = new Map<string, StoredResponse>();
  const evict = () => {
    const now = Date.now();
    for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
    while (store.size > maxEntries) { const oldest = store.keys().next().value; if (oldest === undefined) break; store.delete(oldest); }
  };
  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (!key || c.req.method !== 'POST') return next();
    if (key.length > 128) throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be at most 128 characters.');
    const userId = c.get('principal')?.userId ?? 'anon';
    const rawBody = await c.req.raw.clone().text();
    const requestHash = createHash('sha256').update(rawBody).digest('hex');
    const storeKey = `${userId}:${c.req.method}:${c.req.path}:${key}`;
    evict();
    const existing = store.get(storeKey);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was already used with a different request body.');
      if (existing.inFlight) throw new AppError('IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is still being processed.');
      c.header('idempotency-replayed', 'true');
      return c.body(existing.body, existing.status as 200, existing.contentType ? { 'content-type': existing.contentType } : {});
    }
    // LRU: re-insert moves the key to the end
    store.delete(storeKey);
    store.set(storeKey, { status: 0, body: '', contentType: null, requestHash, expiresAt: Date.now() + ttlMs, inFlight: true });
    try {
      await next();
    } catch (err) {
      store.delete(storeKey);
      throw err;
    }
    const res = c.res;
    if (res.status >= 500) { store.delete(storeKey); return; }
    const body = await res.clone().text();
    store.set(storeKey, { status: res.status, body, contentType: res.headers.get('content-type'), requestHash, expiresAt: Date.now() + ttlMs, inFlight: false });
  };
}

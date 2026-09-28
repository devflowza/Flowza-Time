/**
 * Middleware scope (HR portal Prompt 10 — security gate). The inbound router (device push, vendor webhooks) is mounted at the
 * root, so a `use('*')` on it ran for EVERY request of the app: its limiter (1,200 / min per client IP) capped the whole
 * authenticated API too. Its edge gate and limiter now apply to its own paths only — and every inbound route must live under
 * those paths, or it would escape them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, INBOUND_PREFIXES } from '../app.js';
import { createTestApi, type TestApi } from './harness.js';

let api: TestApi;
beforeAll(async () => { api = await createTestApi('mwscope'); }, 180_000);
afterAll(async () => { await api?.close(); });

describe('middleware scope', () => {
  it('every route outside /api lives under an inbound prefix (its edge gate and limiter apply)', () => {
    const outside = createApp(api.deps).routes.filter((r) => r.method !== 'ALL' && !r.path.startsWith('/api/') && r.path !== '/api');
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.filter((r) => !INBOUND_PREFIXES.some((p) => r.path === p || r.path.startsWith(`${p}/`))).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it('the authenticated API is not counted by the inbound limiter', async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 1250; i += 1) statuses.add((await api.request('GET', '/me')).status);
    expect([...statuses]).toEqual([401]);
  });

  it('the inbound limiter still guards the inbound paths', async () => {
    const app = createApp(api.deps);
    let last = 0;
    for (let i = 0; i < 1300 && last !== 429; i += 1) last = (await app.request(`/webhooks/providers/mock/${randomUUID()}/token`, { method: 'POST', body: '{}' })).status;
    expect(last).toBe(429);
  });
});

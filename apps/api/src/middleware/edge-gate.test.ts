import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { EDGE_HEADER, edgeGate } from './edge-gate.js';
import { errorHandler } from './error-handler.js';
import type { AppEnv } from './request-context.js';

const SECRET = 'a-secret-of-sufficient-length';

const appWith = (secret: string | undefined) => {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.use('*', edgeGate(secret));
  app.get('/guarded', (c) => c.json({ ok: true }));
  return app;
};

describe('edgeGate', () => {
  it('passes a request carrying the shared secret', async () => {
    const res = await appWith(SECRET).request('/guarded', { headers: { [EDGE_HEADER]: SECRET } });
    expect(res.status).toBe(200);
  });

  it('refuses a request that reached the origin without going through the edge', async () => {
    const res = await appWith(SECRET).request('/guarded');
    expect(res.status).toBe(403);
  });

  it('refuses a wrong secret', async () => {
    const res = await appWith(SECRET).request('/guarded', { headers: { [EDGE_HEADER]: 'not-the-secret-value-here' } });
    expect(res.status).toBe(403);
  });

  it('refuses a secret that is a prefix of the real one, despite the length difference', async () => {
    // timingSafeEqual throws on differing lengths, so the length check must come first or this is a 500, not a 403.
    const res = await appWith(SECRET).request('/guarded', { headers: { [EDGE_HEADER]: SECRET.slice(0, 8) } });
    expect(res.status).toBe(403);
  });

  it('refuses a longer value that starts with the real secret', async () => {
    const res = await appWith(SECRET).request('/guarded', { headers: { [EDGE_HEADER]: `${SECRET}extra` } });
    expect(res.status).toBe(403);
  });

  it('does not disclose the header name or the reason in the response body', async () => {
    const res = await appWith(SECRET).request('/guarded');
    const body = JSON.stringify(await res.json()).toLowerCase();
    expect(body).not.toContain(EDGE_HEADER);
    expect(body).not.toContain(SECRET);
  });

  it('is inert when no secret is configured, so local and CDN-less deployments are unaffected', async () => {
    const res = await appWith(undefined).request('/guarded');
    expect(res.status).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { REACHABILITY_PROBE_PATH, securityHeaders } from './security-headers.js';
import type { AppEnv } from './request-context.js';

const app = new Hono<AppEnv>();
app.use('*', securityHeaders());
app.get(REACHABILITY_PROBE_PATH, (c) => c.json({ status: 'ok' }));
app.get('/api/ready', (c) => c.json({ status: 'ready' }));
app.get('/api/v1/me', (c) => c.json({ data: {} }));

describe('securityHeaders', () => {
  it('lets another origin load the health check, the web reachability probe', async () => {
    const res = await app.request(REACHABILITY_PROBE_PATH);
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    // everything else secureHeaders sets is unchanged on the probe path
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('keeps every other path same-origin', async () => {
    for (const path of ['/api/v1/me', '/api/ready', `${REACHABILITY_PROBE_PATH}/x`]) {
      const res = await app.request(path);
      expect(res.headers.get('Cross-Origin-Resource-Policy'), path).toBe('same-origin');
    }
  });
});

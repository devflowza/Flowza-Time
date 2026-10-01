import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config.js';

const baseEnv = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  DATABASE_URL_API: 'postgres://flowza_api:pw@127.0.0.1:54329/flowza',
  FLOWZA_CREDENTIALS_MASTER_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  FLOWZA_DEVICE_PUSH_SECRET: 'push-secret-1',
};

/** WEB_ORIGINS as deployed (fly.api.toml [env]) — the value the production CORS layer actually runs with. */
function deployedWebOrigins(): string {
  const toml = readFileSync(new URL('../../../fly.api.toml', import.meta.url), 'utf8');
  const value = /^\s*WEB_ORIGINS\s*=\s*"([^"]*)"/m.exec(toml)?.[1];
  if (value === undefined) throw new Error('fly.api.toml has no WEB_ORIGINS');
  return value;
}

describe('loadApiConfig WEB_ORIGINS', () => {
  it('reads a comma-separated list, ignoring spaces and empty entries', () => {
    const config = loadApiConfig({ ...baseEnv, WEB_ORIGINS: 'https://a.example, https://b.example ,' });
    expect(config.webOrigins).toEqual(['https://a.example', 'https://b.example']);
  });

  it('allows every hostname the production web app is served from, each as a bare origin', () => {
    // CORS matches the browser's Origin header exactly: a trailing slash or a path here is an origin no browser sends,
    // and the app then reads the healthy API as unreachable from that host.
    const { webOrigins } = loadApiConfig({ ...baseEnv, WEB_ORIGINS: deployedWebOrigins() });
    expect(webOrigins).toEqual(expect.arrayContaining(['https://time.flowza.ai', 'https://time.flowza.com']));
    for (const origin of webOrigins) expect(new URL(origin).origin, origin).toBe(origin);
  });
});

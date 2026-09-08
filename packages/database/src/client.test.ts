import { describe, expect, it, afterEach } from 'vitest';
import type pg from 'pg';
import { createDatabase } from './client.js';
import { SUPABASE_ROOT_CA_2021 } from './supabase-ca.js';

// createDatabase builds a pg.Pool lazily — no connection is opened until a query runs, so these assertions are safe.
const pools: pg.Pool[] = [];
function make(opts: Parameters<typeof createDatabase>[0]) {
  const { pool } = createDatabase(opts);
  pools.push(pool);
  return pool as unknown as { options: Record<string, unknown> };
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
});

describe('createDatabase TLS', () => {
  const connectionString = 'postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';

  it('does not configure TLS when ssl is off, so local development is untouched', () => {
    expect(make({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54329/flowza' }).options.ssl).toBeUndefined();
  });

  it('verifies the server by default when TLS is on', () => {
    expect(make({ connectionString, ssl: true }).options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('pins the given CA without ever relaxing verification', () => {
    // The failure this guards against is a well-meant `rejectUnauthorized: false` to "fix" Supabase's private root:
    // that keeps the traffic encrypted but authenticates nothing.
    const ssl = make({ connectionString, ssl: true, sslCa: SUPABASE_ROOT_CA_2021 }).options.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toBe(SUPABASE_ROOT_CA_2021);
  });

  it('ignores a CA when TLS is off rather than half-configuring the connection', () => {
    expect(make({ connectionString: 'postgresql://postgres:postgres@localhost:5432/flowza', sslCa: 'x' }).options.ssl).toBeUndefined();
  });

  it('drops sslmode from the URL so it cannot override the pinned CA', () => {
    // pg merges as Object.assign({}, config, parse(connectionString)), so a leftover sslmode wins over `ssl` and
    // throws the `ca` away — which is how a pinned private CA silently stops being used.
    const pool = make({ connectionString: `${connectionString}?sslmode=require`, ssl: true, sslCa: SUPABASE_ROOT_CA_2021 });
    expect(String(pool.options.connectionString)).not.toContain('sslmode');
    expect((pool.options.ssl as Record<string, unknown>).ca).toBe(SUPABASE_ROOT_CA_2021);
  });

  it('leaves a connection string with no TLS parameters untouched', () => {
    expect(make({ connectionString, ssl: true }).options.connectionString).toBe(connectionString);
  });
});

describe('SUPABASE_ROOT_CA_2021', () => {
  it('is a single PEM certificate', () => {
    expect(SUPABASE_ROOT_CA_2021.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    expect(SUPABASE_ROOT_CA_2021.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true);
  });
});

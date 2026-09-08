import { Kysely, PostgresDialect, CamelCasePlugin, sql } from 'kysely';
import pg from 'pg';
import type { DB } from './generated/db.js';

export type Database = Kysely<DB>;

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  /** Statement timeout in ms applied to every connection (defensive default 30s). */
  statementTimeoutMs?: number;
  ssl?: boolean;
  /**
   * PEM certificate authority to verify the server against. Required for Supabase, whose Postgres endpoints chain to
   * a private root that Node's default trust store does not carry — see SUPABASE_ROOT_CA_2021. Omitted means "use the
   * system trust store", which is right for a database fronted by a publicly trusted certificate.
   */
  sslCa?: string;
}

/**
 * TLS parameters in a connection string silently beat the explicit `ssl` option.
 *
 * pg builds its config as `Object.assign({}, config, parse(connectionString))` (pg 8.23,
 * lib/connection-parameters.js), so anything the URL says wins. A `sslmode=require` therefore discards the pinned
 * `ca` below and, because pg-connection-string treats `require` as an alias for `verify-full`, the connection then
 * fails against any private CA — the exact opposite of what whoever wrote `require` intended.
 *
 * The sslmode has already been read by then (databaseSslDefault decides `ssl` from it), so dropping it here loses no
 * information and leaves one place deciding TLS.
 */
function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    let touched = false;
    for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        touched = true;
      }
    }
    return touched ? url.toString() : connectionString;
  } catch {
    return connectionString; // not URL-shaped (a key=value DSN); leave it for pg to interpret
  }
}

/**
 * Creates a Kysely instance backed by a pg Pool. Use one per process; never share across tenants
 * without going through withContext() (RLS impersonation).
 */
export function createDatabase(opts: CreateDbOptions): { db: Database; pool: pg.Pool } {
  // int8 (bigint) as string is Kysely's default expectation (Int8 = ColumnType<string,...>); numeric stays string.
  const pool = new pg.Pool({
    connectionString: stripSslParams(opts.connectionString),
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'flowza',
    // rejectUnauthorized stays true in every branch: a `ca` narrows what is trusted, it never disables the check.
    ssl: opts.ssl ? { rejectUnauthorized: true, ...(opts.sslCa ? { ca: opts.sslCa } : {}) } : undefined,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
  });
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
  return { db, pool };
}

export async function pingDatabase(db: Database): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await sql`select 1`.execute(db);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    // Carry the reason. A bare `ok: false` says the database is unreachable but not whether that is a TLS failure, a
    // rejected password or a routing problem — three very different fixes, and the difference is the whole diagnosis.
    // Driver codes (SELF_SIGNED_CERT_IN_CHAIN, ECONNREFUSED, 28P01) and messages carry no credentials or SQL.
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, latencyMs: Date.now() - started, error: code ? `${code}: ${message}` : message };
  }
}

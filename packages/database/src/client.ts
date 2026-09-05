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
}

/**
 * Creates a Kysely instance backed by a pg Pool. Use one per process; never share across tenants
 * without going through withContext() (RLS impersonation).
 */
export function createDatabase(opts: CreateDbOptions): { db: Database; pool: pg.Pool } {
  // int8 (bigint) as string is Kysely's default expectation (Int8 = ColumnType<string,...>); numeric stays string.
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'flowza',
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
  });
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
  return { db, pool };
}

export async function pingDatabase(db: Database): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await sql`select 1`.execute(db);
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

/**
 * Applies supabase/migrations to a PostgreSQL database (used for local development, tests and CI).
 * For hosted Supabase projects use `supabase db push`; this tool exists so tests can run on plain Postgres.
 *   DATABASE_URL_ADMIN=postgres://postgres@127.0.0.1:54329/flowza pnpm --filter @flowza/database migrate:local
 * Options: --shim (apply the local Supabase shim first), --reset (drop & recreate the database)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../../../');
export const migrationsDir = path.join(repoRoot, 'supabase/migrations');
export const shimFile = path.join(repoRoot, 'supabase/tests/00_local_supabase_shim.sql');

export async function applyMigrations(connectionString: string, opts: { shim?: boolean; reset?: boolean; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  if (opts.reset) {
    const url = new URL(connectionString);
    const dbName = url.pathname.replace(/^\//, '');
    url.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    log(`recreated database ${dbName}`);
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (opts.shim) {
      await client.query(readFileSync(shimFile, 'utf8'));
      log('applied local Supabase shim');
    }
    await client.query(`create schema if not exists app; create table if not exists app.migrations (name text primary key, applied_at timestamptz not null default now())`);
    const applied = new Set((await client.query<{ name: string }>('select name from app.migrations')).rows.map((r) => r.name));
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(body);
        await client.query('insert into app.migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (opts.shim) {
      // local passwords for the application roles (local development only); serialised because concurrent test files
      // altering the same role raise "tuple concurrently updated"
      await client.query('select pg_advisory_lock(424242)');
      try {
        await client.query(`alter role flowza_api password 'flowza_api'`);
        await client.query(`alter role flowza_worker password 'flowza_worker'`);
      } finally {
        await client.query('select pg_advisory_unlock(424242)');
      }
    }
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const url = process.env.DATABASE_URL_ADMIN ?? 'postgres://postgres@127.0.0.1:54329/flowza';
  const shim = process.argv.includes('--shim') || process.argv.includes('--local');
  const reset = process.argv.includes('--reset');
  applyMigrations(url, { shim, reset, log: (m) => console.warn(m) }).then(
    () => console.warn('migrations complete'),
    (err) => { console.error(err); process.exit(1); },
  );
}

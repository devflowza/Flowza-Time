import pg from 'pg';
import { applyMigrations } from '../tools/migrate.js';
import { createDatabase, type Database } from '../client.js';

export interface TestDatabase { db: Database; adminDb: Database; workerDb: Database; connectionString: string; close(): Promise<void> }

/**
 * Creates (or resets) an isolated test database on the local Postgres and applies shim + migrations.
 * Returns three clients: admin (superuser, bypasses RLS — fixtures only), api (flowza_api) and worker (flowza_worker).
 */
export async function createTestDatabase(name = `flowza_test_${process.pid}`): Promise<TestDatabase> {
  const base = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
  const url = new URL(base);
  url.pathname = `/${name}`;
  const adminUrl = url.toString();
  await applyMigrations(adminUrl, { shim: true, reset: true });
  const apiUrl = new URL(adminUrl); apiUrl.username = 'flowza_api'; apiUrl.password = 'flowza_api';
  const workerUrl = new URL(adminUrl); workerUrl.username = 'flowza_worker'; workerUrl.password = 'flowza_worker';
  const admin = createDatabase({ connectionString: adminUrl, max: 4, applicationName: 'flowza-test-admin' });
  const api = createDatabase({ connectionString: apiUrl.toString(), max: 4, applicationName: 'flowza-test-api' });
  const worker = createDatabase({ connectionString: workerUrl.toString(), max: 4, applicationName: 'flowza-test-worker' });
  return {
    db: api.db,
    adminDb: admin.db,
    workerDb: worker.db,
    connectionString: adminUrl,
    async close() {
      await Promise.all([api.db.destroy(), worker.db.destroy(), admin.db.destroy()]);
      const client = new pg.Client({ connectionString: base });
      await client.connect();
      // pool.end() resolves when the client sockets are closing, not when the server has processed every Terminate message;
      // `drop ... with (force)` racing that sends a FATAL "terminating connection due to administrator command" to a socket
      // that no longer has an error listener (an unhandled error in vitest). Let the backends leave first (bounded wait).
      for (let i = 0; i < 40; i += 1) {
        const { rows } = await client.query<{ n: string }>('select count(*) as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [name]);
        if (Number(rows[0]?.n ?? 0) === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await client.query(`drop database if exists "${name}" with (force)`);
      await client.end();
    },
  };
}

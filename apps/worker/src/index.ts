import { createLogger, event, sleep } from '@flowza/shared';
import { createDatabase, PgJobQueue, DeviceCredentialsStore, SecretsCipher, SUPABASE_ROOT_CA_2021 } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { loadWorkerConfig, looksLikeTransactionPooler } from './config.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { createMailer, createPlatformClients } from './lib/platform.js';
import { createPdfRenderer } from './lib/pdf.js';
import { buildHandlerRegistry } from './handlers/index.js';
import { scheduledTasks } from './tasks/index.js';
import type { WorkerDeps } from './deps.js';

const config = loadWorkerConfig();
const log = createLogger({ name: 'flowza-worker', level: config.LOG_LEVEL, base: { workerId: config.workerId } });
if (config.SCHEDULER_ENABLED && looksLikeTransactionPooler(config.DATABASE_URL_WORKER)) {
  log.warn(event('worker_pooler_mode_suspect', { port: 6543 }), 'DATABASE_URL_WORKER looks like the transaction pooler (:6543). Scheduler leader election holds a session-level advisory lock and will not survive it — use the session pooler (:5432).');
}
const { db, pool } = createDatabase({
  connectionString: config.DATABASE_URL_WORKER,
  max: config.DATABASE_POOL_MAX,
  applicationName: 'flowza-worker',
  statementTimeoutMs: 120_000,
  ssl: config.databaseSsl,
  sslCa: config.databaseSsl ? (config.DATABASE_SSL_CA ?? SUPABASE_ROOT_CA_2021) : undefined,
});
const platform = createPlatformClients(config, log);

const deps: WorkerDeps = {
  config,
  log,
  db,
  queue: new PgJobQueue(db),
  credentials: new DeviceCredentialsStore(new SecretsCipher(config.FLOWZA_CREDENTIALS_MASTER_KEYS)),
  providers: defaultRegistry({ flowzaFinance: { allowPrivateHosts: config.FLOWZA_ALLOW_PRIVATE_EGRESS }, vendorHttp: { allowPrivateHosts: config.FLOWZA_ALLOW_PRIVATE_EGRESS } }),
  realtime: platform.realtime,
  mailer: createMailer(config, log),
  storage: platform.storage,
  pdf: createPdfRenderer(config, log),
  now: () => new Date(),
};

const runner = new Runner(deps, buildHandlerRegistry());
const scheduler = config.SCHEDULER_ENABLED ? new Scheduler(deps, scheduledTasks()) : null;

void runner.start();
if (scheduler) void scheduler.start();

async function shutdown(signal: string) {
  log.info(event('worker_shutdown', { signal }));
  scheduler?.stop();
  await runner.stop(config.WORKER_SHUTDOWN_GRACE_MS);
  // A handler of a job handed back may still hold a connection: do not wait on it past a second.
  const closed = (async () => { await db.destroy().catch(() => undefined); await pool.end().catch(() => undefined); })();
  await Promise.race([closed, sleep(1_000)]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

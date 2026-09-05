import { createLogger, event } from '@flowza/shared';
import { createDatabase, PgJobQueue, DeviceCredentialsStore, SecretsCipher } from '@flowza/database';
import { defaultRegistry } from '@flowza/device-providers';
import { loadWorkerConfig } from './config.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { createMailer, createPlatformClients } from './lib/platform.js';
import { buildHandlerRegistry } from './handlers/index.js';
import { scheduledTasks } from './tasks/index.js';
import type { WorkerDeps } from './deps.js';

const config = loadWorkerConfig();
const log = createLogger({ name: 'flowza-worker', level: config.LOG_LEVEL, base: { workerId: config.workerId } });
const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL_WORKER, max: config.DATABASE_POOL_MAX, applicationName: 'flowza-worker', statementTimeoutMs: 120_000 });
const platform = createPlatformClients(config, log);

const deps: WorkerDeps = {
  config,
  log,
  db,
  queue: new PgJobQueue(db),
  credentials: new DeviceCredentialsStore(new SecretsCipher(config.FLOWZA_CREDENTIALS_MASTER_KEYS)),
  providers: defaultRegistry(),
  realtime: platform.realtime,
  mailer: createMailer(config, log),
  storage: platform.storage,
  now: () => new Date(),
};

const runner = new Runner(deps, buildHandlerRegistry());
const scheduler = config.SCHEDULER_ENABLED ? new Scheduler(deps, scheduledTasks()) : null;

void runner.start();
if (scheduler) void scheduler.start();

async function shutdown(signal: string) {
  log.info(event('worker_shutdown', { signal }));
  scheduler?.stop();
  await runner.stop();
  await db.destroy().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

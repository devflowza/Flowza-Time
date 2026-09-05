import { createTestDatabase, PgJobQueue, DeviceCredentialsStore, SecretsCipher, type TestDatabase } from '@flowza/database';
import { createLogger } from '@flowza/shared';
import type { ProviderRegistry } from '@flowza/device-providers';
import type { WorkerDeps } from '../deps.js';
import type { WorkerConfig } from '../config.js';

export interface TestHarness { tdb: TestDatabase; deps: WorkerDeps; published: Array<{ channel: string; event: string; payload: Record<string, unknown> }>; emails: Array<{ to: string; subject: string }>; close(): Promise<void> }

export async function createHarness(name: string, providers: ProviderRegistry, now = () => new Date()): Promise<TestHarness> {
  const tdb = await createTestDatabase(name);
  const published: TestHarness['published'] = [];
  const emails: TestHarness['emails'] = [];
  const mem = new Map<string, Buffer>();
  const config = { NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL_WORKER: tdb.connectionString, DATABASE_POOL_MAX: 4, FLOWZA_CREDENTIALS_MASTER_KEYS: [{ id: 't', material: Buffer.alloc(32, 7) }], WORKER_CONCURRENCY: 2, WORKER_QUEUES: 'sync,processing,reports,notifications,maintenance', WORKER_PER_ORG_CONCURRENCY: 5, WORKER_POLL_INTERVAL_MS: 50, SCHEDULER_ENABLED: false, SCHEDULER_TICK_MS: 1000, EMAIL_PROVIDER: 'console', EMAIL_FROM: 'test', API_PUBLIC_URL: 'http://api.test', WEB_PUBLIC_URL: 'http://web.test', workerId: 'test-worker', queues: ['sync', 'processing', 'reports', 'notifications', 'maintenance'] } as unknown as WorkerConfig;
  const deps: WorkerDeps = {
    config,
    log: createLogger({ name: 'worker-test', level: 'silent' }),
    db: tdb.workerDb,
    queue: new PgJobQueue(tdb.workerDb),
    credentials: new DeviceCredentialsStore(new SecretsCipher(config.FLOWZA_CREDENTIALS_MASTER_KEYS)),
    providers,
    realtime: { async publish(channel, event, payload) { published.push({ channel, event, payload }); } },
    mailer: { async send(msg) { emails.push({ to: msg.to, subject: msg.subject }); return { id: 'm1', provider: 'test' }; } },
    storage: {
      async upload(bucket, path, body) { mem.set(`${bucket}/${path}`, body); return { path, size: body.length }; },
      async download(bucket, path) { const b = mem.get(`${bucket}/${path}`); if (!b) throw new Error('not found'); return b; },
      async remove(bucket, paths) { for (const p of paths) mem.delete(`${bucket}/${p}`); },
    },
    now,
  };
  return { tdb, deps, published, emails, close: () => tdb.close() };
}

export function fakeJob(jobType: string, payload: Record<string, unknown> = {}, organizationId: string | null = null) {
  return { id: '1', queueName: 'maintenance', jobType, organizationId, payload, priority: 5, attempts: 1, maxAttempts: 3, correlationId: null, lockedBy: 'test', runAt: new Date() };
}

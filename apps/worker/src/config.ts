import { z } from 'zod';
import { booleanFromEnv, databaseSslDefault, intFromEnv, loadEnv, masterKeysSchema } from '@flowza/shared';
import { QUEUE_NAMES, type QueueName } from '@flowza/contracts';
import { hostname } from 'node:os';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  DATABASE_URL_WORKER: z.string().min(1),
  DATABASE_POOL_MAX: intFromEnv(10),
  // See the API's DATABASE_SSL / DATABASE_SSL_CA — same rules, same reasons.
  DATABASE_SSL: booleanFromEnv.optional(),
  DATABASE_SSL_CA: z.string().optional(),
  FLOWZA_CREDENTIALS_MASTER_KEYS: masterKeysSchema,
  WORKER_ID: z.string().optional(),
  WORKER_CONCURRENCY: intFromEnv(8),
  WORKER_QUEUES: z.string().default(QUEUE_NAMES.join(',')),
  WORKER_PER_ORG_CONCURRENCY: intFromEnv(5),
  WORKER_POLL_INTERVAL_MS: intFromEnv(1000),
  SCHEDULER_ENABLED: booleanFromEnv.default(true),
  SCHEDULER_TICK_MS: intFromEnv(15_000),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('FlowZa Time <no-reply@flowza.example>'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().default('http://localhost:5173'),
});

export type WorkerConfig = z.infer<typeof schema> & { workerId: string; queues: QueueName[]; databaseSsl: boolean };

/**
 * True when the URL looks like a Supavisor **transaction** pooler (port 6543).
 *
 * The scheduler elects a leader with a session-level advisory lock; transaction pooling hands the connection to
 * another transaction and the lock silently goes away, so two workers can both believe they are leader. The worker
 * needs the session pooler (5432). Reported as a warning, not a throw — an unusual topology should not block boot.
 */
export function looksLikeTransactionPooler(connectionString: string): boolean {
  try {
    return new URL(connectionString).port === '6543';
  } catch {
    return false;
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = loadEnv(schema, env);
  const queues = parsed.WORKER_QUEUES.split(',').map((s) => s.trim()).filter((q): q is QueueName => (QUEUE_NAMES as readonly string[]).includes(q));
  return {
    ...parsed,
    workerId: parsed.WORKER_ID ?? `${hostname()}-${process.pid}`,
    queues,
    databaseSsl: parsed.DATABASE_SSL ?? databaseSslDefault(parsed.DATABASE_URL_WORKER),
  };
}

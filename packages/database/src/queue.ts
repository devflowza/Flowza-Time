import { sql } from 'kysely';
import type { QueueName } from '@flowza/contracts';
import type { Database } from './client.js';
import type { Trx } from './context.js';

export interface EnqueueOptions {
  queue: QueueName;
  jobType: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
  priority?: number; // 0..9, higher first
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
  lockTimeoutSeconds?: number;
  correlationId?: string;
}

export interface QueuedJob {
  id: string; // bigint as string
  queueName: string;
  jobType: string;
  organizationId: string | null;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
  maxAttempts: number;
  correlationId: string | null;
  lockedBy: string | null;
  runAt: Date;
}

export interface QueueStats { queueName: string; status: string; count: number; oldestRunAt: Date | null }

/** Port used by services and the worker (ADR-006). The Postgres implementation is the default. */
export interface JobQueue {
  enqueue(opts: EnqueueOptions, trx?: Trx): Promise<string>;
  dequeue(workerId: string, queues: QueueName[], limit: number, perOrgCap: number): Promise<QueuedJob[]>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, errorCode: string, error: string, retryAfterSeconds?: number | null): Promise<'pending' | 'dead' | null>;
  cancel(jobId: string): Promise<boolean>;
  reapStale(limit?: number): Promise<number>;
  stats(): Promise<QueueStats[]>;
}

// NOTE: the CamelCasePlugin also camel-cases result columns of raw sql queries.
type Row = {
  id: string; queueName: string; jobType: string; organizationId: string | null; payload: unknown;
  priority: number; attempts: number; maxAttempts: number; correlationId: string | null; lockedBy: string | null; runAt: Date;
};

function mapRow(r: Row): QueuedJob {
  return {
    id: String(r.id), queueName: r.queueName, jobType: r.jobType, organizationId: r.organizationId,
    payload: (r.payload ?? {}) as Record<string, unknown>, priority: r.priority, attempts: r.attempts,
    maxAttempts: r.maxAttempts, correlationId: r.correlationId, lockedBy: r.lockedBy, runAt: new Date(r.runAt),
  };
}

export class PgJobQueue implements JobQueue {
  constructor(private readonly db: Database) {}

  async enqueue(opts: EnqueueOptions, trx?: Trx): Promise<string> {
    const executor = trx ?? this.db;
    // app.enqueue_job is SECURITY DEFINER and works in user, system, platform and login-role contexts (membership-checked for users).
    const res = await sql<{ id: string }>`select app.enqueue_job(
      ${opts.queue}, ${opts.jobType}, ${opts.organizationId}::uuid, ${JSON.stringify(opts.payload)}::jsonb,
      ${opts.priority ?? 5}, ${opts.runAt ?? new Date()}, ${opts.dedupeKey ?? null},
      ${opts.maxAttempts ?? 6}, ${opts.lockTimeoutSeconds ?? 600}, ${opts.correlationId ?? null}
    ) as id`.execute(executor);
    return String(res.rows[0]!.id);
  }

  async dequeue(workerId: string, queues: QueueName[], limit: number, perOrgCap: number): Promise<QueuedJob[]> {
    const res = await sql<Row>`select * from jobs.dequeue(${workerId}, ${sql.val(queues)}::text[], ${limit}, ${perOrgCap})`.execute(this.db);
    return res.rows.map(mapRow);
  }

  async complete(jobId: string): Promise<void> {
    await sql`select jobs.complete(${jobId}::bigint)`.execute(this.db);
  }

  async fail(jobId: string, errorCode: string, error: string, retryAfterSeconds: number | null = null): Promise<'pending' | 'dead' | null> {
    const res = await sql<{ outcome: 'pending' | 'dead' | null }>`select jobs.fail(${jobId}::bigint, ${errorCode}, ${error}, ${retryAfterSeconds}) as outcome`.execute(this.db);
    return res.rows[0]?.outcome ?? null;
  }

  async cancel(jobId: string): Promise<boolean> {
    const res = await sql<{ ok: boolean }>`select jobs.cancel(${jobId}::bigint) as ok`.execute(this.db);
    return res.rows[0]?.ok ?? false;
  }

  async reapStale(limit = 100): Promise<number> {
    const res = await sql<{ n: number }>`select jobs.reap_stale(${limit}) as n`.execute(this.db);
    return res.rows[0]?.n ?? 0;
  }

  async stats(): Promise<QueueStats[]> {
    const res = await sql<{ queueName: string; status: string; count: string; oldestRunAt: Date | null }>`select * from jobs.stats()`.execute(this.db);
    return res.rows.map((r) => ({ queueName: r.queueName, status: r.status, count: Number(r.count), oldestRunAt: r.oldestRunAt }));
  }
}

/** Fail-with-dead-letter sentinel: pass as retryAfterSeconds to jobs.fail to dead-letter immediately. */
export const DEAD_LETTER_NOW = -1;

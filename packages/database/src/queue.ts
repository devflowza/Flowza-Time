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

/** A running job as the worker that dequeued it holds it: the job id and the attempt its lock belongs to. */
export interface JobLease { id: string; attempts: number }

/** Port used by services and the worker (ADR-006). The Postgres implementation is the default. */
export interface JobQueue {
  enqueue(opts: EnqueueOptions, trx?: Trx): Promise<string>;
  dequeue(workerId: string, queues: QueueName[], limit: number, perOrgCap: number): Promise<QueuedJob[]>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, errorCode: string, error: string, retryAfterSeconds?: number | null): Promise<'pending' | 'dead' | null>;
  /** Extends the locks of the running jobs this worker still owns (same attempt); returns the ids it still owns. */
  heartbeat(workerId: string, leases: JobLease[]): Promise<Set<string>>;
  /** Completes a job only while this worker still owns it (same attempt); false when its lock was lost. */
  completeOwned(jobId: string, workerId: string, attempt: number): Promise<boolean>;
  /** Fails a job only while this worker still owns it (same attempt); null when its lock was lost. */
  failOwned(jobId: string, workerId: string, attempt: number, errorCode: string, error: string, retryAfterSeconds?: number | null): Promise<'pending' | 'dead' | null>;
  /** A worker shutting down hands back a job it still owns (same attempt): pending again at once, no attempt spent. */
  releaseOwned(jobId: string, workerId: string, attempt: number): Promise<boolean>;
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

  async heartbeat(workerId: string, leases: JobLease[]): Promise<Set<string>> {
    if (leases.length === 0) return new Set();
    const res = await sql<{ id: string }>`select h.id from jobs.heartbeat(${workerId}, ${sql.val(leases.map((l) => l.id))}::bigint[], ${sql.val(leases.map((l) => l.attempts))}::int[]) as h(id)`.execute(this.db);
    return new Set(res.rows.map((r) => String(r.id)));
  }

  async completeOwned(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    try {
      const res = await sql<{ ok: boolean }>`select jobs.complete_owned(${jobId}::bigint, ${workerId}, ${attempt}::int) as ok`.execute(this.db);
      return res.rows[0]?.ok ?? false;
    } catch (err) {
      // A worker released before migration 20260929000600 is applied completes as the previous release did.
      if (!isUndefinedFunction(err)) throw err;
      await this.complete(jobId);
      return true;
    }
  }

  async failOwned(jobId: string, workerId: string, attempt: number, errorCode: string, error: string, retryAfterSeconds: number | null = null): Promise<'pending' | 'dead' | null> {
    try {
      const res = await sql<{ outcome: 'pending' | 'dead' | null }>`select jobs.fail_owned(${jobId}::bigint, ${workerId}, ${attempt}::int, ${errorCode}, ${error}, ${retryAfterSeconds}::int) as outcome`.execute(this.db);
      return res.rows[0]?.outcome ?? null;
    } catch (err) {
      if (!isUndefinedFunction(err)) throw err;
      return this.fail(jobId, errorCode, error, retryAfterSeconds);
    }
  }

  async releaseOwned(jobId: string, workerId: string, attempt: number): Promise<boolean> {
    try {
      const res = await sql<{ ok: boolean }>`select jobs.release_owned(${jobId}::bigint, ${workerId}, ${attempt}::int) as ok`.execute(this.db);
      return res.rows[0]?.ok ?? false;
    } catch (err) {
      // Without migration 20260929000600 a job cannot be handed back: its lock times out and it is reaped, as before.
      if (!isUndefinedFunction(err)) throw err;
      return false;
    }
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

/** Postgres `undefined_function`: the database has not been migrated to the functions this release calls yet. */
function isUndefinedFunction(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42883';
}

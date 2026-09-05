import { AppError, event, sleep } from '@flowza/shared';
import { ProviderError } from '@flowza/device-providers';
import { DEAD_LETTER_NOW } from '@flowza/database';
import type { WorkerDeps } from './deps.js';
import type { HandlerRegistry } from './handlers/types.js';

/**
 * Queue consumer loop: dequeues up to `concurrency` jobs across the configured queues with per-organisation fairness
 * (jobs.dequeue), runs handlers with a timeout, and completes/fails jobs. One process may run several runners.
 */
export class Runner {
  private running = 0;
  private stopped = false;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: WorkerDeps, private readonly handlers: HandlerRegistry) {}

  async start(): Promise<void> {
    const { config, log, queue } = this.deps;
    log.info(event('worker_started', { workerId: config.workerId, queues: config.queues, concurrency: config.WORKER_CONCURRENCY }));
    while (!this.stopped) {
      const capacity = config.WORKER_CONCURRENCY - this.running;
      if (capacity <= 0) { await sleep(50); continue; }
      let jobs: Awaited<ReturnType<typeof queue.dequeue>> = [];
      try {
        jobs = await queue.dequeue(config.workerId, config.queues, capacity, config.WORKER_PER_ORG_CONCURRENCY);
      } catch (err) {
        log.error(event('dequeue_failed', { err: (err as Error).message }));
        await sleep(config.WORKER_POLL_INTERVAL_MS * 2);
        continue;
      }
      if (jobs.length === 0) { await sleep(config.WORKER_POLL_INTERVAL_MS); continue; }
      for (const job of jobs) {
        const p = this.execute(job).finally(() => { this.running--; this.inflight.delete(p); });
        this.running++;
        this.inflight.add(p);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inflight]);
  }

  private async execute(job: Awaited<ReturnType<WorkerDeps['queue']['dequeue']>>[number]): Promise<void> {
    const { log: rootLog, queue } = this.deps;
    const log = rootLog.child({ jobId: job.id, jobType: job.jobType, organizationId: job.organizationId, correlationId: job.correlationId, attempt: job.attempts });
    const reg = this.handlers.get(job.jobType);
    if (!reg) {
      log.error(event('job_handler_missing'));
      await queue.fail(job.id, 'NO_HANDLER', `no handler registered for ${job.jobType}`, DEAD_LETTER_NOW);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new AppError('PROVIDER_TIMEOUT', 'job timed out', { retryable: true })), reg.timeoutMs ?? 5 * 60_000);
    const started = Date.now();
    try {
      const result = await reg.handler({ job, log, deps: this.deps, signal: controller.signal });
      await queue.complete(job.id);
      log.info(event('job_completed', { durationMs: Date.now() - started, result: summarize(result) }));
    } catch (err) {
      const { code, message, retryable, retryAfterMs } = classify(err);
      const outcome = await queue.fail(job.id, code, message, retryable ? (retryAfterMs ? Math.ceil(retryAfterMs / 1000) : null) : DEAD_LETTER_NOW);
      (outcome === 'dead' ? log.error.bind(log) : log.warn.bind(log))(event('job_failed', { durationMs: Date.now() - started, code, message, outcome }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function classify(err: unknown): { code: string; message: string; retryable: boolean; retryAfterMs?: number } {
  if (ProviderError.is(err)) return { code: err.code, message: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  if (AppError.is(err)) return { code: err.code, message: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  const e = err as { code?: string; message?: string };
  // transient Postgres / network failures are retryable; everything else retries too but is logged as INTERNAL
  return { code: typeof e?.code === 'string' ? e.code : 'INTERNAL', message: e?.message ?? String(err), retryable: true };
}

function summarize(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  if (typeof result !== 'object') return result;
  const s = JSON.stringify(result);
  return s.length > 500 ? `${s.slice(0, 500)}…` : result;
}

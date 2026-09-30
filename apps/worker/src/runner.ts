import { AppError, event, sleep } from '@flowza/shared';
import { ProviderError } from '@flowza/device-providers';
import { DEAD_LETTER_NOW, type QueuedJob } from '@flowza/database';
import type { WorkerDeps } from './deps.js';
import { lockLostError, type HandlerRegistry } from './handlers/types.js';

/** A job this runner is executing: the attempt its lock belongs to and the controller its handler listens to. */
interface Lease {
  attempts: number;
  controller: AbortController;
  /** A heartbeat found the job is no longer ours; the handler was aborted and the outcome is not recorded. */
  lost: boolean;
  /** The handler returned or threw and the outcome is being recorded; heartbeats leave the job alone from here. */
  settling: boolean;
}

/**
 * Queue consumer loop: dequeues up to `concurrency` jobs across the configured queues with per-organisation fairness
 * (jobs.dequeue), runs handlers with a timeout, and completes/fails jobs. One process may run several runners.
 *
 * A running job's lock is extended every WORKER_HEARTBEAT_INTERVAL_MS (jobs.heartbeat), so jobs.reap_stale only takes back
 * jobs whose worker is gone, however long a handler runs. The outcome is recorded with jobs.complete_owned /
 * jobs.fail_owned, which act only while this worker still holds the same attempt: a job that was reaped while it ran
 * belongs to its next attempt, and this execution must neither complete nor fail it.
 */
export class Runner {
  private running = 0;
  private stopped = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly leases = new Map<string, Lease>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight: Promise<void> | null = null;

  constructor(private readonly deps: WorkerDeps, private readonly handlers: HandlerRegistry) {}

  async start(): Promise<void> {
    const { config, log, queue } = this.deps;
    log.info(event('worker_started', { workerId: config.workerId, queues: config.queues, concurrency: config.WORKER_CONCURRENCY }));
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, config.WORKER_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    while (!this.stopped) {
      const capacity = config.WORKER_CONCURRENCY - this.running;
      if (capacity <= 0) { await sleep(50); continue; }
      let jobs: QueuedJob[] = [];
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

  /**
   * Stops taking jobs. Without a grace period, waits for every running job. With one, the jobs still running when it ends
   * are handed back to the queue (jobs.release_owned: pending at once, no attempt spent) and their handlers aborted, so a
   * deploy does not leave a long job locked until its lock times out. Heartbeats continue until then.
   */
  async stop(graceMs?: number): Promise<void> {
    this.stopped = true;
    const drained = Promise.allSettled([...this.inflight]).then(() => true);
    let finished = true;
    if (graceMs === undefined) await drained;
    else {
      const grace = new AbortController();
      finished = await Promise.race([drained, sleep(graceMs, grace.signal).then(() => false, () => true)]);
      grace.abort();
    }
    if (!finished) await this.releaseRunning();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.heartbeatInFlight;
  }

  private async releaseRunning(): Promise<void> {
    const { config, log, queue } = this.deps;
    const running = [...this.leases].filter(([, l]) => !l.lost && !l.settling);
    await Promise.all(running.map(async ([id, lease]) => {
      lease.lost = true; // from here nothing this execution does is recorded
      lease.controller.abort(lockLostError(id, 'released'));
      const released = await this.settle(log, () => queue.releaseOwned(id, config.workerId, lease.attempts));
      log.info(event('job_released', { jobId: id, attempt: lease.attempts, released: released === true }));
    }));
  }

  /**
   * Extends the locks of the jobs this runner is executing and aborts any it no longer owns. Runs on the runner's own timer;
   * public so tests can drive it. Overlapping calls share the beat in progress instead of stacking queries.
   */
  heartbeat(): Promise<void> {
    if (!this.heartbeatInFlight) this.heartbeatInFlight = this.beat().finally(() => { this.heartbeatInFlight = null; });
    return this.heartbeatInFlight;
  }

  private async beat(): Promise<void> {
    const { config, log, queue } = this.deps;
    const leases = [...this.leases].filter(([, l]) => !l.lost && !l.settling).map(([id, l]) => ({ id, attempts: l.attempts }));
    if (leases.length === 0) return;
    let owned: Set<string>;
    try {
      owned = await queue.heartbeat(config.workerId, leases);
    } catch (err) {
      // Nothing is aborted on a failed heartbeat: the locks are simply not extended this round (a job is taken back only
      // once its whole lock timeout passes without one) and the next beat tries again.
      log.warn(event('job_heartbeat_failed', { jobs: leases.length, err: (err as Error).message }));
      return;
    }
    for (const { id, attempts } of leases) {
      if (owned.has(id)) continue;
      const lease = this.leases.get(id);
      // A job that finished while the beat was in flight is missing for that reason, not because its lock was lost.
      if (!lease || lease.attempts !== attempts || lease.lost || lease.settling) continue;
      lease.lost = true;
      log.warn(event('job_lock_lost', { jobId: id, attempt: attempts }));
      lease.controller.abort(lockLostError(id));
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    const { config, log: rootLog, queue } = this.deps;
    const log = rootLog.child({ jobId: job.id, jobType: job.jobType, organizationId: job.organizationId, correlationId: job.correlationId, attempt: job.attempts });
    const reg = this.handlers.get(job.jobType);
    if (!reg) {
      // A job type this build does not know was almost always enqueued by a NEWER API or worker (one app redeployed before the
      // other — how every "Send now" of a report died on 2026-09-29: the reports worker predated RUN_REPORT_SCHEDULE). Killing it
      // loses the user's request for good; putting it back lets a current worker take it, or this one once it is redeployed. It
      // still dead-letters after the job's max attempts, so a type nobody knows cannot circulate for ever.
      log.error(event('job_handler_missing', { queue: job.queueName, retryInSeconds: UNKNOWN_JOB_RETRY_SECONDS }), `no handler for ${job.jobType} in this build — released for a newer worker`);
      await this.settle(log, () => queue.failOwned(job.id, config.workerId, job.attempts, 'NO_HANDLER', `no handler registered for ${job.jobType} on this worker (an older build?)`, UNKNOWN_JOB_RETRY_SECONDS));
      return;
    }
    const lease: Lease = { attempts: job.attempts, controller: new AbortController(), lost: false, settling: false };
    this.leases.set(job.id, lease);
    const timeout = setTimeout(() => lease.controller.abort(new AppError('PROVIDER_TIMEOUT', 'job timed out', { retryable: true })), reg.timeoutMs ?? 5 * 60_000);
    const started = Date.now();
    try {
      let result: unknown;
      let failure: unknown = null;
      let succeeded = false;
      try {
        result = await reg.handler({ job, log, deps: this.deps, signal: lease.controller.signal });
        succeeded = true;
      } catch (err) {
        failure = err;
      }
      lease.settling = true;
      const durationMs = Date.now() - started;
      if (lease.lost) {
        // Another attempt owns the job now: completing or failing it here would end or reschedule that attempt's job.
        log.warn(event('job_abandoned', { durationMs, succeeded }));
        return;
      }
      if (succeeded) {
        const completed = await this.settle(log, () => queue.completeOwned(job.id, config.workerId, job.attempts));
        if (completed === true) log.info(event('job_completed', { durationMs, result: summarize(result) }));
        else if (completed === false) log.warn(event('job_lock_lost', { phase: 'complete', durationMs }));
        return;
      }
      const { code, message, retryable, retryAfterMs } = classify(failure);
      const retryAfterSeconds = retryable ? (retryAfterMs ? Math.ceil(retryAfterMs / 1000) : null) : DEAD_LETTER_NOW;
      const outcome = await this.settle(log, () => queue.failOwned(job.id, config.workerId, job.attempts, code, message, retryAfterSeconds));
      if (outcome === undefined) return;
      if (outcome === null) log.warn(event('job_lock_lost', { phase: 'fail', durationMs, code, message }));
      else (outcome === 'dead' ? log.error.bind(log) : log.warn.bind(log))(event('job_failed', { durationMs, code, message, outcome }));
    } finally {
      clearTimeout(timeout);
      // An abandoned execution that outlived its lock must not drop the lease of the attempt that replaced it here.
      if (this.leases.get(job.id) === lease) this.leases.delete(job.id);
    }
  }

  /**
   * Records a job's outcome. A failure to reach the queue is logged instead of thrown: the job keeps its lock without
   * heartbeats, so jobs.reap_stale hands it to another attempt once the lock times out (at least once), and one lost
   * connection does not take the whole process and every other job it is running down with it.
   */
  private async settle<T>(log: WorkerDeps['log'], record: () => Promise<T>): Promise<T | undefined> {
    try {
      return await record();
    } catch (err) {
      log.error(event('job_settle_failed', { err: (err as Error).message }));
      return undefined;
    }
  }
}

/** How long a job whose type this worker does not know waits before any worker may try it again. */
export const UNKNOWN_JOB_RETRY_SECONDS = 600;

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

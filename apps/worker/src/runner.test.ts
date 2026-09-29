import { describe, expect, it } from 'vitest';
import type { JobLease, JobQueue, QueuedJob } from '@flowza/database';
import type { Logger } from '@flowza/shared';
import type { WorkerDeps } from './deps.js';
import { Runner } from './runner.js';
import { HandlerRegistry, isLockLost, type JobHandler } from './handlers/types.js';

interface Deferred<T = void> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function until(pred: () => boolean, what = 'condition', timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function job(id: string, attempts = 1, jobType = 'TEST'): QueuedJob {
  return { id, queueName: 'maintenance', jobType, organizationId: null, payload: {}, priority: 5, attempts, maxAttempts: 3, correlationId: null, lockedBy: 'w1', runAt: new Date() };
}

/** In-memory queue: it knows which attempt of each job is the running one, the way jobs.queue does. */
function fakeQueue() {
  const pending: QueuedJob[] = [];
  const current = new Map<string, number>();
  const calls = {
    heartbeats: [] as JobLease[][],
    completed: [] as Array<{ id: string; attempt: number }>,
    failed: [] as Array<{ id: string; attempt: number; code: string; retryAfterSeconds: number | null | undefined }>,
    released: [] as Array<{ id: string; attempt: number }>,
  };
  const faults = { heartbeat: null as Error | null, complete: null as Error | null, heartbeatGate: null as Promise<void> | null, completeGate: null as Promise<void> | null };
  const queue: JobQueue = {
    async enqueue() { return '0'; },
    async dequeue(_worker, _queues, limit) {
      const out = pending.splice(0, limit);
      for (const j of out) current.set(j.id, j.attempts);
      return out;
    },
    async complete() { throw new Error('the runner must complete through completeOwned'); },
    async fail() { throw new Error('the runner must fail through failOwned'); },
    async heartbeat(_worker, leases) {
      calls.heartbeats.push(leases);
      if (faults.heartbeat) { const e = faults.heartbeat; faults.heartbeat = null; throw e; }
      if (faults.heartbeatGate) await faults.heartbeatGate;
      return new Set(leases.filter((l) => current.get(l.id) === l.attempts).map((l) => l.id));
    },
    async completeOwned(id, _worker, attempt) {
      if (faults.complete) { const e = faults.complete; faults.complete = null; throw e; }
      if (current.get(id) !== attempt) return false;
      current.delete(id);
      calls.completed.push({ id, attempt });
      if (faults.completeGate) await faults.completeGate;
      return true;
    },
    async failOwned(id, _worker, attempt, code, _error, retryAfterSeconds) {
      if (current.get(id) !== attempt) return null;
      current.delete(id);
      calls.failed.push({ id, attempt, code, retryAfterSeconds });
      return 'pending';
    },
    async releaseOwned(id, _worker, attempt) {
      if (current.get(id) !== attempt) return false;
      current.delete(id);
      calls.released.push({ id, attempt });
      return true;
    },
    async cancel() { return false; },
    async reapStale() { return 0; },
    async stats() { return []; },
  };
  return {
    queue, calls, faults,
    push: (j: QueuedJob) => { pending.push(j); },
    /** jobs.reap_stale took the job back: the attempt that was running is no longer the job's. */
    reap: (id: string) => { current.delete(id); },
  };
}

function recordingLogger() {
  const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const at = (level: string) => (obj: Record<string, unknown>) => { events.push({ level, event: String(obj['event']), fields: { ...bindings, ...obj } }); };
    return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug'), child: (b: Record<string, unknown>) => make({ ...bindings, ...b }) } as unknown as Logger;
  };
  return { log: make({}), events, has: (name: string) => events.some((e) => e.event === name) };
}

function setup(handler: JobHandler, heartbeatIntervalMs = 60_000) {
  const q = fakeQueue();
  const logger = recordingLogger();
  const deps = {
    config: { workerId: 'w1', queues: ['maintenance'], WORKER_CONCURRENCY: 2, WORKER_PER_ORG_CONCURRENCY: 5, WORKER_POLL_INTERVAL_MS: 5, WORKER_HEARTBEAT_INTERVAL_MS: heartbeatIntervalMs },
    log: logger.log,
    queue: q.queue,
    now: () => new Date(),
  } as unknown as WorkerDeps;
  const runner = new Runner(deps, new HandlerRegistry().register({ jobType: 'TEST', handler }));
  const loop = runner.start();
  return { q, logger, runner, shutdown: async () => { await runner.stop(); await loop; } };
}

describe('Runner job locks', () => {
  it('extends the lock of a running job and completes it as the owner of that attempt', async () => {
    const started = deferred();
    const release = deferred();
    const { q, logger, runner, shutdown } = setup(async () => { started.resolve(); await release.promise; return { ok: true }; });
    q.push(job('1'));
    await started.promise;
    await runner.heartbeat();
    expect(q.calls.heartbeats).toEqual([[{ id: '1', attempts: 1 }]]);
    release.resolve();
    await until(() => q.calls.completed.length === 1, 'completion');
    expect(q.calls.completed).toEqual([{ id: '1', attempt: 1 }]);
    expect(logger.has('job_completed')).toBe(true);
    // nothing left to extend once the job is done
    await runner.heartbeat();
    expect(q.calls.heartbeats).toHaveLength(1);
    await shutdown();
  });

  it('heartbeats on its own timer', async () => {
    const started = deferred();
    const release = deferred();
    const { q, shutdown } = setup(async () => { started.resolve(); await release.promise; }, 10);
    q.push(job('2'));
    await started.promise;
    await until(() => q.calls.heartbeats.length >= 2, 'timer heartbeats');
    release.resolve();
    await until(() => q.calls.completed.length === 1, 'completion');
    await shutdown();
  });

  it('aborts a job whose lock was lost, and records no outcome for it', async () => {
    const started = deferred();
    let sawLockLost: boolean | null = null;
    const { q, logger, runner, shutdown } = setup(async ({ signal }) => {
      started.resolve();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      sawLockLost = isLockLost(signal);
      throw signal.reason;
    });
    q.push(job('3'));
    await started.promise;
    q.reap('3');
    await runner.heartbeat();
    await until(() => logger.has('job_abandoned'), 'abandonment');
    expect(sawLockLost).toBe(true);
    expect(logger.events.find((e) => e.event === 'job_lock_lost')?.fields).toMatchObject({ jobId: '3', attempt: 1 });
    expect(q.calls.completed).toEqual([]);
    expect(q.calls.failed).toEqual([]);
    await shutdown();
  });

  it('a failed heartbeat aborts nothing; the next one extends the lock again', async () => {
    const started = deferred();
    const release = deferred();
    let signal: AbortSignal | null = null;
    const { q, logger, runner, shutdown } = setup(async (ctx) => { signal = ctx.signal; started.resolve(); await release.promise; });
    q.push(job('4'));
    await started.promise;
    q.faults.heartbeat = new Error('connection reset by peer');
    await runner.heartbeat();
    expect(logger.has('job_heartbeat_failed')).toBe(true);
    expect(signal!.aborted).toBe(false);
    await runner.heartbeat();
    expect(q.calls.heartbeats).toHaveLength(2);
    expect(signal!.aborted).toBe(false);
    release.resolve();
    await until(() => q.calls.completed.length === 1, 'completion');
    expect(logger.has('job_lock_lost')).toBe(false);
    await shutdown();
  });

  it('does not report a job that finished during a heartbeat as lost', async () => {
    const started = deferred();
    const release = deferred();
    const heartbeatGate = deferred();
    const completeGate = deferred();
    let signal: AbortSignal | null = null;
    const { q, logger, runner, shutdown } = setup(async (ctx) => { signal = ctx.signal; started.resolve(); await release.promise; });
    q.push(job('5'));
    await started.promise;
    q.faults.heartbeatGate = heartbeatGate.promise;
    q.faults.completeGate = completeGate.promise;
    const beat = runner.heartbeat();
    await until(() => q.calls.heartbeats.length === 1, 'heartbeat sent');
    // the job completes (its row leaves the queue) while the heartbeat is in flight, and the heartbeat answers first
    release.resolve();
    await until(() => q.calls.completed.length === 1, 'completion recorded');
    heartbeatGate.resolve();
    await beat;
    completeGate.resolve();
    await until(() => logger.has('job_completed'), 'completion logged');
    expect(logger.has('job_lock_lost')).toBe(false);
    expect(signal!.aborted).toBe(false);
    await shutdown();
  });

  it('an execution that outlived its lock does not drop the lease of the attempt that replaced it', async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    const { q, logger, runner, shutdown } = setup(async ({ job: j }) => {
      if (j.attempts === 1) { firstStarted.resolve(); await releaseFirst.promise; return 'first (ignores its signal)'; }
      secondStarted.resolve();
      await releaseSecond.promise;
      return 'second';
    });
    q.push(job('6', 1));
    await firstStarted.promise;
    q.reap('6');
    await runner.heartbeat();
    q.push(job('6', 2));
    await secondStarted.promise;
    releaseFirst.resolve();
    await until(() => logger.has('job_abandoned'), 'first attempt abandoned');
    await runner.heartbeat();
    expect(q.calls.heartbeats.at(-1)).toEqual([{ id: '6', attempts: 2 }]);
    releaseSecond.resolve();
    await until(() => q.calls.completed.length === 1, 'completion');
    expect(q.calls.completed).toEqual([{ id: '6', attempt: 2 }]);
    await shutdown();
  });

  it('keeps extending locks while stopping, until the running jobs finish', async () => {
    const started = deferred();
    const release = deferred();
    const { q, runner } = setup(async () => { started.resolve(); await release.promise; }, 10);
    q.push(job('7'));
    await started.promise;
    const stopping = runner.stop();
    const before = q.calls.heartbeats.length;
    await until(() => q.calls.heartbeats.length >= before + 2, 'heartbeats during shutdown');
    release.resolve();
    await stopping;
    expect(q.calls.completed).toEqual([{ id: '7', attempt: 1 }]);
  });

  it('at shutdown, hands a job it cannot finish within the grace period back to the queue and records nothing for it', async () => {
    const started = deferred();
    const finish = deferred();
    let signal: AbortSignal | null = null;
    const { q, logger, runner } = setup(async (ctx) => { signal = ctx.signal; started.resolve(); await finish.promise; return 'too late'; });
    q.push(job('12', 4));
    await started.promise;
    await runner.stop(20);
    expect(q.calls.released).toEqual([{ id: '12', attempt: 4 }]);
    expect(isLockLost(signal!)).toBe(true);
    expect((signal!.reason as { details?: Record<string, unknown> }).details).toMatchObject({ cause: 'released', jobId: '12' });
    expect(logger.events.find((e) => e.event === 'job_released')?.fields).toMatchObject({ jobId: '12', attempt: 4, released: true });
    // the handler ignored its signal and finishes later: its outcome belongs to the next attempt, not to this one
    finish.resolve();
    await until(() => logger.has('job_abandoned'), 'abandonment');
    expect(q.calls.completed).toEqual([]);
    expect(q.calls.failed).toEqual([]);
  });

  it('at shutdown, completes a job that finishes within the grace period instead of handing it back', async () => {
    const started = deferred();
    const finish = deferred();
    const { q, runner } = setup(async () => { started.resolve(); await finish.promise; });
    q.push(job('13'));
    await started.promise;
    const stopping = runner.stop(5_000);
    finish.resolve();
    await stopping;
    expect(q.calls.completed).toEqual([{ id: '13', attempt: 1 }]);
    expect(q.calls.released).toEqual([]);
  });

  it('dead-letters a job without a handler as its owner', async () => {
    const { q, logger, shutdown } = setup(async () => undefined);
    q.push(job('8', 1, 'NO_SUCH_JOB'));
    await until(() => q.calls.failed.length === 1, 'dead-letter');
    expect(q.calls.failed).toEqual([{ id: '8', attempt: 1, code: 'NO_HANDLER', retryAfterSeconds: -1 }]);
    expect(logger.has('job_handler_missing')).toBe(true);
    await shutdown();
  });

  it('logs a queue error while recording an outcome instead of throwing, and keeps running', async () => {
    const { q, logger, shutdown } = setup(async () => 'done');
    q.faults.complete = new Error('connection terminated unexpectedly');
    q.push(job('9'));
    await until(() => logger.has('job_settle_failed'), 'settle failure logged');
    q.push(job('10'));
    await until(() => q.calls.completed.length === 1, 'next job completed');
    expect(q.calls.completed).toEqual([{ id: '10', attempt: 1 }]);
    await shutdown();
  });

  it('records a handler failure through failOwned with the retry decision', async () => {
    const { q, shutdown } = setup(async () => { throw new Error('transient'); });
    q.push(job('11'));
    await until(() => q.calls.failed.length === 1, 'failure recorded');
    expect(q.calls.failed).toEqual([{ id: '11', attempt: 1, code: 'INTERNAL', retryAfterSeconds: null }]);
    await shutdown();
  });
});

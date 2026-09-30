import type { QueuedJob } from '@flowza/database';
import { AppError, type Logger } from '@flowza/shared';
import type { WorkerDeps } from '../deps.js';

export interface JobContext { job: QueuedJob; log: Logger; deps: WorkerDeps; signal: AbortSignal }

/** `details.reason` of the abort a handler receives when this worker no longer owns its job. */
export const LOCK_LOST = 'LOCK_LOST';

/**
 * The runner aborts a job's signal with this error once the job is no longer this worker's: a heartbeat found its lock was
 * taken back (`reaped`: the job went back to the queue or was dead-lettered, or it finished elsewhere), or the worker is
 * shutting down and handed it back to the queue (`released`). The runner then neither completes nor fails the job, so the
 * error is only ever seen by the handler.
 */
export function lockLostError(jobId: string, cause: 'reaped' | 'released' = 'reaped'): AppError {
  const message = cause === 'released' ? 'The worker is shutting down and handed the job back to the queue.' : 'This worker no longer holds the job lock.';
  return new AppError('CONFLICT', message, { retryable: false, details: { reason: LOCK_LOST, cause, jobId } });
}

/**
 * True once this worker no longer holds the job (see lockLostError). A long handler checks this between units of work and
 * stops without recording progress or an outcome of its own: another attempt owns the job now, or will shortly, and
 * anything written after this point races that attempt.
 */
export function isLockLost(signal: AbortSignal): boolean {
  return signal.aborted && AppError.is(signal.reason) && signal.reason.details?.['reason'] === LOCK_LOST;
}

/**
 * A handler processes one job type. Throwing an AppError/ProviderError with `retryable=false` dead-letters the job;
 * any other error retries with exponential backoff (jobs.fail). Return value is logged.
 */
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface HandlerRegistration { jobType: string; handler: JobHandler; timeoutMs?: number }

export class HandlerRegistry {
  private readonly handlers = new Map<string, HandlerRegistration>();
  register(reg: HandlerRegistration): this {
    if (this.handlers.has(reg.jobType)) throw new Error(`duplicate handler for ${reg.jobType}`);
    this.handlers.set(reg.jobType, reg);
    return this;
  }
  get(jobType: string): HandlerRegistration | undefined { return this.handlers.get(jobType); }
  types(): string[] { return [...this.handlers.keys()]; }
}

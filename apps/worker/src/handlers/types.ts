import type { QueuedJob } from '@flowza/database';
import type { Logger } from '@flowza/shared';
import type { WorkerDeps } from '../deps.js';

export interface JobContext { job: QueuedJob; log: Logger; deps: WorkerDeps; signal: AbortSignal }

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

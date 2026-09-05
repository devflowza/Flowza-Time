import type { EnqueueOptions, JobQueue, Trx } from '@flowza/database';

/**
 * Enqueue a job inside the caller's transaction (same commit as the state change, AGENTS.md rule 5).
 *
 * `PgJobQueue.enqueue` calls `app.enqueue_job(...)` (SECURITY DEFINER, migration 2100), which is executable by the
 * `authenticated` role and verifies that a user may only enqueue for organisations they belong to. No role switching
 * happens in the API process: the RLS role and claims of the transaction stay exactly as `withContext` set them.
 */
export async function enqueueJob(queue: JobQueue, trx: Trx, opts: EnqueueOptions): Promise<string> {
  return queue.enqueue(opts, trx);
}

import { sql } from 'kysely';
import { event, sleep } from '@flowza/shared';
import type { WorkerDeps } from './deps.js';

export interface ScheduledTask { name: string; everyMs: number; run: (deps: WorkerDeps) => Promise<unknown>; lastRun?: number }

/**
 * Leader-elected scheduler (§F.3). Exactly one worker process holds the advisory lock and enqueues due work
 * (attendance polls, health checks, reconciliation, outbox relay, retention, partition maintenance, stale-lock reaping).
 * Tasks only ENQUEUE jobs; heavy work always happens in queue handlers so a slow tick never blocks the loop.
 */
export class Scheduler {
  private stopped = false;
  private static readonly LOCK_KEY = 7_242_026; // arbitrary constant shared by all workers

  constructor(private readonly deps: WorkerDeps, private readonly tasks: ScheduledTask[]) {}

  async start(): Promise<void> {
    const { config, log, db } = this.deps;
    while (!this.stopped) {
      // a dedicated connection holds the session-level advisory lock while we are leader
      const leader = await db.connection().execute(async (conn) => {
        const got = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${Scheduler.LOCK_KEY}) as locked`.execute(conn);
        if (!got.rows[0]?.locked) return false;
        log.info(event('scheduler_leader_acquired', { workerId: config.workerId }));
        try {
          while (!this.stopped) {
            const now = Date.now();
            for (const task of this.tasks) {
              if (task.lastRun && now - task.lastRun < task.everyMs) continue;
              task.lastRun = now;
              try {
                const res = await task.run(this.deps);
                log.debug(event('scheduler_task_ran', { task: task.name, result: res ?? null }));
              } catch (err) {
                log.error(event('scheduler_task_failed', { task: task.name, err: (err as Error).message }));
              }
            }
            await sleep(config.SCHEDULER_TICK_MS);
            // keep the lock alive / detect connection loss
            await sql`select 1`.execute(conn);
          }
        } finally {
          await sql`select pg_advisory_unlock(${Scheduler.LOCK_KEY})`.execute(conn).catch(() => undefined);
          log.info(event('scheduler_leader_released', { workerId: config.workerId }));
        }
        return true;
      }).catch((err: Error) => { log.warn(event('scheduler_connection_lost', { err: err.message })); return false; });
      if (!leader && !this.stopped) await sleep(config.SCHEDULER_TICK_MS * 2); // standby: retry the lock later
    }
  }

  stop(): void { this.stopped = true; }
}

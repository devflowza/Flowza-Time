import { sql } from 'kysely';
import type { EnqueueOptions, JobQueue, Trx } from '@flowza/database';

/**
 * Enqueue a job inside the caller's transaction (same commit as the state change, AGENTS.md rule 5).
 *
 * The `jobs` schema is not executable by the `authenticated` role (only the login roles flowza_api/flowza_worker
 * and flowza_system may touch the queue), so a user-context transaction switches back to the connection's login
 * role for the single `jobs.enqueue` call and immediately restores the RLS role. `request.jwt.claims` is a
 * transaction-local setting and survives the switch, so RLS for the rest of the transaction is unaffected.
 * A SECURITY DEFINER wrapper (`app.enqueue_job`) would make this unnecessary; see docs/api.md.
 */
export async function enqueueJob(queue: JobQueue, trx: Trx, opts: EnqueueOptions): Promise<string> {
  const { rows } = await sql<{ currentUser: string; sessionUser: string }>`select current_user as current_user, session_user as session_user`.execute(trx);
  const current = rows[0]?.currentUser;
  const login = rows[0]?.sessionUser;
  const mustSwitch = current !== undefined && login !== undefined && current !== login && current === 'authenticated';
  if (mustSwitch) await sql`set local role ${sql.raw(quoteIdent(login))}`.execute(trx);
  try {
    return await queue.enqueue(opts, trx);
  } finally {
    if (mustSwitch && current) await sql`set local role ${sql.raw(quoteIdent(current))}`.execute(trx);
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unexpected role name ${name}`);
  return `"${name}"`;
}

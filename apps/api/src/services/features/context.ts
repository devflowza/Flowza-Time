import { sql } from 'kysely';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`unexpected role name ${name}`);
  return `"${name}"`;
}

/**
 * Run `fn` as the platform acting for exactly one organisation *inside the caller's transaction* (same commit as the
 * user-context writes). Used for steps a user is explicitly allowed to trigger (service-level permission check done
 * first) but whose rows are owned by the system: device commands, approval requests created by a requester without
 * `attendance.approve`, recalculation requests, raw re-queues. Role + `request.jwt.claims` are restored afterwards, so
 * RLS for the rest of the transaction is unaffected.
 */
export async function systemStep<T>(trx: Trx, organizationId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  const { rows } = await sql<{ role: string; claims: string | null; user: string }>`select current_setting('role', true) as role, current_setting('request.jwt.claims', true) as claims, current_user as user`.execute(trx);
  const prev = rows[0];
  if (!prev) throw errors.internal('cannot read transaction context');
  const prevRole = prev.role && prev.role !== 'none' ? prev.role : prev.user;
  await sql`set local role flowza_system`.execute(trx);
  await sql`select set_config('request.jwt.claims', ${JSON.stringify({ role: 'flowza_system', org_id: organizationId })}, true)`.execute(trx);
  const restore = async () => {
    await sql`set local role ${sql.raw(quoteIdent(prevRole))}`.execute(trx);
    await sql`select set_config('request.jwt.claims', ${prev.claims ?? ''}, true)`.execute(trx);
  };
  let result: T;
  try {
    result = await fn(trx);
  } catch (err) {
    // the transaction is aborted after a failed statement: the restore would fail with "current transaction is aborted" and
    // MASK the real cause (a mapped constraint violation would surface as a 500). The caller rolls back anyway.
    await restore().catch(() => undefined);
    throw err;
  }
  await restore();
  return result;
}

/**
 * Switch to the connection's login role (flowza_api / flowza_worker) for direct `jobs.*` access — the `authenticated`
 * role cannot execute the queue functions. Mirrors lib/jobs.ts but for arbitrary statements (bulk enqueue, cancel).
 */
export async function withQueueRole<T>(trx: Trx, fn: (trx: Trx) => Promise<T>): Promise<T> {
  const { rows } = await sql<{ currentUser: string; sessionUser: string }>`select current_user as current_user, session_user as session_user`.execute(trx);
  const current = rows[0]?.currentUser;
  const login = rows[0]?.sessionUser;
  const mustSwitch = current !== undefined && login !== undefined && current !== login && current === 'authenticated';
  if (mustSwitch) await sql`set local role ${sql.raw(quoteIdent(login))}`.execute(trx);
  try {
    return await fn(trx);
  } finally {
    if (mustSwitch && current) await sql`set local role ${sql.raw(quoteIdent(current))}`.execute(trx);
  }
}

/** Cancel a queue job from inside a transaction (jobs.cancel only touches pending rows). */
export async function cancelQueueJob(trx: Trx, queueJobId: string): Promise<boolean> {
  return withQueueRole(trx, async (t) => {
    const res = await sql<{ ok: boolean }>`select jobs.cancel(${queueJobId}::bigint) as ok`.execute(t);
    return res.rows[0]?.ok ?? false;
  });
}

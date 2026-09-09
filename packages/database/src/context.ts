import { sql, type Transaction } from 'kysely';
import type { DB } from './generated/db.js';
import type { Database } from './client.js';

/**
 * Execution context = who the database should treat the current unit of work as (ADR-002).
 *  - user:   an authenticated person; RLS applies via memberships/roles/branch scope.
 *  - system: the platform acting for exactly one organisation (worker job, webhook, device push).
 *  - platform: cross-tenant maintenance under the same DB role, allowed only on an explicit table whitelist.
 * There is deliberately no "bypass" context: application code never runs unscoped.
 */
export type ExecutionContext =
  | { kind: 'user'; userId: string; email?: string; requestId?: string }
  | { kind: 'system'; organizationId: string; requestId?: string; jobId?: string }
  /** Cross-tenant maintenance (outbox relay, metering, partitions, scheduler scans). Whitelisted tables only — see migration 2000. */
  | { kind: 'platform'; jobId?: string; requestId?: string };

export type Trx = Transaction<DB>;

function claimsFor(ctx: ExecutionContext): Record<string, string> {
  switch (ctx.kind) {
    case 'user': return { sub: ctx.userId, role: 'authenticated', ...(ctx.email ? { email: ctx.email } : {}) };
    case 'system': return { role: 'flowza_system', org_id: ctx.organizationId };
    case 'platform': return { role: 'flowza_system', scope: 'platform' };
  }
}

/**
 * Apply the context to the current transaction: the role, the JWT claims and the request id. One statement, not three:
 * `role` is an ordinary GUC, so `set_config('role', …, true)` is exactly SET LOCAL ROLE, and every statement here is a
 * round trip between the API's region and the database's.
 */
export async function applyContext(trx: Trx, ctx: ExecutionContext): Promise<void> {
  const role = ctx.kind === 'user' ? 'authenticated' : 'flowza_system';
  const claims = JSON.stringify(claimsFor(ctx));
  if (ctx.requestId) {
    await sql`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${claims}, true), set_config('flowza.request_id', ${ctx.requestId}, true)`.execute(trx);
  } else {
    await sql`select set_config('role', ${role}, true), set_config('request.jwt.claims', ${claims}, true)`.execute(trx);
  }
}

/**
 * Runs `fn` inside a transaction whose Postgres role and JWT claims match the context, so every
 * statement is filtered by RLS exactly as Supabase would filter it for that principal.
 */
export async function withContext<T>(db: Database, ctx: ExecutionContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await applyContext(trx, ctx);
    return fn(trx);
  });
}

/** Read-only variant (sets the transaction read only — protects against accidental writes in queries). */
export async function withReadContext<T>(db: Database, ctx: ExecutionContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`set transaction read only`.execute(trx);
    await applyContext(trx, ctx);
    return fn(trx);
  });
}

/** Allow recomputation inside a locked period (only the recalculation/unlock jobs use this). */
export async function bypassPeriodLock(trx: Trx): Promise<void> {
  await sql`select set_config('flowza.bypass_period_lock', 'on', true)`.execute(trx);
}

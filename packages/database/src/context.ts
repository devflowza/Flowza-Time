import { sql, type Transaction } from 'kysely';
import type { DB } from './generated/db.js';
import type { Database } from './client.js';

/**
 * Execution context = who the database should treat the current unit of work as (ADR-002).
 *  - user:   an authenticated person; RLS applies via memberships/roles/branch scope.
 *  - system: the platform acting for exactly one organisation (worker job, webhook, device push).
 * There is deliberately no "bypass" context: application code never runs unscoped.
 */
export type ExecutionContext =
  | { kind: 'user'; userId: string; email?: string; requestId?: string }
  | { kind: 'system'; organizationId: string; requestId?: string; jobId?: string };

export type Trx = Transaction<DB>;

function claimsFor(ctx: ExecutionContext): Record<string, string> {
  return ctx.kind === 'user'
    ? { sub: ctx.userId, role: 'authenticated', ...(ctx.email ? { email: ctx.email } : {}) }
    : { role: 'flowza_system', org_id: ctx.organizationId };
}

/** Apply the context to the current transaction (SET LOCAL ROLE + request.jwt.claims). */
export async function applyContext(trx: Trx, ctx: ExecutionContext): Promise<void> {
  if (ctx.kind === 'user') {
    await sql`set local role authenticated`.execute(trx);
  } else {
    await sql`set local role flowza_system`.execute(trx);
  }
  await sql`select set_config('request.jwt.claims', ${JSON.stringify(claimsFor(ctx))}, true)`.execute(trx);
  if (ctx.requestId) {
    await sql`select set_config('flowza.request_id', ${ctx.requestId}, true)`.execute(trx);
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

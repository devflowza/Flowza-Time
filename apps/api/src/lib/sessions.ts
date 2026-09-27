import { sql } from 'kysely';
import type { Trx } from '@flowza/database';
import type { ApiDeps, SessionRevocation, SessionRevocationResult, SessionRevoker } from '../deps.js';
import { withSystemScope } from './service.js';

/**
 * Database-backed session revocation (AGENTS.md: suspension / role downgrade → revoke the user's sessions).
 *
 * Supabase Auth has no admin endpoint that signs a user out by id — `auth.admin.signOut` needs that user's own access
 * token, and banning is global (it would also lock the person out of their other organisations). So the revocation is
 * the statement Auth's own global sign-out runs: the user's rows in `auth.sessions` are deleted (their refresh tokens go
 * with them), through `app.revoke_user_sessions` (migration 20260928000150), which only the organisation's system
 * context may call and which only touches users holding a membership of that organisation. Access tokens already issued
 * stay valid until they expire (≤ 1 h), but they open nothing: every API request and every RLS predicate re-reads the
 * memberships, so the suspended organisation is closed the moment the transaction commits.
 *
 * It runs inside the caller's transaction, so a rolled-back suspension never ends anybody's session.
 */
export const databaseSessionRevoker: SessionRevoker = {
  async revokeUserSessions(trx: Trx, input: SessionRevocation): Promise<SessionRevocationResult> {
    const userIds = [...new Set(input.userIds)];
    if (userIds.length === 0) return { revoked: 0, available: true };
    const n = await withSystemScope(trx, input.organizationId, async (t) => {
      const { rows } = await sql<{ n: number }>`select app.revoke_user_sessions(${userIds}::uuid[]) as n`.execute(t);
      return Number(rows[0]?.n ?? 0);
    });
    return n < 0 ? { revoked: 0, available: false } : { revoked: n, available: true };
  },
};

/**
 * Ends the sessions of `userIds` with the injected revoker (tests) or the database-backed one, and logs the outcome.
 * Returns the number of sessions ended (0 when the auth schema is unreachable — logged as a warning, never an error:
 * the membership change already closed the organisation).
 */
export async function revokeSessions(deps: ApiDeps, trx: Trx, input: SessionRevocation): Promise<number> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return 0;
  const revoker = deps.sessions ?? databaseSessionRevoker;
  const result = await revoker.revokeUserSessions(trx, { ...input, userIds });
  const fields = { organizationId: input.organizationId, requestId: input.requestId, reason: input.reason, users: userIds.length };
  if (result.available) deps.log.info({ event: 'sessions_revoked', ...fields, sessions: result.revoked });
  else deps.log.warn({ event: 'session_revocation_unavailable', ...fields });
  return result.revoked;
}

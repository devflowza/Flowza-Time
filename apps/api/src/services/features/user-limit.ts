import { sql } from 'kysely';
import { USER_LIMIT_SOURCES, toUserLimit, type UserLimitDto, type UserLimitSource } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import { withSystemScope } from '../../lib/service.js';
import { toCount } from '../../lib/pagination.js';

/*
 * The tenant's user limit: licensed users (active employees) against the cap a platform admin sets (`subscriptions.seats`,
 * else the plan's employee limit, unless an entitlement overrides it). The rule lives once, in SQL — `app.org_user_limits`
 * (migration 20261001000300) — and this module is its only reader.
 */

const sourceOf = (s: string | null): UserLimitSource | null => ((USER_LIMIT_SOURCES as readonly string[]).includes(s ?? '') ? s as UserLimitSource : null);

/**
 * User limits of several organisations in one call. The caller must be a platform admin (any organisation) or the system
 * context of the one organisation asked for; the function silently drops the others.
 */
export async function readUserLimits(trx: Trx, orgIds: string[]): Promise<Map<string, UserLimitDto>> {
  if (orgIds.length === 0) return new Map();
  const { rows } = await sql<{ organizationId: string; used: string | number; userLimit: number | null; limitSource: string | null }>`
    select organization_id as "organizationId", used, user_limit as "userLimit", limit_source as "limitSource" from app.org_user_limits(${orgIds}::uuid[])`.execute(trx);
  return new Map(rows.map((r) => [r.organizationId, toUserLimit(toCount(r.used), r.userLimit, sourceOf(r.limitSource))]));
}

/** One organisation's user limit, read in its system scope: the count covers every branch whatever the caller's scope. */
export async function userLimitOf(trx: Trx, orgId: string): Promise<UserLimitDto> {
  const limits = await withSystemScope(trx, orgId, (t) => readUserLimits(t, [orgId]));
  return limits.get(orgId) ?? toUserLimit(0, null, null);
}

/**
 * Refuse with 402 ENTITLEMENT_EXCEEDED (`details.reason = USER_LIMIT_REACHED`) when `adding` more active employees would take
 * the organisation past its user limit. Serialised per organisation with a transaction-level advisory lock, so two concurrent
 * additions cannot both take the last user: call it in the transaction that writes, before the write.
 */
export async function assertUserCapacity(trx: Trx, orgId: string, adding = 1): Promise<UserLimitDto> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`flowza:user-limit:${orgId}`}, 0))`.execute(trx);
  const current = await userLimitOf(trx, orgId);
  if (adding > 0 && current.limit !== null && current.used + adding > current.limit) throw errors.userLimit(current.limit, current.used, adding);
  return current;
}

import type { Trx } from '@flowza/database';
import { errors } from '@flowza/shared';
import { jsonObject, numberOrNull } from '../../lib/mappers.js';

/**
 * Effective limit for an organisation: an active `entitlements` override wins, otherwise the subscription's plan limit,
 * otherwise null (no limit configured). Runs in the caller's context (plans/subscriptions/entitlements are member-readable).
 */
export async function resolveLimit(trx: Trx, organizationId: string, key: string): Promise<number | null> {
  const override = await trx.selectFrom('entitlements').select(['limitValue', 'enabled'])
    .where('organizationId', '=', organizationId).where('key', '=', key)
    .where('effectiveFrom', '<=', new Date()).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', new Date())]))
    .orderBy('effectiveFrom', 'desc').executeTakeFirst();
  if (override) {
    if (!override.enabled) return 0;
    return numberOrNull(override.limitValue);
  }
  const sub = await trx.selectFrom('subscriptions as s').innerJoin('plans as p', 'p.id', 's.planId').select('p.limits')
    .where('s.organizationId', '=', organizationId).where('s.status', 'in', ['trialing', 'active', 'past_due']).orderBy('s.createdAt', 'desc').executeTakeFirst();
  if (!sub) return null;
  return numberOrNull(jsonObject(sub.limits)[key] as string | number | null | undefined);
}

export async function assertWithinLimit(trx: Trx, organizationId: string, key: string, currentCount: number): Promise<void> {
  const limit = await resolveLimit(trx, organizationId, key);
  if (limit !== null && currentCount >= limit) throw errors.entitlement(key, limit);
}

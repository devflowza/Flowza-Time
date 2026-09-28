import { sql } from 'kysely';
import type { Trx } from '@flowza/database';
import { AppError } from '@flowza/shared';

/**
 * Count one use of `metric` in the organisation's current hourly window (`usage_quotas`, written in the organisation's
 * system scope by the caller) and refuse with RATE_LIMITED past `limit` — the per-organisation export quota of AGENTS.md.
 */
export async function consumeHourlyQuota(trx: Trx, orgId: string, metric: string, limit: number): Promise<void> {
  const windowSeconds = 3600;
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await sql<{ count: number }>`
    insert into public.usage_quotas (organization_id, metric, window_start, window_seconds, count) values (${orgId}::uuid, ${metric}, ${windowStart}, ${windowSeconds}, 1)
    on conflict (organization_id, metric, window_start) do update set count = public.usage_quotas.count + 1 returning count`.execute(trx);
  const count = res.rows[0]?.count ?? 1;
  if (count > limit) throw new AppError('RATE_LIMITED', `At most ${limit} ${metric.replace(/_/g, ' ')} per hour per organisation.`, { details: { metric, limit }, retryAfterMs: windowStart.getTime() + windowSeconds * 1000 - Date.now() });
}

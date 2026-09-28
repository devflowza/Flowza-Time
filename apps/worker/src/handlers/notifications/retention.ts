import { sql } from 'kysely';
import { event } from '@flowza/shared';
import { withContext } from '@flowza/database';
import type { WorkerDeps } from '../../deps.js';
import type { JobContext } from '../types.js';

/**
 * Notification housekeeping (HR portal Prompt 8), daily, platform context:
 *  - `domain_events`: PUBLISHED events older than RETENTION_EVENTS_DAYS. An unpublished event is never deleted (it is either
 *    still to be relayed or a dead letter someone has to look at).
 *  - `notifications`: READ notifications older than RETENTION_READ_NOTIFICATIONS_DAYS (an unread notice stays until it is
 *    read). An organisation with its own enabled `notifications` retention policy is left to that policy (the per-
 *    organisation RETENTION job, floor 30 days), which may keep them longer or shorter.
 *  - `notification_deliveries`: settled (sent / failed / skipped) e-mail deliveries older than RETENTION_DELIVERIES_DAYS;
 *    pending ones are still being worked on.
 * Organisations under legal hold are skipped entirely. Deletes run in batches (RETENTION_BATCH_SIZE rows, each batch its own
 * short transaction, per organisation on its (organization_id, time) index). Every organisation — and the bucket of rows
 * without one — gets its first batch of each class in EVERY run (review 8-P1-1: a shared cap consumed by one probe per empty
 * organisation starved the organisations after the 200th, and the organisation-less bucket, forever); only the further
 * batches of an organisation that still has more to purge count against RETENTION_MAX_BATCHES, taken round-robin so no
 * organisation waits behind a bigger one. A capped class simply continues the next day. One log line and one platform audit
 * row per run record what was purged; `batches` counts the batches that deleted something.
 */
export const NOTIFICATION_RETENTION_JOB_TYPE = 'NOTIFICATION_RETENTION';
export const RETENTION_EVENTS_DAYS = 90;
export const RETENTION_READ_NOTIFICATIONS_DAYS = 180;
export const RETENTION_DELIVERIES_DAYS = 90;
export const RETENTION_BATCH_SIZE = 5_000;
export const RETENTION_MAX_BATCHES = 200;

export interface NotificationRetentionSummary {
  domainEvents: number; notifications: number; deliveries: number;
  batches: number; organizations: number; heldOrganizations: number; policyOrganizations: number; capped: string[];
}

type Purge = (orgId: string | null, cutoff: Date, limit: number) => ReturnType<typeof sql>;
/** Each purge deletes at most `limit` rows of one organisation (or of no organisation) and reports how many it deleted. */
const PURGES: Record<'domainEvents' | 'notifications' | 'deliveries', Purge> = {
  domainEvents: (orgId, cutoff, limit) => sql`delete from public.domain_events where id in (
    select id from public.domain_events where ${orgId === null ? sql`organization_id is null` : sql`organization_id = ${orgId}::uuid`}
      and occurred_at < ${cutoff} and published_at is not null limit ${limit})`,
  notifications: (orgId, cutoff, limit) => sql`delete from public.notifications where id in (
    select id from public.notifications where ${orgId === null ? sql`organization_id is null` : sql`organization_id = ${orgId}::uuid`}
      and created_at < ${cutoff} and read_at is not null limit ${limit})`,
  deliveries: (orgId, cutoff, limit) => sql`delete from public.notification_deliveries where id in (
    select id from public.notification_deliveries where ${orgId === null ? sql`organization_id is null` : sql`organization_id = ${orgId}::uuid`}
      and created_at < ${cutoff} and status <> 'pending' limit ${limit})`,
};

export async function runNotificationRetention(deps: WorkerDeps, opts: { batchSize?: number; maxBatches?: number; jobId?: string } = {}): Promise<NotificationRetentionSummary> {
  const now = deps.now();
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? RETENTION_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.floor(opts.maxBatches ?? RETENTION_MAX_BATCHES));
  const ctx = { kind: 'platform' as const, ...(opts.jobId ? { jobId: opts.jobId } : {}) };
  const { orgs, withPolicy } = await withContext(deps.db, ctx, async (trx) => ({
    orgs: await trx.selectFrom('organizations').select(['id', 'legalHold']).orderBy('id').execute(),
    withPolicy: new Set((await trx.selectFrom('dataRetentionPolicies').select('organizationId').where('dataClass', '=', 'notifications').where('enabled', '=', true).execute()).map((p) => p.organizationId)),
  }));
  const eligible: Array<string | null> = [...orgs.filter((o) => !o.legalHold).map((o) => o.id), null];
  const summary: NotificationRetentionSummary = { domainEvents: 0, notifications: 0, deliveries: 0, batches: 0, organizations: eligible.length - 1, heldOrganizations: orgs.length - (eligible.length - 1), policyOrganizations: withPolicy.size, capped: [] };
  const cutoffs = {
    domainEvents: new Date(now.getTime() - RETENTION_EVENTS_DAYS * 86_400_000),
    notifications: new Date(now.getTime() - RETENTION_READ_NOTIFICATIONS_DAYS * 86_400_000),
    deliveries: new Date(now.getTime() - RETENTION_DELIVERIES_DAYS * 86_400_000),
  };
  for (const cls of ['deliveries', 'notifications', 'domainEvents'] as const) {
    const purge = async (orgId: string | null): Promise<number> => {
      const res = await withContext(deps.db, ctx, (trx) => PURGES[cls](orgId, cutoffs[cls], batchSize).execute(trx));
      const deleted = Number(res.numAffectedRows ?? 0);
      summary[cls] += deleted;
      if (deleted > 0) summary.batches++;
      return deleted;
    };
    // pass 1: one batch for every organisation and for the organisation-less bucket, whatever the cap
    let more: Array<string | null> = [];
    for (const orgId of eligible) {
      if (cls === 'notifications' && orgId !== null && withPolicy.has(orgId)) continue;
      if (await purge(orgId) >= batchSize) more.push(orgId);
    }
    // then round-robin over the ones with more to purge, up to the cap of further batches
    let extra = 0;
    while (more.length > 0 && extra < maxBatches) {
      const next: Array<string | null> = [];
      for (const orgId of more) {
        if (extra >= maxBatches) { next.push(orgId); continue; }
        extra++;
        if (await purge(orgId) >= batchSize) next.push(orgId);
      }
      more = next;
    }
    if (more.length > 0) summary.capped.push(cls);
  }
  await withContext(deps.db, ctx, (trx) => trx.insertInto('audit.logs').values({
    organizationId: null, actorUserId: null, actorType: 'SYSTEM', action: 'notifications.retention_applied', entityType: 'platform', entityId: null,
    newValue: JSON.stringify({ ...summary, cutoffs: Object.fromEntries(Object.entries(cutoffs).map(([k, v]) => [k, v.toISOString()])) }), jobId: opts.jobId ?? null,
  }).execute());
  return summary;
}

/** NOTIFICATION_RETENTION handler (payload `{ batchSize?, maxBatches? }` for tests and manual runs). */
export async function notificationRetentionHandler({ deps, log, job }: JobContext) {
  const res = await runNotificationRetention(deps, {
    ...(typeof job.payload['batchSize'] === 'number' ? { batchSize: job.payload['batchSize'] } : {}),
    ...(typeof job.payload['maxBatches'] === 'number' ? { maxBatches: job.payload['maxBatches'] } : {}),
    jobId: job.id,
  });
  log.info(event('notification_retention', { ...res }));
  return res;
}

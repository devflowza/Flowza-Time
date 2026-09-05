import { withContext } from '@flowza/database';
import type { ScheduledTask } from '../scheduler.js';

/** Platform-wide maintenance ticks: each only ENQUEUES an idempotent job (dedupe_key) on the maintenance queue. */
export const maintenanceTasks: ScheduledTask[] = [
  { name: 'relay-outbox', everyMs: 5_000, run: (d) => d.queue.enqueue({ queue: 'notifications', jobType: 'RELAY_OUTBOX', organizationId: null, payload: { batchSize: 200 }, priority: 7, dedupeKey: 'relay-outbox', lockTimeoutSeconds: 120, maxAttempts: 1 }) },
  { name: 'deliver-notifications', everyMs: 15_000, run: (d) => d.queue.enqueue({ queue: 'notifications', jobType: 'DELIVER_NOTIFICATIONS', organizationId: null, payload: { batchSize: 100 }, priority: 5, dedupeKey: 'deliver-notifications', lockTimeoutSeconds: 120, maxAttempts: 1 }) },
  { name: 'reap-stale', everyMs: 60_000, run: (d) => d.queue.enqueue({ queue: 'maintenance', jobType: 'REAP_STALE', organizationId: null, payload: {}, priority: 9, dedupeKey: 'reap-stale', lockTimeoutSeconds: 30, maxAttempts: 1 }) },
  { name: 'ensure-partitions', everyMs: 6 * 3_600_000, run: (d) => d.queue.enqueue({ queue: 'maintenance', jobType: 'ENSURE_PARTITIONS', organizationId: null, payload: {}, priority: 3, dedupeKey: 'ensure-partitions', lockTimeoutSeconds: 120, maxAttempts: 3 }) },
  { name: 'prune-queue-archive', everyMs: 24 * 3_600_000, run: (d) => d.queue.enqueue({ queue: 'maintenance', jobType: 'PRUNE_QUEUE_ARCHIVE', organizationId: null, payload: {}, priority: 1, dedupeKey: 'prune-queue-archive', lockTimeoutSeconds: 300, maxAttempts: 1 }) },
  { name: 'usage-metering', everyMs: 3_600_000, run: (d) => d.queue.enqueue({ queue: 'maintenance', jobType: 'USAGE_METERING', organizationId: null, payload: {}, priority: 1, dedupeKey: 'usage-metering', lockTimeoutSeconds: 600, maxAttempts: 1 }) },
  {
    name: 'retention',
    everyMs: 24 * 3_600_000,
    run: async (d) => {
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select('id').where('legalHold', '=', false).execute());
      for (const o of orgs) await d.queue.enqueue({ queue: 'maintenance', jobType: 'RETENTION', organizationId: o.id, payload: { organizationId: o.id }, priority: 1, dedupeKey: `retention:${o.id}`, lockTimeoutSeconds: 600, maxAttempts: 2 });
      return { organizations: orgs.length };
    },
  },
];

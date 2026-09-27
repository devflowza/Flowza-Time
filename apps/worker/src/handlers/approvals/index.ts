import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import type { ScheduledTask } from '../../scheduler.js';

export { registerApprovalHandlers, runApprovalReminders, approvalRemindersHandler, APPROVAL_REMINDER_AFTER_HOURS, APPROVAL_DIGEST_LOCAL_HOUR, type ApprovalRemindersResult } from './reminders.js';

/**
 * approvals.reminders — hourly: a platform scan for organisations with pending approval requests (select only, on the
 * whitelisted approval tables), then one deduped APPROVAL_REMINDERS job per organisation. The sweep itself (escalation,
 * 24-hour reminders, the 08:00 digest) runs in that organisation's system context.
 */
export const approvalTasks: ScheduledTask[] = [
  {
    name: 'approvals.reminders',
    everyMs: 3_600_000,
    run: async (d) => {
      const orgs = await withContext(d.db, { kind: 'platform' }, (trx) =>
        sql<{ organizationId: string }>`select distinct organization_id as "organizationId" from public.approval_requests where status = 'PENDING'`.execute(trx));
      for (const o of orgs.rows) {
        await d.queue.enqueue({ queue: 'notifications', jobType: 'APPROVAL_REMINDERS', organizationId: o.organizationId, payload: { organizationId: o.organizationId }, priority: 4, dedupeKey: `approval-reminders:${o.organizationId}`, lockTimeoutSeconds: 120, maxAttempts: 2 });
      }
      return { organizations: orgs.rows.length };
    },
  },
];

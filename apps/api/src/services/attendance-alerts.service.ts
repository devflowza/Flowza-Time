import { resolveNotificationSettings } from '@flowza/contracts';
import { ATTENDANCE_APPRECIATION_JOB_TYPE, appreciationNowDedupeKey } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { enqueueJob } from '../lib/jobs.js';
import { loadSettings } from '../lib/settings.js';
import { type Actor, audit, runUser, withSystemScope } from '../lib/service.js';

/**
 * POST /orgs/:orgId/notifications/appreciation/send — Settings → Notifications → Weekly appreciation, "Send now for last
 * week" (notification.manage). Queues the worker's ATTENDANCE_APPRECIATION job for this organisation (`force`: now, whatever
 * the configured weekday and hour) in the same transaction as the audit row, and answers with the QUEUE job id (AGENTS rule
 * 5; there is no sync page for it). Still once per employee and week: the worker skips everybody already thanked for an
 * overlapping seven days. Refused while the appreciation is switched off (it would mail nobody).
 */
export async function queueAppreciationNow(deps: ApiDeps, actor: Actor, orgId: string): Promise<{ jobId: string; status: 'QUEUED' }> {
  requirePermission(actor.principal, orgId, 'notification.manage');
  return runUser(deps.db, actor, async (trx) => {
    const settings = await withSystemScope(trx, orgId, async (t) => resolveNotificationSettings((await loadSettings(t, orgId)).notifications));
    if (!settings.appreciation.enabled) throw errors.invalidState('Switch weekly appreciation messages on (and save) before sending them.', { reason: 'APPRECIATION_DISABLED' });
    const jobId = await enqueueJob(deps.queue, trx, {
      queue: 'notifications', jobType: ATTENDANCE_APPRECIATION_JOB_TYPE, organizationId: orgId, payload: { organizationId: orgId, force: true, requestedBy: actor.userId },
      priority: 3, dedupeKey: appreciationNowDedupeKey(orgId), maxAttempts: 1, lockTimeoutSeconds: 1_800, correlationId: actor.requestId,
    });
    await audit(trx, actor, orgId, 'notification.appreciation_requested', 'organization_settings', { entityId: `${orgId}:notifications`, newValue: { jobId } });
    return { jobId, status: 'QUEUED' as const };
  });
}

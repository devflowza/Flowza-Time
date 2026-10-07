import { DateTime } from 'luxon';
import { z } from 'zod';
import { BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, branchDeploymentCleanupDedupeKey, cleanupBranchDeployment, deploymentsDueForCleanup, withContext, writeAudit } from '@flowza/database';
import { AppError, event, isValidTimezone } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { ScheduledTask } from '../../scheduler.js';
import type { HandlerRegistry, JobContext } from '../types.js';

/*
 * Temporary branch deployments (Enterprise, docs/enterprise/plan.md §4.7): the daily ACCESS-REMOVAL sweep.
 *
 *   branch-deployments.cleanup   hourly tick; an organisation is enqueued while its local clock is in
 *                                DEPLOYMENT_CLEANUP_LOCAL_HOUR (just after local midnight, when yesterday's deployments
 *                                have ended), ONE job per organisation and local date (the queue dedupes pending jobs
 *                                only, so the key carries the date). A missed hour is caught up the next day: the sweep
 *                                takes every deployment that is due, not only yesterday's.
 *   BRANCH_DEPLOYMENT_CLEANUP    in the organisation's system context: every deployment that ended before today (org
 *                                timezone, not cancelled) or was cancelled after enrolling, and is not cleaned up yet, gets
 *                                ONE sync job of DELETE_EMPLOYEE items for the host branch's terminals on which the
 *                                employee is still wanted (packages/database cleanupBranchDeployment: not when the host is
 *                                now their own branch or the host of another deployment that has not ended); `cleanup_job_id`
 *                                and `cleaned_up_at` are stamped; each is audited as SYSTEM.
 *
 * NOT gated by the `advanced_scheduling` module: this is a security measure (access removal), so switching the module off
 * never leaves a deployed employee on another branch's terminals. Each deployment is cleaned in its own transaction; a
 * failure is logged and the job fails at the end so the queue retries (the others are already stamped and skipped).
 */

/** Local hour (organisation timezone) in which the daily sweep is enqueued. */
export const DEPLOYMENT_CLEANUP_LOCAL_HOUR = 0;
/** Deployments read per batch, and the batches one run works through at most (a larger backlog continues the next day). */
export const DEPLOYMENT_CLEANUP_BATCH = 500;
export const DEPLOYMENT_CLEANUP_MAX_ROUNDS = 20;

export const deploymentCleanupPayloadSchema = z.object({ organizationId: z.guid(), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export interface DeploymentCleanupSummary { organizationId: string; today: string; due: number; cleanedUp: number; pending: number; removals: number; syncJobIds: string[]; failed: number }

type DueDeployment = Awaited<ReturnType<typeof deploymentsDueForCleanup>>[number];

/** Clean one deployment in its own transaction and audit it as SYSTEM; a failure is counted and logged, never thrown. */
async function cleanOne(deps: Pick<WorkerDeps, 'db' | 'queue' | 'log'>, organizationId: string, jobId: string | null, today: string, d: DueDeployment, summary: DeploymentCleanupSummary): Promise<void> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  try {
    const res = await withContext(deps.db, ctx, async (trx) => {
      const r = await cleanupBranchDeployment(trx, deps.queue, { organizationId, deploymentId: d.id, today, trigger: 'SCHEDULED', requestedBy: null, correlationId: `deployment-cleanup:${d.id}`, cause: d.cancelled ? 'cancelled' : 'ended' });
      await writeAudit(trx, {
        organizationId, actorUserId: null, actorType: 'SYSTEM', action: 'employee.deployment_cleaned_up', entityType: 'employee', entityId: d.employeeId, branchId: d.branchId, jobId,
        newValue: { deploymentId: d.id, toDate: d.toDate, cause: d.cancelled ? 'cancelled' : 'ended', syncJobId: r.syncJobId, removals: r.removals, skipped: r.skipped, kept: r.kept, cancelledEnrolItems: r.cancelledEnrolItems, inFlightEnrolItems: r.inFlightEnrolItems, cleanedUp: r.cleanedUp },
        reason: 'Temporary deployment ended: access to the branch\'s terminals removed',
      });
      return r;
    });
    if (res.cleanedUp) summary.cleanedUp += 1; else summary.pending += 1;
    summary.removals += res.removals.length;
    if (res.syncJobId) summary.syncJobIds.push(res.syncJobId);
  } catch (err) {
    summary.failed += 1;
    deps.log.error(event('deployment_cleanup_failed', { organizationId, deploymentId: d.id, jobId, err: (err as Error).message }));
  }
}

export async function runBranchDeploymentCleanup(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now' | 'log'>, organizationId: string, jobId: string | null = null): Promise<DeploymentCleanupSummary> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  const today = await withContext(deps.db, ctx, async (trx) => {
    const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', organizationId).executeTakeFirst();
    const zone = org?.timezone && isValidTimezone(org.timezone) ? org.timezone : 'UTC';
    return DateTime.fromJSDate(deps.now()).setZone(zone).toISODate() ?? deps.now().toISOString().slice(0, 10);
  });
  const summary: DeploymentCleanupSummary = { organizationId, today, due: 0, cleanedUp: 0, pending: 0, removals: 0, syncJobIds: [], failed: 0 };
  // a backlog larger than one batch is worked through in the same run, each deployment at most once (one still waiting for a
  // running enrolment item stays due and is picked again by the next run, not by this one)
  const seen = new Set<string>();
  for (let round = 0; round < DEPLOYMENT_CLEANUP_MAX_ROUNDS; round += 1) {
    const batch = (await withContext(deps.db, ctx, (trx) => deploymentsDueForCleanup(trx, organizationId, today, DEPLOYMENT_CLEANUP_BATCH))).filter((d) => !seen.has(d.id));
    if (batch.length === 0) break;
    for (const d of batch) {
      seen.add(d.id);
      summary.due += 1;
      await cleanOne(deps, organizationId, jobId, today, d, summary);
    }
  }
  deps.log.info(event('deployment_cleanup_done', { ...summary, syncJobIds: summary.syncJobIds.length, jobId }));
  if (summary.failed > 0) throw new AppError('INTERNAL_ERROR', `${summary.failed} deployment clean-up(s) failed`, { retryable: true, details: { organizationId, failed: summary.failed } });
  return summary;
}

export async function deploymentCleanupHandler(ctx: JobContext): Promise<DeploymentCleanupSummary> {
  const parsed = deploymentCleanupPayloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'BRANCH_DEPLOYMENT_CLEANUP needs an organizationId', { retryable: false });
  return runBranchDeploymentCleanup(ctx.deps, parsed.data.organizationId, String(ctx.job.id));
}

export function registerSchedulingHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, handler: deploymentCleanupHandler, timeoutMs: 600_000 });
}

/** Enqueue the sweep for every organisation whose local clock is in the clean-up hour (enqueue-only, platform scan of `organizations`). */
export async function scheduleDeploymentCleanup(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now'>): Promise<{ organizations: number; enqueued: number }> {
  const now = deps.now();
  const orgs = await withContext(deps.db, { kind: 'platform' }, (trx) => trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute());
  let enqueued = 0;
  for (const o of orgs) {
    const local = DateTime.fromJSDate(now).setZone(isValidTimezone(o.timezone) ? o.timezone : 'UTC');
    if (local.hour !== DEPLOYMENT_CLEANUP_LOCAL_HOUR) continue;
    const localDate = local.toISODate() ?? now.toISOString().slice(0, 10);
    await deps.queue.enqueue({ queue: 'processing', jobType: BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, asOf: localDate }, priority: 3, dedupeKey: branchDeploymentCleanupDedupeKey(o.id, localDate), lockTimeoutSeconds: 600, maxAttempts: 3 });
    enqueued += 1;
  }
  return { organizations: orgs.length, enqueued };
}

export const schedulingTasks: ScheduledTask[] = [
  { name: 'branch-deployments.cleanup', everyMs: 3_600_000, run: (d) => scheduleDeploymentCleanup(d) },
];

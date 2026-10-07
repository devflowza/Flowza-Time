import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, branchDeploymentCleanupDedupeKey, branchLocalDates, cleanupBranchDeployment, deploymentsDueForCleanup, deploymentsDueForEnrolment, enrolBranchDeployment,
  withContext, writeAudit, type DueDeployment,
} from '@flowza/database';
import { AppError, event, isValidTimezone } from '@flowza/shared';
import type { WorkerDeps } from '../../deps.js';
import type { ScheduledTask } from '../../scheduler.js';
import type { HandlerRegistry, JobContext } from '../types.js';

/*
 * Temporary branch deployments (Enterprise, docs/enterprise/plan.md §4.7): the daily TERMINAL sweep. Every date is the HOST
 * branch's local date (packages/domain deployment-window).
 *
 *   branch-deployments.cleanup   hourly tick; an organisation is enqueued while the local clock of its timezone OR of one of
 *                                its branches' timezones is in DEPLOYMENT_CLEANUP_LOCAL_HOUR (just after a local midnight:
 *                                a host branch's new day has begun), as ONE job per organisation and local date (the queue
 *                                dedupes pending jobs only, so the key carries the date). A missed hour is caught up the
 *                                next day: the sweep takes everything that is due, not only today's.
 *   BRANCH_DEPLOYMENT_CLEANUP    (the job type keeps its name) in the organisation's system context, two passes:
 *     1. ACCESS REMOVAL — every deployment not cleaned up yet that was cancelled (whatever it enrolled) or whose host date is
 *        at least toDate + 2 (the morning after the last day — a night shift's check-out — still belongs to it): ONE sync job
 *        of DELETE_EMPLOYEE items for the terminals the deployment enrolled (packages/database cleanupBranchDeployment: kept
 *        when the host is now the employee's own branch; handed over to another deployment to the same host that covers the
 *        host's today); `cleanup_job_id` / `cleaned_up_at` are stamped; audited as SYSTEM `employee.deployment_cleaned_up`.
 *        NOT gated by the `advanced_scheduling` module: switching the module off never leaves access behind.
 *     2. ENROLMENT — every deployment whose first day has arrived at the host (fromDate ≤ host today ≤ toDate), not cancelled,
 *        `enrol_on_devices`, without an enrolment job: ONE sync job of PUSH_EMPLOYEE items for the host terminals the employee
 *        is not on yet (enrolBranchDeployment); `enrol_job_id` / `enrolled_device_ids` are stamped; audited as SYSTEM
 *        `employee.deployment_enrolled`. This WIDENS access, so it follows the module (off → nothing is enrolled; the
 *        deployment is enrolled on the first sweep after the module is back, while it still runs).
 * Each deployment is handled in its own transaction; a failure is logged and the job fails at the end so the queue retries
 * (the others are already stamped and skipped).
 */

/** Local hour (organisation or branch timezone) in which the daily sweep is enqueued. */
export const DEPLOYMENT_CLEANUP_LOCAL_HOUR = 0;
/** Deployments read per batch, and the batches one run works through at most (a larger backlog continues the next day). */
export const DEPLOYMENT_CLEANUP_BATCH = 500;
export const DEPLOYMENT_CLEANUP_MAX_ROUNDS = 20;

export const deploymentCleanupPayloadSchema = z.object({ organizationId: z.guid(), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export interface DeploymentSweepSummary {
  organizationId: string;
  /** Today in the organisation's timezone (each deployment is judged with its host branch's date). */
  today: string;
  /** Access removal: deployments due, cleaned up, left for the next sweep (enrolment still running), terminals removed, DELETE jobs. */
  due: number; cleanedUp: number; pending: number; removals: number; syncJobIds: string[];
  /** Enrolment: whether the module allows it, deployments due, PUSH jobs created. */
  enrolmentEnabled: boolean; enrolDue: number; enrolJobIds: string[];
  failed: number;
}

type Deps = Pick<WorkerDeps, 'db' | 'queue' | 'now' | 'log'>;

/** Clean one deployment in its own transaction and audit it as SYSTEM; a failure is counted and logged, never thrown. */
async function cleanOne(deps: Deps, organizationId: string, jobId: string | null, d: DueDeployment, summary: DeploymentSweepSummary): Promise<void> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  const cause = d.cancelled ? 'cancelled' as const : 'ended' as const;
  try {
    const res = await withContext(deps.db, ctx, async (trx) => {
      const r = await cleanupBranchDeployment(trx, deps.queue, { organizationId, deploymentId: d.id, hostToday: d.hostToday, trigger: 'SCHEDULED', requestedBy: null, correlationId: `deployment-cleanup:${d.id}`, cause });
      await writeAudit(trx, {
        organizationId, actorUserId: null, actorType: 'SYSTEM', action: 'employee.deployment_cleaned_up', entityType: 'employee', entityId: d.employeeId, branchId: d.branchId, jobId,
        newValue: {
          deploymentId: d.id, toDate: d.toDate, hostToday: d.hostToday, cause, syncJobId: r.syncJobId, enrolledDevices: r.enrolledDevices, removals: r.removals, skipped: r.skipped, kept: r.kept, handedOverTo: r.handedOverTo,
          cancelledEnrolItems: r.cancelledEnrolItems, inFlightEnrolItems: r.inFlightEnrolItems, cleanedUp: r.cleanedUp,
        },
        reason: cause === 'cancelled' ? 'Temporary deployment cancelled: access to the branch\'s terminals removed' : 'Temporary deployment ended: access to the branch\'s terminals removed',
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

/** Enrol one deployment in its own transaction (audited as SYSTEM when a job was created); a failure is counted and logged. */
async function enrolOne(deps: Deps, organizationId: string, jobId: string | null, d: DueDeployment, summary: DeploymentSweepSummary): Promise<void> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  try {
    const res = await withContext(deps.db, ctx, async (trx) => {
      const r = await enrolBranchDeployment(trx, deps.queue, { organizationId, deploymentId: d.id, hostToday: d.hostToday, trigger: 'SCHEDULED', requestedBy: null, correlationId: `deployment-enrol:${d.id}` });
      if (r.syncJobId) {
        await writeAudit(trx, {
          organizationId, actorUserId: null, actorType: 'SYSTEM', action: 'employee.deployment_enrolled', entityType: 'employee', entityId: d.employeeId, branchId: d.branchId, jobId,
          newValue: { deploymentId: d.id, fromDate: d.fromDate, hostToday: d.hostToday, syncJobId: r.syncJobId, enrolled: r.enrolled, alreadyEnrolled: r.alreadyEnrolled },
          reason: 'Temporary deployment started: employee added to the branch\'s terminals',
        });
      }
      return r;
    });
    if (res.syncJobId) summary.enrolJobIds.push(res.syncJobId);
  } catch (err) {
    summary.failed += 1;
    deps.log.error(event('deployment_enrol_failed', { organizationId, deploymentId: d.id, jobId, err: (err as Error).message }));
  }
}

export async function runBranchDeploymentSweep(deps: Deps, organizationId: string, jobId: string | null = null): Promise<DeploymentSweepSummary> {
  const ctx = { kind: 'system' as const, organizationId, ...(jobId ? { jobId } : {}) };
  const at = deps.now();
  const { dates, enrolmentEnabled } = await withContext(deps.db, ctx, async (trx) => {
    const d = await branchLocalDates(trx, organizationId, at);
    const m = await sql<{ on: boolean | null }>`select app.org_module_enabled(${organizationId}::uuid, 'advanced_scheduling') as on`.execute(trx);
    return { dates: d, enrolmentEnabled: m.rows[0]?.on !== false };
  });
  const summary: DeploymentSweepSummary = { organizationId, today: dates.orgToday, due: 0, cleanedUp: 0, pending: 0, removals: 0, syncJobIds: [], enrolmentEnabled, enrolDue: 0, enrolJobIds: [], failed: 0 };

  // 1. access removal first (keyset paging: a deployment still waiting for a running enrolment item stays due and is picked
  // again by the next run, not by this one)
  let after: { date: string; id: string } | null = null;
  for (let round = 0; round < DEPLOYMENT_CLEANUP_MAX_ROUNDS; round += 1) {
    const batch: DueDeployment[] = await withContext(deps.db, ctx, (trx) => deploymentsDueForCleanup(trx, organizationId, dates, { limit: DEPLOYMENT_CLEANUP_BATCH, after }));
    if (batch.length === 0) break;
    for (const d of batch) {
      summary.due += 1;
      await cleanOne(deps, organizationId, jobId, d, summary);
    }
    const last = batch[batch.length - 1]!;
    after = { date: last.toDate, id: last.id };
    if (batch.length < DEPLOYMENT_CLEANUP_BATCH) break;
  }

  // 2. enrolment of the deployments whose first day has arrived (the module's feature)
  if (enrolmentEnabled) {
    after = null;
    for (let round = 0; round < DEPLOYMENT_CLEANUP_MAX_ROUNDS; round += 1) {
      const batch: DueDeployment[] = await withContext(deps.db, ctx, (trx) => deploymentsDueForEnrolment(trx, organizationId, dates, { limit: DEPLOYMENT_CLEANUP_BATCH, after }));
      if (batch.length === 0) break;
      for (const d of batch) {
        summary.enrolDue += 1;
        await enrolOne(deps, organizationId, jobId, d, summary);
      }
      const last = batch[batch.length - 1]!;
      after = { date: last.fromDate, id: last.id };
      if (batch.length < DEPLOYMENT_CLEANUP_BATCH) break;
    }
  }
  deps.log.info(event('deployment_sweep_done', { ...summary, syncJobIds: summary.syncJobIds.length, enrolJobIds: summary.enrolJobIds.length, jobId }));
  if (summary.failed > 0) throw new AppError('INTERNAL_ERROR', `${summary.failed} deployment sweep step(s) failed`, { retryable: true, details: { organizationId, failed: summary.failed } });
  return summary;
}

export async function deploymentCleanupHandler(ctx: JobContext): Promise<DeploymentSweepSummary> {
  const parsed = deploymentCleanupPayloadSchema.safeParse(ctx.job.payload);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 'BRANCH_DEPLOYMENT_CLEANUP needs an organizationId', { retryable: false });
  return runBranchDeploymentSweep(ctx.deps, parsed.data.organizationId, String(ctx.job.id));
}

export function registerSchedulingHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, handler: deploymentCleanupHandler, timeoutMs: 600_000 });
}

/**
 * Enqueue the sweep for every organisation in which a local day has just begun — in its own timezone or in one of its
 * branches' (a host branch's new day decides its deployments). Enqueue-only, platform scan of `organizations` / `branches`.
 */
export async function scheduleDeploymentCleanup(deps: Pick<WorkerDeps, 'db' | 'queue' | 'now'>): Promise<{ organizations: number; enqueued: number }> {
  const now = deps.now();
  const { orgs, branchZones } = await withContext(deps.db, { kind: 'platform' }, async (trx) => ({
    orgs: await trx.selectFrom('organizations').select(['id', 'timezone']).where('status', 'in', ['trial', 'active']).execute(),
    branchZones: await trx.selectFrom('branches as b').innerJoin('organizations as o', 'o.id', 'b.organizationId').select(['b.organizationId', 'b.timezone']).distinct()
      .where('o.status', 'in', ['trial', 'active']).execute(),
  }));
  const zonesOf = new Map<string, Set<string>>();
  for (const o of orgs) zonesOf.set(o.id, new Set([isValidTimezone(o.timezone) ? o.timezone : 'UTC']));
  for (const b of branchZones) if (b.timezone && isValidTimezone(b.timezone)) zonesOf.get(b.organizationId)?.add(b.timezone);
  let enqueued = 0;
  for (const o of orgs) {
    const localDates = new Set<string>();
    for (const zone of zonesOf.get(o.id) ?? []) {
      const local = DateTime.fromJSDate(now).setZone(zone);
      if (local.hour === DEPLOYMENT_CLEANUP_LOCAL_HOUR) localDates.add(local.toISODate() ?? now.toISOString().slice(0, 10));
    }
    for (const localDate of localDates) {
      await deps.queue.enqueue({ queue: 'processing', jobType: BRANCH_DEPLOYMENT_CLEANUP_JOB_TYPE, organizationId: o.id, payload: { organizationId: o.id, asOf: localDate }, priority: 3, dedupeKey: branchDeploymentCleanupDedupeKey(o.id, localDate), lockTimeoutSeconds: 600, maxAttempts: 3 });
      enqueued += 1;
    }
  }
  return { organizations: orgs.length, enqueued };
}

export const schedulingTasks: ScheduledTask[] = [
  { name: 'branch-deployments.cleanup', everyMs: 3_600_000, run: (d) => scheduleDeploymentCleanup(d) },
];

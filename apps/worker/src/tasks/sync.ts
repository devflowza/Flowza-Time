import { sql } from 'kysely';
import { withContext } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../deps.js';
import type { ScheduledTask } from '../scheduler.js';
import { createSyncJob } from '../handlers/sync/api.js';
import { loadOrgSyncSettings } from '../handlers/sync/context.js';

/** Admission cap per organisation per tick (§F.6 fairness): the rest is picked up next tick in due-time order (round-robin). */
export const POLL_ADMISSION_CAP = 200;
export const HEALTH_ADMISSION_CAP = 500;

interface DueDevice { id: string; organizationId: string; branchId: string; syncIntervalMinutes: number }

function groupByOrg<T extends { organizationId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const list = m.get(r.organizationId) ?? []; list.push(r); m.set(r.organizationId, list); }
  return m;
}

/**
 * poll-due-devices: every active, auto-sync device whose `next_attendance_sync_at` has passed (push devices excluded — they
 * talk to us) and that has no PULL_ATTENDANCE item in flight, capped per organisation. One SCHEDULED sync job per organisation
 * per tick with one item per device; the queue jobs carry dedupe key `pull:<deviceId>`.
 */
export async function pollDueDevices(deps: WorkerDeps): Promise<{ organizations: number; devices: number; jobs: string[] }> {
  const now = deps.now();
  const due = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    const res = await sql<DueDevice>`
      with candidates as (
        select d.id, d.organization_id as "organizationId", d.branch_id as "branchId", d.sync_interval_minutes as "syncIntervalMinutes",
               row_number() over (partition by d.organization_id order by d.next_attendance_sync_at asc nulls first, d.id) as rn
        from public.devices d
        join public.organizations o on o.id = d.organization_id
        where d.status = 'active' and d.auto_sync_enabled and d.integration_type <> 'DEVICE_PUSH'
          and (d.next_attendance_sync_at is null or d.next_attendance_sync_at <= ${now})
          and o.status in ('active', 'trial')
          and not exists (
            select 1 from public.sync_job_items i
            where i.device_id = d.id and i.operation = 'PULL_ATTENDANCE' and i.status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')
          )
      )
      select id, "organizationId", "branchId", "syncIntervalMinutes" from candidates where rn <= ${POLL_ADMISSION_CAP} order by "organizationId", rn`.execute(trx);
    return res.rows;
  });
  const jobs: string[] = [];
  for (const [organizationId, devices] of groupByOrg(due)) {
    try {
      const jobId = await withContext(deps.db, { kind: 'system', organizationId }, async (trx) => {
        const created = await createSyncJob(trx, deps.queue, {
          organizationId, jobType: 'PULL_ATTENDANCE', trigger: 'SCHEDULED', scope: { scheduled: true, deviceIds: devices.map((d) => d.id), tickAt: now.toISOString() },
          items: devices.map((d) => ({ deviceId: d.id, operation: 'PULL_ATTENDANCE', branchId: d.branchId })),
        });
        // push the due time forward so a slow queue does not re-admit the same device every tick; the pull recomputes it adaptively
        for (const d of devices) await trx.updateTable('devices').set({ nextAttendanceSyncAt: new Date(now.getTime() + Math.max(1, d.syncIntervalMinutes) * 60_000) }).where('id', '=', d.id).execute();
        return created.syncJobId;
      });
      jobs.push(jobId);
    } catch (err) {
      deps.log.error(event('poll_due_devices_failed', { organizationId, devices: devices.length, err: (err as Error).message }));
    }
  }
  return { organizations: jobs.length, devices: due.length, jobs };
}

/** health-check: devices not seen within their offline threshold get a DEVICE_HEALTH_CHECK (dedupe `health:<deviceId>`, low priority). */
export async function scheduleHealthChecks(deps: WorkerDeps): Promise<{ organizations: number; devices: number; jobs: string[] }> {
  const now = deps.now();
  const stale = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    const res = await sql<{ id: string; organizationId: string; branchId: string }>`
      with candidates as (
        select d.id, d.organization_id as "organizationId", d.branch_id as "branchId",
               row_number() over (partition by d.organization_id order by coalesce(d.last_successful_communication_at, d.last_heartbeat_at, d.created_at) asc, d.id) as rn
        from public.devices d
        join public.organizations o on o.id = d.organization_id
        where d.status = 'active' and o.status in ('active', 'trial')
          and coalesce(d.last_successful_communication_at, 'epoch'::timestamptz) < ${now}::timestamptz - make_interval(mins => d.offline_threshold_minutes)
          and coalesce(d.last_heartbeat_at, 'epoch'::timestamptz) < ${now}::timestamptz - make_interval(mins => d.offline_threshold_minutes)
          and not exists (
            select 1 from public.sync_job_items i
            where i.device_id = d.id and i.operation = 'DEVICE_HEALTH_CHECK' and i.status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')
          )
      )
      select id, "organizationId", "branchId" from candidates where rn <= ${HEALTH_ADMISSION_CAP} order by "organizationId", rn`.execute(trx);
    return res.rows;
  });
  const jobs: string[] = [];
  for (const [organizationId, devices] of groupByOrg(stale)) {
    try {
      const jobId = await withContext(deps.db, { kind: 'system', organizationId }, async (trx) => (await createSyncJob(trx, deps.queue, {
        organizationId, jobType: 'DEVICE_HEALTH_CHECK', trigger: 'SCHEDULED', priority: 2, scope: { scheduled: true, deviceIds: devices.map((d) => d.id) },
        items: devices.map((d) => ({ deviceId: d.id, operation: 'DEVICE_HEALTH_CHECK', branchId: d.branchId })), maxAttempts: 3,
      })).syncJobId);
      jobs.push(jobId);
    } catch (err) {
      deps.log.error(event('schedule_health_checks_failed', { organizationId, devices: devices.length, err: (err as Error).message }));
    }
  }
  return { organizations: jobs.length, devices: stale.length, jobs };
}

/**
 * reconciliation: per organisation, when the last RECONCILIATION sync job is older than `sync.reconciliationIntervalHours`
 * (default 24), one job with an item per active device. The org setting is read in the org's own system context.
 */
export async function scheduleReconciliation(deps: WorkerDeps): Promise<{ organizations: number; jobs: string[] }> {
  const orgs = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    // age measured with the database clock (created_at is set by the database), so the two clocks never disagree
    const res = await sql<{ organizationId: string; ageSeconds: number | null }>`
      select o.id as "organizationId", (select extract(epoch from now() - max(j.created_at)) from public.sync_jobs j where j.organization_id = o.id and j.job_type = 'RECONCILIATION')::float8 as "ageSeconds"
      from public.organizations o
      where o.status in ('active', 'trial') and exists (select 1 from public.devices d where d.organization_id = o.id and d.status = 'active')`.execute(trx);
    return res.rows;
  });
  const jobs: string[] = [];
  for (const o of orgs) {
    try {
      const jobId = await withContext(deps.db, { kind: 'system', organizationId: o.organizationId }, async (trx) => {
        const settings = await loadOrgSyncSettings(trx, o.organizationId);
        if (o.ageSeconds !== null && o.ageSeconds < settings.reconciliationIntervalHours * 3_600) return null;
        const devices = await trx.selectFrom('devices').select(['id', 'branchId']).where('organizationId', '=', o.organizationId).where('status', '=', 'active').execute();
        if (devices.length === 0) return null;
        return (await createSyncJob(trx, deps.queue, {
          organizationId: o.organizationId, jobType: 'RECONCILIATION', trigger: 'SCHEDULED', priority: 3, scope: { scheduled: true, intervalHours: settings.reconciliationIntervalHours },
          items: devices.map((d) => ({ deviceId: d.id, operation: 'RECONCILIATION', branchId: d.branchId })), maxAttempts: 3,
        })).syncJobId;
      });
      if (jobId) jobs.push(jobId);
    } catch (err) {
      deps.log.error(event('schedule_reconciliation_failed', { organizationId: o.organizationId, err: (err as Error).message }));
    }
  }
  return { organizations: orgs.length, jobs };
}

/** Scheduler ticks for synchronisation (docs/sync-engine.md): enqueue-only, platform context for the scans. */
export const syncTasks: ScheduledTask[] = [
  { name: 'poll-due-devices', everyMs: 15_000, run: pollDueDevices },
  { name: 'health-check', everyMs: 5 * 60_000, run: scheduleHealthChecks },
  { name: 'reconciliation', everyMs: 60 * 60_000, run: scheduleReconciliation },
];

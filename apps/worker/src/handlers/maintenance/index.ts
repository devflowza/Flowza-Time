import { sql } from 'kysely';
import { event } from '@flowza/shared';
import { withContext } from '@flowza/database';
import type { HandlerRegistry, JobContext } from '../types.js';

const PARTITIONED_TABLES = ['public.attendance_raw_transactions', 'public.attendance_events', 'public.device_logs', 'public.sync_logs'] as const;

/** Keep ≥ 12 months of future partitions and alert when rows land in a default partition. */
export async function ensurePartitions({ deps, log }: JobContext) {
  const created: Record<string, number> = {};
  const from = new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), 1));
  for (const table of PARTITIONED_TABLES) {
    const res = await sql<{ n: number }>`select app.ensure_month_partitions(${table}::regclass, ${from}::date, 14) as n`.execute(deps.db);
    created[table] = res.rows[0]?.n ?? 0;
    const def = await sql<{ c: string }>`select count(*)::text as c from ${sql.raw(`${table}_default`)}`.execute(deps.db);
    if (Number(def.rows[0]?.c ?? 0) > 0) log.error(event('default_partition_has_rows', { table, rows: def.rows[0]?.c }));
  }
  log.info(event('partitions_ensured', { created }));
  return created;
}

export async function reapStaleJobs({ deps, log }: JobContext) {
  const n = await deps.queue.reapStale(500);
  if (n > 0) log.warn(event('stale_jobs_requeued', { count: n }));
  return { requeued: n };
}

/** Archive pruning: keep 90 days of completed/dead queue rows for diagnostics. */
export async function pruneQueueArchive({ deps, log }: JobContext) {
  const res = await sql`delete from jobs.queue_archive where completed_at < now() - interval '90 days'`.execute(deps.db);
  log.info(event('queue_archive_pruned', { deleted: Number(res.numAffectedRows ?? 0) }));
  return { deleted: Number(res.numAffectedRows ?? 0) };
}

/** Platform minimum retention per data class (days). Organisation policies below the floor are raised to the floor. */
const RETENTION_FLOORS: Record<string, number> = { raw_transactions: 365, attendance_events: 730, audit_logs: 365, device_logs: 30, sync_logs: 30, report_files: 7, notifications: 30, import_files: 30, login_history: 90 };

/**
 * Retention purge for one organisation (payload.organizationId). Only enabled policies apply; legal hold blocks everything.
 * Partition-backed classes are purged by date range inside the organisation (partition detach is a platform-level operation
 * done when ALL organisations' floors have passed — see docs/deployment.md).
 */
export async function applyRetention({ job, deps, log }: JobContext) {
  const orgId = String(job.payload['organizationId'] ?? '');
  if (!orgId) return { skipped: 'no organizationId' };
  return withContext(deps.db, { kind: 'system', organizationId: orgId, jobId: job.id }, async (trx) => {
    const org = await trx.selectFrom('organizations').select(['legalHold']).where('id', '=', orgId).executeTakeFirst();
    if (!org || org.legalHold) { log.info(event('retention_skipped', { orgId, reason: org ? 'legal_hold' : 'missing' })); return { skipped: 'legal_hold' }; }
    const policies = await trx.selectFrom('dataRetentionPolicies').select(['dataClass', 'retentionDays']).where('organizationId', '=', orgId).where('enabled', '=', true).execute();
    const results: Record<string, number> = {};
    for (const p of policies) {
      if (p.retentionDays === null) continue;
      const days = Math.max(p.retentionDays, RETENTION_FLOORS[p.dataClass] ?? 0);
      const cutoff = new Date(deps.now().getTime() - days * 86_400_000);
      let affected = 0;
      switch (p.dataClass) {
        case 'device_logs': affected = Number((await sql`delete from public.device_logs where organization_id = ${orgId}::uuid and created_at < ${cutoff}`.execute(trx)).numAffectedRows ?? 0); break;
        case 'sync_logs': affected = Number((await sql`delete from public.sync_logs where organization_id = ${orgId}::uuid and created_at < ${cutoff}`.execute(trx)).numAffectedRows ?? 0); break;
        case 'notifications': affected = Number((await sql`delete from public.notifications where organization_id = ${orgId}::uuid and created_at < ${cutoff} and read_at is not null`.execute(trx)).numAffectedRows ?? 0); break;
        case 'report_files': {
          const expired = await trx.selectFrom('reportRequests').select(['id', 'filePath']).where('organizationId', '=', orgId).where('createdAt', '<', cutoff).where('status', '=', 'COMPLETED').execute();
          if (expired.length) {
            await deps.storage.remove('reports', expired.map((r) => r.filePath).filter((p): p is string => !!p)).catch((err: Error) => log.warn(event('report_file_remove_failed', { err: err.message })));
            await trx.updateTable('reportRequests').set({ status: 'EXPIRED', filePath: null }).where('id', 'in', expired.map((r) => r.id)).execute();
          }
          affected = expired.length; break;
        }
        case 'raw_transactions': case 'attendance_events': case 'audit_logs': case 'login_history': case 'import_files':
          // Immutable classes are never row-deleted by an org job; they are handled by platform partition detach + archive export.
          log.info(event('retention_deferred_to_platform', { dataClass: p.dataClass, cutoff }));
          break;
      }
      results[p.dataClass] = affected;
    }
    await trx.insertInto('audit.logs').values({ organizationId: orgId, actorUserId: null, actorType: 'SYSTEM', action: 'retention.applied', entityType: 'organization', entityId: orgId, newValue: JSON.stringify(results), jobId: job.id }).execute();
    return results;
  });
}

/** Monthly usage metering per organisation (employees, devices, branches, users, raw rows, storage estimate). */
export async function meterUsage({ deps, log }: JobContext) {
  const periodStart = new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth() + 1, 0));
  const res = await sql`
    insert into public.usage_records (organization_id, metric, period_start, period_end, value)
    select o.id, m.metric, ${periodStart}::date, ${periodEnd}::date, m.value
    from public.organizations o
    cross join lateral (
      select 'employees' as metric, count(*)::numeric as value from public.employees e where e.organization_id = o.id and e.deleted_at is null and e.employment_status <> 'terminated'
      union all select 'devices', count(*) from public.devices d where d.organization_id = o.id and d.status = 'active'
      union all select 'branches', count(*) from public.branches b where b.organization_id = o.id and b.status = 'active'
      union all select 'users', count(*) from public.org_memberships mm where mm.organization_id = o.id and mm.status = 'active'
      union all select 'raw_transactions_month', count(*) from public.attendance_raw_transactions r where r.organization_id = o.id and r.received_at >= ${periodStart}
    ) m
    on conflict (organization_id, metric, period_start) do update set value = excluded.value, updated_at = now()`.execute(deps.db);
  log.info(event('usage_metered', { rows: Number(res.numAffectedRows ?? 0) }));
  return { rows: Number(res.numAffectedRows ?? 0) };
}

export function registerMaintenanceHandlers(registry: HandlerRegistry): void {
  registry.register({ jobType: 'ENSURE_PARTITIONS', handler: ensurePartitions, timeoutMs: 120_000 });
  registry.register({ jobType: 'REAP_STALE', handler: reapStaleJobs, timeoutMs: 30_000 });
  registry.register({ jobType: 'PRUNE_QUEUE_ARCHIVE', handler: pruneQueueArchive, timeoutMs: 300_000 });
  registry.register({ jobType: 'RETENTION', handler: applyRetention, timeoutMs: 600_000 });
  registry.register({ jobType: 'USAGE_METERING', handler: meterUsage, timeoutMs: 600_000 });
}

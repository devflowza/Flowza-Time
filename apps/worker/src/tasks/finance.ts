import { sql } from 'kysely';
import { FLOWZA_FINANCE_PROVIDER_KEY } from '@flowza/contracts';
import { withContext } from '@flowza/database';
import { event } from '@flowza/shared';
import type { WorkerDeps } from '../deps.js';
import type { ScheduledTask } from '../scheduler.js';
import { createSyncJob } from '../handlers/sync/api.js';
import { scheduleNextFinancePush } from '../handlers/sync/finance-state.js';

export const FINANCE_PUSH_ADMISSION_CAP = 50;

interface DueConnector { id: string; organizationId: string; branchId: string; pollMinutes: number }

/**
 * finance-push: every active Flowza Finance connector whose direction includes push and whose `finance_sync_state.next_push_at`
 * has passed (or was never set), in an active/trial organisation, with no PUSH_ATTENDANCE item in flight. One SCHEDULED sync
 * job per organisation per tick; the due time is pushed forward at admission so a slow queue does not re-admit the connector
 * every tick (the handler recomputes it: immediately when more remained, else after `pollMinutes`). The pull side needs no
 * task of its own — the connector is an ordinary auto-sync device polled by `poll-due-devices`.
 */
export async function scheduleFinancePushes(deps: WorkerDeps, opts: { cap?: number } = {}): Promise<{ organizations: number; devices: number; jobs: string[] }> {
  const now = deps.now();
  const cap = opts.cap ?? FINANCE_PUSH_ADMISSION_CAP;
  const due = await withContext(deps.db, { kind: 'platform' }, async (trx) => {
    const res = await sql<DueConnector>`
      with candidates as (
        select d.id, d.organization_id as "organizationId", d.branch_id as "branchId",
               least(60, greatest(5, coalesce(case when d.config->>'pollMinutes' ~ '^[0-9]+$' then (d.config->>'pollMinutes')::int end, d.sync_interval_minutes, 10))) as "pollMinutes",
               row_number() over (partition by d.organization_id order by s.next_push_at asc nulls first, d.id) as rn
        from public.devices d
        join public.organizations o on o.id = d.organization_id
        left join public.finance_sync_state s on s.device_id = d.id
        where d.status = 'active' and d.provider_key = ${FLOWZA_FINANCE_PROVIDER_KEY}
          and coalesce(d.config->>'direction', 'both') in ('push', 'both')
          and o.status in ('active', 'trial')
          -- the organisation's Flowza Finance integration module (migration 20260929000600): off ⇒ nothing is pushed
          and app.org_module_enabled(o.id, 'finance_integration') is not false
          and (s.next_push_at is null or s.next_push_at <= ${now})
          and not exists (
            select 1 from public.sync_job_items i
            where i.device_id = d.id and i.operation = 'PUSH_ATTENDANCE' and i.status in ('PENDING', 'QUEUED', 'RUNNING', 'RETRYING')
          )
      )
      select id, "organizationId", "branchId", "pollMinutes" from candidates where rn <= ${cap} order by "organizationId", rn`.execute(trx);
    return res.rows;
  });
  const byOrg = new Map<string, DueConnector[]>();
  for (const d of due) { const list = byOrg.get(d.organizationId) ?? []; list.push(d); byOrg.set(d.organizationId, list); }
  const jobs: string[] = [];
  for (const [organizationId, devices] of byOrg) {
    try {
      const jobId = await withContext(deps.db, { kind: 'system', organizationId }, async (trx) => {
        const created = await createSyncJob(trx, deps.queue, {
          organizationId, jobType: 'PUSH_ATTENDANCE', trigger: 'SCHEDULED', scope: { scheduled: true, deviceIds: devices.map((d) => d.id), tickAt: now.toISOString() },
          items: devices.map((d) => ({ deviceId: d.id, operation: 'PUSH_ATTENDANCE', branchId: d.branchId })),
        });
        for (const d of devices) await scheduleNextFinancePush(trx, { id: d.id, organizationId }, new Date(now.getTime() + d.pollMinutes * 60_000));
        return created.syncJobId;
      });
      jobs.push(jobId);
    } catch (err) {
      deps.log.error(event('schedule_finance_pushes_failed', { organizationId, devices: devices.length, err: (err as Error).message }));
    }
  }
  return { organizations: jobs.length, devices: due.length, jobs };
}

export const financeTasks: ScheduledTask[] = [
  { name: 'finance-push', everyMs: 30_000, run: (d) => scheduleFinancePushes(d) },
];

import { sql } from 'kysely';
import type { DashboardBranchRow, DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, eachDate } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';

const MAX_TREND_DAYS = 92;

interface DayAgg { present: number; absent: number; late: number; onLeave: number; earlyDeparture: number; overtimeMinutes: number; missingPunch: number }
const emptyAgg = (): DayAgg => ({ present: 0, absent: 0, late: 0, onLeave: 0, earlyDeparture: 0, overtimeMinutes: 0, missingPunch: 0 });

/** One grouped query over attendance_daily_records for a date range (optionally grouped by branch or date). */
async function attendanceAgg(trx: Trx, orgId: string, from: string, to: string, scope: string[] | null, groupBy: 'date' | 'branch' | null): Promise<Map<string, DayAgg>> {
  let q = trx.selectFrom('attendanceDailyRecords as r').where('r.organizationId', '=', orgId).where('r.attendanceDate', '>=', sql<Date>`${from}::date`).where('r.attendanceDate', '<=', sql<Date>`${to}::date`);
  if (scope) q = q.where('r.branchId', 'in', scope);
  // grouping by a constant is not allowed in GROUP BY; all rows share the organisation id, mapped to 'all' below
  const keyExpr = groupBy === 'date' ? sql<string>`to_char(r.attendance_date, 'YYYY-MM-DD')` : groupBy === 'branch' ? sql<string>`r.branch_id::text` : sql<string>`r.organization_id::text`;
  const rows = await q.select([
    keyExpr.as('key'),
    // An employee who has clocked in but not yet out stays PENDING until the punch window closes (the engine cannot
    // judge the day yet), and is present as far as the dashboard is concerned.
    sql<string>`count(*) filter (where r.status in ('PRESENT', 'HALF_DAY') or (r.status = 'PENDING' and r.first_in_at is not null))`.as('present'),
    sql<string>`count(*) filter (where r.status = 'ABSENT')`.as('absent'),
    sql<string>`count(*) filter (where 'LATE' = any(r.flags))`.as('late'),
    sql<string>`count(*) filter (where r.status = 'LEAVE')`.as('onLeave'),
    sql<string>`count(*) filter (where 'EARLY_DEPARTURE' = any(r.flags))`.as('earlyDeparture'),
    sql<string>`coalesce(sum(r.overtime_minutes), 0)`.as('overtimeMinutes'),
    sql<string>`count(*) filter (where r.status = 'MISSING_PUNCH')`.as('missingPunch'),
  ]).groupBy(keyExpr).execute();
  return new Map(rows.map((r) => [groupBy ? r.key : 'all', { present: toCount(r.present), absent: toCount(r.absent), late: toCount(r.late), onLeave: toCount(r.onLeave), earlyDeparture: toCount(r.earlyDeparture), overtimeMinutes: toCount(r.overtimeMinutes), missingPunch: toCount(r.missingPunch) }]));
}

export async function summary(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string; branchId?: string }): Promise<DashboardSummary> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    // One statement. The day in the organisation's zone, the attendance aggregates (same filters as attendanceAgg),
    // the headcount, device states, sync failures and pending approvals used to be six queries in a row, and each is a
    // round trip between the API's region and the database's.
    const scoped = (col: string) => (scope ? sql`and ${sql.ref(col)} = any(${scope}::uuid[])` : sql``);
    const row = await sql<{ date: string; employees: string; present: string; absent: string; late: string; onLeave: string; earlyDeparture: string; overtimeMinutes: string; missingPunch: string; online: string; unknown: string; total: string; syncFailures: string; pendingApprovals: string }>`
      with day as (
        select coalesce(${q.date ?? null}::date, (now() at time zone (select o.timezone from public.organizations o where o.id = ${orgId}))::date) as d
      ),
      att as (
        select count(*) filter (where r.status in ('PRESENT', 'HALF_DAY') or (r.status = 'PENDING' and r.first_in_at is not null)) as present,
               count(*) filter (where r.status = 'ABSENT') as absent,
               count(*) filter (where 'LATE' = any(r.flags)) as late,
               count(*) filter (where r.status = 'LEAVE') as on_leave,
               count(*) filter (where 'EARLY_DEPARTURE' = any(r.flags)) as early_departure,
               coalesce(sum(r.overtime_minutes), 0) as overtime_minutes,
               count(*) filter (where r.status = 'MISSING_PUNCH') as missing_punch
        from public.attendance_daily_records r, day
        where r.organization_id = ${orgId} and r.attendance_date = day.d ${scoped('r.branch_id')}
      ),
      dev as (
        select count(*) filter (where d.connection_status = 'online') as online,
               count(*) filter (where d.connection_status = 'unknown') as unknown,
               count(*) as total
        from public.devices d
        where d.organization_id = ${orgId} and d.status = 'active' ${scoped('d.branch_id')}
      )
      select to_char(day.d, 'YYYY-MM-DD') as date,
             (select count(*) from public.employees e where e.organization_id = ${orgId} and e.deleted_at is null and e.employment_status = 'active' ${scoped('e.branch_id')}) as employees,
             att.present, att.absent, att.late, att.on_leave, att.early_departure, att.overtime_minutes, att.missing_punch,
             dev.online, dev.unknown, dev.total,
             (select count(*) from public.sync_job_items s where s.organization_id = ${orgId} and s.status = 'FAILED' and s.updated_at >= now() - interval '24 hours' ${scoped('s.branch_id')}) as sync_failures,
             (select count(*) from public.approval_requests a where a.organization_id = ${orgId} and a.status = 'PENDING'
                ${scope ? sql`and (a.branch_id is null or a.branch_id = any(${scope}::uuid[]))` : sql``}) as pending_approvals
      from day, att, dev`.execute(trx);
    const r = row.rows[0];
    if (!r) throw errors.notFound('Organisation not found.');
    const online = toCount(r.online); const unknown = toCount(r.unknown);
    return {
      date: r.date, employees: toCount(r.employees), presentToday: toCount(r.present), absent: toCount(r.absent), late: toCount(r.late), onLeave: toCount(r.onLeave), earlyDeparture: toCount(r.earlyDeparture), overtimeMinutes: toCount(r.overtimeMinutes), missingPunch: toCount(r.missingPunch),
      // offline includes degraded, error and vendor_degraded — anything that is not online and not unknown
      devicesOnline: online, devicesOffline: toCount(r.total) - online - unknown, devicesUnknown: unknown, syncFailures24h: toCount(r.syncFailures), pendingApprovals: toCount(r.pendingApprovals),
    };
  });
}

export async function trends(deps: ApiDeps, actor: Actor, orgId: string, q: { from: string; to: string; branchId?: string }): Promise<DashboardTrendPoint[]> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  const days = eachDate(q.from, q.to);
  if (days.length > MAX_TREND_DAYS) throw errors.validation(`Trend range is limited to ${MAX_TREND_DAYS} days.`);
  return runUser(deps.db, actor, async (trx) => {
    const agg = await attendanceAgg(trx, orgId, q.from, q.to, scope, 'date');
    return days.map((date) => { const a = agg.get(date) ?? emptyAgg(); return { date, present: a.present, absent: a.absent, late: a.late, onLeave: a.onLeave, missingPunch: a.missingPunch, overtimeMinutes: a.overtimeMinutes }; });
  });
}

export async function branches(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string }): Promise<DashboardBranchRow[]> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant);
  return runUser(deps.db, actor, async (trx) => {
    // One statement: the branches, the day's attendance per branch (same filters as attendanceAgg), device states
    // and headcounts — four queries in a row before, five without a date.
    const scoped = (col: string) => (scope ? sql`and ${sql.ref(col)} = any(${scope}::uuid[])` : sql``);
    const { rows } = await sql<{ id: string; code: string; name: string; employees: string; present: string; absent: string; late: string; onLeave: string; missingPunch: string; online: string; total: string }>`
      with day as (
        select coalesce(${q.date ?? null}::date, (now() at time zone (select o.timezone from public.organizations o where o.id = ${orgId}))::date) as d
      ),
      att as (
        select r.branch_id,
               count(*) filter (where r.status in ('PRESENT', 'HALF_DAY') or (r.status = 'PENDING' and r.first_in_at is not null)) as present,
               count(*) filter (where r.status = 'ABSENT') as absent,
               count(*) filter (where 'LATE' = any(r.flags)) as late,
               count(*) filter (where r.status = 'LEAVE') as on_leave,
               count(*) filter (where r.status = 'MISSING_PUNCH') as missing_punch
        from public.attendance_daily_records r, day
        where r.organization_id = ${orgId} and r.attendance_date = day.d ${scoped('r.branch_id')}
        group by r.branch_id
      ),
      dev as (
        select d.branch_id, count(*) filter (where d.connection_status = 'online') as online, count(*) as total
        from public.devices d
        where d.organization_id = ${orgId} and d.status = 'active' ${scoped('d.branch_id')}
        group by d.branch_id
      ),
      emp as (
        select e.branch_id, count(*) as n
        from public.employees e
        where e.organization_id = ${orgId} and e.deleted_at is null and e.employment_status = 'active' ${scoped('e.branch_id')}
        group by e.branch_id
      )
      select b.id, b.code, b.name,
             coalesce(emp.n, 0) as employees,
             coalesce(att.present, 0) as present, coalesce(att.absent, 0) as absent, coalesce(att.late, 0) as late,
             coalesce(att.on_leave, 0) as on_leave, coalesce(att.missing_punch, 0) as missing_punch,
             coalesce(dev.online, 0) as online, coalesce(dev.total, 0) as total
      from public.branches b
      left join att on att.branch_id = b.id
      left join dev on dev.branch_id = b.id
      left join emp on emp.branch_id = b.id
      where b.organization_id = ${orgId} and b.status <> 'archived' ${scoped('b.id')}
      order by b.name`.execute(trx);
    return rows.map((b) => {
      const online = toCount(b.online);
      // offline includes degraded, error, vendor_degraded and unknown — anything that is not online
      return { branchId: b.id, branchCode: String(b.code), branchName: b.name, employees: toCount(b.employees), present: toCount(b.present), absent: toCount(b.absent), late: toCount(b.late), onLeave: toCount(b.onLeave), missingPunch: toCount(b.missingPunch), devicesOnline: online, devicesOffline: toCount(b.total) - online };
    });
  });
}

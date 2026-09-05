import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { DashboardBranchRow, DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, eachDate } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';

const MAX_TREND_DAYS = 92;

async function orgToday(trx: Trx, orgId: string): Promise<string> {
  const org = await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst();
  return DateTime.now().setZone(org?.timezone ?? 'UTC').toISODate() ?? DateTime.utc().toISODate()!;
}

interface DayAgg { present: number; absent: number; late: number; onLeave: number; earlyDeparture: number; overtimeMinutes: number; missingPunch: number }
const emptyAgg = (): DayAgg => ({ present: 0, absent: 0, late: 0, onLeave: 0, earlyDeparture: 0, overtimeMinutes: 0, missingPunch: 0 });

/** One grouped query over attendance_daily_records for a date range (optionally grouped by branch or date). */
async function attendanceAgg(trx: Trx, orgId: string, from: string, to: string, scope: string[] | null, groupBy: 'date' | 'branch' | null): Promise<Map<string, DayAgg>> {
  let q = trx.selectFrom('attendanceDailyRecords as r').where('r.organizationId', '=', orgId).where('r.attendanceDate', '>=', sql<Date>`${from}::date`).where('r.attendanceDate', '<=', sql<Date>`${to}::date`);
  if (scope) q = q.where('r.branchId', 'in', scope);
  const keyExpr = groupBy === 'date' ? sql<string>`to_char(r.attendance_date, 'YYYY-MM-DD')` : groupBy === 'branch' ? sql<string>`r.branch_id::text` : sql<string>`'all'`;
  const rows = await q.select([
    keyExpr.as('key'),
    sql<string>`count(*) filter (where r.status in ('PRESENT', 'HALF_DAY'))`.as('present'),
    sql<string>`count(*) filter (where r.status = 'ABSENT')`.as('absent'),
    sql<string>`count(*) filter (where 'LATE' = any(r.flags))`.as('late'),
    sql<string>`count(*) filter (where r.status = 'LEAVE')`.as('onLeave'),
    sql<string>`count(*) filter (where 'EARLY_DEPARTURE' = any(r.flags))`.as('earlyDeparture'),
    sql<string>`coalesce(sum(r.overtime_minutes), 0)`.as('overtimeMinutes'),
    sql<string>`count(*) filter (where r.status = 'MISSING_PUNCH')`.as('missingPunch'),
  ]).groupBy(keyExpr).execute();
  return new Map(rows.map((r) => [r.key, { present: toCount(r.present), absent: toCount(r.absent), late: toCount(r.late), onLeave: toCount(r.onLeave), earlyDeparture: toCount(r.earlyDeparture), overtimeMinutes: toCount(r.overtimeMinutes), missingPunch: toCount(r.missingPunch) }]));
}

async function deviceCounts(trx: Trx, orgId: string, scope: string[] | null): Promise<Map<string, { online: number; offline: number; unknown: number }>> {
  let q = trx.selectFrom('devices').where('organizationId', '=', orgId).where('status', '=', 'active');
  if (scope) q = q.where('branchId', 'in', scope);
  const rows = await q.select(['branchId', 'connectionStatus', (eb) => eb.fn.countAll().as('n')]).groupBy(['branchId', 'connectionStatus']).execute();
  const out = new Map<string, { online: number; offline: number; unknown: number }>();
  for (const r of rows) {
    const key = r.branchId; const agg = out.get(key) ?? { online: 0, offline: 0, unknown: 0 }; const n = toCount(r.n);
    if (r.connectionStatus === 'online') agg.online += n; else if (r.connectionStatus === 'unknown') agg.unknown += n; else agg.offline += n; // offline/degraded/error/vendor_degraded count as not online
    out.set(key, agg);
  }
  return out;
}

export async function summary(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string; branchId?: string }): Promise<DashboardSummary> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const date = q.date ?? (await orgToday(trx, orgId));
    const agg = (await attendanceAgg(trx, orgId, date, date, scope, null)).get('all') ?? emptyAgg();
    let empQ = trx.selectFrom('employees').where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('employmentStatus', '=', 'active');
    if (scope) empQ = empQ.where('branchId', 'in', scope);
    const employees = toCount((await empQ.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const devices = [...(await deviceCounts(trx, orgId, scope)).values()].reduce((a, d) => ({ online: a.online + d.online, offline: a.offline + d.offline, unknown: a.unknown + d.unknown }), { online: 0, offline: 0, unknown: 0 });
    let failQ = trx.selectFrom('syncJobItems').where('organizationId', '=', orgId).where('status', '=', 'FAILED').where('updatedAt', '>=', new Date(Date.now() - 86_400_000));
    if (scope) failQ = failQ.where('branchId', 'in', scope);
    const syncFailures24h = toCount((await failQ.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    let apprQ = trx.selectFrom('approvalRequests').where('organizationId', '=', orgId).where('status', '=', 'PENDING');
    if (scope) apprQ = apprQ.where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', 'in', scope)]));
    const pendingApprovals = toCount((await apprQ.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    return {
      date, employees, presentToday: agg.present, absent: agg.absent, late: agg.late, onLeave: agg.onLeave, earlyDeparture: agg.earlyDeparture, overtimeMinutes: agg.overtimeMinutes, missingPunch: agg.missingPunch,
      devicesOnline: devices.online, devicesOffline: devices.offline, devicesUnknown: devices.unknown, syncFailures24h, pendingApprovals,
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
    const date = q.date ?? (await orgToday(trx, orgId));
    let bq = trx.selectFrom('branches').select(['id', 'code', 'name']).where('organizationId', '=', orgId).where('status', '!=', 'archived');
    if (scope) bq = bq.where('id', 'in', scope);
    const branchRows = await bq.orderBy('name').execute();
    const agg = await attendanceAgg(trx, orgId, date, date, scope, 'branch');
    const devices = await deviceCounts(trx, orgId, scope);
    let eq = trx.selectFrom('employees').select(['branchId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('employmentStatus', '=', 'active');
    if (scope) eq = eq.where('branchId', 'in', scope);
    const employees = new Map((await eq.groupBy('branchId').execute()).map((r) => [r.branchId, toCount(r.n)]));
    return branchRows.map((b) => {
      const a = agg.get(b.id) ?? emptyAgg(); const d = devices.get(b.id) ?? { online: 0, offline: 0, unknown: 0 };
      return { branchId: b.id, branchCode: String(b.code), branchName: b.name, employees: employees.get(b.id) ?? 0, present: a.present, absent: a.absent, late: a.late, onLeave: a.onLeave, missingPunch: a.missingPunch, devicesOnline: d.online, devicesOffline: d.offline + d.unknown };
    });
  });
}

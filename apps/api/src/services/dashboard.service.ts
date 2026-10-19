import { sql } from 'kysely';
import type { DashboardBranchRow, DashboardDepartmentRow, DashboardMonthToDate, DashboardSummary, DashboardTrendPoint } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, eachDate } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requirePermission } from '../lib/authorize.js';
import { locationScope, type LocationScope } from '../lib/location-scope.js';
import { type Actor, runUser, withSystemScope } from '../lib/service.js';
import { toCount } from '../lib/pagination.js';

const MAX_TREND_DAYS = 92;

interface DayAgg { present: number; absent: number; late: number; onLeave: number; earlyDeparture: number; overtimeMinutes: number; missingPunch: number }
const emptyAgg = (): DayAgg => ({ present: 0, absent: 0, late: 0, onLeave: 0, earlyDeparture: 0, overtimeMinutes: 0, missingPunch: 0 });

/*
 * `locationId` (docs/locations.md §2), resolved under the caller's RLS (NOT_FOUND for a location they cannot see):
 *  - a group / branch location → every widget is restricted to its branches ∩ the caller's scope ∩ an explicit `branchId`;
 *  - a place → its branch ∩ that scope, and then: the attendance figures (summary and trends) and the headcount to the
 *    employees whose work location is the place or a place below it; the device figures (online / offline / unknown) and the
 *    sync failures to the terminals installed there (a device's location — what GET /devices?locationId= lists);
 *    the pending approvals follow the caller, never a filter.
 */

/** One grouped query over attendance_daily_records for a date range (optionally grouped by branch or date). */
async function attendanceAgg(trx: Trx, orgId: string, from: string, to: string, scope: LocationScope, groupBy: 'date' | 'branch' | null): Promise<Map<string, DayAgg>> {
  let q = trx.selectFrom('attendanceDailyRecords as r').where('r.organizationId', '=', orgId).where('r.attendanceDate', '>=', sql<Date>`${from}::date`).where('r.attendanceDate', '<=', sql<Date>`${to}::date`);
  if (scope.branchIds) q = q.where('r.branchId', 'in', scope.branchIds);
  const places = scope.placeIds;
  if (places) q = q.where('r.employeeId', 'in', trx.selectFrom('employees as pe').select('pe.id').where('pe.organizationId', '=', orgId).where('pe.workLocationId', 'in', places));
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
    // The engine never emits the MISSING_PUNCH status: a missing punch is the MISSING_IN / MISSING_OUT flag on a PRESENT,
    // HALF_DAY or ABSENT record (missingPunchBehavior decides the status). Counting the status showed 0 forever.
    sql<string>`count(*) filter (where r.flags && array['MISSING_IN', 'MISSING_OUT']::text[])`.as('missingPunch'),
  ]).groupBy(keyExpr).execute();
  return new Map(rows.map((r) => [groupBy ? r.key : 'all', { present: toCount(r.present), absent: toCount(r.absent), late: toCount(r.late), onLeave: toCount(r.onLeave), earlyDeparture: toCount(r.earlyDeparture), overtimeMinutes: toCount(r.overtimeMinutes), missingPunch: toCount(r.missingPunch) }]));
}

export async function summary(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string | undefined; branchId?: string | undefined; locationId?: string | undefined }): Promise<DashboardSummary> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const loc = await locationScope(trx, orgId, q.locationId, scope);
    // One statement. The day in the organisation's zone, the attendance aggregates (same filters as attendanceAgg),
    // the headcount, device states, sync failures and pending approvals used to be six queries in a row, and each is a
    // round trip between the API's region and the database's.
    const branchIds = loc.branchIds;
    const scoped = (col: string) => (branchIds ? sql`and ${sql.ref(col)} = any(${branchIds}::uuid[])` : sql``);
    // a place: the employees working in it or below / the terminals installed there (see the note above attendanceAgg)
    const places = loc.placeIds;
    const working = (col: string) => (places ? sql`and ${sql.ref(col)} in (select pe.id from public.employees pe where pe.organization_id = ${orgId} and pe.work_location_id = any(${places}::uuid[]))` : sql``);
    const installed = (col: string) => (places ? sql`and ${sql.ref(col)} in (select pd.id from public.devices pd where pd.organization_id = ${orgId} and pd.location_id = any(${places}::uuid[]))` : sql``);
    const placed = (col: string) => (places ? sql`and ${sql.ref(col)} = any(${places}::uuid[])` : sql``);
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
               count(*) filter (where r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]) as missing_punch
        from public.attendance_daily_records r, day
        where r.organization_id = ${orgId} and r.attendance_date = day.d ${scoped('r.branch_id')} ${working('r.employee_id')}
      ),
      dev as (
        select count(*) filter (where d.connection_status = 'online') as online,
               count(*) filter (where d.connection_status = 'unknown') as unknown,
               count(*) as total
        from public.devices d
        where d.organization_id = ${orgId} and d.status = 'active' ${scoped('d.branch_id')} ${placed('d.location_id')}
      )
      select to_char(day.d, 'YYYY-MM-DD') as date,
             (select count(*) from public.employees e where e.organization_id = ${orgId} and e.deleted_at is null and e.employment_status = 'active' ${scoped('e.branch_id')} ${placed('e.work_location_id')}) as employees,
             att.present, att.absent, att.late, att.on_leave, att.early_departure, att.overtime_minutes, att.missing_punch,
             dev.online, dev.unknown, dev.total,
             (select count(*) from public.sync_job_items s where s.organization_id = ${orgId} and s.status = 'FAILED' and s.updated_at >= now() - interval '24 hours' ${scoped('s.branch_id')} ${installed('s.device_id')}) as sync_failures,
             -- what is waiting for the caller: exactly the Approvals card's "mine" queue (review P2-11), not every pending
             -- request the caller can read; it follows the person, not the branch filter
             (select count(*) from app.approval_actionable_request_ids(${orgId}::uuid)) as pending_approvals
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

export async function trends(deps: ApiDeps, actor: Actor, orgId: string, q: { from: string; to: string; branchId?: string | undefined; locationId?: string | undefined }): Promise<DashboardTrendPoint[]> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  const days = eachDate(q.from, q.to);
  if (days.length > MAX_TREND_DAYS) throw errors.validation(`Trend range is limited to ${MAX_TREND_DAYS} days.`);
  return runUser(deps.db, actor, async (trx) => {
    const agg = await attendanceAgg(trx, orgId, q.from, q.to, await locationScope(trx, orgId, q.locationId, scope), 'date');
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
               count(*) filter (where r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]) as missing_punch
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

// ---- statistics and indicators (customer requirement 2026-10-19) ----------------------------------------------------------------

/** One decimal percentage, or null when there is nothing to divide by. */
const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** The caller's attendance scope as SQL: branches (an explicit branch, their branch scope, a location's) and a place's employees. */
function scopeSql(orgId: string, loc: LocationScope) {
  const branches = loc.branchIds ? sql`and r.branch_id = any(${loc.branchIds}::uuid[])` : sql``;
  const places = loc.placeIds ? sql`and r.employee_id in (select pe.id from public.employees pe where pe.organization_id = ${orgId} and pe.work_location_id = any(${loc.placeIds}::uuid[]))` : sql``;
  return sql`${branches} ${places}`;
}

/** The day the widgets describe: the requested date, else today in the organisation's zone. */
const dayCte = (orgId: string, date: string | undefined) => sql`select coalesce(${date ?? null}::date, (now() at time zone (select o.timezone from public.organizations o where o.id = ${orgId}))::date) as d`;

/**
 * GET /dashboard/departments — the day's attendance per department (Statistics: "attendance, absence and lateness statistics"),
 * read under the caller's RLS with their branch scope (and an optional branch / location filter), exactly as the summary counts.
 * A record counts under the department it was calculated in (the record's own department that day). Attendance rate = present ÷
 * the employees expected to work (present, half day, absent, missing punch; leave, weekly offs and holidays are not expected).
 * Department names are read in the organisation's system scope: a dashboard viewer without department.view still sees the label.
 */
export async function departments(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string | undefined; branchId?: string | undefined; locationId?: string | undefined }): Promise<DashboardDepartmentRow[]> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const loc = await locationScope(trx, orgId, q.locationId, scope);
    const { rows } = await sql<{ departmentId: string | null; employees: string; present: string; expected: string; absent: string; late: string; onLeave: string; missingPunch: string }>`
      with day as (${dayCte(orgId, q.date)})
      select r.department_id as "departmentId",
             count(*) as employees,
             count(*) filter (where r.status in ('PRESENT', 'HALF_DAY') or (r.status = 'PENDING' and r.first_in_at is not null)) as present,
             count(*) filter (where r.status in ('PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_PUNCH') or (r.status = 'PENDING' and r.first_in_at is not null)) as expected,
             count(*) filter (where r.status = 'ABSENT') as absent,
             count(*) filter (where 'LATE' = any(r.flags)) as late,
             count(*) filter (where r.status = 'LEAVE') as "onLeave",
             count(*) filter (where r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]) as "missingPunch"
      from public.attendance_daily_records r, day
      where r.organization_id = ${orgId} and r.attendance_date = day.d and r.status not in ('EXITED', 'NOT_JOINED') ${scopeSql(orgId, loc)}
      group by r.department_id`.execute(trx);
    const ids = rows.map((r) => r.departmentId).filter((id): id is string => id !== null);
    const names = ids.length
      ? new Map((await withSystemScope(trx, orgId, (t) => t.selectFrom('departments').select(['id', 'name']).where('organizationId', '=', orgId).where('id', 'in', ids).execute())).map((d) => [d.id, d.name]))
      : new Map<string, string>();
    return rows.map((r): DashboardDepartmentRow => ({
      departmentId: r.departmentId, departmentName: r.departmentId ? names.get(r.departmentId) ?? null : null, employees: toCount(r.employees), present: toCount(r.present), absent: toCount(r.absent),
      late: toCount(r.late), onLeave: toCount(r.onLeave), missingPunch: toCount(r.missingPunch), attendanceRate: rate(toCount(r.present), toCount(r.expected)),
    })).sort((a, b) => (a.departmentName === null ? 1 : 0) - (b.departmentName === null ? 1 : 0) || (a.departmentName ?? '').localeCompare(b.departmentName ?? ''));
  });
}

/**
 * GET /dashboard/month-to-date — the month's indicators from the 1st to the chosen day (inclusive): attendance rate over the
 * working days the engine judged (present ÷ present + half day + absent + missing punch), late days and minutes, absences, early
 * departures, missing punches, leave days, short hours (the reports' UT, same rule as `shortfallMinutes`), overtime and the
 * average worked time per worked day. Same scope and RLS as the summary; days not judged yet (PENDING) count nowhere.
 */
export async function monthToDate(deps: ApiDeps, actor: Actor, orgId: string, q: { date?: string | undefined; branchId?: string | undefined; locationId?: string | undefined }): Promise<DashboardMonthToDate> {
  const grant = requirePermission(actor.principal, orgId, 'dashboard.view');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const loc = await locationScope(trx, orgId, q.locationId, scope);
    const row = (await sql<{ from: string; to: string; workingDays: string; presentDays: string; absentDays: string; lateDays: string; lateMinutes: string; earlyDepartureDays: string; missingPunchDays: string; leaveDays: string; shortfallMinutes: string; overtimeMinutes: string; workedDays: string; workedMinutes: string }>`
      with day as (${dayCte(orgId, q.date)}),
      span as (select date_trunc('month', day.d)::date as f, day.d as t from day)
      select to_char(span.f, 'YYYY-MM-DD') as "from", to_char(span.t, 'YYYY-MM-DD') as "to",
             count(r.id) filter (where r.status in ('PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_PUNCH')) as "workingDays",
             count(r.id) filter (where r.status in ('PRESENT', 'HALF_DAY')) as "presentDays",
             count(r.id) filter (where r.status = 'ABSENT') as "absentDays",
             count(r.id) filter (where 'LATE' = any(r.flags)) as "lateDays",
             coalesce(sum(r.late_minutes) filter (where 'LATE' = any(r.flags)), 0) as "lateMinutes",
             count(r.id) filter (where 'EARLY_DEPARTURE' = any(r.flags)) as "earlyDepartureDays",
             count(r.id) filter (where r.status = 'MISSING_PUNCH' or r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]) as "missingPunchDays",
             count(r.id) filter (where r.status = 'LEAVE') as "leaveDays",
             -- the reports' UT (packages/domain reports/derive.ts deriveHours): base − worked on a worked day with a base
             coalesce(sum(greatest(0, r.scheduled_minutes - greatest(0, r.worked_minutes))) filter (where r.scheduled_minutes > 0 and (
               r.status in ('PRESENT', 'HALF_DAY', 'MISSING_PUNCH')
               or (r.status in ('WEEKLY_OFF', 'HOLIDAY') and r.flags && array['WORKED_ON_WEEKLY_OFF', 'WORKED_ON_HOLIDAY']::text[])
               or (r.status = 'LEAVE' and r.worked_minutes > 0))), 0) as "shortfallMinutes",
             coalesce(sum(greatest(0, r.overtime_minutes)), 0) as "overtimeMinutes",
             count(r.id) filter (where r.status in ('PRESENT', 'HALF_DAY') and r.worked_minutes > 0) as "workedDays",
             coalesce(sum(r.worked_minutes) filter (where r.status in ('PRESENT', 'HALF_DAY') and r.worked_minutes > 0), 0) as "workedMinutes"
      from span
      left join public.attendance_daily_records r on r.organization_id = ${orgId} and r.attendance_date between span.f and span.t ${scopeSql(orgId, loc)}
      group by span.f, span.t`.execute(trx)).rows[0];
    if (!row) throw errors.notFound('Organisation not found.');
    const workingDays = toCount(row.workingDays); const presentDays = toCount(row.presentDays); const workedDays = toCount(row.workedDays);
    return {
      from: row.from, to: row.to, workingDays, presentDays, absentDays: toCount(row.absentDays), lateDays: toCount(row.lateDays), lateMinutes: toCount(row.lateMinutes),
      earlyDepartureDays: toCount(row.earlyDepartureDays), missingPunchDays: toCount(row.missingPunchDays), leaveDays: toCount(row.leaveDays), shortfallMinutes: toCount(row.shortfallMinutes),
      overtimeMinutes: toCount(row.overtimeMinutes), attendanceRate: rate(presentDays, workingDays), avgWorkedMinutes: workedDays > 0 ? Math.round(toCount(row.workedMinutes) / workedDays) : null,
    };
  });
}

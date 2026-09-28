import { sql, type RawBuilder } from 'kysely';
import type { Trx } from '../context.js';

/*
 * The monthly attendance summary figures (HR portal Prompt 6a; ONE definition since the review — defects 8, 9, 10): the API's
 * summary page, the employee profile's month strip, the print statement and the worker's `monthly_summary` report all read
 * THIS query, so the same employee-month can never show two different sets of figures under the same labels.
 *
 * Per employee employed during the period (joining / exit dates), from `attendance_daily_records`, with the period summary's
 * fractions (`summarisePeriod`): a PRESENT day with half-day leave is ½ present + ½ leave, a HALF_DAY is ½ present + ½ absent
 * (or + ½ leave with the half-day-leave flag), LOP counts PAY_EFFECT_FULL = 1 / PAY_EFFECT_HALF = ½. When the period is exactly a
 * payroll period whose summary is FINALIZED (and the caller may use it), its day counts win — they are what payroll paid.
 *
 * Runs under whatever context the transaction carries: the API caller's RLS (a branch-scoped HR user gets their branches, a
 * line manager their team), or the worker's system context with the requester's scope passed explicitly.
 */

export interface AttendanceSummaryScope {
  /** Employees whose CURRENT branch is one of these (the page's branch filter / the requester's branches); null = any. */
  employeeBranchIds: string[] | null;
  /**
   * Days whose OWNING branch is one of these (a branch-restricted requester's scope, applied explicitly where RLS does not —
   * the worker's system context); null = any. Under the API caller's RLS this is redundant and left null.
   */
  recordBranchIds: string[] | null;
  departmentId: string | null;
  /** Explicit employees (a filter, or a line manager's team); null = everyone in scope. */
  employeeIds: string[] | null;
  /** Name / employee-number contains (case-insensitive, LIKE wildcards escaped). */
  search: string | null;
  /** Whether a FINALIZED period summary may replace the live figures (payroll.view; RLS decides again under the API). */
  includeFinalized: boolean;
}

export interface AttendanceSummaryPeriod { from: string; to: string }

/** One employee-month; day counts may be fractional (a half day is 0.5). */
export interface AttendanceSummaryDbFigures {
  presentDays: number; lateDays: number; halfDays: number; leaveDays: number; absentDays: number; missingPunchDays: number; holidayDays: number;
  weeklyOffDays: number; daysWorked: number; workedMinutes: number; overtimeMinutes: number; averageWorkedMinutes: number; lopDays: number;
  unexcusedDays: number; pendingDays: number; recordCount: number;
}
export interface AttendanceSummaryDbRow extends AttendanceSummaryDbFigures {
  employeeId: string; employeeNumber: string; employeeName: string; branchId: string; departmentId: string | null; finalizedAt: Date | null;
}

const NONE = '00000000-0000-0000-0000-000000000000';
const ids = (list: string[] | null): string[] | null => (list === null ? null : list.length ? list : [NONE]);
const likeContains = (term: string): string => `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
const num = (v: unknown): number => { const n = typeof v === 'number' ? v : Number(v ?? 0); return Number.isFinite(n) ? n : 0; };

/** Worked minutes ÷ days worked, rounded (0 without worked days). */
export function averageWorkedMinutes(workedMinutes: number, daysWorked: number): number {
  return daysWorked > 0 ? Math.round(workedMinutes / daysWorked) : 0;
}

/** emp (the employee set, optionally one ordered page of it), rec (the live figures), fin (the finalised figures). */
function ctes(organizationId: string, period: AttendanceSummaryPeriod, s: AttendanceSummaryScope, page: { limit: number; offset: number } | null): RawBuilder<unknown> {
  const like = s.search ? likeContains(s.search) : null;
  const employeeBranches = ids(s.employeeBranchIds);
  const recordBranches = ids(s.recordBranchIds);
  const employees = ids(s.employeeIds);
  const paging = page ? sql`order by e.display_name, e.id limit ${page.limit} offset ${page.offset}` : sql``;
  return sql`
    with emp as (
      select e.id, e.employee_number::text as employee_number, e.display_name, e.branch_id, e.department_id
      from public.employees e
      where e.organization_id = ${organizationId}::uuid and e.deleted_at is null
        and e.joining_date <= ${period.to}::date and (e.exit_date is null or e.exit_date >= ${period.from}::date)
        and (${employeeBranches}::uuid[] is null or e.branch_id = any(${employeeBranches}::uuid[]))
        and (${s.departmentId}::uuid is null or e.department_id = ${s.departmentId}::uuid)
        and (${employees}::uuid[] is null or e.id = any(${employees}::uuid[]))
        and (${like}::text is null or e.display_name ilike ${like}::text or e.employee_number::text ilike ${like}::text)
      ${paging}
    ),
    rec as (
      select r.employee_id,
        count(*)::int as record_count,
        coalesce(sum(case when r.status in ('PRESENT', 'MISSING_PUNCH') then (case when 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 1 end)
                          when r.status = 'HALF_DAY' then 0.5 else 0 end), 0)::numeric as present_days,
        (count(*) filter (where 'LATE' = any(r.flags)))::int as late_days,
        (count(*) filter (where r.status = 'HALF_DAY' or (r.status in ('PRESENT', 'MISSING_PUNCH') and 'HALF_DAY_LEAVE' = any(r.flags))))::int as half_days,
        coalesce(sum(case when r.status = 'LEAVE' then 1
                          when r.status in ('PRESENT', 'MISSING_PUNCH', 'HALF_DAY', 'ABSENT') and 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 0 end), 0)::numeric as leave_days,
        coalesce(sum(case when r.status = 'ABSENT' then (case when 'HALF_DAY_LEAVE' = any(r.flags) then 0.5 else 1 end)
                          when r.status = 'HALF_DAY' and not ('HALF_DAY_LEAVE' = any(r.flags)) then 0.5 else 0 end), 0)::numeric as absent_days,
        (count(*) filter (where r.status = 'MISSING_PUNCH' or r.flags && array['MISSING_IN', 'MISSING_OUT']::text[]))::int as missing_punch_days,
        (count(*) filter (where r.status = 'HOLIDAY'))::int as holiday_days,
        (count(*) filter (where r.status = 'WEEKLY_OFF'))::int as weekly_off_days,
        (count(*) filter (where r.worked_minutes > 0))::int as days_worked,
        coalesce(sum(greatest(r.worked_minutes, 0)), 0)::bigint as worked_minutes,
        coalesce(sum(greatest(r.overtime_minutes, 0)), 0)::bigint as overtime_minutes,
        coalesce(sum(case when 'LOP' = any(r.flags) then (case when 'PAY_EFFECT_FULL' = any(r.flags) then 1 when 'PAY_EFFECT_HALF' = any(r.flags) then 0.5 else 0 end) else 0 end), 0)::numeric as lop_days,
        (count(*) filter (where 'UNEXCUSED' = any(r.flags)))::int as unexcused_days,
        (count(*) filter (where r.status = 'PENDING'))::int as pending_days
      from public.attendance_daily_records r
      where r.organization_id = ${organizationId}::uuid and r.attendance_date between ${period.from}::date and ${period.to}::date
        and r.employee_id in (select id from emp)
        and (${recordBranches}::uuid[] is null or r.branch_id = any(${recordBranches}::uuid[]))
      group by r.employee_id
    ),
    fin as (
      select distinct on (s.employee_id) s.employee_id, s.present_days, s.late_days, s.half_days, s.leave_days, s.absent_days, s.missing_punch_days, s.holiday_days, s.weekly_off_days,
        (s.regular_minutes + s.overtime_minutes + s.overtime_weekly_off_minutes + s.overtime_holiday_minutes)::bigint as worked_minutes,
        (s.overtime_minutes + s.overtime_weekly_off_minutes + s.overtime_holiday_minutes)::bigint as overtime_minutes,
        s.lop_days, s.unexcused_days, s.finalized_at
      from public.attendance_period_summaries s
      where ${s.includeFinalized}::boolean and s.organization_id = ${organizationId}::uuid and s.period_start = ${period.from}::date and s.period_end = ${period.to}::date
        and s.status = 'finalized' and s.employee_id in (select id from emp)
        and (${recordBranches}::uuid[] is null or s.branch_id = any(${recordBranches}::uuid[]))
      order by s.employee_id, s.version desc
    )`;
}

/** The per-employee figures, finalised counts first (shared by the page rows and the totals). */
const FIGURES = sql`
  coalesce(fin.present_days, rec.present_days, 0) as "presentDays", coalesce(fin.late_days, rec.late_days, 0) as "lateDays", coalesce(fin.half_days, rec.half_days, 0) as "halfDays",
  coalesce(fin.leave_days, rec.leave_days, 0) as "leaveDays", coalesce(fin.absent_days, rec.absent_days, 0) as "absentDays",
  coalesce(fin.missing_punch_days, rec.missing_punch_days, 0) as "missingPunchDays", coalesce(fin.holiday_days, rec.holiday_days, 0) as "holidayDays",
  coalesce(fin.weekly_off_days, rec.weekly_off_days, 0) as "weeklyOffDays", coalesce(rec.days_worked, 0) as "daysWorked",
  coalesce(fin.worked_minutes, rec.worked_minutes, 0) as "workedMinutes", coalesce(fin.overtime_minutes, rec.overtime_minutes, 0) as "overtimeMinutes",
  coalesce(fin.lop_days, rec.lop_days, 0) as "lopDays", coalesce(fin.unexcused_days, rec.unexcused_days, 0) as "unexcusedDays",
  coalesce(rec.pending_days, 0) as "pendingDays", coalesce(rec.record_count, 0) as "recordCount"`;

const FIGURE_KEYS = ['presentDays', 'lateDays', 'halfDays', 'leaveDays', 'absentDays', 'missingPunchDays', 'holidayDays', 'weeklyOffDays', 'daysWorked', 'workedMinutes', 'overtimeMinutes', 'lopDays', 'unexcusedDays', 'pendingDays', 'recordCount'] as const;

function figuresOf(r: Record<string, unknown>): AttendanceSummaryDbFigures {
  const out = Object.fromEntries(FIGURE_KEYS.map((k) => [k, num(r[k])])) as Record<(typeof FIGURE_KEYS)[number], number>;
  return { ...out, averageWorkedMinutes: averageWorkedMinutes(out.workedMinutes, out.daysWorked) };
}

/**
 * One page of the summary, ordered by name then id; `page` null = every employee in scope (bounded by the caller). Paging
 * happens in SQL on the employee set BEFORE the figures are aggregated, so a page costs a page (review defect 9).
 */
export async function attendanceSummaryRows(trx: Trx, organizationId: string, period: AttendanceSummaryPeriod, scope: AttendanceSummaryScope, page: { limit: number; offset: number } | null): Promise<AttendanceSummaryDbRow[]> {
  const res = await sql<Record<string, unknown>>`${ctes(organizationId, period, scope, page)}
    select emp.id as "employeeId", emp.employee_number as "employeeNumber", emp.display_name as "employeeName", emp.branch_id as "branchId", emp.department_id as "departmentId",
      ${FIGURES}, fin.finalized_at as "finalizedAt"
    from emp left join rec on rec.employee_id = emp.id left join fin on fin.employee_id = emp.id
    order by emp.display_name, emp.id`.execute(trx);
  return res.rows.map((r) => ({
    ...figuresOf(r), employeeId: String(r['employeeId']), employeeNumber: String(r['employeeNumber']), employeeName: String(r['employeeName']), branchId: String(r['branchId']),
    departmentId: r['departmentId'] === null || r['departmentId'] === undefined ? null : String(r['departmentId']), finalizedAt: r['finalizedAt'] instanceof Date ? r['finalizedAt'] : r['finalizedAt'] ? new Date(String(r['finalizedAt'])) : null,
  }));
}

/** The number of employees in scope and the totals of their figures (one aggregate over the whole filtered set). */
export async function attendanceSummaryTotals(trx: Trx, organizationId: string, period: AttendanceSummaryPeriod, scope: AttendanceSummaryScope): Promise<{ employees: number; totals: AttendanceSummaryDbFigures }> {
  // literal quoted aliases (constants): a `sql.ref` would be snake-cased by the CamelCasePlugin and miss the camelCase columns
  const sums = sql.raw(FIGURE_KEYS.map((k) => `coalesce(sum(x."${k}"), 0) as "${k}"`).join(', '));
  const res = await sql<Record<string, unknown>>`${ctes(organizationId, period, scope, null)}
    select count(*)::int as "employees", ${sums}
    from (select ${FIGURES} from emp left join rec on rec.employee_id = emp.id left join fin on fin.employee_id = emp.id) x`.execute(trx);
  const row = res.rows[0] ?? {};
  return { employees: num(row['employees']), totals: figuresOf(row) };
}

/** The number of employees in scope (cheap: no figures). */
export async function attendanceSummaryCount(trx: Trx, organizationId: string, period: AttendanceSummaryPeriod, scope: AttendanceSummaryScope): Promise<number> {
  const res = await sql<{ n: number }>`${ctes(organizationId, period, { ...scope, includeFinalized: false }, null)} select count(*)::int as n from emp`.execute(trx);
  return num(res.rows[0]?.n);
}

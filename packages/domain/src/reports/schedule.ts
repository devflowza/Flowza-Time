import { DateTime } from 'luxon';
import { MONTH_PARAMETER_REPORT_TYPES, REPORT_TYPE_DEFINITIONS, WEEK_PARAMETER_REPORT_TYPES, type ReportPeriodRule, type ReportScheduleCadence, type ReportType } from '@flowza/contracts';
import { isValidTimezone } from '@flowza/shared';

/**
 * Report schedules (HR portal Prompt 6a) — pure timing and scope rules shared by the API (next run on save, validation,
 * preview of the next period) and the worker (due runs, per-recipient generation). Every instant is computed in the
 * ORGANISATION's IANA zone: "the 1st at 07:00" means 07:00 on the wall clock of the tenant, across DST changes.
 */

export interface ScheduleTiming {
  cadence: ReportScheduleCadence;
  /** monthly: day of month 1–28; weekly: 0 = Sunday … 6 = Saturday. */
  runDay: number;
  /** `HH:mm` or `HH:mm:ss`, local time. */
  runTime: string;
  timezone: string;
}

export interface SchedulePeriodRule {
  periodRule: ReportPeriodRule;
  customFromDay?: number | null;
  customToDay?: number | null;
  /** First day of the week for `previous_week` (0 = Sunday … 6 = Saturday; organisation setting general.firstDayOfWeek). */
  firstDayOfWeek?: number;
}

export interface ReportPeriod { from: string; to: string }

const zoneOf = (tz: string): string => (tz && isValidTimezone(tz) ? tz : 'UTC');

function clock(runTime: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})/.exec(runTime);
  const hour = m ? Math.min(23, Number(m[1])) : 7;
  const minute = m ? Math.min(59, Number(m[2])) : 0;
  return { hour, minute };
}

/** Luxon weekday (1 = Monday … 7 = Sunday) of a 0 = Sunday … 6 = Saturday day number. */
const luxonWeekday = (day: number): number => (((day % 7) + 7) % 7 === 0 ? 7 : ((day % 7) + 7) % 7);

/** The occurrence of the schedule in the month / week that contains `local` (it may lie before or after `local`). */
function occurrenceAround(t: ScheduleTiming, local: DateTime): DateTime {
  const { hour, minute } = clock(t.runTime);
  if (t.cadence === 'monthly') return local.set({ day: Math.min(28, Math.max(1, t.runDay)), hour, minute, second: 0, millisecond: 0 });
  const target = luxonWeekday(t.runDay);
  return local.set({ hour, minute, second: 0, millisecond: 0 }).plus({ days: target - local.weekday });
}

const step = (t: ScheduleTiming, dt: DateTime, n: number): DateTime => {
  const moved = t.cadence === 'monthly' ? dt.plus({ months: n }).set({ day: Math.min(28, Math.max(1, t.runDay)) }) : dt.plus({ weeks: n });
  const { hour, minute } = clock(t.runTime);
  // re-anchor the wall-clock time after the move (a DST change between the two dates must not drift the run time)
  return moved.set({ hour, minute, second: 0, millisecond: 0 });
};

/** The first occurrence strictly after `after`. */
export function nextScheduleRun(t: ScheduleTiming, after: Date): Date {
  const local = DateTime.fromJSDate(after, { zone: zoneOf(t.timezone) });
  let candidate = occurrenceAround(t, local);
  if (candidate.toMillis() <= local.toMillis()) candidate = step(t, candidate, 1);
  return candidate.toUTC().toJSDate();
}

/** The last occurrence at or before `at` (the one a late run should cover — never an older one). */
export function latestScheduleRunAtOrBefore(t: ScheduleTiming, at: Date): Date {
  const local = DateTime.fromJSDate(at, { zone: zoneOf(t.timezone) });
  let candidate = occurrenceAround(t, local);
  if (candidate.toMillis() > local.toMillis()) candidate = step(t, candidate, -1);
  return candidate.toUTC().toJSDate();
}

/**
 * Which occurrence a due run covers. Normally the stored `next_run_at`; when the scheduler was down for longer than one
 * cadence the stored time is stale, and the run covers the LATEST missed occurrence instead of replaying an old period
 * (missed intermediate occurrences are counted, not sent — a report for a period long past helps nobody).
 */
export function dueOccurrence(t: ScheduleTiming, storedNextRunAt: Date, now: Date): { scheduledFor: Date; missed: number } {
  const latest = latestScheduleRunAtOrBefore(t, now);
  if (storedNextRunAt.getTime() >= latest.getTime()) return { scheduledFor: storedNextRunAt, missed: 0 };
  let missed = 0;
  let cursor = storedNextRunAt;
  while (cursor.getTime() < latest.getTime() && missed < 1000) { missed += 1; cursor = nextScheduleRun(t, cursor); }
  return { scheduledFor: latest, missed };
}

/**
 * The period an occurrence covers, as inclusive local dates (organisation zone), always COMPLETE days:
 *  - previous_month: the whole calendar month before the run's month;
 *  - month_to_date: the first of the month up to YESTERDAY (a run on the 1st therefore covers the whole previous month);
 *  - previous_week: the whole week before the run's week (weeks start on `firstDayOfWeek`);
 *  - custom: the last complete cut-off period `customFromDay` of one month → `customToDay` of the next (e.g. 26 → 25),
 *    i.e. the one ending before the run's date.
 */
export function schedulePeriod(rule: SchedulePeriodRule, scheduledFor: Date, timezone: string): ReportPeriod {
  const local = DateTime.fromJSDate(scheduledFor, { zone: zoneOf(timezone) }).startOf('day');
  const iso = (d: DateTime) => d.toISODate() ?? '';
  switch (rule.periodRule) {
    case 'previous_month': {
      const start = local.startOf('month').minus({ months: 1 });
      return { from: iso(start), to: iso(start.endOf('month')) };
    }
    case 'month_to_date': {
      const to = local.minus({ days: 1 });
      return { from: iso(to.startOf('month')), to: iso(to) };
    }
    case 'previous_week': {
      const first = luxonWeekday(rule.firstDayOfWeek ?? 0);
      const offset = (local.weekday - first + 7) % 7;
      const weekStart = local.minus({ days: offset });
      const from = weekStart.minus({ weeks: 1 });
      return { from: iso(from), to: iso(from.plus({ days: 6 })) };
    }
    case 'custom': {
      const fromDay = Math.min(28, Math.max(1, rule.customFromDay ?? 26));
      const toDay = Math.min(28, Math.max(1, rule.customToDay ?? 25));
      let to = local.set({ day: toDay });
      if (to.toMillis() >= local.toMillis()) to = to.minus({ months: 1 }).set({ day: toDay });
      const from = to.minus({ months: 1 }).set({ day: fromDay });
      return { from: iso(from), to: iso(to) };
    }
    default: {
      const exhaustive: never = rule.periodRule;
      throw new Error(`unknown period rule ${String(exhaustive)}`);
    }
  }
}

/**
 * The report's period parameters for a period: whole-month types get `month`, one-week types the week's first day in
 * `from`, range types `from`/`to`; types without a period (the employee directory) get none.
 */
export function periodParameters(reportType: ReportType, period: ReportPeriod): Record<string, string> {
  const def = REPORT_TYPE_DEFINITIONS.find((d) => d.key === reportType);
  if (!def) return {};
  if (MONTH_PARAMETER_REPORT_TYPES.includes(reportType)) return { month: period.from.slice(0, 7) };
  if (WEEK_PARAMETER_REPORT_TYPES.includes(reportType)) return { from: period.from };
  const out: Record<string, string> = {};
  if (def.requiredParameters.includes('from') || def.optionalParameters.includes('from')) out['from'] = period.from;
  if (def.requiredParameters.includes('to') || def.optionalParameters.includes('to')) out['to'] = period.to;
  return out;
}

// ---- per-recipient scope ---------------------------------------------------------------------------------------------------

/** What the worker knows about one recipient's membership (same fields as the API's MembershipGrant). */
export interface RecipientGrant {
  userId: string;
  permissions: readonly string[];
  allBranches: boolean;
  branchIds: readonly string[];
  /** Direct reports (primary or secondary manager), leavers excluded — the same set as `app.team_employee_ids()`. */
  teamEmployeeIds?: readonly string[];
}

/** Line-manager variants of the organisation-wide read permissions a report type can require. */
export const TEAM_PERMISSION_VARIANTS: Readonly<Record<string, string>> = {
  'attendance.view': 'attendance.view_team',
  'leave.view': 'leave.view_team',
  'employee.view': 'employee.view_team',
};

export type RecipientScopeKind = 'ORGANIZATION' | 'BRANCHES' | 'TEAM';
export type RecipientScopeDecision =
  | { ok: true; kind: RecipientScopeKind; parameters: Record<string, unknown>; branchId: string | null; branchCount: number | null; employeeCount: number | null }
  | { ok: false; reason: string };

/**
 * The parameters a report is generated with FOR ONE RECIPIENT — never more than the recipient could see by requesting it
 * themselves — or a refusal:
 *  - the recipient must hold report.view and report.export (to download it);
 *  - every permission of the report type, or — for the organisation-wide reads — its line-manager variant, in which case
 *    the report is restricted to the recipient's direct reports (TEAM scope, `employeeIds` injected);
 *  - an explicit branch / employee filter must sit inside the recipient's scope (never widened, and never silently narrowed
 *    into a different report than the sender chose);
 *  - a branch-restricted recipient gets their branch scope injected (`branchScope` / `branchIds` / `branchId`), so the
 *    worker's report scope can only ever narrow to what the recipient may see.
 */
export function scopeReportForRecipient(
  grant: RecipientGrant,
  reportType: ReportType,
  parameters: Record<string, unknown>,
  employeeBranches: ReadonlyMap<string, string>,
): RecipientScopeDecision {
  const def = REPORT_TYPE_DEFINITIONS.find((d) => d.key === reportType);
  if (!def || def.status !== 'available') return { ok: false, reason: 'report_type_unavailable' };
  for (const p of ['report.view', 'report.export']) if (!grant.permissions.includes(p)) return { ok: false, reason: `missing_permission:${p}` };
  let teamOnly = false;
  for (const p of def.permissions) {
    if (grant.permissions.includes(p)) continue;
    const variant = TEAM_PERMISSION_VARIANTS[p];
    if (variant && grant.permissions.includes(variant)) { teamOnly = true; continue; }
    return { ok: false, reason: `missing_permission:${p}` };
  }
  const out: Record<string, unknown> = { ...parameters };
  delete out['branchScope']; delete out['branchIds'];
  let branchId = typeof out['branchId'] === 'string' ? (out['branchId'] as string) : null;
  const requested = Array.isArray(out['employeeIds']) ? (out['employeeIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  for (const id of requested) if (!employeeBranches.has(id)) return { ok: false, reason: 'outside_scope:employees' };
  if (!grant.allBranches) {
    if (grant.branchIds.length === 0) return { ok: false, reason: 'no_branch_access' };
    if (branchId && !grant.branchIds.includes(branchId)) return { ok: false, reason: 'outside_scope:branch' };
    for (const id of requested) if (!grant.branchIds.includes(employeeBranches.get(id) ?? '')) return { ok: false, reason: 'outside_scope:employees' };
  }
  let employeeCount: number | null = null;
  if (teamOnly) {
    const team = new Set(grant.teamEmployeeIds ?? []);
    if (team.size === 0) return { ok: false, reason: 'no_team' };
    if (requested.some((id) => !team.has(id))) return { ok: false, reason: 'outside_scope:employees' };
    const ids = requested.length ? requested : [...team].sort();
    out['employeeIds'] = ids;
    employeeCount = ids.length;
  }
  if (grant.allBranches) {
    if (branchId) out['branchId'] = branchId;
    return { ok: true, kind: teamOnly ? 'TEAM' : 'ORGANIZATION', parameters: out, branchId: teamOnly ? null : branchId, branchCount: null, employeeCount };
  }
  if (!branchId) {
    // a single-branch holder's report is that branch's; a team report stays across the holder's branches
    if (grant.branchIds.length === 1 && !teamOnly) branchId = grant.branchIds[0]!;
    else out['branchIds'] = [...grant.branchIds];
  }
  out['branchScope'] = [...grant.branchIds];
  if (branchId) out['branchId'] = branchId;
  return { ok: true, kind: teamOnly ? 'TEAM' : 'BRANCHES', parameters: out, branchId: teamOnly ? null : branchId, branchCount: grant.branchIds.length, employeeCount };
}

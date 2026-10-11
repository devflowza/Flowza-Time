import { sql } from 'kysely';
import { COUNTRY_PACK_CODES, COUNTRY_RULE_PACKS, countryRulePack, DEFAULT_POLICY_SECTIONS, type AttendancePointsDetailDto, type AttendancePointsRowDto, type AttendanceRuleSetInput, type CountryRulePack, type OvertimeSummaryRowDto, type PolicyCandidateDto, type PolicyComplianceDto, type PolicyResolutionDto, type PolicyScopeDto } from '@flowza/contracts';
import { explainPolicyFor, type RuleSetRow, type Trx } from '@flowza/database';
import { checkPolicyCompliance, computeAttendancePoints, monthBounds, overtimeSummaryFrom, summariseOvertime, type AttendancePointsResult, type MembershipGrant, type PointsDayRecord } from '@flowza/domain';
import { addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, runUser, withSystemScope } from '../../lib/service.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { isoDate } from '../../lib/mappers.js';
import { orgToday } from '../features/recalc.js';
import { dv } from '../features/sql-helpers.js';
import { placementsOn, policiesOn, shiftScheduledMinutes, type EmployeePolicy } from './placement.js';

/*
 * Global attendance policies (Enterprise, attendance_policies — docs/enterprise/plan.md §4–§7): "which policy applies", the
 * country rule packs and the compliance check of a draft, the attendance points & discipline report and the overtime summary.
 * Every endpoint reads with attendance.view; employees are listed under the caller's RLS and branch scope, and each one's policy
 * is resolved exactly as the engine resolves it (placement.ts, in the organisation's system scope).
 */

const NIL = '00000000-0000-0000-0000-000000000000';
const scopeOf = (row: RuleSetRow): PolicyScopeDto => ({ countryCode: row.countryCode?.trim() || null, branchId: row.branchId, departmentId: row.departmentId, employeeGroupId: row.employeeGroupId, shiftId: row.shiftId, locationId: row.locationId });

/** The employee, read under the caller's RLS (404 when hidden or deleted) and inside their branch scope (403). */
async function authoriseEmployee(trx: Trx, grant: MembershipGrant, orgId: string, employeeId: string): Promise<{ id: string; branchId: string; employeeNumber: string; displayName: string }> {
  const e = await trx.selectFrom('employees').select(['id', 'branchId', 'employeeNumber', 'displayName']).where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!e) throw errors.notFound('Employee', employeeId);
  requireBranchAccess(grant, e.branchId);
  return { ...e, employeeNumber: String(e.employeeNumber) };
}

// ----- which policy applies ------------------------------------------------------------------------------------------------------

/**
 * GET /attendance-policies/resolve — where the employee sits on the date and every policy with the reason it does (not) apply,
 * winner first. A branch-scoped caller sees the organisation-wide policies and those of their branches (what RLS shows them on
 * the rule-set list) — plus the winner, which governs an employee they may see.
 */
export async function resolveEmployeePolicy(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, date: string): Promise<PolicyResolutionDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    await authoriseEmployee(trx, grant, orgId, employeeId);
    const explained = await withSystemScope(trx, orgId, async (t) => {
      const placement = (await placementsOn(t, orgId, [employeeId], date)).get(employeeId);
      if (!placement) throw errors.notFound('Employee', employeeId);
      return explainPolicyFor(t, orgId, employeeId, date, placement);
    });
    const winnerId = explained.winner?.id ?? null;
    const visible = (row: RuleSetRow) => grant.allBranches || row.id === winnerId || row.branchId === null || grant.branchIds.includes(row.branchId);
    const candidates: PolicyCandidateDto[] = explained.candidates.filter((c) => visible(c.policy.row)).map((c) => ({
      id: c.policy.id, name: c.policy.row.name, scope: scopeOf(c.policy.row), effectiveFrom: c.policy.effectiveFrom, effectiveTo: c.policy.effectiveTo,
      specificity: c.specificity, matches: c.mismatch === null, mismatch: c.mismatch,
    }));
    const winner = explained.winner ? candidates.find((c) => c.id === explained.winner!.id) ?? null : null;
    const { locationIds, ...scope } = explained.scope;
    const chain = [...(locationIds ?? [])];
    return { employeeId, date, scope: { ...scope, locationId: chain.at(-1) ?? null, locationIds: chain }, policy: winner ? { id: winner.id, name: winner.name, specificity: winner.specificity } : null, candidates };
  });
}

// ----- country packs and compliance -----------------------------------------------------------------------------------------------

export function listCountryPacks(actor: Actor, orgId: string): CountryRulePack[] {
  requirePermission(actor.principal, orgId, 'attendance.view');
  return COUNTRY_PACK_CODES.map((code) => COUNTRY_RULE_PACKS[code]);
}

/** POST /attendance-policies/compliance — a policy draft against a country pack: warnings only (HR decides). No pack, no opinion. */
export async function checkCompliance(deps: ApiDeps, actor: Actor, orgId: string, countryCode: string, draft: AttendanceRuleSetInput): Promise<PolicyComplianceDto> {
  requirePermission(actor.principal, orgId, 'attendance.view');
  const pack = countryRulePack(countryCode);
  if (!pack) return { countryCode, packVersion: null, warnings: [] };
  const shiftScheduled: number[] = [];
  if (draft.shiftId) {
    const shift = await runUser(deps.db, actor, (trx) => trx.selectFrom('shifts').select(['type', 'startTime', 'endTime', 'requiredMinutes', 'breaks']).where('organizationId', '=', orgId).where('id', '=', draft.shiftId!).executeTakeFirst());
    if (shift) shiftScheduled.push(shiftScheduledMinutes(shift));
  }
  return { countryCode, packVersion: pack.version, warnings: checkPolicyCompliance(draft, pack, { shiftScheduledMinutes: shiftScheduled }) };
}

// ----- the employee page of the reports -------------------------------------------------------------------------------------------

interface EmployeePageFilter { branchScope: string[] | null; departmentId?: string; employeeGroupId?: string; search?: string; employedFrom: string; employedTo: string; groupOn: string }

/** Employees employed during [employedFrom, employedTo], filtered, under the caller's RLS; the page is ordered by name. */
function employeePage(trx: Trx, orgId: string, f: EmployeePageFilter) {
  let q = trx.selectFrom('employees as e').where('e.organizationId', '=', orgId).where('e.deletedAt', 'is', null)
    .where('e.joiningDate', '<=', dv(f.employedTo)).where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', dv(f.employedFrom))]));
  if (f.branchScope) q = q.where('e.branchId', 'in', f.branchScope.length ? f.branchScope : [NIL]);
  if (f.departmentId) q = q.where('e.departmentId', '=', f.departmentId);
  if (f.employeeGroupId) {
    const groupId = f.employeeGroupId; const on = f.groupOn;
    q = q.where((eb) => eb.exists(eb.selectFrom('employeeGroupMemberships as gm').select('gm.id')
      .whereRef('gm.employeeId', '=', 'e.id').where('gm.organizationId', '=', orgId).where('gm.employeeGroupId', '=', groupId)
      .where('gm.effectiveFrom', '<=', dv(on)).where((w) => w.or([w('gm.effectiveTo', 'is', null), w('gm.effectiveTo', '>', dv(on))]))));
  }
  if (f.search) { const like = likeContains(f.search); q = q.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb(sql`e.employee_number::text`, 'ilike', like)])); }
  return q;
}

async function pageOfEmployees(trx: Trx, orgId: string, f: EmployeePageFilter, q: { page: number; pageSize: number }) {
  const base = employeePage(trx, orgId, f);
  const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
  const page = pageOf(q);
  const rows = await base.select(['e.id', 'e.employeeNumber', 'e.displayName', 'e.branchId']).orderBy('e.displayName').orderBy('e.id').limit(page.pageSize).offset(page.offset).execute();
  return { total, employees: rows.map((r) => ({ id: r.id, employeeNumber: String(r.employeeNumber), displayName: r.displayName, branchId: r.branchId })) };
}

// ----- attendance points & discipline -----------------------------------------------------------------------------------------------

function pointsRow(e: { id: string; employeeNumber: string; displayName: string; branchId: string }, policy: EmployeePolicy | undefined, r: AttendancePointsResult): AttendancePointsRowDto {
  return {
    employeeId: e.id, employeeNumber: e.employeeNumber, displayName: e.displayName, branchId: e.branchId,
    policyId: policy?.row?.id ?? null, policyName: policy?.row?.name ?? null, pointsEnabled: r.enabled,
    points: r.total, occurrences: r.occurrences, escalation: r.escalation, nextEscalation: r.nextEscalation,
  };
}

/** Daily records (status + flags) of the employees from `from` to `to`, as the caller may read them. */
async function pointRecords(trx: Trx, orgId: string, employeeIds: string[], from: string, to: string): Promise<Map<string, PointsDayRecord[]>> {
  const out = new Map<string, PointsDayRecord[]>();
  if (employeeIds.length === 0) return out;
  const rows = await trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'attendanceDate', 'status', 'flags'])
    .where('organizationId', '=', orgId).where('employeeId', 'in', employeeIds).where('attendanceDate', '>=', dv(from)).where('attendanceDate', '<=', dv(to)).execute();
  for (const r of rows) out.set(r.employeeId, [...(out.get(r.employeeId) ?? []), { date: isoDate(r.attendanceDate), status: r.status, flags: [...r.flags] }]);
  return out;
}

function standings(employees: Array<{ id: string }>, policies: Map<string, EmployeePolicy>, records: Map<string, PointsDayRecord[]>, asOf: string): Map<string, AttendancePointsResult> {
  const out = new Map<string, AttendancePointsResult>();
  for (const e of employees) {
    // an employee without a placement (no employment record on the date) has no policy: the defaults, points off
    out.set(e.id, computeAttendancePoints(records.get(e.id) ?? [], policies.get(e.id)?.sections ?? DEFAULT_POLICY_SECTIONS, asOf));
  }
  return out;
}

/** The earliest window start among the page's policies (points off → nothing to read). */
function earliestWindow(policies: Iterable<EmployeePolicy>, asOf: string): string | null {
  let from: string | null = null;
  for (const p of policies) {
    if (!p.sections.points.enabled) continue;
    const start = addDays(asOf, -(p.sections.points.expiryDays - 1));
    if (from === null || start < from) from = start;
  }
  return from;
}

/**
 * GET /attendance-policies/points — the page of employees first (filters, RLS, branch scope), then each one's policy on `asOf`
 * and the daily records of its rolling window. `minPoints` thins the computed page (the total counts the employees).
 */
export async function listAttendancePoints(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; asOf?: string; branchId?: string; departmentId?: string; employeeGroupId?: string; search?: string; minPoints?: number }): Promise<{ data: AttendancePointsRowDto[]; total: number; asOf: string }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const branchScope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    const asOf = q.asOf ?? (await orgToday(trx, orgId));
    const { total, employees } = await pageOfEmployees(trx, orgId, { branchScope, departmentId: q.departmentId, employeeGroupId: q.employeeGroupId, search: q.search, employedFrom: asOf, employedTo: asOf, groupOn: asOf }, q);
    const ids = employees.map((e) => e.id);
    const policies = await withSystemScope(trx, orgId, (t) => policiesOn(t, orgId, ids, asOf));
    const from = earliestWindow(policies.values(), asOf);
    const scored = ids.filter((id) => policies.get(id)?.sections.points.enabled);
    const records = from ? await pointRecords(trx, orgId, scored, from, asOf) : new Map<string, PointsDayRecord[]>();
    const results = standings(employees, policies, records, asOf);
    const data = employees.map((e) => pointsRow(e, policies.get(e.id), results.get(e.id)!)).filter((r) => q.minPoints === undefined || r.points >= q.minPoints);
    return { data, total, asOf };
  });
}

/** GET /attendance-policies/points/:employeeId — the standing with every event of the window. */
export async function attendancePointsDetail(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, q: { asOf?: string }): Promise<AttendancePointsDetailDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const e = await authoriseEmployee(trx, grant, orgId, employeeId);
    const asOf = q.asOf ?? (await orgToday(trx, orgId));
    const policies = await withSystemScope(trx, orgId, (t) => policiesOn(t, orgId, [employeeId], asOf));
    const from = earliestWindow(policies.values(), asOf);
    const records = from ? await pointRecords(trx, orgId, [employeeId], from, asOf) : new Map<string, PointsDayRecord[]>();
    const result = standings([e], policies, records, asOf).get(employeeId)!;
    const policyId = policies.get(employeeId)?.row?.id ?? null;
    return { ...pointsRow(e, policies.get(employeeId), result), asOf, windowFrom: result.windowFrom, events: result.events.map((ev) => ({ ...ev, policyId })) };
  });
}

// ----- overtime summary -------------------------------------------------------------------------------------------------------------

/**
 * GET /attendance-policies/overtime-summary?month= — per employee employed during the month: overtime by category, weekly
 * overtime and the weighted minutes under the policy resolved on the month's last day. The records read start on the Monday
 * of the month's first ISO week (weekly overtime counts whole weeks whose Sunday is in the month).
 */
export async function listOvertimeSummary(deps: ApiDeps, actor: Actor, orgId: string, q: { page: number; pageSize: number; month: string; branchId?: string; departmentId?: string; employeeGroupId?: string; search?: string }): Promise<{ data: OvertimeSummaryRowDto[]; total: number; month: string }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  const branchScope = branchFilter(grant, q.branchId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw errors.validation('month must be YYYY-MM.', { issues: [{ path: 'month', message: 'Invalid month' }] });
  const { from, to } = monthBounds(q.month);
  return runUser(deps.db, actor, async (trx) => {
    const { total, employees } = await pageOfEmployees(trx, orgId, { branchScope, departmentId: q.departmentId, employeeGroupId: q.employeeGroupId, search: q.search, employedFrom: from, employedTo: to, groupOn: to }, q);
    const ids = employees.map((e) => e.id);
    const policies = await withSystemScope(trx, orgId, (t) => policiesOn(t, orgId, ids, to));
    const rows = ids.length ? await trx.selectFrom('attendanceDailyRecords').select(['employeeId', 'attendanceDate', 'workedMinutes', 'overtimeMinutes', 'overtimeCategory'])
      .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('attendanceDate', '>=', dv(overtimeSummaryFrom(q.month))).where('attendanceDate', '<=', dv(to)).execute() : [];
    const byEmployee = new Map<string, Array<{ date: string; workedMinutes: number; overtimeMinutes: number; overtimeCategory: string | null }>>();
    for (const r of rows) byEmployee.set(r.employeeId, [...(byEmployee.get(r.employeeId) ?? []), { date: isoDate(r.attendanceDate), workedMinutes: r.workedMinutes, overtimeMinutes: r.overtimeMinutes, overtimeCategory: r.overtimeCategory }]);
    const data = employees.map((e): OvertimeSummaryRowDto => {
      const policy = policies.get(e.id);
      const s = summariseOvertime(byEmployee.get(e.id) ?? [], { overtime: (policy?.sections ?? DEFAULT_POLICY_SECTIONS).overtime }, q.month);
      return {
        employeeId: e.id, employeeNumber: e.employeeNumber, displayName: e.displayName, branchId: e.branchId, policyId: policy?.row?.id ?? null, policyName: policy?.row?.name ?? null,
        workedMinutes: s.workedMinutes, regularOvertimeMinutes: s.regularOvertimeMinutes, weeklyOffOvertimeMinutes: s.weeklyOffOvertimeMinutes, holidayOvertimeMinutes: s.holidayOvertimeMinutes,
        weeklyOvertimeMinutes: s.weeklyOvertimeMinutes, weightedOvertimeMinutes: s.weightedOvertimeMinutes, daysOverDailyMaximum: s.daysOverDailyMaximum,
      };
    });
    return { data, total, month: q.month };
  });
}

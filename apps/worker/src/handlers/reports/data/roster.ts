import type { EmploymentStatus } from '@flowza/contracts';
import { uuidArray, type Trx } from '@flowza/database';
import { naturalCompare, resolvePolicy, resolveShift, type EngineRuleSet, type EngineShiftAssignment, type EngineShiftPattern } from '@flowza/domain';
import { asDate, chunk, isoDate } from '../../attendance/common.js';
import { toEnginePattern } from '../../attendance/load-inputs.js';
import type { ReportContext } from '../context.js';

export interface RosterEmployee {
  id: string;
  employeeNumber: string;
  displayName: string;
  branchId: string;
  branchName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  designationName: string | null;
  cardNumber: string | null;
  joiningDate: string;
  exitDate: string | null;
  employmentStatus: EmploymentStatus;
}

/** Active = working or on leave; everything else (suspended, terminated, resigned) is inactive. Soft-deleted rows never appear. */
export const ACTIVE_STATUSES: readonly EmploymentStatus[] = ['active', 'on_leave'];
export const INACTIVE_STATUSES: readonly EmploymentStatus[] = ['suspended', 'terminated', 'resigned'];

export interface RosterOptions {
  employeeIds?: readonly string[] | null;
  statuses?: readonly EmploymentStatus[] | null;
  /** Only employees employed at some point in this range (joined by `to`, not exited before `from`). */
  employedBetween?: { from: string; to: string } | null;
}

/** Employees in the report's scope with the display fields the sample layouts print. */
export async function loadRoster(trx: Trx, ctx: ReportContext, opts: RosterOptions = {}): Promise<RosterEmployee[]> {
  const ids = opts.employeeIds ?? ctx.scope.employeeIds;
  const out: RosterEmployee[] = [];
  const batches: Array<readonly string[] | null> = ids ? chunk(ids, 1000) : [null];
  for (const batch of batches) {
    if (batch && batch.length === 0) continue;
    let q = trx.selectFrom('employees as e')
      .leftJoin('departments as d', 'd.id', 'e.departmentId')
      .leftJoin('designations as g', 'g.id', 'e.designationId')
      .leftJoin('branches as b', 'b.id', 'e.branchId')
      .select(['e.id', 'e.employeeNumber', 'e.displayName', 'e.displayNameAr', 'e.branchId', 'b.name as branchName', 'e.departmentId', 'd.name as departmentName', 'd.nameAr as departmentNameAr', 'g.name as designationName', 'g.nameAr as designationNameAr', 'e.cardNumber', 'e.joiningDate', 'e.exitDate', 'e.employmentStatus'])
      .where('e.organizationId', '=', ctx.organizationId).where('e.deletedAt', 'is', null);
    if (batch) q = q.where('e.id', 'in', [...batch]);
    if (ctx.scope.branchIds) q = q.where('e.branchId', 'in', ctx.scope.branchIds.length ? ctx.scope.branchIds : ['00000000-0000-0000-0000-000000000000']);
    if (ctx.scope.departmentId) q = q.where('e.departmentId', '=', ctx.scope.departmentId);
    if (opts.statuses) q = q.where('e.employmentStatus', 'in', [...opts.statuses]);
    if (opts.employedBetween) q = q.where('e.joiningDate', '<=', asDate(opts.employedBetween.to)).where((eb) => eb.or([eb('e.exitDate', 'is', null), eb('e.exitDate', '>=', asDate(opts.employedBetween!.from))]));
    const rows = await q.execute();
    for (const r of rows) {
      out.push({
        id: r.id, employeeNumber: String(r.employeeNumber), displayName: (ctx.locale === 'ar' && r.displayNameAr) || r.displayName, branchId: r.branchId, branchName: r.branchName,
        departmentId: r.departmentId, departmentName: (ctx.locale === 'ar' && r.departmentNameAr) || r.departmentName, designationName: (ctx.locale === 'ar' && r.designationNameAr) || r.designationName,
        cardNumber: r.cardNumber, joiningDate: isoDate(r.joiningDate), exitDate: r.exitDate === null ? null : isoDate(r.exitDate), employmentStatus: r.employmentStatus,
      });
    }
  }
  return sortByEmployeeNumber(out);
}

export function sortByEmployeeNumber<T extends { employeeNumber: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => naturalCompare(a.employeeNumber, b.employeeNumber));
}

export interface DepartmentGroup<T> { label: string; items: T[] }

/**
 * Group by department name the way the samples do — alphabetical headings, employees in natural order under each,
 * and an "N/A" heading for employees without a department (it sorts by its label like any other).
 */
export function groupByDepartment<T>(ctx: ReportContext, items: readonly T[], departmentOf: (item: T) => string | null): DepartmentGroup<T>[] {
  const na = ctx.t('group.na');
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = departmentOf(item) ?? na;
    const list = groups.get(label) ?? [];
    list.push(item);
    groups.set(label, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, ctx.locale, { sensitivity: 'base' })).map(([label, list]) => ({ label, items: list }));
}

/** Shift names by id, in the report's locale — for the shift each daily record was calculated under. */
export async function loadShiftNames(trx: Trx, ctx: ReportContext): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('shifts').select(['id', 'name', 'nameAr']).where('organizationId', '=', ctx.organizationId).execute();
  return new Map(rows.map((s) => [s.id, (ctx.locale === 'ar' && s.nameAr) || s.name]));
}

export interface ShiftAndPolicy { shift: string | null; policy: string | null }

/**
 * Effective shift and attendance rule set ("Policy") per employee on `date`: the same precedence the engine uses
 * (employee > team > department > branch > organisation; branch rule set before the organisation default), resolved
 * for a whole roster with a handful of queries rather than one per employee.
 */
export async function loadShiftAndPolicy(trx: Trx, ctx: ReportContext, employees: readonly RosterEmployee[], date: string): Promise<Map<string, ShiftAndPolicy>> {
  const out = new Map<string, ShiftAndPolicy>();
  if (employees.length === 0) return out;
  const orgId = ctx.organizationId;
  const [assignmentRows, patternRows, shiftRows, ruleRows, branchRows, locationRows] = await Promise.all([
    trx.selectFrom('shiftAssignments').select(['id', 'targetType', 'targetId', 'shiftId', 'shiftPatternId', 'effectiveFrom', 'effectiveTo']).where('organizationId', '=', orgId)
      .where('effectiveFrom', '<=', asDate(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', asDate(date))])).execute(),
    trx.selectFrom('shiftPatterns').select(['id', 'name', 'cycleLengthDays', 'anchorDate', 'sequence']).where('organizationId', '=', orgId).execute(),
    trx.selectFrom('shifts').select(['id', 'name', 'nameAr', 'code']).where('organizationId', '=', orgId).execute(),
    trx.selectFrom('attendanceRuleSets').select(['id', 'name', 'branchId', 'countryCode', 'departmentId', 'employeeGroupId', 'shiftId', 'locationId', 'effectiveFrom', 'effectiveTo']).where('organizationId', '=', orgId).execute(),
    trx.selectFrom('branches').select(['id', 'countryCode']).where('organizationId', '=', orgId).execute(),
    // the location tree (docs/locations.md §3): policy depths and each employee's location chain
    trx.selectFrom('locations').select(['id', 'role', 'branchId', 'path']).where('organizationId', '=', orgId).execute(),
  ]);
  const pathOf = new Map(locationRows.map((l) => [l.id, uuidArray(l.path) ?? [l.id]]));
  const placeBranchOf = new Map(locationRows.map((l) => [l.id, l.branchId]));
  const branchNodeOf = new Map(locationRows.flatMap((l) => (l.role === 'branch' && l.branchId ? [[l.branchId, l.id] as const] : [])));
  const workLocationOf = new Map<string, string>();
  for (const batch of chunk(employees.map((e) => e.id), 1000)) {
    for (const r of await trx.selectFrom('employees').select(['id', 'workLocationId']).where('organizationId', '=', orgId).where('id', 'in', batch).where('workLocationId', 'is not', null).execute()) {
      if (r.workLocationId) workLocationOf.set(r.id, r.workLocationId);
    }
  }
  // the employee group of each employee on the date (Enterprise policy scope)
  const groupOf = new Map<string, string>();
  for (const batch of chunk(employees.map((e) => e.id), 1000)) {
    for (const m of await trx.selectFrom('employeeGroupMemberships').select(['employeeId', 'employeeGroupId']).where('organizationId', '=', orgId).where('employeeId', 'in', batch)
      .where('effectiveFrom', '<=', asDate(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', asDate(date))])).execute()) groupOf.set(m.employeeId, m.employeeGroupId);
  }
  const countryOf = new Map(branchRows.map((b) => [b.id, b.countryCode?.trim() || null]));
  const teamRows: Array<{ employeeId: string; teamId: string }> = [];
  for (const batch of chunk(employees.map((e) => e.id), 1000)) teamRows.push(...await trx.selectFrom('teamMembers').select(['employeeId', 'teamId']).where('organizationId', '=', orgId).where('employeeId', 'in', batch).execute());
  const teamsOf = new Map<string, string[]>();
  for (const t of teamRows) teamsOf.set(t.employeeId, [...(teamsOf.get(t.employeeId) ?? []), t.teamId]);

  const assignments: EngineShiftAssignment[] = assignmentRows.map((a) => ({ id: a.id, targetType: a.targetType, targetId: a.targetId, shiftId: a.shiftId, shiftPatternId: a.shiftPatternId, effectiveFrom: isoDate(a.effectiveFrom), effectiveTo: a.effectiveTo === null ? null : isoDate(a.effectiveTo) }));
  const patterns: EngineShiftPattern[] = patternRows.map(toEnginePattern);
  const patternName = new Map(patternRows.map((p) => [p.id, p.name]));
  const shiftName = new Map(shiftRows.map((s) => [s.id, (ctx.locale === 'ar' && s.nameAr) || s.name]));
  const depthOf = (id: string | null | undefined) => (id ? pathOf.get(id)?.length ?? null : null);
  const ruleSets: Array<EngineRuleSet & { name: string }> = ruleRows.map((r) => ({
    id: r.id, branchId: r.branchId, countryCode: r.countryCode, departmentId: r.departmentId, employeeGroupId: r.employeeGroupId, shiftId: r.shiftId,
    locationId: r.locationId, locationDepth: depthOf(r.locationId), branchDepth: r.branchId ? depthOf(branchNodeOf.get(r.branchId)) : null,
    effectiveFrom: isoDate(r.effectiveFrom), effectiveTo: r.effectiveTo === null ? null : isoDate(r.effectiveTo), rules: {} as EngineRuleSet['rules'], name: r.name,
  }));

  for (const e of employees) {
    const scope = { employeeId: e.id, teamIds: teamsOf.get(e.id) ?? [], departmentId: e.departmentId, branchId: e.branchId, organizationId: orgId };
    const resolved = resolveShift(assignments, patterns, scope, date);
    const shift = resolved.shiftId ? shiftName.get(resolved.shiftId) ?? null : resolved.assignment?.shiftPatternId ? patternName.get(resolved.assignment.shiftPatternId) ?? null : null;
    // the work location counts only inside the employee's branch; otherwise the branch's own node (loadPolicyScope's rule)
    const work = workLocationOf.get(e.id);
    const chainNode = work && placeBranchOf.get(work) === e.branchId ? work : branchNodeOf.get(e.branchId);
    const locationIds = chainNode ? pathOf.get(chainNode) : undefined;
    const rule = resolvePolicy(ruleSets, date, { countryCode: countryOf.get(e.branchId) ?? null, branchId: e.branchId, departmentId: e.departmentId, employeeGroupId: groupOf.get(e.id) ?? null, shiftId: resolved.shiftId, ...(locationIds ? { locationIds } : {}) });
    out.set(e.id, { shift, policy: rule?.name ?? null });
  }
  return out;
}

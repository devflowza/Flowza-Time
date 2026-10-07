import type { EmployeeGroupDto, EmployeeGroupInput, EmployeeGroupMemberDto, EmployeeGroupMembersInput, EmployeeGroupMembersResultDto, EndedEmployeeGroupMembershipDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { AppError, addDays, errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { requireBranchAccess, requirePermission } from '../../lib/authorize.js';
import { type Actor, audit, diffObjects, runUser, withSystemScope } from '../../lib/service.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { isoDate, isoDateTime } from '../../lib/mappers.js';
import { assignmentEndFromStored, assignmentEndToStored } from '../features/assignment-dates.js';
import { orgToday } from '../features/recalc.js';
import { recalcIfPast } from '../features/schedule.service.js';
import { dv } from '../features/sql-helpers.js';

/*
 * Employee groups (Enterprise, attendance_policies — docs/enterprise/plan.md §6): the "employee group" dimension of the attendance
 * policy scope (Office Staff, Sales Staff, Field Staff…) and the effective-dated memberships that put employees in them.
 *
 * - Read with attendance.view, write with attendance.manage_rules — checked here and again by RLS (migration 20261007000100).
 * - Groups are organisation-wide configuration: only callers with access to every branch create, rename or delete them (as for
 *   the organisation-wide rule set). Memberships are per employee: a branch-scoped caller manages the employees of their
 *   branches only (the memberships table has no branch column, so the service is the branch gate).
 * - The API speaks of inclusive last days; the table stores the exclusive bound (assignment-dates.ts).
 * - A membership change can move an employee to another policy: it recomputes the employee's days from the first affected
 *   date up to today (future dates are computed when they arrive).
 */

type GroupRow = { id: string; code: string; name: string; nameAr: string | null; description: string; status: string; createdAt: Date; updatedAt: Date };
const toGroupDto = (g: GroupRow, memberCount: number, policyCount: number): EmployeeGroupDto => ({
  id: g.id, code: String(g.code), name: g.name, nameAr: g.nameAr, description: g.description, status: g.status as EmployeeGroupDto['status'], memberCount, policyCount,
  createdAt: isoDateTime(g.createdAt), updatedAt: isoDateTime(g.updatedAt),
});

function requireAllBranches(grant: MembershipGrant): void {
  if (!grant.allBranches) throw errors.forbidden('Employee groups are organisation-wide: only users with access to every branch can change them.');
}

async function loadGroup(trx: Trx, orgId: string, id: string): Promise<GroupRow> {
  const g = await trx.selectFrom('employeeGroups').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!g) throw errors.notFound('Employee group', id);
  return g as GroupRow;
}

/** Members on `date` and policies (any date) per group. Policies are counted organisation-wide: a delete is refused on that count. */
async function groupCounts(trx: Trx, orgId: string, groupIds: string[], date: string): Promise<{ members: Map<string, number>; policies: Map<string, number> }> {
  if (groupIds.length === 0) return { members: new Map(), policies: new Map() };
  const members = await trx.selectFrom('employeeGroupMemberships').select(['employeeGroupId', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where('employeeGroupId', 'in', groupIds)
    .where('effectiveFrom', '<=', dv(date)).where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(date))]))
    .groupBy('employeeGroupId').execute();
  const policies = await withSystemScope(trx, orgId, (t) => t.selectFrom('attendanceRuleSets').select(['employeeGroupId', (eb) => eb.fn.countAll().as('n')])
    .where('organizationId', '=', orgId).where('employeeGroupId', 'in', groupIds).groupBy('employeeGroupId').execute());
  return {
    members: new Map(members.map((m) => [m.employeeGroupId, toCount(m.n)])),
    policies: new Map(policies.map((p) => [p.employeeGroupId as string, toCount(p.n)])),
  };
}

export async function listEmployeeGroups(deps: ApiDeps, actor: Actor, orgId: string, q: { status?: string; search?: string }): Promise<EmployeeGroupDto[]> {
  requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('employeeGroups').selectAll().where('organizationId', '=', orgId);
    if (q.status) base = base.where('status', '=', q.status as never);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb('code', 'ilike', like)])); }
    const rows = (await base.orderBy('name').orderBy('id').limit(1000).execute()) as GroupRow[];
    const counts = await groupCounts(trx, orgId, rows.map((r) => r.id), await orgToday(trx, orgId));
    return rows.map((r) => toGroupDto(r, counts.members.get(r.id) ?? 0, counts.policies.get(r.id) ?? 0));
  });
}

export async function getEmployeeGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<EmployeeGroupDto> {
  requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    const g = await loadGroup(trx, orgId, id);
    const counts = await groupCounts(trx, orgId, [id], await orgToday(trx, orgId));
    return toGroupDto(g, counts.members.get(id) ?? 0, counts.policies.get(id) ?? 0);
  });
}

export async function createEmployeeGroup(deps: ApiDeps, actor: Actor, orgId: string, input: EmployeeGroupInput): Promise<EmployeeGroupDto> {
  requireAllBranches(requirePermission(actor.principal, orgId, 'attendance.manage_rules'));
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('employeeGroups').values({ organizationId: orgId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, description: input.description, status: input.status, createdBy: actor.userId })
      .returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'attendance.employee_group_created', 'employee_group', { entityId: row.id, newValue: input });
    return toGroupDto(row as GroupRow, 0, 0);
  });
}

export async function updateEmployeeGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: Partial<EmployeeGroupInput>): Promise<EmployeeGroupDto> {
  requireAllBranches(requirePermission(actor.principal, orgId, 'attendance.manage_rules'));
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadGroup(trx, orgId, id);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length) await trx.updateTable('employeeGroups').set(patch as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadGroup(trx, orgId, id);
    const counts = await groupCounts(trx, orgId, [id], await orgToday(trx, orgId));
    const b = toGroupDto(before, 0, 0); const a = toGroupDto(after, 0, 0);
    await audit(trx, actor, orgId, 'attendance.employee_group_updated', 'employee_group', { entityId: id, ...diffObjects(b as unknown as Record<string, unknown>, a as unknown as Record<string, unknown>) });
    return toGroupDto(after, counts.members.get(id) ?? 0, counts.policies.get(id) ?? 0);
  });
}

/** A group a policy uses cannot go (409; the foreign key is the backstop). Its memberships go with it. */
export async function deleteEmployeeGroup(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requireAllBranches(requirePermission(actor.principal, orgId, 'attendance.manage_rules'));
  return runUser(deps.db, actor, async (trx) => {
    const g = await loadGroup(trx, orgId, id);
    const counts = await groupCounts(trx, orgId, [id], await orgToday(trx, orgId));
    const policies = counts.policies.get(id) ?? 0;
    if (policies > 0) throw errors.conflict('A policy is scoped to this employee group; delete or end that policy first, or set the group inactive.', { policies });
    await trx.deleteFrom('employeeGroups').where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'attendance.employee_group_deleted', 'employee_group', { entityId: id, oldValue: { code: String(g.code), name: g.name, members: counts.members.get(id) ?? 0 } });
  });
}

// ----- members ------------------------------------------------------------------------------------------------------------------

type MemberRow = { id: string; employeeGroupId: string; employeeId: string; employeeNumber: string; displayName: string; branchId: string; effectiveFrom: Date | string; effectiveTo: Date | string | null };
const toMemberDto = (m: MemberRow): EmployeeGroupMemberDto => ({
  id: m.id, employeeGroupId: m.employeeGroupId, employeeId: m.employeeId, employeeNumber: String(m.employeeNumber), displayName: m.displayName, branchId: m.branchId,
  effectiveFrom: isoDate(m.effectiveFrom), effectiveTo: assignmentEndFromStored(m.effectiveTo),
});

function membersQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('employeeGroupMemberships as m').innerJoin('employees as e', (j) => j.onRef('e.id', '=', 'm.employeeId').onRef('e.organizationId', '=', 'm.organizationId'))
    .where('m.organizationId', '=', orgId);
}
const MEMBER_COLUMNS = ['m.id', 'm.employeeGroupId', 'm.employeeId', 'e.employeeNumber', 'e.displayName', 'e.branchId', 'm.effectiveFrom', 'm.effectiveTo'] as const;

/** Members of a group: on `activeOn` (default today), or every past and future membership with `all`. Employees under RLS. */
export async function listEmployeeGroupMembers(deps: ApiDeps, actor: Actor, orgId: string, groupId: string, q: { page: number; pageSize: number; activeOn?: string; all: boolean; search?: string }): Promise<{ data: EmployeeGroupMemberDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.view');
  return runUser(deps.db, actor, async (trx) => {
    await loadGroup(trx, orgId, groupId);
    let base = membersQuery(trx, orgId).where('m.employeeGroupId', '=', groupId).where('e.deletedAt', 'is', null);
    if (!grant.allBranches) base = base.where('e.branchId', 'in', grant.branchIds.length ? grant.branchIds : ['00000000-0000-0000-0000-000000000000']);
    if (!q.all) {
      const on = q.activeOn ?? (await orgToday(trx, orgId));
      base = base.where('m.effectiveFrom', '<=', dv(on)).where((eb) => eb.or([eb('m.effectiveTo', 'is', null), eb('m.effectiveTo', '>', dv(on))]));
    }
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('e.displayName', 'ilike', like), eb('e.employeeNumber', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = (await base.select(MEMBER_COLUMNS).orderBy('e.displayName').orderBy('m.effectiveFrom', 'desc').orderBy('m.id').limit(page.pageSize).offset(page.offset).execute()) as MemberRow[];
    return { data: rows.map(toMemberDto), total };
  });
}

/** The employees of the request as the caller sees them (RLS), each inside the caller's branch scope; 404 names the missing ones. */
async function authorisedEmployees(trx: Trx, grant: MembershipGrant, orgId: string, employeeIds: readonly string[]): Promise<Map<string, { id: string; branchId: string; displayName: string }>> {
  const rows = await trx.selectFrom('employees').select(['id', 'branchId', 'displayName']).where('organizationId', '=', orgId).where('id', 'in', [...employeeIds]).where('deletedAt', 'is', null).execute();
  const found = new Map(rows.map((r) => [r.id, r]));
  const missing = employeeIds.filter((id) => !found.has(id));
  if (missing.length) throw new AppError('NOT_FOUND', missing.length === 1 ? 'Employee not found.' : `${missing.length} employees were not found.`, { details: { employeeIds: missing } });
  for (const r of rows) requireBranchAccess(grant, r.branchId);
  return found;
}

/**
 * Put employees in the group from `effectiveFrom` (to the inclusive `effectiveTo`, or open-ended). An employee belongs to one
 * group on a date: an OPEN-ENDED membership of any group that started before `effectiveFrom` is ended the day before
 * (stored exclusive end = effectiveFrom); any other overlap is a 409 naming the employee — nothing is written then.
 */
export async function addEmployeeGroupMembers(deps: ApiDeps, actor: Actor, orgId: string, groupId: string, input: EmployeeGroupMembersInput): Promise<EmployeeGroupMembersResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw errors.validation('The last day cannot be before the first day.', { issues: [{ path: 'effectiveTo', message: 'Before the first day' }] });
  return runUser(deps.db, actor, async (trx) => {
    const group = await loadGroup(trx, orgId, groupId);
    if (group.status !== 'active') throw errors.invalidState('The employee group is inactive; activate it before adding members.');
    const employees = await authorisedEmployees(trx, grant, orgId, input.employeeIds);
    const from = input.effectiveFrom;
    const storedTo = assignmentEndToStored(input.effectiveTo);
    let overlapping = trx.selectFrom('employeeGroupMemberships').select(['id', 'employeeGroupId', 'employeeId', 'effectiveFrom', 'effectiveTo'])
      .where('organizationId', '=', orgId).where('employeeId', 'in', [...input.employeeIds])
      .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', dv(from))]));
    if (storedTo) overlapping = overlapping.where('effectiveFrom', '<', dv(storedTo));
    const existing = await overlapping.forUpdate().execute();
    const toEnd = existing.filter((m) => m.effectiveTo === null && isoDate(m.effectiveFrom) < from);
    const clashes = existing.filter((m) => !toEnd.includes(m));
    if (clashes.length) {
      const first = clashes[0]!;
      const name = employees.get(first.employeeId)?.displayName ?? first.employeeId;
      throw errors.conflict(`${name} already belongs to a group from ${isoDate(first.effectiveFrom)}${first.effectiveTo ? ` to ${assignmentEndFromStored(first.effectiveTo)}` : ''}; end or remove that membership first.`, {
        employeeId: first.employeeId, employeeName: name, membershipId: first.id, employeeIds: [...new Set(clashes.map((c) => c.employeeId))],
      });
    }
    const ended: EndedEmployeeGroupMembershipDto[] = [];
    if (toEnd.length) {
      await trx.updateTable('employeeGroupMemberships').set({ effectiveTo: from }).where('organizationId', '=', orgId).where('id', 'in', toEnd.map((m) => m.id)).execute();
      for (const m of toEnd) ended.push({ id: m.id, employeeGroupId: m.employeeGroupId, employeeId: m.employeeId, effectiveFrom: isoDate(m.effectiveFrom), effectiveTo: addDays(from, -1) });
    }
    const inserted = await trx.insertInto('employeeGroupMemberships')
      .values(input.employeeIds.map((employeeId) => ({ organizationId: orgId, employeeGroupId: groupId, employeeId, effectiveFrom: from, effectiveTo: storedTo, createdBy: actor.userId })))
      .returning('id').execute();
    await audit(trx, actor, orgId, 'attendance.employee_group_members_added', 'employee_group', {
      entityId: groupId, newValue: { employeeIds: input.employeeIds, effectiveFrom: from, effectiveTo: input.effectiveTo ?? null, ended },
    });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, from, null, { employeeIds: [...input.employeeIds], reason: `employee group ${String(group.code)}: members added` });
    const added = (await membersQuery(trx, orgId).select(MEMBER_COLUMNS).where('m.id', 'in', inserted.map((r) => r.id)).orderBy('e.displayName').execute()) as MemberRow[];
    return { added: added.map(toMemberDto), ended, recalculationJobId: recalc?.jobId ?? null };
  });
}

async function loadMembership(trx: Trx, grant: MembershipGrant, orgId: string, groupId: string, membershipId: string): Promise<MemberRow> {
  const m = (await membersQuery(trx, orgId).select(MEMBER_COLUMNS).where('m.employeeGroupId', '=', groupId).where('m.id', '=', membershipId).executeTakeFirst()) as MemberRow | undefined;
  if (!m) throw errors.notFound('Membership', membershipId);
  requireBranchAccess(grant, m.branchId);
  return m;
}

/** End a membership on its inclusive last day (not before its first day — DELETE removes it). */
export async function endEmployeeGroupMembership(deps: ApiDeps, actor: Actor, orgId: string, groupId: string, membershipId: string, input: { effectiveTo: string }): Promise<EmployeeGroupMemberDto & { recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadMembership(trx, grant, orgId, groupId, membershipId);
    const b = toMemberDto(before);
    if (input.effectiveTo < b.effectiveFrom) throw errors.validation('The last day cannot be before the first day; remove the membership instead.', { issues: [{ path: 'effectiveTo', message: 'Before the first day' }] });
    const storedTo = assignmentEndToStored(input.effectiveTo)!;
    await trx.updateTable('employeeGroupMemberships').set({ effectiveTo: storedTo }).where('organizationId', '=', orgId).where('id', '=', membershipId).execute();
    await audit(trx, actor, orgId, 'attendance.employee_group_membership_ended', 'employee_group', { entityId: groupId, oldValue: { membershipId, employeeId: b.employeeId, effectiveTo: b.effectiveTo }, newValue: { membershipId, employeeId: b.employeeId, effectiveTo: input.effectiveTo } });
    // the days between the old and the new end changed group
    const oldStored = assignmentEndToStored(b.effectiveTo);
    const firstChanged = oldStored && oldStored < storedTo ? oldStored : storedTo;
    const recalc = await recalcIfPast(deps, trx, actor, orgId, firstChanged, null, { employeeIds: [b.employeeId], reason: 'employee group membership ended' });
    return { ...b, effectiveTo: input.effectiveTo, recalculationJobId: recalc?.jobId ?? null };
  });
}

export async function deleteEmployeeGroupMembership(deps: ApiDeps, actor: Actor, orgId: string, groupId: string, membershipId: string): Promise<{ recalculationJobId: string | null }> {
  const grant = requirePermission(actor.principal, orgId, 'attendance.manage_rules');
  return runUser(deps.db, actor, async (trx) => {
    const m = toMemberDto(await loadMembership(trx, grant, orgId, groupId, membershipId));
    await trx.deleteFrom('employeeGroupMemberships').where('organizationId', '=', orgId).where('id', '=', membershipId).execute();
    await audit(trx, actor, orgId, 'attendance.employee_group_membership_deleted', 'employee_group', { entityId: groupId, oldValue: m });
    const recalc = await recalcIfPast(deps, trx, actor, orgId, m.effectiveFrom, m.effectiveTo, { employeeIds: [m.employeeId], reason: 'employee group membership removed' });
    return { recalculationJobId: recalc?.jobId ?? null };
  });
}

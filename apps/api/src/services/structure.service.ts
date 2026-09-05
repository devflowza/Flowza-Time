import { type z } from 'zod';
import { sql } from 'kysely';
import type { branchInputSchema, departmentInputSchema, designationInputSchema, teamInputSchema, updateTeamSchema, BranchDto, DepartmentDto, DesignationDto, StructureListQuery, TeamDto, UpdateBranchInput, UpdateDepartmentInput, UpdateDesignationInput } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors, isValidTimezone } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { branchFilter, requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, audit, diffObjects } from '../lib/service.js';
import { likeContains, pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { isoDateTime } from '../lib/mappers.js';
import { BRANCH_COLUMNS, DEPARTMENT_COLUMNS, DESIGNATION_COLUMNS, TEAM_COLUMNS, toBranchDto, toDepartmentDto, toDesignationDto, toTeamDto, type DepartmentRow, type TeamRow } from './structure.mappers.js';

type BranchInput = z.infer<typeof branchInputSchema>;
type DepartmentInput = z.infer<typeof departmentInputSchema>;
type DesignationInput = z.infer<typeof designationInputSchema>;
type TeamInput = z.infer<typeof teamInputSchema>;

/** Branch-scoped callers may only create/move departments and teams inside their own branches — never org-wide (branch null). */
function requireScopedBranch(grant: MembershipGrant, branchId: string | null | undefined, mustBeSet: boolean): void {
  if (grant.allBranches) return;
  if (branchId) { requireBranchAccess(grant, branchId); return; }
  if (mustBeSet || branchId === null) throw errors.forbidden('Your access is limited to specific branches; choose one of them.');
}

async function employeeCounts(trx: Trx, orgId: string, column: 'branchId' | 'departmentId', ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await trx.selectFrom('employees').select([column, (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('deletedAt', 'is', null).where(column, 'in', ids).groupBy(column).execute();
  return new Map(rows.map((r) => [String(r[column]), toCount(r.n)]));
}

// Branches ---------------------------------------------------------------------------------------
const BRANCH_SORT = { code: 'code', name: 'name', city: 'city', status: 'status', createdAt: 'created_at' } as const;

export async function listBranches(deps: ApiDeps, actor: Actor, orgId: string, q: StructureListQuery): Promise<{ data: BranchDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'branch.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(BRANCH_SORT, q.sort, q.order, 'name');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('branches').where('organizationId', '=', orgId);
    if (scope) base = base.where('id', 'in', scope);
    if (q.status) base = base.where('status', '=', q.status);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb(sql`code::text`, 'ilike', like), eb('city', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(BRANCH_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('id').limit(page.pageSize).offset(page.offset).execute();
    const counts = await employeeCounts(trx, orgId, 'branchId', rows.map((r) => r.id));
    return { data: rows.map((r) => toBranchDto(r, counts.get(r.id) ?? 0)), total };
  });
}

async function loadBranch(trx: Trx, orgId: string, id: string): Promise<BranchDto> {
  const row = await trx.selectFrom('branches').select(BRANCH_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Branch', id);
  const counts = await employeeCounts(trx, orgId, 'branchId', [id]);
  return toBranchDto(row, counts.get(id) ?? 0);
}

export async function getBranch(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<BranchDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.view');
  requireBranchAccess(grant, id);
  return runUser(deps.db, actor, (trx) => loadBranch(trx, orgId, id));
}

function branchValues(input: Partial<BranchInput> | UpdateBranchInput): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input)) {
    if (val === undefined) continue;
    v[k] = k === 'address' || k === 'contact' ? JSON.stringify(val) : val;
  }
  return v;
}

export async function createBranch(deps: ApiDeps, actor: Actor, orgId: string, input: BranchInput): Promise<BranchDto> {
  requirePermission(actor.principal, orgId, 'branch.manage');
  if (!isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('branches').values({ organizationId: orgId, ...branchValues(input) } as never).returning(BRANCH_COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'branch.created', 'branch', { entityId: row.id, branchId: row.id, newValue: input });
    return toBranchDto(row, 0);
  });
}

export async function updateBranch(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateBranchInput): Promise<BranchDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireBranchAccess(grant, id);
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) throw errors.validation('Invalid IANA timezone.', { issues: [{ path: 'timezone', message: 'Unknown timezone' }] });
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadBranch(trx, orgId, id);
    const values = branchValues(input);
    if (Object.keys(values).length) await trx.updateTable('branches').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadBranch(trx, orgId, id);
    await audit(trx, actor, orgId, 'branch.updated', 'branch', { entityId: id, branchId: id, ...diffObjects(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    return after;
  });
}

/** Branches are archived, never physically deleted (employees, devices and history reference them). */
export async function archiveBranch(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<BranchDto> {
  const grant = requirePermission(actor.principal, orgId, 'branch.manage');
  requireBranchAccess(grant, id);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadBranch(trx, orgId, id);
    const active = toCount((await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('branchId', '=', id).where('deletedAt', 'is', null).where('employmentStatus', 'in', ['active', 'on_leave', 'suspended']).executeTakeFirst())?.n);
    if (active > 0) throw errors.conflict('The branch still has active employees. Move them first.', { activeEmployees: active });
    await trx.updateTable('branches').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'branch.archived', 'branch', { entityId: id, branchId: id, oldValue: { status: before.status }, newValue: { status: 'archived' } });
    return loadBranch(trx, orgId, id);
  });
}

// Departments ------------------------------------------------------------------------------------
const DEPARTMENT_SORT = { code: 'd.code', name: 'd.name', status: 'd.status', createdAt: 'd.created_at' } as const;

function departmentQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('departments as d').leftJoin('branches as b', 'b.id', 'd.branchId').leftJoin('employees as m', 'm.id', 'd.managerEmployeeId').where('d.organizationId', '=', orgId);
}

export async function listDepartments(deps: ApiDeps, actor: Actor, orgId: string, q: StructureListQuery): Promise<{ data: DepartmentDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'department.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(DEPARTMENT_SORT, q.sort, q.order, 'd.name');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = departmentQuery(trx, orgId);
    if (scope) base = q.branchId ? base.where('d.branchId', '=', q.branchId) : base.where((eb) => eb.or([eb('d.branchId', 'is', null), eb('d.branchId', 'in', scope)]));
    if (q.status) base = base.where('d.status', '=', q.status);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('d.name', 'ilike', like), eb(sql`d.code::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(DEPARTMENT_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('d.id').limit(page.pageSize).offset(page.offset).execute();
    const counts = await employeeCounts(trx, orgId, 'departmentId', rows.map((r) => r.id));
    return { data: rows.map((r) => toDepartmentDto(r as DepartmentRow, counts.get(r.id) ?? 0)), total };
  });
}

async function loadDepartment(trx: Trx, orgId: string, id: string): Promise<DepartmentDto> {
  const row = await departmentQuery(trx, orgId).select(DEPARTMENT_COLUMNS).where('d.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Department', id);
  const counts = await employeeCounts(trx, orgId, 'departmentId', [id]);
  return toDepartmentDto(row as DepartmentRow, counts.get(id) ?? 0);
}

export async function getDepartment(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DepartmentDto> {
  requirePermission(actor.principal, orgId, 'department.view');
  return runUser(deps.db, actor, (trx) => loadDepartment(trx, orgId, id));
}

/** Walk up from `parentId`; if we reach `selfId` the new parent would create a cycle. */
async function assertNoDepartmentCycle(trx: Trx, orgId: string, selfId: string | null, parentId: string | null): Promise<void> {
  if (!parentId) return;
  if (selfId && parentId === selfId) throw errors.validation('A department cannot be its own parent.', { issues: [{ path: 'parentId', message: 'Cycle' }] });
  const all = await trx.selectFrom('departments').select(['id', 'parentId']).where('organizationId', '=', orgId).execute();
  const parentOf = new Map(all.map((d) => [d.id, d.parentId]));
  if (!parentOf.has(parentId)) throw errors.validation('Parent department not found in this organisation.', { issues: [{ path: 'parentId', message: 'Unknown department' }] });
  let cursor: string | null | undefined = parentId; let hops = 0;
  while (cursor && hops++ < 1000) {
    if (selfId && cursor === selfId) throw errors.validation('This parent would create a cycle in the department tree.', { issues: [{ path: 'parentId', message: 'Cycle' }] });
    cursor = parentOf.get(cursor) ?? null;
  }
}

async function assertManagerInOrg(trx: Trx, orgId: string, managerEmployeeId: string | null | undefined, path: string): Promise<void> {
  if (!managerEmployeeId) return;
  const m = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', '=', managerEmployeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!m) throw errors.validation('Employee not found in this organisation.', { issues: [{ path, message: 'Unknown employee' }] });
}

export async function createDepartment(deps: ApiDeps, actor: Actor, orgId: string, input: DepartmentInput): Promise<DepartmentDto> {
  const grant = requirePermission(actor.principal, orgId, 'department.manage');
  requireScopedBranch(grant, input.branchId, true);
  return runUser(deps.db, actor, async (trx) => {
    await assertNoDepartmentCycle(trx, orgId, null, input.parentId ?? null);
    await assertManagerInOrg(trx, orgId, input.managerEmployeeId, 'managerEmployeeId');
    const row = await trx.insertInto('departments').values({ organizationId: orgId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, branchId: input.branchId ?? null, parentId: input.parentId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, status: input.status }).returning('id').executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'department.created', 'department', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    return loadDepartment(trx, orgId, row.id);
  });
}

export async function updateDepartment(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateDepartmentInput): Promise<DepartmentDto> {
  const grant = requirePermission(actor.principal, orgId, 'department.manage');
  requireScopedBranch(grant, input.branchId, false);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDepartment(trx, orgId, id);
    if (input.parentId !== undefined) await assertNoDepartmentCycle(trx, orgId, id, input.parentId);
    if (input.managerEmployeeId !== undefined) await assertManagerInOrg(trx, orgId, input.managerEmployeeId, 'managerEmployeeId');
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) values[k] = v;
    if (Object.keys(values).length) await trx.updateTable('departments').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadDepartment(trx, orgId, id);
    await audit(trx, actor, orgId, 'department.updated', 'department', { entityId: id, branchId: after.branchId, ...diffObjects(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    return after;
  });
}

export async function archiveDepartment(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DepartmentDto> {
  requirePermission(actor.principal, orgId, 'department.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDepartment(trx, orgId, id);
    const children = toCount((await trx.selectFrom('departments').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('parentId', '=', id).where('status', '!=', 'archived').executeTakeFirst())?.n);
    if (children > 0) throw errors.conflict('Archive or move the child departments first.', { children });
    if ((before.employeeCount ?? 0) > 0) throw errors.conflict('The department still has employees assigned.', { employees: before.employeeCount });
    await trx.updateTable('departments').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'department.archived', 'department', { entityId: id, branchId: before.branchId, oldValue: { status: before.status }, newValue: { status: 'archived' } });
    return loadDepartment(trx, orgId, id);
  });
}

// Designations -----------------------------------------------------------------------------------
const DESIGNATION_SORT = { code: 'code', name: 'name', level: 'level', status: 'status', createdAt: 'created_at' } as const;

export async function listDesignations(deps: ApiDeps, actor: Actor, orgId: string, q: StructureListQuery): Promise<{ data: DesignationDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'department.view');
  const sort = resolveSort(DESIGNATION_SORT, q.sort, q.order, 'level');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = trx.selectFrom('designations').where('organizationId', '=', orgId);
    if (q.status) base = base.where('status', '=', q.status);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('name', 'ilike', like), eb(sql`code::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(DESIGNATION_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('name').limit(page.pageSize).offset(page.offset).execute();
    return { data: rows.map(toDesignationDto), total };
  });
}

async function loadDesignation(trx: Trx, orgId: string, id: string): Promise<DesignationDto> {
  const row = await trx.selectFrom('designations').select(DESIGNATION_COLUMNS).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Designation', id);
  return toDesignationDto(row);
}

export async function createDesignation(deps: ApiDeps, actor: Actor, orgId: string, input: DesignationInput): Promise<DesignationDto> {
  requirePermission(actor.principal, orgId, 'department.manage');
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.insertInto('designations').values({ organizationId: orgId, code: input.code, name: input.name, nameAr: input.nameAr ?? null, level: input.level, status: input.status }).returning(DESIGNATION_COLUMNS).executeTakeFirstOrThrow();
    await audit(trx, actor, orgId, 'designation.created', 'designation', { entityId: row.id, newValue: input });
    return toDesignationDto(row);
  });
}

export async function updateDesignation(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateDesignationInput): Promise<DesignationDto> {
  requirePermission(actor.principal, orgId, 'department.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDesignation(trx, orgId, id);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) values[k] = v;
    if (Object.keys(values).length) await trx.updateTable('designations').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    const after = await loadDesignation(trx, orgId, id);
    await audit(trx, actor, orgId, 'designation.updated', 'designation', { entityId: id, ...diffObjects(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>) });
    return after;
  });
}

export async function archiveDesignation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<DesignationDto> {
  requirePermission(actor.principal, orgId, 'department.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadDesignation(trx, orgId, id);
    const inUse = toCount((await trx.selectFrom('employees').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('designationId', '=', id).where('deletedAt', 'is', null).executeTakeFirst())?.n);
    if (inUse > 0) throw errors.conflict('The designation is still assigned to employees.', { employees: inUse });
    await trx.updateTable('designations').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await audit(trx, actor, orgId, 'designation.archived', 'designation', { entityId: id, oldValue: { status: before.status }, newValue: { status: 'archived' } });
    return loadDesignation(trx, orgId, id);
  });
}

// Teams ------------------------------------------------------------------------------------------
const TEAM_SORT = { code: 't.code', name: 't.name', status: 't.status', createdAt: 't.created_at' } as const;

function teamQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('teams as t').leftJoin('branches as b', 'b.id', 't.branchId').leftJoin('employees as l', 'l.id', 't.leadEmployeeId').where('t.organizationId', '=', orgId);
}

async function teamMemberCounts(trx: Trx, orgId: string, teamIds: string[]): Promise<Map<string, number>> {
  if (!teamIds.length) return new Map();
  const rows = await trx.selectFrom('teamMembers').select(['teamId', (eb) => eb.fn.countAll().as('n')]).where('organizationId', '=', orgId).where('teamId', 'in', teamIds).groupBy('teamId').execute();
  return new Map(rows.map((r) => [r.teamId, toCount(r.n)]));
}

export async function listTeams(deps: ApiDeps, actor: Actor, orgId: string, q: StructureListQuery): Promise<{ data: TeamDto[]; total: number }> {
  const grant = requirePermission(actor.principal, orgId, 'department.view');
  const scope = branchFilter(grant, q.branchId);
  const sort = resolveSort(TEAM_SORT, q.sort, q.order, 't.name');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = teamQuery(trx, orgId);
    if (scope) base = q.branchId ? base.where('t.branchId', '=', q.branchId) : base.where((eb) => eb.or([eb('t.branchId', 'is', null), eb('t.branchId', 'in', scope)]));
    if (q.status) base = base.where('t.status', '=', q.status);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('t.name', 'ilike', like), eb(sql`t.code::text`, 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(TEAM_COLUMNS).orderBy(sql.raw(sort.column), sort.direction).orderBy('t.id').limit(page.pageSize).offset(page.offset).execute();
    const counts = await teamMemberCounts(trx, orgId, rows.map((r) => r.id));
    return { data: rows.map((r) => toTeamDto(r as TeamRow, counts.get(r.id) ?? 0)), total };
  });
}

async function loadTeam(trx: Trx, orgId: string, id: string): Promise<TeamDto> {
  const row = await teamQuery(trx, orgId).select(TEAM_COLUMNS).where('t.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Team', id);
  const members = await trx.selectFrom('teamMembers as tm').innerJoin('employees as e', 'e.id', 'tm.employeeId').select(['e.id', 'e.employeeNumber', 'e.displayName', 'tm.addedAt']).where('tm.teamId', '=', id).where('tm.organizationId', '=', orgId).orderBy('e.displayName').execute();
  return toTeamDto(row as TeamRow, members.length, members.map((m) => ({ employeeId: m.id, employeeNumber: m.employeeNumber, displayName: m.displayName, addedAt: isoDateTime(m.addedAt) })));
}

export async function getTeam(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<TeamDto> {
  requirePermission(actor.principal, orgId, 'department.view');
  return runUser(deps.db, actor, (trx) => loadTeam(trx, orgId, id));
}

async function replaceTeamMembers(trx: Trx, orgId: string, teamId: string, memberIds: string[]): Promise<void> {
  const unique = [...new Set(memberIds)];
  if (unique.length) {
    const found = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('deletedAt', 'is', null).where('id', 'in', unique).execute();
    if (found.length !== unique.length) throw errors.validation('One or more employees were not found in this organisation.', { issues: [{ path: 'memberIds', message: 'Unknown employee' }] });
  }
  await trx.deleteFrom('teamMembers').where('teamId', '=', teamId).where('organizationId', '=', orgId).execute();
  if (unique.length) await trx.insertInto('teamMembers').values(unique.map((e) => ({ teamId, employeeId: e, organizationId: orgId }))).execute();
}

export async function createTeam(deps: ApiDeps, actor: Actor, orgId: string, input: TeamInput): Promise<TeamDto> {
  const grant = requirePermission(actor.principal, orgId, 'department.manage');
  requireScopedBranch(grant, input.branchId, true);
  return runUser(deps.db, actor, async (trx) => {
    await assertManagerInOrg(trx, orgId, input.leadEmployeeId, 'leadEmployeeId');
    const row = await trx.insertInto('teams').values({ organizationId: orgId, code: input.code, name: input.name, branchId: input.branchId ?? null, leadEmployeeId: input.leadEmployeeId ?? null }).returning('id').executeTakeFirstOrThrow();
    if (input.memberIds) await replaceTeamMembers(trx, orgId, row.id, input.memberIds);
    await audit(trx, actor, orgId, 'team.created', 'team', { entityId: row.id, branchId: input.branchId ?? null, newValue: input });
    return loadTeam(trx, orgId, row.id);
  });
}

export async function updateTeam(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: z.infer<typeof updateTeamSchema>): Promise<TeamDto> {
  const grant = requirePermission(actor.principal, orgId, 'department.manage');
  requireScopedBranch(grant, input.branchId, false);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadTeam(trx, orgId, id);
    if (input.leadEmployeeId !== undefined) await assertManagerInOrg(trx, orgId, input.leadEmployeeId, 'leadEmployeeId');
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined && k !== 'memberIds') values[k] = v;
    if (Object.keys(values).length) await trx.updateTable('teams').set(values as never).where('organizationId', '=', orgId).where('id', '=', id).execute();
    if (input.memberIds) await replaceTeamMembers(trx, orgId, id, input.memberIds);
    const after = await loadTeam(trx, orgId, id);
    const { members: _b, ...beforeFlat } = before; const { members: _a, ...afterFlat } = after;
    await audit(trx, actor, orgId, 'team.updated', 'team', { entityId: id, branchId: after.branchId, ...diffObjects(beforeFlat as unknown as Record<string, unknown>, { ...afterFlat, memberIds: input.memberIds } as unknown as Record<string, unknown>) });
    return after;
  });
}

export async function archiveTeam(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<TeamDto> {
  requirePermission(actor.principal, orgId, 'department.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadTeam(trx, orgId, id);
    await trx.updateTable('teams').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', id).execute();
    await trx.deleteFrom('teamMembers').where('teamId', '=', id).where('organizationId', '=', orgId).execute();
    await audit(trx, actor, orgId, 'team.archived', 'team', { entityId: id, branchId: before.branchId, oldValue: { status: before.status, memberCount: before.memberCount }, newValue: { status: 'archived' } });
    return loadTeam(trx, orgId, id);
  });
}

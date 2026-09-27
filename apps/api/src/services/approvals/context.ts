import type { ApprovalEntity } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { ApproverCandidate, ChainRung, ResolutionContext } from '@flowza/domain';
import { enumArrayOrNull } from '../../lib/mappers.js';
import { dv } from '../features/sql-helpers.js';

const OWNER = 'owner'; const HR_ADMIN = 'hr_admin'; const BRANCH_MANAGER = 'branch_manager';
const MAX_CHAIN = 10;

export interface OrgDirectory {
  activeUserIds: Set<string>;
  userByEmployee: Map<string, string>;
  roleKeyByUser: Map<string, string>;
  roleIdByUser: Map<string, string>;
  hrAdminUserIds: string[];
  ownerUserIds: string[];
  permissionHolders: Map<string, Set<string>>;
  roleMembers: Map<string, Set<string>>;
  branchManagers: Array<{ userId: string; allBranches: boolean; branchIds: string[] }>;
  /** Branch scope per user: null = all branches (unrestricted membership). */
  branchScope: Map<string, string[] | null>;
}

/** Everybody who can hold a seat in the organisation (active memberships) with their role, permissions and branch scope. One pass, system scope. */
export async function loadOrgDirectory(trx: Trx, orgId: string): Promise<OrgDirectory> {
  const members = await trx.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId').select(['m.id as membershipId', 'm.userId', 'm.roleId', 'r.key as roleKey', 'm.employeeId', 'm.allBranches'])
    .where('m.organizationId', '=', orgId).where('m.status', '=', 'active').orderBy('m.createdAt').execute();
  const roleIds = [...new Set(members.map((m) => m.roleId))];
  const perms = roleIds.length ? await trx.selectFrom('rolePermissions').select(['roleId', 'permissionKey']).where('roleId', 'in', roleIds).execute() : [];
  const restrictedIds = members.filter((m) => !m.allBranches).map((m) => m.membershipId);
  const scopedBranches = restrictedIds.length ? await trx.selectFrom('membershipBranches').select(['membershipId', 'branchId']).where('membershipId', 'in', restrictedIds).execute() : [];
  const permsByRole = new Map<string, string[]>();
  for (const p of perms) { const arr = permsByRole.get(p.roleId) ?? []; arr.push(p.permissionKey); permsByRole.set(p.roleId, arr); }
  const dir: OrgDirectory = { activeUserIds: new Set(), userByEmployee: new Map(), roleKeyByUser: new Map(), roleIdByUser: new Map(), hrAdminUserIds: [], ownerUserIds: [], permissionHolders: new Map(), roleMembers: new Map(), branchManagers: [], branchScope: new Map() };
  for (const m of members) {
    dir.activeUserIds.add(m.userId);
    if (m.employeeId && !dir.userByEmployee.has(m.employeeId)) dir.userByEmployee.set(m.employeeId, m.userId);
    dir.roleKeyByUser.set(m.userId, m.roleKey); dir.roleIdByUser.set(m.userId, m.roleId);
    if (m.roleKey === HR_ADMIN) dir.hrAdminUserIds.push(m.userId);
    if (m.roleKey === OWNER) dir.ownerUserIds.push(m.userId);
    const rm = dir.roleMembers.get(m.roleId) ?? new Set<string>(); rm.add(m.userId); dir.roleMembers.set(m.roleId, rm);
    for (const key of permsByRole.get(m.roleId) ?? []) { const set = dir.permissionHolders.get(key) ?? new Set<string>(); set.add(m.userId); dir.permissionHolders.set(key, set); }
    const branchIds = m.allBranches ? null : scopedBranches.filter((b) => b.membershipId === m.membershipId).map((b) => b.branchId);
    if (!dir.branchScope.has(m.userId)) dir.branchScope.set(m.userId, branchIds);
    if (m.roleKey === BRANCH_MANAGER) dir.branchManagers.push({ userId: m.userId, allBranches: m.allBranches, branchIds: branchIds ?? [] });
  }
  return dir;
}

/** Active delegations in force on `today` for this entity type: delegator → delegate (a type-specific row beats a blanket one, newest wins). */
export async function loadDelegationMap(trx: Trx, orgId: string, entityType: ApprovalEntity, today: string): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('approvalDelegations').select(['delegatorUserId', 'delegateUserId', 'entityTypes', 'createdAt'])
    .where('organizationId', '=', orgId).where('isActive', '=', true).where('startsOn', '<=', dv(today)).where('endsOn', '>=', dv(today)).orderBy('createdAt', 'desc').execute();
  const out = new Map<string, { delegate: string; specific: boolean }>();
  for (const r of rows) {
    const types = enumArrayOrNull<ApprovalEntity>(r.entityTypes);
    if (types && !types.includes(entityType)) continue;
    const specific = !!types;
    const current = out.get(r.delegatorUserId);
    if (!current || (specific && !current.specific)) out.set(r.delegatorUserId, { delegate: r.delegateUserId, specific });
  }
  return new Map([...out.entries()].map(([k, v]) => [k, v.delegate]));
}

interface EmployeeLite { id: string; managerEmployeeId: string | null; secondaryManagerEmployeeId: string | null; departmentId: string | null; branchId: string; deletedAt: Date | null }

/**
 * The domain `ResolutionContext` for one subject employee: the reporting chain (primary links, with each level's secondary
 * manager as the substitute), absence today (approved leave), the department head, the branch managers of the subject's
 * branch, HR admins, owners, permission/role holders and active delegations. System scope.
 *
 * Seats are scoped to people who could act on the request anyway: every seat but the owner must cover the request's branch
 * (membership branch scope), and a PERMISSION seat (`ROLE` by permission — also the synthetic default level) additionally
 * needs the entity's organisation-wide read key (`attendance.view` / `leave.view`) or to be the subject's own manager.
 * Without it, a `manager` role holding attendance.approve would sit on every correction in the organisation instead of
 * only on their direct reports' ones.
 */
export async function buildResolutionContext(trx: Trx, orgId: string, input: { employeeId: string | null; branchId: string | null; requestedBy: string | null; entityType: ApprovalEntity; viewPermission: string; today: string; allowSelfApproval: boolean; directory?: OrgDirectory }): Promise<ResolutionContext> {
  const dir = input.directory ?? await loadOrgDirectory(trx, orgId);
  const delegations = await loadDelegationMap(trx, orgId, input.entityType, input.today);
  const employees = new Map<string, EmployeeLite>();
  const loadEmployees = async (ids: string[]) => {
    const missing = ids.filter((id) => !employees.has(id));
    if (!missing.length) return;
    const rows = await trx.selectFrom('employees').select(['id', 'managerEmployeeId', 'secondaryManagerEmployeeId', 'departmentId', 'branchId', 'deletedAt']).where('organizationId', '=', orgId).where('id', 'in', missing).execute();
    for (const r of rows) employees.set(r.id, r);
  };
  const chainEmployeeIds: Array<{ primary: string | null; secondary: string | null }> = [];
  let subject: EmployeeLite | null = null;
  if (input.employeeId) {
    await loadEmployees([input.employeeId]);
    subject = employees.get(input.employeeId) ?? null;
    let current = subject;
    const seen = new Set<string>(subject ? [subject.id] : []);
    while (current && chainEmployeeIds.length < MAX_CHAIN) {
      const primary = current.managerEmployeeId; const secondary = current.secondaryManagerEmployeeId;
      if (!primary && !secondary) break;
      chainEmployeeIds.push({ primary, secondary });
      if (!primary || seen.has(primary)) break; // cycle guard: never walk the same record twice
      seen.add(primary);
      await loadEmployees([primary, ...(secondary ? [secondary] : [])]);
      current = employees.get(primary) ?? null;
    }
    const secondaries = chainEmployeeIds.map((r) => r.secondary).filter((x): x is string => !!x);
    await loadEmployees(secondaries);
  }
  const headEmployeeId = subject?.departmentId ? (await trx.selectFrom('departments').select('managerEmployeeId').where('organizationId', '=', orgId).where('id', '=', subject.departmentId).executeTakeFirst())?.managerEmployeeId ?? null : null;
  if (headEmployeeId) await loadEmployees([headEmployeeId]);
  const candidateIds = [...new Set([...chainEmployeeIds.flatMap((r) => [r.primary, r.secondary]), headEmployeeId].filter((x): x is string => !!x))];
  const onLeave = new Set(candidateIds.length ? (await trx.selectFrom('leaveRecords').select('employeeId').where('organizationId', '=', orgId).where('employeeId', 'in', candidateIds).where('status', '=', 'APPROVED')
    .where('startDate', '<=', dv(input.today)).where('endDate', '>=', dv(input.today)).execute()).map((r) => r.employeeId) : []);
  const candidate = (employeeId: string | null): ApproverCandidate | null => {
    if (!employeeId) return null;
    const e = employees.get(employeeId);
    if (!e || e.deletedAt) return { employeeId, userId: null, absent: true, absentReason: 'employee record archived' };
    const userId = dir.userByEmployee.get(employeeId) ?? null;
    if (onLeave.has(employeeId)) return { employeeId, userId, absent: true, absentReason: 'on approved leave' };
    return { employeeId, userId, absent: false, absentReason: null };
  };
  const chain: ChainRung[] = chainEmployeeIds.map((r) => ({ primary: candidate(r.primary), secondary: candidate(r.secondary) }));
  const branchManagerUserIds = subject ? dir.branchManagers.filter((b) => b.allBranches || b.branchIds.includes(subject!.branchId)).map((b) => b.userId) : [];
  const branch = subject?.branchId ?? input.branchId;
  const inBranch = (userId: string): boolean => { if (!branch) return true; const scope = dir.branchScope.get(userId); return scope === null || scope === undefined ? true : scope.includes(branch); };
  const subjectManagers = new Set([chain[0]?.primary?.userId, chain[0]?.secondary?.userId].filter((u): u is string => !!u));
  const viewers = dir.permissionHolders.get(input.viewPermission) ?? new Set<string>();
  return {
    subjectEmployeeId: input.employeeId,
    subjectUserId: input.employeeId ? dir.userByEmployee.get(input.employeeId) ?? null : null,
    requestedBy: input.requestedBy,
    chain,
    departmentHead: candidate(headEmployeeId),
    branchManagerUserIds,
    hrAdminUserIds: dir.hrAdminUserIds.filter(inBranch),
    ownerUserIds: dir.ownerUserIds,
    activeUserIds: dir.activeUserIds,
    roleMemberUserIds: (roleId) => [...(dir.roleMembers.get(roleId) ?? [])].filter(inBranch),
    permissionHolderUserIds: (permission) => [...(dir.permissionHolders.get(permission) ?? [])].filter((u) => inBranch(u) && (viewers.has(u) || subjectManagers.has(u))),
    delegateOf: (userId) => delegations.get(userId) ?? null,
    allowSelfApproval: input.allowSelfApproval,
  };
}

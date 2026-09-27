import type { Permission } from '@flowza/contracts';
import type { MembershipGrant, Principal } from '@flowza/domain';
import { errors } from '@flowza/shared';

/** Returns the membership for the organisation or throws FORBIDDEN (route-level tenant check). */
export function requireMembership(principal: Principal, organizationId: string): MembershipGrant {
  const m = principal.memberships.find((x) => x.organizationId === organizationId);
  if (!m) throw errors.forbidden('You are not a member of this organisation.');
  return m;
}

export function hasPermission(m: MembershipGrant, permission: Permission): boolean {
  return m.permissions.includes(permission);
}

export function requirePermission(principal: Principal, organizationId: string, ...permissions: Permission[]): MembershipGrant {
  const m = requireMembership(principal, organizationId);
  const missing = permissions.filter((p) => !hasPermission(m, p));
  if (missing.length > 0) throw errors.forbidden(`Missing permission: ${missing.join(', ')}.`);
  return m;
}

/**
 * The membership when it holds AT LEAST ONE of the permissions, else FORBIDDEN. For reads whose rows RLS scopes per key:
 * e.g. the employee directory answers `employee.view` (organisation-wide, branch-scoped) or `employee.view_team` (own
 * record + direct reports) — the service admits either and the database decides which rows each one reveals.
 */
export function requireAnyPermission(principal: Principal, organizationId: string, ...permissions: [Permission, ...Permission[]]): MembershipGrant {
  const m = requireMembership(principal, organizationId);
  if (permissions.some((p) => hasPermission(m, p))) return m;
  throw errors.forbidden(`Missing permission: one of ${permissions.join(', ')}.`);
}

/** True when the employee is one of the membership's direct reports (primary or secondary manager on the employee record). */
export function isTeamMember(m: MembershipGrant, employeeId: string): boolean {
  return m.teamEmployeeIds.includes(employeeId);
}

/**
 * Line-manager semantics (docs/hr-portal/prompt-pack.md, Prompt 1): the organisation-wide permission ⇒ allowed; otherwise
 * the employee must be one of the caller's direct reports ⇒ allowed; else FORBIDDEN. The team comes from the principal
 * snapshot (org_memberships.employee_id → employees.manager_employee_id / secondary_manager_employee_id), the same
 * rule as `app.team_employee_ids()` — RLS applies it again row by row, additionally gated by the team key of the table
 * (attendance.view_team / leave.view_team), so a service that passes here still only reads what the caller's role allows.
 */
export function requireTeamOrPermission(principal: Principal, organizationId: string, employeeId: string, ...permissions: Permission[]): MembershipGrant {
  const m = requireMembership(principal, organizationId);
  if (permissions.length > 0 && permissions.every((p) => hasPermission(m, p))) return m;
  if (isTeamMember(m, employeeId)) return m;
  const missing = permissions.length > 0 ? `Missing permission: ${permissions.join(', ')}` : 'No organisation-wide permission';
  throw errors.forbidden(`${missing} — and the employee is not one of your direct reports.`);
}

/** Branch-scope check for explicit branch ids supplied by clients (RLS enforces it again). */
export function requireBranchAccess(m: MembershipGrant, branchId: string | null | undefined): void {
  if (!branchId || m.allBranches) return;
  if (!m.branchIds.includes(branchId)) throw errors.forbidden('This branch is outside your access scope.');
}

export function requirePlatformAdmin(principal: Principal): void {
  if (!principal.isPlatformAdmin) throw errors.forbidden('Platform administrator access required.');
}

/** Restrict a list query to the caller's branches when scoped. Returns null for "no restriction". */
export function branchFilter(m: MembershipGrant, requested?: string | null): string[] | null {
  if (m.allBranches) return requested ? [requested] : null;
  if (requested) {
    requireBranchAccess(m, requested);
    return [requested];
  }
  return m.branchIds.length > 0 ? m.branchIds : ['00000000-0000-0000-0000-000000000000'];
}

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

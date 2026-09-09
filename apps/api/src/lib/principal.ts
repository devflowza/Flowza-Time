import { sql } from 'kysely';
import type { Permission } from '@flowza/contracts';
import type { MembershipGrant, Principal } from '@flowza/domain';
import type { Database } from '@flowza/database';

/**
 * Loads the caller's memberships and permissions from the database (never from the JWT) so role changes
 * and suspensions take effect immediately (ADR-002/007). One round trip: `app.principal_snapshot` (migration
 * 20260909000300) returns everything as a single document, where the previous transaction needed up to ten
 * statements — and each of those is a trip from the API's region to the database's.
 */
export interface LoadedPrincipal { principal: Principal; mfaRequiredOrgIds: ReadonlySet<string> }

interface Snapshot {
  profile: { id: string; email: string; status: string } | null;
  isPlatformAdmin: boolean;
  memberships: Array<{ membershipId: string; organizationId: string; roleId: string; roleKey: string; allBranches: boolean; employeeId: string | null; permissions: string[]; branchIds: string[] }>;
  grants: Array<{ organizationId: string; accessLevel: 'read' | 'write' }>;
  allPermissions: string[];
  mfaRequiredOrgIds: string[];
}

export async function loadPrincipal(db: Database, userId: string, email: string | undefined): Promise<LoadedPrincipal> {
  const { rows } = await sql<{ snap: Snapshot }>`select app.principal_snapshot(${userId}::uuid) as snap`.execute(db);
  const snap = rows[0]?.snap;
  if (!snap) throw new Error('principal snapshot returned no row');
  const memberships: MembershipGrant[] = snap.memberships.map((m) => ({
    membershipId: m.membershipId,
    organizationId: m.organizationId,
    roleId: m.roleId,
    roleKey: m.roleKey,
    permissions: m.permissions as Permission[],
    allBranches: m.allBranches,
    branchIds: m.branchIds,
    employeeId: m.employeeId,
  }));
  // platform admins with an active grant get a synthetic membership carrying the grant's permission class
  if (snap.isPlatformAdmin) {
    const allPerms = snap.allPermissions as Permission[];
    for (const g of snap.grants) {
      if (memberships.some((m) => m.organizationId === g.organizationId)) continue;
      memberships.push({
        membershipId: `grant:${g.organizationId}`,
        organizationId: g.organizationId,
        roleId: 'platform-grant',
        roleKey: g.accessLevel === 'write' ? 'platform_grant_write' : 'platform_grant_read',
        permissions: g.accessLevel === 'write' ? allPerms : allPerms.filter((p) => p.endsWith('.view') || p.endsWith('.export')),
        allBranches: true,
        branchIds: [],
        employeeId: null,
      });
    }
  }
  return {
    principal: { userId, email: snap.profile?.email ?? email ?? '', isPlatformAdmin: snap.isPlatformAdmin, memberships },
    mfaRequiredOrgIds: new Set(snap.mfaRequiredOrgIds),
  };
}

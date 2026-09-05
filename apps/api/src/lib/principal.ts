import { sql } from 'kysely';
import type { Permission } from '@flowza/contracts';
import type { MembershipGrant, Principal } from '@flowza/domain';
import { withContext, type Database } from '@flowza/database';

/**
 * Loads the caller's memberships and permissions from the database (never from the JWT) so role changes
 * and suspensions take effect immediately (ADR-002/007). Runs in the user's own RLS context.
 */
export async function loadPrincipal(db: Database, userId: string, email: string | undefined, requestId: string): Promise<Principal> {
  return withContext(db, { kind: 'user', userId, email, requestId }, async (trx) => {
    const profile = await trx.selectFrom('userProfiles').select(['id', 'email', 'status']).where('id', '=', userId).executeTakeFirst();
    const isPlatformAdmin = !!(await trx.selectFrom('platformAdmins').select('userId').where('userId', '=', userId).where('status', '=', 'active').executeTakeFirst());
    const rows = await trx
      .selectFrom('orgMemberships as m')
      .innerJoin('roles as r', 'r.id', 'm.roleId')
      .select(['m.id as membershipId', 'm.organizationId', 'm.roleId', 'r.key as roleKey', 'm.allBranches', 'm.employeeId', 'm.status'])
      .where('m.userId', '=', userId)
      .where('m.status', '=', 'active')
      .execute();
    const memberships: MembershipGrant[] = [];
    for (const row of rows) {
      const perms = await trx.selectFrom('rolePermissions').select('permissionKey').where('roleId', '=', row.roleId).execute();
      const branches = row.allBranches
        ? []
        : (await trx.selectFrom('membershipBranches').select('branchId').where('membershipId', '=', row.membershipId).execute()).map((b) => b.branchId);
      memberships.push({
        membershipId: row.membershipId,
        organizationId: row.organizationId,
        roleId: row.roleId,
        roleKey: row.roleKey,
        permissions: perms.map((p) => p.permissionKey as Permission),
        allBranches: row.allBranches,
        branchIds: branches,
        employeeId: row.employeeId,
      });
    }
    // platform admins with an active grant get a synthetic membership carrying the grant's permission class
    if (isPlatformAdmin) {
      const grants = await sql<{ organizationId: string; accessLevel: 'read' | 'write' }>`
        select organization_id, access_level from public.platform_access_grants
        where platform_admin_user_id = ${userId}::uuid and revoked_at is null and now() >= starts_at and now() < expires_at`.execute(trx);
      const allPerms = (await trx.selectFrom('permissions').select('key').execute()).map((p) => p.key as Permission);
      for (const g of grants.rows) {
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
    return { userId, email: profile?.email ?? email ?? '', isPlatformAdmin, memberships };
  });
}

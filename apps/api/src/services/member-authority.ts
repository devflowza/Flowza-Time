import { SYSTEM_ROLE_IDS } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import { type Actor, withSystemScope } from '../lib/service.js';

/**
 * THE rule for managing a member (HR portal Prompt 5 review, P0-1 / P0-3). Every members / invitations / portal-access write
 * path asks it before it changes anything — invite, update (role, branches, status, link), suspend, restore, revoke, resend,
 * delete an invitation, and the employee profile's access card (invite, revoke, restore, resend). The caller (who already
 * holds `user.manage`) may act on a target only when:
 *
 *   (a) the target is not themselves — nobody changes their own role, branch scope or status (there is no self-service
 *       ownership transfer: an owner promotes another member, who then changes the first; the one self change left is an
 *       owner linking their own login to their own employee record, decided by `updateMember`);
 *   (b) the target is not an owner, unless the caller is one — and only an owner hands out the owner role;
 *   (c) the caller may GRANT the target's current role AND the requested new role — the invitation rule of Prompt 1: an
 *       actor only hands out a role whose every permission they hold (owners hold every permission);
 *   (d) the target's current and requested branch scope lie within the caller's: a branch-scoped caller never grants, keeps
 *       or restores access to every branch, nor to a branch outside their own.
 *
 * Refusals are 403 with a sentence that says which rule applies. The rule reads roles and role permissions (reference data
 * every member can read) and nothing else. The target's reach is passed in by the caller — its branch ids read with
 * `membershipBranchIds` (the organisation's system scope), never through a view the caller's read keys could empty: a user
 * admin without `branch.view` would otherwise see every restricted member as scoped to no branch at all, which would pass
 * clause (d) for members of any branch.
 */

/** The reach of a membership or an invitation: its role and its branch scope. */
export interface MemberScope { roleId: string; allBranches: boolean; branchIds: readonly string[] }
/** The membership (or invitation) being acted on: its current reach, and whose login it is (null for an invitation). */
export interface ManagedTarget extends MemberScope { userId: string | null }

const OWNER_ROLE = SYSTEM_ROLE_IDS.owner;

/**
 * No privilege escalation through role assignment: an actor may only hand out (or act on) a role whose permissions they hold
 * themselves — the same rule the database enforces for custom role definitions. Owners hold every permission.
 */
export async function assertRoleGrantable(trx: Trx, roleId: string, grant: MembershipGrant, what: 'assign' | 'manage' = 'assign'): Promise<void> {
  if (grant.roleKey === 'owner') return;
  const perms = (await trx.selectFrom('rolePermissions').select('permissionKey').where('roleId', '=', roleId).execute()).map((p) => p.permissionKey);
  const missing = perms.filter((p) => !(grant.permissions as readonly string[]).includes(p));
  if (!missing.length) return;
  if (what === 'assign') throw errors.forbidden(`You cannot assign a role with permissions you do not hold: ${missing.join(', ')}.`);
  throw errors.forbidden(`You cannot change a member whose role carries permissions you do not hold: ${missing.join(', ')}.`);
}

/** True when every branch of `scope` lies within the caller's branch scope. */
export function scopeWithin(grant: Pick<MembershipGrant, 'allBranches' | 'branchIds'>, scope: Pick<MemberScope, 'allBranches' | 'branchIds'>): boolean {
  if (grant.allBranches) return true;
  if (scope.allBranches) return false;
  return scope.branchIds.every((b) => grant.branchIds.includes(b));
}

/**
 * The branch scope an invitation gets when the request leaves it out: the caller's own. An organisation-wide user admin
 * invites to every branch (as before); a branch-scoped one to exactly their branches — never to all of them (P0-1).
 */
export function defaultInviteScope(grant: Pick<MembershipGrant, 'allBranches' | 'branchIds'>, input: { allBranches?: boolean | undefined; branchIds?: readonly string[] | undefined }): { allBranches: boolean; branchIds: string[] } {
  if (input.allBranches === true) return { allBranches: true, branchIds: [] };
  if (input.allBranches === false || (input.branchIds && input.branchIds.length > 0)) return { allBranches: false, branchIds: [...new Set(input.branchIds ?? [])] };
  return grant.allBranches ? { allBranches: true, branchIds: [] } : { allBranches: false, branchIds: [...grant.branchIds] };
}

/**
 * May the caller act on `target` and give it `next`? `target` is null for a brand-new invitation (nothing exists yet);
 * `next` is null when the reach does not change (suspend, restore, revoke, resend of the same invitation). See the file
 * header for the four rules.
 */
export async function assertMayManageMember(trx: Trx, actor: Actor, grant: MembershipGrant, target: ManagedTarget | null, next: MemberScope | null): Promise<void> {
  // (a) never oneself
  if (target?.userId && target.userId === actor.userId) throw errors.forbidden('You cannot change your own membership (role, branch access or status). Ask another administrator.');
  // (b) owners are changed by owners only, and only an owner grants the owner role
  const isOwner = grant.roleKey === 'owner';
  if (target && target.roleId === OWNER_ROLE && !isOwner) throw errors.forbidden('Only an owner can change another owner.');
  if (next && next.roleId === OWNER_ROLE && !isOwner) throw errors.forbidden('Only an owner can grant the owner role.');
  // (d) branch scope — the target's current reach and the requested one both lie within the caller's
  if (!grant.allBranches) {
    if (target && target.allBranches) throw errors.forbidden('This member has access to every branch; only an administrator with access to every branch can change them.');
    if (target && !scopeWithin(grant, target)) throw errors.forbidden('This member has access to branches outside your access scope.');
    if (next && next.allBranches) throw errors.forbidden('You cannot grant access to every branch: your own access is limited to some branches.');
    if (next && !scopeWithin(grant, next)) throw errors.forbidden('This branch is outside your access scope.');
  }
  // (c) the caller may grant the target's current role and the requested one
  if (target) await assertRoleGrantable(trx, target.roleId, grant, 'manage');
  if (next && next.roleId !== target?.roleId) await assertRoleGrantable(trx, next.roleId, grant, 'assign');
}

/**
 * The branch ids of one membership of `orgId` (membership_branches), read in the organisation's system scope — the reach the
 * member-management rule judges must not depend on what the caller may read (`MemberDto.branchIds` joins `branches`, which
 * needs `branch.view`).
 */
export async function membershipBranchIds(trx: Trx, orgId: string, membershipId: string): Promise<string[]> {
  return withSystemScope(trx, orgId, async (t) => (await t.selectFrom('membershipBranches as mb').innerJoin('orgMemberships as m', 'm.id', 'mb.membershipId')
    .select('mb.branchId').where('m.organizationId', '=', orgId).where('mb.membershipId', '=', membershipId).execute()).map((b) => b.branchId));
}

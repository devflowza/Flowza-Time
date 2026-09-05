import { z } from 'zod';
import { sql } from 'kysely';
import { SYSTEM_ROLE_IDS, updateMemberSchema, type InviteMemberInput, type InvitationDto, type MemberDto, type MemberListQuery } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import { errors, randomToken, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requireBranchAccess, requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, diffObjects } from '../lib/service.js';
import { likeContains, pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { groupBy } from '../lib/mappers.js';
import { toInvitationDto, toMemberDto, type MemberRow } from './members.mappers.js';

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
const INVITATION_TTL_DAYS = 7;

const MEMBER_SORT = { createdAt: 'm.created_at', email: 'u.email', fullName: 'u.full_name', role: 'r.name', status: 'm.status' } as const;

async function branchesForMemberships(trx: Trx, membershipIds: string[]): Promise<Map<string, { id: string; name: string }[]>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await trx.selectFrom('membershipBranches as mb').innerJoin('branches as b', 'b.id', 'mb.branchId').select(['mb.membershipId', 'b.id', 'b.name']).where('mb.membershipId', 'in', membershipIds).execute();
  const grouped = groupBy(rows, (r) => r.membershipId);
  return new Map([...grouped].map(([k, v]) => [k, v.map((b) => ({ id: b.id, name: b.name }))]));
}

function memberQuery(trx: Trx, orgId: string) {
  return trx.selectFrom('orgMemberships as m')
    .innerJoin('roles as r', 'r.id', 'm.roleId')
    .leftJoin('userProfiles as u', 'u.id', 'm.userId')
    .leftJoin('employees as e', 'e.id', 'm.employeeId')
    .where('m.organizationId', '=', orgId);
}
const MEMBER_SELECT = ['m.id', 'm.organizationId', 'm.userId', 'm.roleId', 'm.status', 'm.allBranches', 'm.employeeId', 'm.joinedAt', 'm.createdAt', 'm.updatedAt', 'u.email', 'u.fullName', 'u.avatarPath', 'u.lastLoginAt', 'r.key as roleKey', 'r.name as roleName', 'e.employeeNumber'] as const;

export async function listMembers(deps: ApiDeps, actor: Actor, orgId: string, q: MemberListQuery): Promise<{ data: MemberDto[]; total: number }> {
  requirePermission(actor.principal, orgId, 'user.view');
  const sort = resolveSort(MEMBER_SORT, q.sort, q.order, 'm.created_at');
  return runUser(deps.db, actor, async (trx) => {
    const page = pageOf(q);
    let base = memberQuery(trx, orgId);
    if (q.status) base = base.where('m.status', '=', q.status);
    if (q.roleId) base = base.where('m.roleId', '=', q.roleId);
    if (q.search) { const like = likeContains(q.search); base = base.where((eb) => eb.or([eb('u.email', 'ilike', like), eb('u.fullName', 'ilike', like)])); }
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const rows = await base.select(MEMBER_SELECT).orderBy(sql.raw(sort.column), sort.direction).orderBy('m.id').limit(page.pageSize).offset(page.offset).execute();
    const branches = await branchesForMemberships(trx, rows.filter((r) => !r.allBranches).map((r) => r.id));
    return { data: rows.map((r) => toMemberDto(r as MemberRow, branches.get(r.id) ?? [])), total };
  });
}

async function loadMember(trx: Trx, orgId: string, id: string): Promise<MemberDto> {
  const row = await memberQuery(trx, orgId).select(MEMBER_SELECT).where('m.id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Member', id);
  const branches = await branchesForMemberships(trx, row.allBranches ? [] : [row.id]);
  return toMemberDto(row as MemberRow, branches.get(row.id) ?? []);
}

export async function getMember(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MemberDto> {
  requirePermission(actor.principal, orgId, 'user.view');
  return runUser(deps.db, actor, (trx) => loadMember(trx, orgId, id));
}

async function assertRoleUsable(trx: Trx, orgId: string, roleId: string): Promise<void> {
  const role = await trx.selectFrom('roles').select(['id', 'organizationId', 'isSystem']).where('id', '=', roleId).executeTakeFirst();
  if (!role || (!role.isSystem && role.organizationId !== orgId)) throw errors.validation('Unknown role for this organisation.', { issues: [{ path: 'roleId', message: 'Unknown role' }] });
}

async function assertBranchesInOrg(trx: Trx, orgId: string, branchIds: string[]): Promise<void> {
  if (branchIds.length === 0) return;
  const found = await trx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', 'in', branchIds).execute();
  if (found.length !== new Set(branchIds).size) throw errors.validation('One or more branches do not belong to this organisation.', { issues: [{ path: 'branchIds', message: 'Unknown branch' }] });
}

async function assertEmployeeInOrg(trx: Trx, orgId: string, employeeId: string): Promise<void> {
  const e = await trx.selectFrom('employees').select('id').where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!e) throw errors.validation('Employee not found in this organisation.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
}

/** Builds the plain invitation token: `<orgId>.<secret>`; only sha256(secret) is stored. */
function buildToken(orgId: string): { token: string; hash: string } {
  const secret = randomToken(32);
  return { token: `${orgId}.${secret}`, hash: sha256Hex(secret) };
}
function parseToken(token: string): { orgId: string; hash: string } | null {
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const orgId = token.slice(0, idx); const secret = token.slice(idx + 1);
  if (!/^[0-9a-f-]{36}$/i.test(orgId) || secret.length < 16) return null;
  return { orgId, hash: sha256Hex(secret) };
}

export async function inviteMember(deps: ApiDeps, actor: Actor, orgId: string, input: InviteMemberInput): Promise<InvitationDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  for (const b of input.branchIds) requireBranchAccess(grant, b);
  return runUser(deps.db, actor, async (trx) => {
    await assertRoleUsable(trx, orgId, input.roleId);
    await assertBranchesInOrg(trx, orgId, input.branchIds);
    if (input.employeeId) await assertEmployeeInOrg(trx, orgId, input.employeeId);
    if (input.roleId === SYSTEM_ROLE_IDS.owner && actor.principal.memberships.find((m) => m.organizationId === orgId)?.roleKey !== 'owner') {
      throw errors.forbidden('Only an owner can invite another owner.');
    }
    const existingMember = await trx.selectFrom('orgMemberships as m').innerJoin('userProfiles as u', 'u.id', 'm.userId').select(['m.id', 'm.status']).where('m.organizationId', '=', orgId).where('u.email', '=', input.email).executeTakeFirst();
    if (existingMember && existingMember.status !== 'suspended') throw errors.conflict('This user is already a member of the organisation.');
    const pending = await trx.selectFrom('invitations').select('id').where('organizationId', '=', orgId).where('email', '=', input.email).where('acceptedAt', 'is', null).where('expiresAt', '>', new Date()).executeTakeFirst();
    if (pending) throw errors.conflict('An invitation for this email is already pending.', { invitationId: pending.id });

    const { token, hash } = buildToken(orgId);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    const inv = await trx.insertInto('invitations').values({
      organizationId: orgId, email: input.email, roleId: input.roleId, allBranches: input.allBranches, branchIds: input.allBranches ? [] : input.branchIds,
      tokenHash: hash, invitedBy: actor.userId, expiresAt,
    }).returning(['id', 'organizationId', 'email', 'roleId', 'allBranches', 'branchIds', 'invitedBy', 'expiresAt', 'acceptedAt', 'createdAt']).executeTakeFirstOrThrow();

    // Existing account (visible to us as an org peer or not at all): create the membership up-front as 'invited'.
    let membershipId: string | null = null;
    const profile = await trx.selectFrom('userProfiles').select('id').where('email', '=', input.email).executeTakeFirst();
    if (profile) {
      const m = await trx.insertInto('orgMemberships').values({ organizationId: orgId, userId: profile.id, roleId: input.roleId, status: 'invited', allBranches: input.allBranches, employeeId: input.employeeId ?? null, invitedBy: actor.userId })
        .onConflict((oc) => oc.columns(['organizationId', 'userId']).doUpdateSet({ roleId: input.roleId, status: 'invited', allBranches: input.allBranches, employeeId: input.employeeId ?? null, invitedBy: actor.userId }))
        .returning('id').executeTakeFirstOrThrow();
      membershipId = m.id;
      await trx.deleteFrom('membershipBranches').where('membershipId', '=', m.id).execute();
      if (!input.allBranches) await trx.insertInto('membershipBranches').values(input.branchIds.map((b) => ({ membershipId: m.id, branchId: b }))).execute();
    }
    await audit(trx, actor, orgId, 'member.invited', 'invitation', { entityId: inv.id, newValue: { email: input.email, roleId: input.roleId, allBranches: input.allBranches, branchIds: input.branchIds, membershipId } });
    return toInvitationDto(inv, { token, membershipId });
  });
}

export async function listInvitations(deps: ApiDeps, actor: Actor, orgId: string): Promise<InvitationDto[]> {
  requirePermission(actor.principal, orgId, 'user.view');
  return runUser(deps.db, actor, async (trx) => {
    const rows = await trx.selectFrom('invitations as i').innerJoin('roles as r', 'r.id', 'i.roleId').leftJoin('userProfiles as u', 'u.id', 'i.invitedBy')
      .select(['i.id', 'i.organizationId', 'i.email', 'i.roleId', 'i.allBranches', 'i.branchIds', 'i.invitedBy', 'i.expiresAt', 'i.acceptedAt', 'i.createdAt', 'r.name as roleName', 'u.fullName as invitedByName'])
      .where('i.organizationId', '=', orgId).where('i.acceptedAt', 'is', null).orderBy('i.createdAt', 'desc').limit(500).execute();
    return rows.map((r) => toInvitationDto(r));
  });
}

export async function revokeInvitation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    const inv = await trx.selectFrom('invitations').select(['id', 'email', 'acceptedAt']).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!inv) throw errors.notFound('Invitation', id);
    if (inv.acceptedAt) throw errors.invalidState('The invitation was already accepted.');
    await trx.deleteFrom('invitations').where('id', '=', id).execute();
    await trx.deleteFrom('orgMemberships').where('organizationId', '=', orgId).where('status', '=', 'invited')
      .where('userId', 'in', trx.selectFrom('userProfiles').select('id').where('email', '=', inv.email)).execute();
    await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: id, oldValue: { email: inv.email } });
  });
}

/**
 * Accept an invitation. The caller is not a member yet, so this runs in the system context of the organisation
 * encoded in the token after verifying the token hash and that the invitation was addressed to the caller's email.
 */
export async function acceptInvitation(deps: ApiDeps, actor: Actor, token: string): Promise<{ membershipId: string; organizationId: string }> {
  const parsed = parseToken(token);
  if (!parsed) throw errors.notFound('Invitation');
  return runSystem(deps.db, parsed.orgId, actor.requestId, async (trx) => {
    const inv = await trx.selectFrom('invitations').select(['id', 'organizationId', 'email', 'roleId', 'allBranches', 'branchIds', 'expiresAt', 'acceptedAt']).where('tokenHash', '=', parsed.hash).where('organizationId', '=', parsed.orgId).executeTakeFirst();
    if (!inv) throw errors.notFound('Invitation');
    if (inv.acceptedAt) throw errors.invalidState('This invitation was already accepted.');
    if (inv.expiresAt.getTime() < Date.now()) throw errors.invalidState('This invitation has expired.');
    if (!actor.email || inv.email.toLowerCase() !== actor.email.toLowerCase()) throw errors.forbidden('This invitation was issued to a different email address.');
    const profile = await trx.selectFrom('userProfiles').select('id').where('id', '=', actor.userId).executeTakeFirst();
    if (!profile) await trx.insertInto('userProfiles').values({ id: actor.userId, email: actor.email, fullName: '' }).execute();
    const membership = await trx.insertInto('orgMemberships').values({ organizationId: inv.organizationId, userId: actor.userId, roleId: inv.roleId, status: 'active', allBranches: inv.allBranches, joinedAt: new Date() })
      .onConflict((oc) => oc.columns(['organizationId', 'userId']).doUpdateSet({ roleId: inv.roleId, status: 'active', allBranches: inv.allBranches, joinedAt: new Date() }))
      .returning('id').executeTakeFirstOrThrow();
    await trx.deleteFrom('membershipBranches').where('membershipId', '=', membership.id).execute();
    if (!inv.allBranches && inv.branchIds.length > 0) await trx.insertInto('membershipBranches').values(inv.branchIds.map((b) => ({ membershipId: membership.id, branchId: b }))).execute();
    await trx.updateTable('invitations').set({ acceptedAt: new Date(), acceptedBy: actor.userId }).where('id', '=', inv.id).execute();
    await audit(trx, actor, inv.organizationId, 'member.invitation_accepted', 'org_membership', { entityId: membership.id, newValue: { invitationId: inv.id, roleId: inv.roleId, allBranches: inv.allBranches, branchIds: inv.branchIds } });
    return { membershipId: membership.id, organizationId: inv.organizationId };
  });
}

async function assertNotLastOwner(trx: Trx, orgId: string, membershipId: string, next: { roleId: string; status: string }): Promise<void> {
  const current = await trx.selectFrom('orgMemberships').select(['roleId', 'status']).where('id', '=', membershipId).executeTakeFirstOrThrow();
  const wasActiveOwner = current.roleId === SYSTEM_ROLE_IDS.owner && current.status === 'active';
  const staysActiveOwner = next.roleId === SYSTEM_ROLE_IDS.owner && next.status === 'active';
  if (!wasActiveOwner || staysActiveOwner) return;
  const owners = toCount((await trx.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('roleId', '=', SYSTEM_ROLE_IDS.owner).where('status', '=', 'active').executeTakeFirst())?.n);
  if (owners <= 1) throw errors.invalidState('An organisation must keep at least one active owner.');
}

export async function updateMember(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateMemberInput): Promise<MemberDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  for (const b of input.branchIds ?? []) requireBranchAccess(grant, b);
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadMember(trx, orgId, id);
    if (input.roleId) {
      await assertRoleUsable(trx, orgId, input.roleId);
      if (input.roleId === SYSTEM_ROLE_IDS.owner && grant.roleKey !== 'owner') throw errors.forbidden('Only an owner can grant the owner role.');
    }
    if (before.roleKey === 'owner' && grant.roleKey !== 'owner') throw errors.forbidden('Only an owner can change another owner.');
    if (input.branchIds) await assertBranchesInOrg(trx, orgId, input.branchIds);
    if (input.employeeId) await assertEmployeeInOrg(trx, orgId, input.employeeId);
    const nextRole = input.roleId ?? before.roleId;
    const nextStatus = input.status ?? before.status;
    const nextAll = input.allBranches ?? (input.branchIds ? false : before.allBranches);
    if (!nextAll && (input.branchIds ?? before.branchIds).length === 0) throw errors.validation('Select at least one branch or grant all branches.', { issues: [{ path: 'branchIds', message: 'Required' }] });
    await assertNotLastOwner(trx, orgId, id, { roleId: nextRole, status: nextStatus });
    const patch: Record<string, unknown> = { roleId: nextRole, status: nextStatus, allBranches: nextAll };
    if (input.employeeId !== undefined) patch['employeeId'] = input.employeeId;
    if (nextStatus === 'active' && before.status !== 'active') patch['joinedAt'] = new Date();
    await trx.updateTable('orgMemberships').set(patch).where('id', '=', id).where('organizationId', '=', orgId).execute();
    if (nextAll) await trx.deleteFrom('membershipBranches').where('membershipId', '=', id).execute();
    else if (input.branchIds) {
      await trx.deleteFrom('membershipBranches').where('membershipId', '=', id).execute();
      await trx.insertInto('membershipBranches').values(input.branchIds.map((b) => ({ membershipId: id, branchId: b }))).execute();
    }
    const after = await loadMember(trx, orgId, id);
    const diff = diffObjects(before as unknown as Record<string, unknown>, { roleId: after.roleId, status: after.status, allBranches: after.allBranches, branchIds: after.branchIds, employeeId: after.employeeId });
    await audit(trx, actor, orgId, 'member.updated', 'org_membership', { entityId: id, ...diff });
    return after;
  });
}

export async function suspendMember(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MemberDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadMember(trx, orgId, id);
    if (before.roleKey === 'owner' && grant.roleKey !== 'owner') throw errors.forbidden('Only an owner can suspend another owner.');
    if (before.userId === actor.userId) throw errors.invalidState('You cannot suspend your own membership.');
    if (before.status === 'suspended') return before;
    await assertNotLastOwner(trx, orgId, id, { roleId: before.roleId, status: 'suspended' });
    await trx.updateTable('orgMemberships').set({ status: 'suspended' }).where('id', '=', id).where('organizationId', '=', orgId).execute();
    await audit(trx, actor, orgId, 'member.suspended', 'org_membership', { entityId: id, oldValue: { status: before.status }, newValue: { status: 'suspended' } });
    return loadMember(trx, orgId, id);
  });
}

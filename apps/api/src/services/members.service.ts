import { type z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { INVITATION_EMAIL_JOB_TYPE, SYSTEM_ROLE_IDS, uuidSchema, type updateMemberSchema, type InviteMemberInput, type InvitationDto, type InvitationPreviewDto, type MemberDto, type MemberListQuery } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors, randomToken, sha256Hex } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { type Actor, runUser, runSystem, audit, diffObjects, withSystemScope, PLATFORM_SCOPE_ORG } from '../lib/service.js';
import { likeContains, pageOf, resolveSort, toCount } from '../lib/pagination.js';
import { groupBy } from '../lib/mappers.js';
import { toInvitationDto, toMemberDto, type MemberRow } from './members.mappers.js';
import { revokeSessions } from '../lib/sessions.js';
import { enqueueJob } from '../lib/jobs.js';
import { hasLeft } from './offboarding.js';
import { assertMayManageMember, defaultInviteScope, membershipBranchIds, type ManagedTarget } from './member-authority.js';

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

export async function loadMember(trx: Trx, orgId: string, id: string): Promise<MemberDto> {
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

/**
 * The branches exist in the organisation — a referential check, read in the organisation's system scope: a user admin need
 * not hold `branch.view`, and whether the caller may hand the branches out is THE member-management rule's question (its
 * branch-scope clause runs first and answers 403), never a side effect of what the caller can read.
 */
async function assertBranchesInOrg(trx: Trx, orgId: string, branchIds: string[]): Promise<void> {
  if (branchIds.length === 0) return;
  const found = await withSystemScope(trx, orgId, (t) => t.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', 'in', branchIds).execute());
  if (found.length !== new Set(branchIds).size) throw errors.validation('One or more branches do not belong to this organisation.', { issues: [{ path: 'branchIds', message: 'Unknown branch' }] });
}

/**
 * The employee a login is linked to must exist, be live and not have left (B-75: leaving ends every login linked to the
 * record, so a login is never linked to somebody who left).
 */
export async function assertEmployeeLinkable(trx: Trx, orgId: string, employeeId: string): Promise<void> {
  const e = await trx.selectFrom('employees').select(['id', 'employmentStatus']).where('organizationId', '=', orgId).where('id', '=', employeeId).where('deletedAt', 'is', null).executeTakeFirst();
  if (!e) throw errors.validation('Employee not found in this organisation.', { issues: [{ path: 'employeeId', message: 'Unknown employee' }] });
  if (hasLeft(e.employmentStatus)) throw errors.validation('This employee has left the organisation (terminated or resigned); a login cannot be linked to them.', { issues: [{ path: 'employeeId', message: 'Employee has left' }] });
}

/** True when the employee record is archived or has left — read in system scope (the caller may not see the record). */
export async function employeeHasLeft(trx: Trx, orgId: string, employeeId: string): Promise<boolean> {
  const e = await withSystemScope(trx, orgId, (t) => t.selectFrom('employees').select(['employmentStatus', 'deletedAt']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst());
  return !e || e.deletedAt !== null || hasLeft(e.employmentStatus);
}

/** True when `nextRoleId` lacks at least one permission `prevRoleId` grants (a downgrade ends the user's sessions). */
async function isRoleDowngrade(trx: Trx, prevRoleId: string, nextRoleId: string): Promise<boolean> {
  if (prevRoleId === nextRoleId) return false;
  const rows = await trx.selectFrom('rolePermissions').select(['roleId', 'permissionKey']).where('roleId', 'in', [prevRoleId, nextRoleId]).execute();
  const next = new Set(rows.filter((r) => r.roleId === nextRoleId).map((r) => r.permissionKey));
  return rows.some((r) => r.roleId === prevRoleId && !next.has(r.permissionKey));
}

/**
 * One login per employee record: the link (org_memberships.employee_id) is what self-service, the team predicate and
 * approvals resolve a person by, so a second membership pointing at the same employee would double their identity.
 * Returns the reason when the employee is already taken by another membership (any status) or reserved by a pending
 * invitation; callers in a user context run it in the organisation's system scope (memberships are hidden without user.view).
 */
async function employeeLinkClash(trx: Trx, orgId: string, employeeId: string, except: { membershipId?: string; userId?: string; invitationId?: string } = {}): Promise<string | null> {
  let members = trx.selectFrom('orgMemberships').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId);
  if (except.membershipId) members = members.where('id', '<>', except.membershipId);
  if (except.userId) members = members.where('userId', '<>', except.userId);
  if (await members.executeTakeFirst()) return 'This employee is already linked to another member of the organisation.';
  let pending = trx.selectFrom('invitations').select('id').where('organizationId', '=', orgId).where('employeeId', '=', employeeId).where('acceptedAt', 'is', null).where('revokedAt', 'is', null).where('expiresAt', '>', new Date());
  if (except.invitationId) pending = pending.where('id', '<>', except.invitationId);
  if (await pending.executeTakeFirst()) return 'A pending invitation already links this employee; revoke it first.';
  return null;
}
export async function assertEmployeeUnlinked(trx: Trx, orgId: string, employeeId: string, except: { membershipId?: string } = {}): Promise<void> {
  const clash = await withSystemScope(trx, orgId, (t) => employeeLinkClash(t, orgId, employeeId, except));
  if (clash) throw errors.conflict(clash, { employeeId });
}

/** Builds the plain invitation token: `<orgId>.<secret>`; only sha256(secret) is stored. */
export function buildToken(orgId: string): { token: string; hash: string } {
  const secret = randomToken(32);
  return { token: `${orgId}.${secret}`, hash: sha256Hex(secret) };
}
export function parseToken(token: string): { orgId: string; hash: string } | null {
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const orgId = token.slice(0, idx); const secret = token.slice(idx + 1);
  // the organisation part must be a real uuid (review P2-7a: 36 dashes passed a character-class check and failed the cast)
  if (!uuidSchema.safeParse(orgId).success || secret.length < 16) return null;
  return { orgId, hash: sha256Hex(secret) };
}
/** Constant-time comparison of two hex digests (AGENTS.md: invitation hashes are compared with timingSafeEqual). */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex'); const bb = Buffer.from(b, 'hex');
  return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb);
}
/**
 * The invitation whose copied-link token OR e-mailed token has this hash (constant-time per comparison). Both tokens of one
 * invitation accept the same single-use invitation; every candidate is compared, so the scan does not stop early on a match.
 */
export function findByTokenHash<T extends { tokenHash: string; deliveryTokenHash: string | null }>(candidates: readonly T[], hash: string): T | undefined {
  let found: T | undefined;
  for (const c of candidates) {
    const hit = hashesEqual(c.tokenHash, hash) || (c.deliveryTokenHash !== null && hashesEqual(c.deliveryTokenHash, hash));
    if (hit && !found) found = c;
  }
  return found;
}

const INVITATION_LOOKUP_COLUMNS = ['id', 'organizationId', 'email', 'roleId', 'allBranches', 'branchIds', 'employeeId', 'expiresAt', 'acceptedAt', 'acceptedBy', 'revokedAt', 'tokenHash', 'deliveryTokenHash'] as const;

/**
 * The invitation of `orgId` a token hash belongs to (review P1-2): an INDEXED equality lookup on the two hash columns — both
 * carry a unique index (`invitations_token_hash_key`, `invitations_delivery_token_hash_key`) — never a window of the newest
 * rows, so an old open invitation stays reachable however many newer ones the organisation has. The row found is then
 * confirmed with a constant-time comparison (AGENTS.md). What the database compares is a sha256 of a 256-bit secret, never
 * the secret itself. Accepted / revoked rows are found too, so a re-used token reports why it no longer works.
 */
async function invitationByTokenHash(trx: Trx, orgId: string, hash: string) {
  const rows = await trx.selectFrom('invitations').select(INVITATION_LOOKUP_COLUMNS)
    .where('organizationId', '=', orgId).where((eb) => eb.or([eb('tokenHash', '=', hash), eb('deliveryTokenHash', '=', hash)])).limit(2).execute();
  return findByTokenHash(rows, hash);
}

/** `a***@e***.com`: enough for the invitee to recognise their address, not enough to harvest it (B-70). */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const mask = (part: string) => (part.length ? `${part[0]}***` : '***');
  return `${mask(local)}@${mask(host)}${tld}`;
}

/**
 * Public preview of an invitation (B-70): the state of the token (valid / accepted / revoked / expired), the organisation,
 * the linked employee's name and the masked address — without accepting anything. An unknown or malformed token is 404.
 * Runs in the system context of the organisation encoded in the token (the caller is anonymous or not a member yet).
 */
export async function validateInvitation(deps: ApiDeps, requestId: string, token: string): Promise<InvitationPreviewDto> {
  const parsed = parseToken(token);
  // review P2-7: a malformed token and an unknown one answer the same 404 after the same work — one indexed lookup in a
  // system context (a malformed token is looked up under the nil organisation, where no invitation exists)
  const lookup = parsed ?? { orgId: PLATFORM_SCOPE_ORG, hash: sha256Hex(token) };
  return runSystem(deps.db, lookup.orgId, requestId, async (trx) => {
    const inv = await invitationByTokenHash(trx, lookup.orgId, lookup.hash);
    if (!inv || !parsed) throw errors.notFound('Invitation');
    const org = await trx.selectFrom('organizations').select('displayName').where('id', '=', parsed.orgId).executeTakeFirst();
    const employee = inv.employeeId ? await trx.selectFrom('employees').select('displayName').where('organizationId', '=', parsed.orgId).where('id', '=', inv.employeeId).executeTakeFirst() : undefined;
    const state: InvitationPreviewDto['state'] = inv.acceptedAt ? 'accepted' : inv.revokedAt ? 'revoked' : inv.expiresAt.getTime() < Date.now() ? 'expired' : 'valid';
    return { state, organizationName: org?.displayName ?? '', employeeName: employee?.displayName ?? null, emailMasked: maskEmail(inv.email), expiresAt: inv.expiresAt.toISOString() };
  });
}

/** The invitee's existing account, if any. Not visible to the inviter under RLS until they are an org peer: resolved (id only) in the organisation's system context. */
export async function profileIdByEmail(deps: ApiDeps, orgId: string, requestId: string, email: string): Promise<string | null> {
  const row = await runSystem(deps.db, orgId, requestId, (trx) => trx.selectFrom('userProfiles').select('id').where(sql`lower(email::text)`, '=', email.toLowerCase()).executeTakeFirst());
  return row?.id ?? null;
}

export interface CreateInvitationOptions {
  /** Where the invitation came from (audit): the users page, an employee profile, or a resend. */
  source: 'members' | 'employee_profile' | 'resend';
  /** The invitation this one replaces (a resend): recorded on the audit row. */
  replaces?: string;
  /**
   * Where the address came from (review P0-2, employee profile only): the employee's work e-mail field, their personal e-mail
   * field, or typed in by the administrator — with who last changed that field and when — recorded on the audit row.
   */
  address?: { source: 'work' | 'personal' | 'entered'; changedAt: string | null; changedByUserId: string | null };
}

/** The invitation's branch scope once the caller's defaults are applied (a branch-scoped caller defaults to their own). */
export type ResolvedInviteInput = Omit<InviteMemberInput, 'allBranches' | 'branchIds'> & { allBranches: boolean; branchIds: string[] };

/**
 * The membership an invitation to this address would refresh (an existing account invited before, or a suspended login):
 * read in the organisation's system scope so the rules below see it whatever the caller's read keys.
 */
async function membershipByEmail(trx: Trx, orgId: string, email: string): Promise<(ManagedTarget & { id: string; status: string }) | null> {
  const m = await withSystemScope(trx, orgId, (t) => t.selectFrom('orgMemberships as m').innerJoin('userProfiles as u', 'u.id', 'm.userId').select(['m.id', 'm.userId', 'm.roleId', 'm.status', 'm.allBranches'])
    .where('m.organizationId', '=', orgId).where(sql`lower(u.email::text)`, '=', email.toLowerCase()).executeTakeFirst());
  if (!m) return null;
  return { id: m.id, userId: m.userId, roleId: m.roleId, status: m.status, allBranches: m.allBranches, branchIds: m.allBranches ? [] : await membershipBranchIds(trx, orgId, m.id) };
}

/**
 * Insert one invitation (+ an `invited` membership when the invitee already has an account) and queue its e-mail, inside the
 * caller's transaction. The caller has already checked `user.manage`; every rule of the invitation itself lives here:
 * THE member-management rule (member-authority.ts — grantable role, owner-only owner, the caller's branch scope; the
 * membership an invitation to an existing account would refresh counts as its target), a usable role, branches of the
 * organisation, an employee that is linkable and not linked elsewhere, no active member and no open invitation for the
 * address. The token is `<orgId>.<secret>`; only sha256(secret) is stored. The e-mail job mints its OWN token at send time
 * (worker, hash only) — nothing secret is queued.
 */
export async function createInvitation(deps: ApiDeps, trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, request: InviteMemberInput, profileId: string | null, opts: CreateInvitationOptions): Promise<InvitationDto> {
  const input: ResolvedInviteInput = { ...request, ...defaultInviteScope(grant, request) };
  const existingMember = await membershipByEmail(trx, orgId, input.email);
  // an `invited` membership (an earlier invitation to an existing account) is refreshed by the new invitation; a suspended
  // one is re-invited as before; only an ACTIVE member is refused
  if (existingMember && existingMember.status === 'active') throw errors.conflict('This user is already a member of the organisation.');
  await assertRoleUsable(trx, orgId, input.roleId);
  await assertMayManageMember(trx, actor, grant, existingMember, { roleId: input.roleId, allBranches: input.allBranches, branchIds: input.branchIds });
  await assertBranchesInOrg(trx, orgId, input.branchIds);
  if (!input.allBranches && input.branchIds.length === 0) throw errors.validation('Select at least one branch or grant all branches.', { issues: [{ path: 'branchIds', message: 'Required' }] });
  if (input.employeeId) { await assertEmployeeLinkable(trx, orgId, input.employeeId); await assertEmployeeUnlinked(trx, orgId, input.employeeId); }
  const pending = await trx.selectFrom('invitations').select('id').where('organizationId', '=', orgId).where(sql`lower(email::text)`, '=', input.email.toLowerCase())
    .where('acceptedAt', 'is', null).where('revokedAt', 'is', null).where('expiresAt', '>', new Date()).executeTakeFirst();
  if (pending) throw errors.conflict('An invitation for this email is already pending.', { invitationId: pending.id });

  const { token, hash } = buildToken(orgId);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
  // The employee link travels with the invitation so an invitee who has no account yet still lands linked on acceptance.
  const inv = await trx.insertInto('invitations').values({
    organizationId: orgId, email: input.email, roleId: input.roleId, allBranches: input.allBranches, branchIds: input.allBranches ? [] : input.branchIds,
    employeeId: input.employeeId ?? null, tokenHash: hash, invitedBy: actor.userId, expiresAt,
  }).returning(['id', 'organizationId', 'email', 'roleId', 'allBranches', 'branchIds', 'employeeId', 'invitedBy', 'expiresAt', 'acceptedAt', 'createdAt', 'deliverySentAt']).executeTakeFirstOrThrow();

  // Existing account (visible to us as an org peer or not at all): create the membership up-front as 'invited'.
  let membershipId: string | null = null;
  if (profileId) {
    const m = await trx.insertInto('orgMemberships').values({ organizationId: orgId, userId: profileId, roleId: input.roleId, status: 'invited', allBranches: input.allBranches, employeeId: input.employeeId ?? null, invitedBy: actor.userId })
      .onConflict((oc) => oc.columns(['organizationId', 'userId']).doUpdateSet({ roleId: input.roleId, status: 'invited', allBranches: input.allBranches, employeeId: input.employeeId ?? null, invitedBy: actor.userId }))
      .returning('id').executeTakeFirstOrThrow();
    membershipId = m.id;
    await trx.deleteFrom('membershipBranches').where('membershipId', '=', m.id).execute();
    if (!input.allBranches) await trx.insertInto('membershipBranches').values(input.branchIds.map((b) => ({ membershipId: m.id, branchId: b }))).execute();
  }
  // B-68: the invitation is e-mailed (same commit as the row: a rolled-back invitation sends nothing)
  await enqueueJob(deps.queue, trx, { queue: 'notifications', jobType: INVITATION_EMAIL_JOB_TYPE, organizationId: orgId, payload: { organizationId: orgId, invitationId: inv.id }, correlationId: actor.requestId, priority: 3, maxAttempts: 5 });
  await audit(trx, actor, orgId, opts.source === 'resend' ? 'member.invitation_resent' : 'member.invited', 'invitation', {
    entityId: inv.id,
    newValue: {
      email: input.email, roleId: input.roleId, allBranches: input.allBranches, branchIds: input.branchIds, employeeId: input.employeeId ?? null, membershipId, source: opts.source,
      ...(opts.replaces ? { replaces: opts.replaces } : {}),
      ...(opts.address ? { addressSource: opts.address.source, addressChangedAt: opts.address.changedAt, addressChangedBy: opts.address.changedByUserId } : {}),
    },
  });
  return toInvitationDto(inv, { token, membershipId });
}

export async function inviteMember(deps: ApiDeps, actor: Actor, orgId: string, input: InviteMemberInput): Promise<InvitationDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  const profileId = await profileIdByEmail(deps, orgId, actor.requestId, input.email);
  return runUser(deps.db, actor, (trx) => createInvitation(deps, trx, actor, grant, orgId, input, profileId, { source: 'members' }));
}

export async function listInvitations(deps: ApiDeps, actor: Actor, orgId: string): Promise<InvitationDto[]> {
  requirePermission(actor.principal, orgId, 'user.view');
  return runUser(deps.db, actor, async (trx) => {
    const rows = await trx.selectFrom('invitations as i').innerJoin('roles as r', 'r.id', 'i.roleId').leftJoin('userProfiles as u', 'u.id', 'i.invitedBy').leftJoin('employees as e', 'e.id', 'i.employeeId')
      .select(['i.id', 'i.organizationId', 'i.email', 'i.roleId', 'i.allBranches', 'i.branchIds', 'i.employeeId', 'i.invitedBy', 'i.expiresAt', 'i.acceptedAt', 'i.createdAt', 'i.deliverySentAt', 'r.name as roleName', 'u.fullName as invitedByName', 'e.employeeNumber as employeeNumber'])
      .where('i.organizationId', '=', orgId).where('i.acceptedAt', 'is', null).where('i.revokedAt', 'is', null).orderBy('i.createdAt', 'desc').limit(500).execute();
    return rows.map((r) => toInvitationDto(r));
  });
}

/**
 * Revoke one open invitation inside the caller's transaction: the row stays (validation reports the token as revoked), its
 * `invited` membership (an existing account invited up-front) is removed as before.
 */
export async function revokeInvitationWithin(trx: Trx, actor: Actor, orgId: string, inv: { id: string; email: string }, reason: string): Promise<void> {
  await trx.updateTable('invitations').set({ revokedAt: new Date(), revokedBy: actor.userId, revokeReason: reason })
    .where('organizationId', '=', orgId).where('id', '=', inv.id).where('acceptedAt', 'is', null).where('revokedAt', 'is', null).execute();
  await trx.deleteFrom('orgMemberships').where('organizationId', '=', orgId).where('status', '=', 'invited')
    .where('userId', 'in', trx.selectFrom('userProfiles').select('id').where(sql`lower(email::text)`, '=', String(inv.email).toLowerCase())).execute();
}

/** An invitation as the member-management rule sees it: its role and branch scope (no login behind it yet). */
export const invitationTarget = (inv: { roleId: string; allBranches: boolean; branchIds: readonly string[] }): ManagedTarget => ({ userId: null, roleId: inv.roleId, allBranches: inv.allBranches, branchIds: inv.allBranches ? [] : inv.branchIds });

export async function revokeInvitation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    const inv = await trx.selectFrom('invitations').select(['id', 'email', 'roleId', 'allBranches', 'branchIds', 'acceptedAt', 'revokedAt']).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!inv || inv.revokedAt) throw errors.notFound('Invitation', id);
    if (inv.acceptedAt) throw errors.invalidState('The invitation was already accepted.');
    // review P0-1 / P0-3: only an invitation the caller could have issued (its role and branch scope) is theirs to revoke
    await assertMayManageMember(trx, actor, grant, invitationTarget(inv), null);
    await revokeInvitationWithin(trx, actor, orgId, inv, 'revoked');
    await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: id, oldValue: { email: inv.email } });
  });
}

/**
 * B-67 / B-68: resend = revoke the open invitation (reason `resent`) and issue a new one with the same address, role, branch
 * scope and employee link — a new 7-day token, e-mailed. The new invitation goes through every invitation rule again (the
 * role must still be grantable by the caller, the employee still linkable), so a resend never carries a stale decision.
 */
export async function resendInvitation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<InvitationDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  const inv = await runUser(deps.db, actor, (trx) => trx.selectFrom('invitations').select(['id', 'email', 'acceptedAt', 'revokedAt']).where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst());
  if (!inv || inv.revokedAt) throw errors.notFound('Invitation', id);
  if (inv.acceptedAt) throw errors.invalidState('The invitation was already accepted.');
  const profileId = await profileIdByEmail(deps, orgId, actor.requestId, inv.email);
  return runUser(deps.db, actor, (trx) => resendWithin(deps, trx, actor, grant, orgId, id, profileId));
}

/** Resend inside the caller's transaction (the row is locked: two resends of one invitation never both issue a successor). */
export async function resendWithin(deps: ApiDeps, trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, id: string, profileId: string | null): Promise<InvitationDto> {
  const locked = await trx.selectFrom('invitations').select(['id', 'email', 'roleId', 'allBranches', 'branchIds', 'employeeId', 'acceptedAt', 'revokedAt'])
    .where('organizationId', '=', orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!locked || locked.revokedAt) throw errors.conflict('This invitation was already revoked or resent.');
  if (locked.acceptedAt) throw errors.invalidState('The invitation was already accepted.');
  // the invitation being replaced is the target (its role and scope); the successor goes through the same rule in createInvitation
  await assertMayManageMember(trx, actor, grant, invitationTarget(locked), null);
  await revokeInvitationWithin(trx, actor, orgId, locked, 'resent');
  const next = await createInvitation(deps, trx, actor, grant, orgId, {
    email: locked.email, roleId: locked.roleId, allBranches: locked.allBranches, branchIds: locked.allBranches ? [] : locked.branchIds, ...(locked.employeeId ? { employeeId: locked.employeeId } : {}),
  }, profileId, { source: 'resend', replaces: id });
  await trx.updateTable('invitations').set({ replacedById: next.id }).where('organizationId', '=', orgId).where('id', '=', id).execute();
  return next;
}

/**
 * Accept an invitation. The caller is not a member yet, so this runs in the system context of the organisation
 * encoded in the token after verifying the token hash and that the invitation was addressed to the caller's email.
 *
 * Atomic (review P2-9): the invitation is CLAIMED first by a conditional update (`accepted_at is null and revoked_at is
 * null`) that only one of several concurrent accepts can win; a loser re-reads the committed row and, when the winner was the
 * same person, gets the same answer (the membership) without a second membership write or audit row.
 */
export async function acceptInvitation(deps: ApiDeps, actor: Actor, token: string): Promise<{ membershipId: string; organizationId: string }> {
  const parsed = parseToken(token);
  if (!parsed) throw errors.notFound('Invitation');
  return runSystem(deps.db, parsed.orgId, actor.requestId, async (trx) => {
    const inv = await invitationByTokenHash(trx, parsed.orgId, parsed.hash); // accepted / revoked ones are found so a re-used token reports why
    if (!inv) throw errors.notFound('Invitation');
    if (inv.acceptedAt) throw errors.invalidState('This invitation was already accepted.');
    if (inv.revokedAt) throw errors.invalidState('This invitation was revoked.');
    if (inv.expiresAt.getTime() < Date.now()) throw errors.invalidState('This invitation has expired.');
    if (!actor.email || inv.email.toLowerCase() !== actor.email.toLowerCase()) throw errors.forbidden('This invitation was issued to a different email address.');
    // B-75: the invitation was issued for an employee who has since left — their login must not come back through it
    // (leaving revokes pending invitations; this guards invitations that predate that rule)
    if (inv.employeeId && (await employeeHasLeft(trx, inv.organizationId, inv.employeeId))) {
      throw errors.invalidState('This invitation is no longer valid: the employee record it was issued for has left the organisation.');
    }
    const claimed = await trx.updateTable('invitations').set({ acceptedAt: new Date(), acceptedBy: actor.userId })
      .where('organizationId', '=', inv.organizationId).where('id', '=', inv.id).where('acceptedAt', 'is', null).where('revokedAt', 'is', null)
      .returning('id').executeTakeFirst();
    if (!claimed) {
      // a concurrent accept (or a revocation) committed between the read and the claim: read what it left behind
      const now = await trx.selectFrom('invitations').select(['acceptedAt', 'acceptedBy', 'revokedAt']).where('organizationId', '=', inv.organizationId).where('id', '=', inv.id).executeTakeFirst();
      if (now?.acceptedAt && now.acceptedBy === actor.userId) {
        const mine = await trx.selectFrom('orgMemberships').select('id').where('organizationId', '=', inv.organizationId).where('userId', '=', actor.userId).executeTakeFirst();
        if (mine) return { membershipId: mine.id, organizationId: inv.organizationId };
      }
      if (now?.revokedAt) throw errors.invalidState('This invitation was revoked.');
      throw errors.invalidState('This invitation was already accepted.');
    }
    const profile = await trx.selectFrom('userProfiles').select('id').where('id', '=', actor.userId).executeTakeFirst();
    if (!profile) await trx.insertInto('userProfiles').values({ id: actor.userId, email: actor.email, fullName: '' }).execute();
    // The employee link chosen at invitation time lands on the membership — unless somebody else took that employee in
    // the meantime, in which case the membership is created unlinked (audited) rather than stealing the link or failing onboarding.
    const linkClash = inv.employeeId ? await employeeLinkClash(trx, inv.organizationId, inv.employeeId, { userId: actor.userId, invitationId: inv.id }) : null;
    const employeeLink = inv.employeeId && !linkClash ? { employeeId: inv.employeeId } : {};
    const membership = await trx.insertInto('orgMemberships').values({ organizationId: inv.organizationId, userId: actor.userId, roleId: inv.roleId, status: 'active', allBranches: inv.allBranches, joinedAt: new Date(), ...employeeLink })
      .onConflict((oc) => oc.columns(['organizationId', 'userId']).doUpdateSet({ roleId: inv.roleId, status: 'active', allBranches: inv.allBranches, joinedAt: new Date(), ...employeeLink }))
      .returning('id').executeTakeFirstOrThrow();
    await trx.deleteFrom('membershipBranches').where('membershipId', '=', membership.id).execute();
    if (!inv.allBranches && inv.branchIds.length > 0) await trx.insertInto('membershipBranches').values(inv.branchIds.map((b) => ({ membershipId: membership.id, branchId: b }))).execute();
    await audit(trx, actor, inv.organizationId, 'member.invitation_accepted', 'org_membership', { entityId: membership.id, newValue: { invitationId: inv.id, roleId: inv.roleId, allBranches: inv.allBranches, branchIds: inv.branchIds, employeeId: inv.employeeId && !linkClash ? inv.employeeId : null, ...(linkClash ? { employeeLinkSkipped: linkClash } : {}) } });
    return { membershipId: membership.id, organizationId: inv.organizationId };
  });
}

export async function assertNotLastOwner(trx: Trx, orgId: string, membershipId: string, next: { roleId: string; status: string }): Promise<void> {
  const current = await trx.selectFrom('orgMemberships').select(['roleId', 'status']).where('id', '=', membershipId).executeTakeFirstOrThrow();
  const wasActiveOwner = current.roleId === SYSTEM_ROLE_IDS.owner && current.status === 'active';
  const staysActiveOwner = next.roleId === SYSTEM_ROLE_IDS.owner && next.status === 'active';
  if (!wasActiveOwner || staysActiveOwner) return;
  const owners = toCount((await trx.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n')).where('organizationId', '=', orgId).where('roleId', '=', SYSTEM_ROLE_IDS.owner).where('status', '=', 'active').executeTakeFirst())?.n);
  if (owners <= 1) throw errors.invalidState('An organisation must keep at least one active owner.');
}

/** True when the patch changes the membership's role, status or branch scope (anything but the employee link). */
function changesReach(before: MemberDto, beforeBranchIds: readonly string[], input: UpdateMemberInput): boolean {
  if (input.roleId !== undefined && input.roleId !== before.roleId) return true;
  if (input.status !== undefined && input.status !== before.status) return true;
  const nextAll = input.allBranches ?? (input.branchIds ? false : before.allBranches);
  if (nextAll !== before.allBranches) return true;
  if (!nextAll && input.branchIds) {
    const a = [...new Set(input.branchIds)].sort(); const b = [...beforeBranchIds].sort();
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) return true;
  }
  return false;
}

export async function updateMember(deps: ApiDeps, actor: Actor, orgId: string, id: string, input: UpdateMemberInput): Promise<MemberDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadMember(trx, orgId, id);
    // the member's branches as stored — MemberDto.branchIds is empty for a caller without branch.view
    const beforeBranchIds = before.allBranches ? [] : await membershipBranchIds(trx, orgId, id);
    if (input.roleId) await assertRoleUsable(trx, orgId, input.roleId);
    const nextRole = input.roleId ?? before.roleId;
    const nextStatus = input.status ?? before.status;
    const nextAll = input.allBranches ?? (input.branchIds ? false : before.allBranches);
    const nextBranches = nextAll ? [] : (input.branchIds ?? beforeBranchIds);
    // THE member-management rule (review P0-1 / P0-3): not oneself, owners by owners, grantable roles (current and new), the
    // caller's branch scope over the current and the requested reach. The one self change left: an OWNER linking their own
    // login to their own employee record (nobody else can in a single-owner organisation, and an owner reads every record).
    const ownerSelfLink = before.userId === actor.userId && grant.roleKey === 'owner' && !changesReach(before, beforeBranchIds, input);
    if (!ownerSelfLink) await assertMayManageMember(trx, actor, grant, { userId: before.userId, roleId: before.roleId, allBranches: before.allBranches, branchIds: beforeBranchIds }, { roleId: nextRole, allBranches: nextAll, branchIds: nextBranches });
    if (input.branchIds) await assertBranchesInOrg(trx, orgId, input.branchIds);
    if (input.employeeId) { await assertEmployeeLinkable(trx, orgId, input.employeeId); await assertEmployeeUnlinked(trx, orgId, input.employeeId, { membershipId: id }); }
    if (!nextAll && nextBranches.length === 0) throw errors.validation('Select at least one branch or grant all branches.', { issues: [{ path: 'branchIds', message: 'Required' }] });
    await assertNotLastOwner(trx, orgId, id, { roleId: nextRole, status: nextStatus });
    // B-75: a login stays suspended while the employee it is linked to has left — re-activating the employee record
    // does not bring the login back, and neither does re-activating the login while the employee is still gone
    const nextEmployeeId = input.employeeId !== undefined ? input.employeeId : before.employeeId;
    if (nextStatus === 'active' && before.status !== 'active' && nextEmployeeId && input.employeeId === undefined && (await employeeHasLeft(trx, orgId, nextEmployeeId))) {
      throw errors.invalidState('The employee linked to this login has left the organisation: re-activate the employee record, or remove the link, before re-activating the login.');
    }
    // AGENTS.md: suspension / role downgrade → the user's sessions end (decided before the role changes)
    const endSessions: 'member_suspended' | 'role_downgraded' | null = before.status === 'active' && nextStatus !== 'active' ? 'member_suspended'
      : before.status === 'active' && (await isRoleDowngrade(trx, before.roleId, nextRole)) ? 'role_downgraded' : null;
    const patch: Record<string, unknown> = { roleId: nextRole, status: nextStatus, allBranches: nextAll };
    if (input.employeeId !== undefined) patch['employeeId'] = input.employeeId;
    if (nextStatus === 'active' && before.status !== 'active') patch['joinedAt'] = new Date();
    await trx.updateTable('orgMemberships').set(patch).where('id', '=', id).where('organizationId', '=', orgId).execute();
    if (nextAll) await trx.deleteFrom('membershipBranches').where('membershipId', '=', id).execute();
    else if (input.branchIds && (before.allBranches || !sameBranches(input.branchIds, before.branchIds))) {
      await trx.deleteFrom('membershipBranches').where('membershipId', '=', id).execute();
      await trx.insertInto('membershipBranches').values([...new Set(input.branchIds)].map((b) => ({ membershipId: id, branchId: b }))).execute();
    }
    const sessionsRevoked = endSessions ? await revokeSessions(deps, trx, { organizationId: orgId, userIds: [before.userId], reason: endSessions, requestId: actor.requestId }) : 0;
    const after = await loadMember(trx, orgId, id);
    const diff = diffObjects(before as unknown as Record<string, unknown>, { roleId: after.roleId, status: after.status, allBranches: after.allBranches, branchIds: after.branchIds, employeeId: after.employeeId });
    if (endSessions) (diff.newValue as Record<string, unknown>)['sessionsRevoked'] = sessionsRevoked;
    await audit(trx, actor, orgId, 'member.updated', 'org_membership', { entityId: id, ...diff });
    return after;
  });
}

export async function suspendMember(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<MemberDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    const before = await loadMember(trx, orgId, id);
    // THE member-management rule (review P0-3): not oneself, owners by owners, a role the caller may grant, within their branches
    await assertMayManageMember(trx, actor, grant, { userId: before.userId, roleId: before.roleId, allBranches: before.allBranches, branchIds: before.allBranches ? [] : await membershipBranchIds(trx, orgId, id) }, null);
    if (before.status === 'suspended') return before;
    await assertNotLastOwner(trx, orgId, id, { roleId: before.roleId, status: 'suspended' });
    await trx.updateTable('orgMemberships').set({ status: 'suspended' }).where('id', '=', id).where('organizationId', '=', orgId).execute();
    // AGENTS.md: suspension → the user's sessions end (inside this transaction: a rollback ends nobody's session)
    const sessionsRevoked = before.status === 'active' ? await revokeSessions(deps, trx, { organizationId: orgId, userIds: [before.userId], reason: 'member_suspended', requestId: actor.requestId }) : 0;
    await audit(trx, actor, orgId, 'member.suspended', 'org_membership', { entityId: id, oldValue: { status: before.status }, newValue: { status: 'suspended', sessionsRevoked } });
    return loadMember(trx, orgId, id);
  });
}

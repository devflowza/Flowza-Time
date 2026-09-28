import { sql } from 'kysely';
import { PORTAL_ADDRESS_RECENT_CHANGE_DAYS, SYSTEM_ROLE_IDS, type EmployeePortalAccessDto, type InvitationDto, type PortalAccessAddressDto, type PortalAccessChangeInput, type PortalAccessInviteInput, type PortalAccessResendResultDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { jsonObject } from '../lib/mappers.js';
import { revokeSessions } from '../lib/sessions.js';
import { type Actor, audit, runUser, withSystemScope } from '../lib/service.js';
import { assertNotLastOwner, createInvitation, invitationTarget, profileIdByEmail, resendWithin, revokeInvitationWithin } from './members.service.js';
import { assertMayManageMember, membershipBranchIds, type ManagedTarget } from './member-authority.js';
import { hasLeft } from './offboarding.js';

/**
 * "FlowZa Time access" on an employee profile (HR portal Prompt 6b; Finance B-67 … B-69, B-74). One login per employee
 * record (org_memberships.employee_id), reached through an invitation:
 *   - invite: to the address the administrator CHOSE (review P0-2: the known addresses of the record — work e-mail, the
 *     `personalEmail` custom field — are offered with who last changed them and when, never pre-selected), the `employee`
 *     role, the employee's own branch — role and scope overridable; older open invitations of the employee / the address are
 *     revoked first (B-68);
 *   - revoke: the linked login is SUSPENDED — the employee link stays (B-74), sessions end, open invitations are revoked;
 *   - restore: the suspended login is re-activated (never while the employee counts as left, B-75);
 *   - resend: a suspended linked login is restored directly (B-69), an open invitation is re-issued with a fresh token.
 * Reads need user.view, writes user.manage — the one rule of the users page. Every write goes through THE member-management
 * rule (member-authority.ts, review P0-1 / P0-3): nobody changes their own access, owners are changed by owners, the caller
 * must be able to grant the login's (or invitation's) role and cover its branch scope. Everything runs under the caller's RLS;
 * the invitation and suspension rules are members.service's own, reused, never re-implemented.
 */

type Employee = { id: string; displayName: string; email: string | null; branchId: string; employmentStatus: string; deletedAt: Date | null; customFields: unknown };

async function loadEmployee(trx: Trx, orgId: string, employeeId: string): Promise<Employee> {
  const e = await trx.selectFrom('employees').select(['id', 'displayName', 'email', 'branchId', 'employmentStatus', 'deletedAt', 'customFields']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  if (!e) throw errors.notFound('Employee', employeeId);
  return e as Employee;
}
const employeeLeft = (e: Employee) => e.deletedAt !== null || hasLeft(e.employmentStatus as Parameters<typeof hasLeft>[0]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (v: unknown): string | null => (typeof v === 'string' && EMAIL.test(v.trim()) ? v.trim() : null);
/** The `personalEmail` custom field (legacy spelling `personal_email`) of a record or of an audit snapshot of it. */
function personalEmailOf(customFields: unknown): string | null {
  const custom = jsonObject(customFields);
  return validEmail(custom['personalEmail']) ?? validEmail(custom['personal_email']);
}

/** The addresses an invitation could go to, as they stand on the record: the work e-mail field and the personal one. */
export function knownAddressesOf(e: Pick<Employee, 'email' | 'customFields'>): Array<{ email: string; source: 'work' | 'personal' }> {
  const out: Array<{ email: string; source: 'work' | 'personal' }> = [];
  const work = validEmail(e.email);
  if (work) out.push({ email: work, source: 'work' });
  const personal = personalEmailOf(e.customFields);
  if (personal && personal.toLowerCase() !== work?.toLowerCase()) out.push({ email: personal, source: 'personal' });
  return out;
}

interface FieldChange { at: Date; byUserId: string | null; byName: string | null }

/**
 * Who last changed each address field of an employee record and when — from the audit log (`employee.created` /
 * `employee.updated` carry the fields that changed; the personal e-mail lives in `customFields`). Read in the organisation's
 * system scope for this one record: the user admin rarely holds `audit.view`, and only the timestamp and the actor of these two
 * fields are returned, never another field.
 */
async function addressFieldChanges(trx: Trx, orgId: string, employeeId: string): Promise<{ work: FieldChange | null; personal: FieldChange | null }> {
  const rows = await withSystemScope(trx, orgId, (t) => t.selectFrom('audit.logs as a').leftJoin('userProfiles as u', 'u.id', 'a.actorUserId')
    .select(['a.action', 'a.createdAt', 'a.actorUserId', 'a.oldValue', 'a.newValue', 'u.fullName', 'u.email'])
    .where('a.organizationId', '=', orgId).where('a.entityType', '=', 'employee').where('a.entityId', '=', employeeId).where('a.action', 'in', ['employee.created', 'employee.updated'])
    .orderBy('a.createdAt', 'desc').orderBy('a.id', 'desc').limit(500).execute());
  let work: FieldChange | null = null;
  let personal: FieldChange | null = null;
  for (const r of rows) {
    if (work && personal) break;
    const next = jsonObject(r.newValue); const prev = jsonObject(r.oldValue);
    const change: FieldChange = { at: r.createdAt, byUserId: r.actorUserId, byName: r.fullName || r.email || null };
    if (!work && 'email' in next && (r.action === 'employee.updated' || next['email'])) work = change;
    if (!personal && 'customFields' in next && (r.action === 'employee.created' ? personalEmailOf(next['customFields']) !== null : personalEmailOf(next['customFields']) !== personalEmailOf(prev['customFields']))) personal = change;
  }
  return { work, personal };
}

/** The address choices with their provenance (review P0-2): nothing pre-selected, a recent change by somebody else flagged. */
async function addressChoices(trx: Trx, actor: Actor, orgId: string, e: Employee): Promise<PortalAccessAddressDto[]> {
  const known = knownAddressesOf(e);
  if (known.length === 0) return [];
  const changes = await addressFieldChanges(trx, orgId, e.id);
  const recentFrom = Date.now() - PORTAL_ADDRESS_RECENT_CHANGE_DAYS * 86_400_000;
  return known.map((k) => {
    const c = changes[k.source];
    return {
      email: k.email, source: k.source, changedAt: c ? c.at.toISOString() : null, changedByUserId: c?.byUserId ?? null, changedByName: c?.byName ?? null,
      recentlyChangedByOther: !!c && c.at.getTime() >= recentFrom && c.byUserId !== actor.userId,
    };
  });
}

type LinkedMembership = { id: string; userId: string; roleId: string; status: 'invited' | 'active' | 'suspended'; roleKey: string; roleName: string; allBranches: boolean; email: string | null; fullName: string | null; lastLoginAt: Date | null };

async function linkedMembership(trx: Trx, orgId: string, employeeId: string): Promise<LinkedMembership | undefined> {
  return trx.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId').leftJoin('userProfiles as u', 'u.id', 'm.userId')
    .select(['m.id', 'm.userId', 'm.roleId', 'm.status', 'm.allBranches', 'r.key as roleKey', 'r.name as roleName', 'u.email', 'u.fullName', 'u.lastLoginAt'])
    .where('m.organizationId', '=', orgId).where('m.employeeId', '=', employeeId).orderBy('m.createdAt', 'desc').executeTakeFirst();
}
/** The linked login as the member-management rule sees it: whose it is, its role and its branch scope. */
async function membershipTarget(trx: Trx, orgId: string, m: LinkedMembership): Promise<ManagedTarget> {
  return { userId: m.userId, roleId: m.roleId, allBranches: m.allBranches, branchIds: m.allBranches ? [] : await membershipBranchIds(trx, orgId, m.id) };
}
async function openInvitations(trx: Trx, orgId: string, employeeId: string, email: string | null) {
  return trx.selectFrom('invitations as i').leftJoin('roles as r', 'r.id', 'i.roleId')
    .select(['i.id', 'i.email', 'i.roleId', 'i.allBranches', 'i.branchIds', 'r.name as roleName', 'i.expiresAt', 'i.createdAt'])
    .where('i.organizationId', '=', orgId).where('i.acceptedAt', 'is', null).where('i.revokedAt', 'is', null)
    .where((eb) => eb.or([eb('i.employeeId', '=', employeeId), ...(email ? [eb(sql`lower(i.email::text)`, '=', email.toLowerCase())] : [])]))
    .orderBy('i.createdAt', 'desc').execute();
}

async function accessWithin(trx: Trx, actor: Actor, orgId: string, employeeId: string): Promise<EmployeePortalAccessDto> {
  const e = await loadEmployee(trx, orgId, employeeId);
  const m = await linkedMembership(trx, orgId, employeeId);
  const inv = (await openInvitations(trx, orgId, employeeId, null))[0];
  const state: EmployeePortalAccessDto['state'] = m?.status === 'active' ? 'active' : m?.status === 'suspended' ? 'suspended' : inv || m?.status === 'invited' ? 'invited' : 'none';
  return {
    employeeId, state,
    membership: m ? { id: m.id, userId: m.userId, email: m.email ?? '', fullName: m.fullName ?? '', roleId: m.roleId, roleName: m.roleName, status: m.status, lastLoginAt: m.lastLoginAt ? m.lastLoginAt.toISOString() : null } : null,
    invitation: inv ? { id: inv.id, email: inv.email, roleId: inv.roleId, roleName: inv.roleName ?? null, expiresAt: inv.expiresAt.toISOString(), createdAt: inv.createdAt.toISOString(), expired: inv.expiresAt.getTime() < Date.now() } : null,
    addresses: await addressChoices(trx, actor, orgId, e), employeeLeft: employeeLeft(e),
  };
}

/** GET /orgs/:orgId/employees/:id/portal-access. */
export async function getPortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<EmployeePortalAccessDto> {
  requirePermission(actor.principal, orgId, 'user.view');
  return runUser(deps.db, actor, (trx) => accessWithin(trx, actor, orgId, employeeId));
}

/**
 * Where the address an administrator chose comes from (review P0-2): the work e-mail field, the personal one, or typed in —
 * with who last changed that field and when. Recorded on the invitation's audit row.
 */
async function addressProvenance(trx: Trx, orgId: string, e: Employee, email: string): Promise<{ source: 'work' | 'personal' | 'entered'; changedAt: string | null; changedByUserId: string | null }> {
  const match = knownAddressesOf(e).find((k) => k.email.toLowerCase() === email.toLowerCase());
  if (!match) return { source: 'entered', changedAt: null, changedByUserId: null };
  const c = (await addressFieldChanges(trx, orgId, e.id))[match.source];
  return { source: match.source, changedAt: c ? c.at.toISOString() : null, changedByUserId: c?.byUserId ?? null };
}

/** POST /orgs/:orgId/employees/:id/portal-access/invite — "Invite to FlowZa Time" (B-67 / B-68). */
export async function invitePortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: PortalAccessInviteInput): Promise<{ invitation: InvitationDto; access: EmployeePortalAccessDto }> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  const pre = await runUser(deps.db, actor, async (trx) => ({ e: await loadEmployee(trx, orgId, employeeId), m: await linkedMembership(trx, orgId, employeeId) }));
  if (employeeLeft(pre.e)) throw errors.invalidState('This employee has left the organisation (terminated, resigned or archived); a login cannot be linked to them.');
  if (pre.m?.status === 'active') throw errors.conflict('This employee already has FlowZa Time access.');
  if (pre.m?.status === 'suspended') throw errors.conflict('This employee\'s access was revoked: restore it instead of inviting again.', { membershipId: pre.m.id });
  // review P0-2: the address is the administrator's explicit choice — never defaulted from fields an employee.update holder edits
  const email = input.email.trim();
  const allBranches = input.allBranches ?? false;
  const branchIds = allBranches ? [] : (input.branchIds && input.branchIds.length ? input.branchIds : [pre.e.branchId]);
  const profileId = await profileIdByEmail(deps, orgId, actor.requestId, email);
  return runUser(deps.db, actor, async (trx) => {
    // B-68: older open invitations of this employee — or to this address — are revoked before the new one is issued; each is
    // a target of the member-management rule (a lower administrator never supersedes an invitation above them)
    for (const old of await openInvitations(trx, orgId, employeeId, email)) {
      await assertMayManageMember(trx, actor, grant, invitationTarget(old), null);
      await revokeInvitationWithin(trx, actor, orgId, old, 'superseded');
      await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: old.id, oldValue: { email: old.email }, newValue: { cause: 'superseded', employeeId } });
    }
    const address = await addressProvenance(trx, orgId, pre.e, email);
    const invitation = await createInvitation(deps, trx, actor, grant, orgId, { email, roleId: input.roleId ?? SYSTEM_ROLE_IDS.employee, allBranches, branchIds, employeeId }, profileId, { source: 'employee_profile', address });
    return { invitation, access: await accessWithin(trx, actor, orgId, employeeId) };
  });
}

/**
 * The linked login may be changed by this caller (THE member-management rule — not oneself, owners by owners, a role the
 * caller may grant, within their branches) and, when it is being suspended, is not the organisation's last active owner.
 */
async function assertMayChange(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, m: LinkedMembership, next: 'suspended' | 'active'): Promise<void> {
  await assertMayManageMember(trx, actor, grant, await membershipTarget(trx, orgId, m), null);
  if (next === 'suspended') await assertNotLastOwner(trx, orgId, m.id, { roleId: m.roleId, status: 'suspended' });
}

/**
 * POST /orgs/:orgId/employees/:id/portal-access/revoke (B-74): the linked login is suspended, the employee link KEPT; the
 * user's sessions end in the same transaction; open invitations of the employee are revoked so nobody accepts back in.
 */
export async function revokePortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: PortalAccessChangeInput): Promise<EmployeePortalAccessDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, async (trx) => {
    await loadEmployee(trx, orgId, employeeId);
    const m = await linkedMembership(trx, orgId, employeeId);
    const open = await openInvitations(trx, orgId, employeeId, null);
    if ((!m || m.status === 'suspended') && open.length === 0) throw errors.invalidState('This employee has no FlowZa Time access to revoke.');
    // every target first, then the changes: a refusal never leaves half of it done
    if (m && m.status !== 'suspended') await assertMayChange(trx, actor, grant, orgId, m, 'suspended');
    for (const inv of open) await assertMayManageMember(trx, actor, grant, invitationTarget(inv), null);
    for (const inv of open) {
      await revokeInvitationWithin(trx, actor, orgId, inv, 'access_revoked');
      await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: inv.id, oldValue: { email: inv.email }, newValue: { cause: 'access_revoked', employeeId }, reason: input.reason ?? null });
    }
    if (m && m.status !== 'suspended') {
      await trx.updateTable('orgMemberships').set({ status: 'suspended' }).where('organizationId', '=', orgId).where('id', '=', m.id).execute();
      const sessionsRevoked = m.status === 'active' ? await revokeSessions(deps, trx, { organizationId: orgId, userIds: [m.userId], reason: 'member_suspended', requestId: actor.requestId }) : 0;
      await audit(trx, actor, orgId, 'member.portal_access_revoked', 'org_membership', { entityId: m.id, oldValue: { status: m.status }, newValue: { status: 'suspended', employeeId, sessionsRevoked }, reason: input.reason ?? null });
    }
    return accessWithin(trx, actor, orgId, employeeId);
  });
}

async function restoreWithin(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, employeeId: string, reason: string | null): Promise<EmployeePortalAccessDto> {
  const e = await loadEmployee(trx, orgId, employeeId);
  const m = await linkedMembership(trx, orgId, employeeId);
  if (!m || m.status !== 'suspended') throw errors.invalidState('This employee has no revoked FlowZa Time access to restore.');
  // B-75: a login stays suspended while the employee it is linked to has left
  if (employeeLeft(e)) throw errors.invalidState('The employee linked to this login has left the organisation: re-activate the employee record before restoring access.');
  await assertMayChange(trx, actor, grant, orgId, m, 'active');
  await trx.updateTable('orgMemberships').set({ status: 'active', joinedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', m.id).where('status', '=', 'suspended').execute();
  await audit(trx, actor, orgId, 'member.portal_access_restored', 'org_membership', { entityId: m.id, oldValue: { status: 'suspended' }, newValue: { status: 'active', employeeId }, reason });
  return accessWithin(trx, actor, orgId, employeeId);
}

/** POST /orgs/:orgId/employees/:id/portal-access/restore. */
export async function restorePortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: PortalAccessChangeInput): Promise<EmployeePortalAccessDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  return runUser(deps.db, actor, (trx) => restoreWithin(trx, actor, grant, orgId, employeeId, input.reason ?? null));
}

/** POST /orgs/:orgId/employees/:id/portal-access/resend — B-69: a linked, suspended login is restored directly; else re-invite. */
export async function resendPortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<PortalAccessResendResultDto> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  const pre = await runUser(deps.db, actor, async (trx) => ({ m: await linkedMembership(trx, orgId, employeeId), inv: (await openInvitations(trx, orgId, employeeId, null))[0], e: await loadEmployee(trx, orgId, employeeId) }));
  if (pre.m?.status === 'suspended') {
    const access = await runUser(deps.db, actor, (trx) => restoreWithin(trx, actor, grant, orgId, employeeId, 'resend'));
    return { action: 'restored', invitation: null, access };
  }
  if (pre.m?.status === 'active') throw errors.invalidState('This employee already has FlowZa Time access.');
  if (!pre.inv) throw errors.invalidState('There is no invitation to resend: invite the employee instead.');
  if (employeeLeft(pre.e)) throw errors.invalidState('This employee has left the organisation; the invitation cannot be resent.');
  const profileId = await profileIdByEmail(deps, orgId, actor.requestId, pre.inv.email);
  return runUser(deps.db, actor, async (trx) => {
    const invitation = await resendWithin(deps, trx, actor, grant, orgId, pre.inv!.id, profileId);
    return { action: 'reinvited', invitation, access: await accessWithin(trx, actor, orgId, employeeId) };
  });
}

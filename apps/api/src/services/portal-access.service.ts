import { sql } from 'kysely';
import { SYSTEM_ROLE_IDS, type EmployeePortalAccessDto, type InvitationDto, type PortalAccessChangeInput, type PortalAccessInviteInput, type PortalAccessResendResultDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { requirePermission } from '../lib/authorize.js';
import { jsonObject } from '../lib/mappers.js';
import { revokeSessions } from '../lib/sessions.js';
import { type Actor, audit, runUser } from '../lib/service.js';
import { assertNotLastOwner, createInvitation, profileIdByEmail, resendWithin, revokeInvitationWithin } from './members.service.js';
import { hasLeft } from './offboarding.js';

/**
 * "FlowZa Time access" on an employee profile (HR portal Prompt 6b; Finance B-67 … B-69, B-74). One login per employee
 * record (org_memberships.employee_id), reached through an invitation:
 *   - invite: the work e-mail (else a `personalEmail` custom field), the `employee` role, the employee's own branch — every
 *     default overridable; older open invitations of the employee / the address are revoked first (B-68);
 *   - revoke: the linked login is SUSPENDED — the employee link stays (B-74), sessions end, open invitations are revoked;
 *   - restore: the suspended login is re-activated (never while the employee counts as left, B-75);
 *   - resend: a suspended linked login is restored directly (B-69), an open invitation is re-issued with a fresh token.
 * Reads need user.view, writes user.manage — the one rule of the users page (`inviteMember` checks user.manage). Everything
 * runs under the caller's RLS; the invitation and suspension rules are members.service's own, reused, never re-implemented.
 */

type Employee = { id: string; displayName: string; email: string | null; branchId: string; employmentStatus: string; deletedAt: Date | null; customFields: unknown };

async function loadEmployee(trx: Trx, orgId: string, employeeId: string): Promise<Employee> {
  const e = await trx.selectFrom('employees').select(['id', 'displayName', 'email', 'branchId', 'employmentStatus', 'deletedAt', 'customFields']).where('organizationId', '=', orgId).where('id', '=', employeeId).executeTakeFirst();
  if (!e) throw errors.notFound('Employee', employeeId);
  return e as Employee;
}
const employeeLeft = (e: Employee) => e.deletedAt !== null || hasLeft(e.employmentStatus as Parameters<typeof hasLeft>[0]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The address an invitation goes to: the work e-mail, else a `personalEmail` custom field (Finance: COALESCE(work_email, email)). */
export function suggestedEmailOf(e: Pick<Employee, 'email' | 'customFields'>): { email: string | null; source: 'work' | 'personal' | null } {
  const work = e.email?.trim();
  if (work && EMAIL.test(work)) return { email: work, source: 'work' };
  const custom = jsonObject(e.customFields);
  const personal = [custom['personalEmail'], custom['personal_email']].find((v): v is string => typeof v === 'string' && EMAIL.test(v.trim()));
  return personal ? { email: personal.trim(), source: 'personal' } : { email: null, source: null };
}

async function linkedMembership(trx: Trx, orgId: string, employeeId: string) {
  return trx.selectFrom('orgMemberships as m').innerJoin('roles as r', 'r.id', 'm.roleId').leftJoin('userProfiles as u', 'u.id', 'm.userId')
    .select(['m.id', 'm.userId', 'm.roleId', 'm.status', 'r.key as roleKey', 'r.name as roleName', 'u.email', 'u.fullName', 'u.lastLoginAt'])
    .where('m.organizationId', '=', orgId).where('m.employeeId', '=', employeeId).orderBy('m.createdAt', 'desc').executeTakeFirst();
}
async function openInvitations(trx: Trx, orgId: string, employeeId: string, email: string | null) {
  return trx.selectFrom('invitations as i').leftJoin('roles as r', 'r.id', 'i.roleId')
    .select(['i.id', 'i.email', 'i.roleId', 'r.name as roleName', 'i.expiresAt', 'i.createdAt'])
    .where('i.organizationId', '=', orgId).where('i.acceptedAt', 'is', null).where('i.revokedAt', 'is', null)
    .where((eb) => eb.or([eb('i.employeeId', '=', employeeId), ...(email ? [eb(sql`lower(i.email::text)`, '=', email.toLowerCase())] : [])]))
    .orderBy('i.createdAt', 'desc').execute();
}

async function accessWithin(trx: Trx, orgId: string, employeeId: string): Promise<EmployeePortalAccessDto> {
  const e = await loadEmployee(trx, orgId, employeeId);
  const m = await linkedMembership(trx, orgId, employeeId);
  const inv = (await openInvitations(trx, orgId, employeeId, null))[0];
  const suggested = suggestedEmailOf(e);
  const state: EmployeePortalAccessDto['state'] = m?.status === 'active' ? 'active' : m?.status === 'suspended' ? 'suspended' : inv || m?.status === 'invited' ? 'invited' : 'none';
  return {
    employeeId, state,
    membership: m ? { id: m.id, userId: m.userId, email: m.email ?? '', fullName: m.fullName ?? '', roleId: m.roleId, roleName: m.roleName, status: m.status, lastLoginAt: m.lastLoginAt ? m.lastLoginAt.toISOString() : null } : null,
    invitation: inv ? { id: inv.id, email: inv.email, roleId: inv.roleId, roleName: inv.roleName ?? null, expiresAt: inv.expiresAt.toISOString(), createdAt: inv.createdAt.toISOString(), expired: inv.expiresAt.getTime() < Date.now() } : null,
    suggestedEmail: suggested.email, suggestedEmailSource: suggested.source, employeeLeft: employeeLeft(e),
  };
}

/** GET /orgs/:orgId/employees/:id/portal-access. */
export async function getPortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string): Promise<EmployeePortalAccessDto> {
  requirePermission(actor.principal, orgId, 'user.view');
  return runUser(deps.db, actor, (trx) => accessWithin(trx, orgId, employeeId));
}

/** POST /orgs/:orgId/employees/:id/portal-access/invite — "Invite to FlowZa Time" (B-67 / B-68). */
export async function invitePortalAccess(deps: ApiDeps, actor: Actor, orgId: string, employeeId: string, input: PortalAccessInviteInput): Promise<{ invitation: InvitationDto; access: EmployeePortalAccessDto }> {
  const grant = requirePermission(actor.principal, orgId, 'user.manage');
  const pre = await runUser(deps.db, actor, async (trx) => ({ e: await loadEmployee(trx, orgId, employeeId), m: await linkedMembership(trx, orgId, employeeId) }));
  if (employeeLeft(pre.e)) throw errors.invalidState('This employee has left the organisation (terminated, resigned or archived); a login cannot be linked to them.');
  if (pre.m?.status === 'active') throw errors.conflict('This employee already has FlowZa Time access.');
  if (pre.m?.status === 'suspended') throw errors.conflict('This employee\'s access was revoked: restore it instead of inviting again.', { membershipId: pre.m.id });
  const email = input.email ?? suggestedEmailOf(pre.e).email;
  if (!email) throw errors.validation('The employee has no e-mail address on record: enter the address to invite.', { issues: [{ path: 'email', message: 'Required' }] });
  const allBranches = input.allBranches ?? false;
  const branchIds = allBranches ? [] : (input.branchIds && input.branchIds.length ? input.branchIds : [pre.e.branchId]);
  const profileId = await profileIdByEmail(deps, orgId, actor.requestId, email);
  return runUser(deps.db, actor, async (trx) => {
    // B-68: older open invitations of this employee — or to this address — are revoked before the new one is issued
    for (const old of await openInvitations(trx, orgId, employeeId, email)) {
      await revokeInvitationWithin(trx, actor, orgId, old, 'superseded');
      await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: old.id, oldValue: { email: old.email }, newValue: { cause: 'superseded', employeeId } });
    }
    const invitation = await createInvitation(deps, trx, actor, grant, orgId, { email, roleId: input.roleId ?? SYSTEM_ROLE_IDS.employee, allBranches, branchIds, employeeId }, profileId, { source: 'employee_profile' });
    return { invitation, access: await accessWithin(trx, orgId, employeeId) };
  });
}

/** The same protections as suspending a member (members.service suspendMember), for the linked login. */
async function assertMayChange(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, m: { id: string; userId: string; roleId: string; roleKey: string }, next: 'suspended' | 'active'): Promise<void> {
  if (m.roleKey === 'owner' && grant.roleKey !== 'owner') throw errors.forbidden('Only an owner can change another owner\'s access.');
  if (m.userId === actor.userId) throw errors.invalidState('You cannot change your own access.');
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
    for (const inv of open) {
      await revokeInvitationWithin(trx, actor, orgId, inv, 'access_revoked');
      await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', { entityId: inv.id, oldValue: { email: inv.email }, newValue: { cause: 'access_revoked', employeeId }, reason: input.reason ?? null });
    }
    if (m && m.status !== 'suspended') {
      await assertMayChange(trx, actor, grant, orgId, m, 'suspended');
      await trx.updateTable('orgMemberships').set({ status: 'suspended' }).where('organizationId', '=', orgId).where('id', '=', m.id).execute();
      const sessionsRevoked = m.status === 'active' ? await revokeSessions(deps, trx, { organizationId: orgId, userIds: [m.userId], reason: 'member_suspended', requestId: actor.requestId }) : 0;
      await audit(trx, actor, orgId, 'member.portal_access_revoked', 'org_membership', { entityId: m.id, oldValue: { status: m.status }, newValue: { status: 'suspended', employeeId, sessionsRevoked }, reason: input.reason ?? null });
    }
    return accessWithin(trx, orgId, employeeId);
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
  return accessWithin(trx, orgId, employeeId);
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
    return { action: 'reinvited', invitation, access: await accessWithin(trx, orgId, employeeId) };
  });
}

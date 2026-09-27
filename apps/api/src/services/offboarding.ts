import { SYSTEM_ROLE_IDS, type EmployeeDto } from '@flowza/contracts';
import type { Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../deps.js';
import { type Actor, audit, withSystemScope } from '../lib/service.js';
import { revokeSessions } from '../lib/sessions.js';
import { toCount } from '../lib/pagination.js';

/** Employment statuses that mean the person has left the organisation (B-75). Archiving a record counts as leaving too. */
export const LEFT_EMPLOYMENT_STATUSES = ['terminated', 'resigned'] as const satisfies readonly EmployeeDto['employmentStatus'][];
export const hasLeft = (status: EmployeeDto['employmentStatus']): boolean => (LEFT_EMPLOYMENT_STATUSES as readonly string[]).includes(status);

export interface LeaverContext {
  /** What ended the employment: a status change (single or bulk) or archiving the record. */
  source: 'update' | 'bulk_set_status' | 'delete';
  employmentStatus: EmployeeDto['employmentStatus'];
}

/**
 * B-75 — an employee who leaves (employment status terminated/resigned, or the record is archived) loses every login linked
 * to their record in this organisation:
 *  - each linked membership (org_memberships.employee_id; active or invited) is set to `suspended` — the employee link is
 *    KEPT, so HR can see whose login it was. Re-activating the employee later does NOT re-activate the login: an
 *    administrator does that explicitly on the member (members.service refuses while the employee still counts as left);
 *  - pending invitations that would link the record are revoked, so nobody can accept their way back in;
 *  - the Supabase Auth sessions of every user whose membership was active are ended (lib/sessions.ts);
 *  - every step is audited as the acting HR user.
 *
 * The same rules as suspending a member apply, because this IS suspending members: only an owner may end an owner's
 * login, nobody ends their own, and the organisation keeps at least one active owner. A refusal aborts the whole change —
 * the termination is not recorded while it would leave a login behind.
 *
 * Reads and writes run in the organisation's system scope, deliberately: the HR actor was authorised for the employee
 * change (employee.update / employee.delete), and memberships are hidden from — and not writable by — callers without
 * user.view / user.manage under RLS. Runs inside the caller's transaction, so everything commits or rolls back together.
 */
export async function offboardLinkedLogins(deps: ApiDeps, trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, employeeIds: string[], context: LeaverContext): Promise<void> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return;
  const { logins, invitations, activeOwners } = await withSystemScope(trx, orgId, async (t) => ({
    logins: await t.selectFrom('orgMemberships').select(['id', 'userId', 'employeeId', 'status', 'roleId'])
      .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('status', '<>', 'suspended').orderBy('id').execute(),
    invitations: await t.selectFrom('invitations').select(['id', 'email', 'employeeId'])
      .where('organizationId', '=', orgId).where('employeeId', 'in', ids).where('acceptedAt', 'is', null).orderBy('id').execute(),
    activeOwners: toCount((await t.selectFrom('orgMemberships').select((eb) => eb.fn.countAll().as('n'))
      .where('organizationId', '=', orgId).where('roleId', '=', SYSTEM_ROLE_IDS.owner).where('status', '=', 'active').executeTakeFirst())?.n),
  }));
  if (logins.length === 0 && invitations.length === 0) return;

  // the rules of member suspension (members.service suspendMember), checked before anything is written
  for (const l of logins) {
    if (l.userId === actor.userId) {
      throw errors.invalidState('This employee record is linked to your own login: ending the employment would lock you out. Ask another administrator to record it.', { employeeId: l.employeeId });
    }
    if (l.roleId === SYSTEM_ROLE_IDS.owner && grant.roleKey !== 'owner') {
      throw errors.forbidden('This employee is linked to an owner\'s login. Only an owner can end it: suspend the member or transfer ownership first, then record the change.');
    }
  }
  const ownersLeaving = logins.filter((l) => l.roleId === SYSTEM_ROLE_IDS.owner && l.status === 'active').length;
  if (ownersLeaving > 0 && activeOwners - ownersLeaving < 1) {
    throw errors.invalidState('An organisation must keep at least one active owner: transfer ownership before ending this employment.');
  }

  await withSystemScope(trx, orgId, async (t) => {
    if (logins.length) await t.updateTable('orgMemberships').set({ status: 'suspended' }).where('organizationId', '=', orgId).where('id', 'in', logins.map((l) => l.id)).execute();
    if (invitations.length) await t.deleteFrom('invitations').where('organizationId', '=', orgId).where('id', 'in', invitations.map((i) => i.id)).execute();
  });

  for (const l of logins) {
    // only a login that could be used has sessions worth ending; an invited membership was never active here
    const sessionsRevoked = l.status === 'active'
      ? await revokeSessions(deps, trx, { organizationId: orgId, userIds: [l.userId], reason: 'employee_left', requestId: actor.requestId })
      : 0;
    await audit(trx, actor, orgId, 'member.suspended', 'org_membership', {
      entityId: l.id,
      oldValue: { status: l.status },
      newValue: { status: 'suspended', userId: l.userId, employeeId: l.employeeId, cause: 'employee_left', source: context.source, employmentStatus: context.employmentStatus, sessionsRevoked },
      reason: 'Employee left the organisation',
    });
  }
  for (const i of invitations) {
    await audit(trx, actor, orgId, 'member.invitation_revoked', 'invitation', {
      entityId: i.id,
      oldValue: { email: i.email, employeeId: i.employeeId },
      newValue: { cause: 'employee_left', source: context.source },
      reason: 'Employee left the organisation',
    });
  }
}

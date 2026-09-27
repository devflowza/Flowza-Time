import type { ApprovalDelegationDto, ApprovalDelegationInput, ApprovalEntity } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { hasPermission, requireMembership } from '../../lib/authorize.js';
import { enumArrayOrNull, isoDate, isoDateTime, isoDateTimeOrNull } from '../../lib/mappers.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { likeContains } from '../../lib/pagination.js';
import { systemStep } from '../features/context.js';
import { dv } from '../features/sql-helpers.js';

type Row = { id: string; organizationId: string; delegatorUserId: string; delegateUserId: string; entityTypes: unknown; startsOn: Date | string; endsOn: Date | string; isActive: boolean; reason: string | null; createdAt: Date; revokedAt: Date | null };

async function toDtos(trx: Parameters<typeof withSystemScope>[0], orgId: string, rows: Row[]): Promise<ApprovalDelegationDto[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.delegatorUserId, r.delegateUserId]))];
  const users = ids.length ? await withSystemScope(trx, orgId, (t) => t.selectFrom('userProfiles').select(['id', 'fullName', 'email']).where('id', 'in', ids).execute()) : [];
  const name = new Map(users.map((u) => [u.id, u.fullName || u.email]));
  return rows.map((r) => ({ id: r.id, organizationId: r.organizationId, delegatorUserId: r.delegatorUserId, delegatorName: name.get(r.delegatorUserId) ?? null, delegateUserId: r.delegateUserId, delegateName: name.get(r.delegateUserId) ?? null, entityTypes: enumArrayOrNull<ApprovalEntity>(r.entityTypes), startsOn: isoDate(r.startsOn), endsOn: isoDate(r.endsOn), isActive: r.isActive, reason: r.reason, createdAt: isoDateTime(r.createdAt), revokedAt: isoDateTimeOrNull(r.revokedAt) }));
}

/** Own delegations (either side) for `approval.delegate` holders; the whole organisation's for `approval.manage`. */
export async function listDelegations(deps: ApiDeps, actor: Actor, orgId: string, q: { scope: 'mine' | 'all'; activeOnly: boolean }): Promise<ApprovalDelegationDto[]> {
  const grant = requireMembership(actor.principal, orgId);
  const manage = hasPermission(grant, 'approval.manage') || grant.roleKey === 'owner';
  if (q.scope === 'all' && !manage) throw errors.forbidden('Missing permission: approval.manage.');
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('approvalDelegations').selectAll().where('organizationId', '=', orgId);
    if (q.scope === 'mine') base = base.where((eb) => eb.or([eb('delegatorUserId', '=', actor.userId), eb('delegateUserId', '=', actor.userId)]));
    if (q.activeOnly) base = base.where('isActive', '=', true).where('endsOn', '>=', dv(new Date().toISOString().slice(0, 10)));
    const rows = await base.orderBy('isActive', 'desc').orderBy('startsOn', 'desc').orderBy('createdAt', 'desc').execute();
    return toDtos(trx, orgId, rows as Row[]);
  });
}

/**
 * Create a delegation. `approval.delegate` lets a member delegate their own approvals; `approval.manage` may delegate on
 * somebody else's behalf. The delegate must be an active member and somebody else. Requests routed from now on stamp the
 * delegate as an extra actor in the delegator's seat; requests already in flight accept the delegate at decision time.
 */
export async function createDelegation(deps: ApiDeps, actor: Actor, orgId: string, input: ApprovalDelegationInput): Promise<ApprovalDelegationDto> {
  const grant = requireMembership(actor.principal, orgId);
  const manage = hasPermission(grant, 'approval.manage') || grant.roleKey === 'owner';
  const delegator = input.delegatorUserId ?? actor.userId;
  if (delegator !== actor.userId && !manage) throw errors.forbidden('Missing permission: approval.manage (delegating on behalf of somebody else).');
  if (delegator === actor.userId && !manage && !hasPermission(grant, 'approval.delegate')) throw errors.forbidden('Missing permission: approval.delegate.');
  if (input.delegateUserId === delegator) throw errors.validation('You cannot delegate to yourself.', { issues: [{ path: 'delegateUserId', message: 'Same as delegator' }] });
  return runUser(deps.db, actor, async (trx) => {
    const row = await systemStep(trx, orgId, async (t) => {
      const members = await t.selectFrom('orgMemberships').select('userId').where('organizationId', '=', orgId).where('status', '=', 'active').where('userId', 'in', [delegator, input.delegateUserId]).execute();
      if (!members.some((m) => m.userId === input.delegateUserId)) throw errors.validation('The delegate is not an active member of this organisation.', { issues: [{ path: 'delegateUserId', message: 'Not an active member' }] });
      if (!members.some((m) => m.userId === delegator)) throw errors.validation('The delegator is not an active member of this organisation.', { issues: [{ path: 'delegatorUserId', message: 'Not an active member' }] });
      return t.insertInto('approvalDelegations').values({ organizationId: orgId, delegatorUserId: delegator, delegateUserId: input.delegateUserId, entityTypes: input.entityTypes ?? null, startsOn: input.startsOn, endsOn: input.endsOn, reason: input.reason ?? null, createdBy: actor.userId }).returningAll().executeTakeFirstOrThrow();
    });
    await audit(trx, actor, orgId, 'approval_delegation.created', 'approval_delegation', { entityId: row.id, newValue: { ...input, delegatorUserId: delegator } });
    return (await toDtos(trx, orgId, [row as Row]))[0]!;
  });
}

/** Revoke (soft): the delegator, the delegate or approval.manage. Requests already stamped keep the delegate's seat only while the delegation is in force — decisions re-check it. */
export async function revokeDelegation(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<void> {
  const grant = requireMembership(actor.principal, orgId);
  const manage = hasPermission(grant, 'approval.manage') || grant.roleKey === 'owner';
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('approvalDelegations').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Delegation', id);
    if (!manage && row.delegatorUserId !== actor.userId && row.delegateUserId !== actor.userId) throw errors.forbidden('Only the delegator, the delegate or approval.manage can revoke a delegation.');
    if (!row.isActive) return;
    await systemStep(trx, orgId, (t) => t.updateTable('approvalDelegations').set({ isActive: false, revokedAt: new Date(), revokedBy: actor.userId }).where('id', '=', id).execute());
    await audit(trx, actor, orgId, 'approval_delegation.revoked', 'approval_delegation', { entityId: id, oldValue: { delegatorUserId: row.delegatorUserId, delegateUserId: row.delegateUserId } });
  });
}

/**
 * People a delegation (or a reassignment) can name: active members of the organisation, searched by name or e-mail, 20 at
 * most. For approval.delegate / approval.manage holders — a line manager has no user.view, yet must be able to pick the
 * colleague who covers for them. Names and e-mails only, read in the organisation's system scope.
 */
export async function listDelegateCandidates(deps: ApiDeps, actor: Actor, orgId: string, search: string | undefined): Promise<Array<{ userId: string; fullName: string | null; email: string }>> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'approval.delegate') && !hasPermission(grant, 'approval.manage') && grant.roleKey !== 'owner') throw errors.forbidden('Missing permission: approval.delegate.');
  const term = (search ?? '').trim().toLowerCase().slice(0, 100);
  return runUser(deps.db, actor, (trx) => withSystemScope(trx, orgId, async (t) => {
    let q = t.selectFrom('orgMemberships as m').innerJoin('userProfiles as u', 'u.id', 'm.userId').select(['m.userId', 'u.fullName', 'u.email'])
      .where('m.organizationId', '=', orgId).where('m.status', '=', 'active');
    if (term) { const like = likeContains(term); q = q.where((eb) => eb.or([eb('u.fullName', 'ilike', like), eb('u.email', 'ilike', like)])); }
    return q.orderBy('u.fullName').limit(20).execute();
  }));
}

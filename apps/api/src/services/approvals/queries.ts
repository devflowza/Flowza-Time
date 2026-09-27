import { sql, type ExpressionBuilder } from 'kysely';
import type { ApprovalInboxQuery, ApprovalRequestDto, MyApprovalsQuery } from '@flowza/contracts';
import type { DB } from '@flowza/database';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireMembership } from '../../lib/authorize.js';
import { pageOf, toCount } from '../../lib/pagination.js';
import { type Actor, runUser } from '../../lib/service.js';
import { dv } from '../features/sql-helpers.js';
import { hydrateRequests } from './dto.js';

const ORG_WIDE = ['attendance.view', 'leave.view', 'approval.manage'] as const;
const TEAM_KEYS = ['attendance.view_team', 'leave.view_team'] as const;
const NIL = '00000000-0000-0000-0000-000000000000';

type RB = ExpressionBuilder<DB, 'approvalRequests'>;

/** `mine`: a pending actor row for me on the current step, or a pending actor who delegates to me today for the entity type. */
function mineCurrentStep(eb: RB, userId: string) {
  return eb.exists(
    eb.selectFrom('approvalSteps as s').innerJoin('approvalStepActors as a', 'a.stepId', 's.id').select(sql`1`.as('x'))
      .whereRef('s.requestId', '=', 'approvalRequests.id').whereRef('s.stepNo', '=', 'approvalRequests.currentStep').where('a.decision', '=', 'PENDING')
      .where((e) => e.or([
        e('a.userId', '=', userId),
        e.exists(e.selectFrom('approvalDelegations as d').select(sql`1`.as('y')).whereRef('d.delegatorUserId', '=', 'a.userId').where('d.delegateUserId', '=', userId).where('d.isActive', '=', true)
          .where(sql<boolean>`current_date between d.starts_on and d.ends_on`).where(sql<boolean>`(d.entity_types is null or approval_requests.entity_type = any (d.entity_types))`)),
      ])),
  );
}
/** History for `mine`: any decision or seat of mine on any step, or a request I closed. */
function mineInvolved(eb: RB, userId: string) {
  return eb.or([
    eb.exists(eb.selectFrom('approvalSteps as s').innerJoin('approvalStepActors as a', 'a.stepId', 's.id').select(sql`1`.as('x')).whereRef('s.requestId', '=', 'approvalRequests.id').where('a.userId', '=', userId)),
    eb('approvalRequests.decidedBy', '=', userId),
    eb('approvalRequests.cancelledBy', '=', userId),
  ]);
}

/**
 * The unified inbox. Rows are read under the caller's RLS (assignee / subject / team / org keys), then narrowed by scope:
 * `mine` = my queue (or my history), `team` = my direct reports' requests (needs a team key), `all` = the organisation
 * (needs an org-wide key; branch scope applies). Pending sorts oldest first (a queue), history newest first.
 */
export async function listInbox(deps: ApiDeps, actor: Actor, orgId: string, q: ApprovalInboxQuery): Promise<{ data: ApprovalRequestDto[]; total: number }> {
  const grant = requireMembership(actor.principal, orgId);
  const orgWide = ORG_WIDE.some((p) => hasPermission(grant, p));
  const teamKey = TEAM_KEYS.some((p) => hasPermission(grant, p));
  if (q.scope === 'all' && !orgWide) throw errors.forbidden('Missing permission: attendance.view, leave.view or approval.manage.');
  if (q.scope === 'team' && !teamKey && !orgWide) throw errors.forbidden('Missing permission: attendance.view_team or leave.view_team.');
  const scope = branchFilter(grant, q.branchId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('approvalRequests').where('approvalRequests.organizationId', '=', orgId);
    if (q.view === 'pending') base = base.where('approvalRequests.status', '=', 'PENDING');
    else base = q.status && q.status !== 'PENDING' ? base.where('approvalRequests.status', '=', q.status) : base.where('approvalRequests.status', '!=', 'PENDING');
    if (q.scope === 'mine') base = q.view === 'pending' ? base.where((eb) => mineCurrentStep(eb, actor.userId)) : base.where((eb) => mineInvolved(eb, actor.userId));
    else if (q.scope === 'team') base = base.where('approvalRequests.employeeId', 'in', grant.teamEmployeeIds.length ? grant.teamEmployeeIds : [NIL]);
    if (scope) base = base.where((eb) => eb.or([eb('approvalRequests.branchId', 'is', null), eb('approvalRequests.branchId', 'in', scope)]));
    if (q.entityType) base = base.where('approvalRequests.entityType', '=', q.entityType);
    if (q.employeeId) base = base.where('approvalRequests.employeeId', '=', q.employeeId);
    if (q.from) base = base.where('approvalRequests.createdAt', '>=', sql<Date>`${dv(q.from)}::timestamptz`);
    if (q.to) base = base.where('approvalRequests.createdAt', '<', sql<Date>`${dv(q.to)}::date + interval '1 day'`);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    let rowsQ = base.selectAll('approvalRequests');
    rowsQ = q.view === 'pending' ? rowsQ.orderBy('approvalRequests.createdAt', 'asc').orderBy('approvalRequests.id') : rowsQ.orderBy('approvalRequests.completedAt', 'desc').orderBy('approvalRequests.createdAt', 'desc').orderBy('approvalRequests.id');
    const rows = await rowsQ.limit(page.pageSize).offset(page.offset).execute();
    return { data: await hydrateRequests(trx, actor, grant, orgId, rows, {}), total };
  });
}

/** One request with its timeline; visibility is the RLS rule (404 when the caller may not see it). */
export async function getRequest(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ApprovalRequestDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Approval request', id);
    if (!grant.allBranches && row.branchId && !grant.branchIds.includes(row.branchId) && row.requestedBy !== actor.userId && row.subjectUserId !== actor.userId) {
      // an assignee outside the branch still sees the request they were routed (RLS admitted it); anyone else is refused
      const assigned = await trx.selectFrom('approvalSteps as s').innerJoin('approvalStepActors as a', 'a.stepId', 's.id').select('s.id').where('s.requestId', '=', id).where('a.userId', '=', actor.userId).executeTakeFirst();
      if (!assigned) throw errors.forbidden('This request is outside your branch scope.');
    }
    const [dto] = await hydrateRequests(trx, actor, grant, orgId, [row], { withEvents: true });
    return dto!;
  });
}

/** Requests I filed or that are about me (the portal's "my requests"). */
export async function listMine(deps: ApiDeps, actor: Actor, orgId: string, q: MyApprovalsQuery): Promise<{ data: ApprovalRequestDto[]; total: number }> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    let base = trx.selectFrom('approvalRequests').where('approvalRequests.organizationId', '=', orgId)
      .where((eb) => eb.or([eb('approvalRequests.requestedBy', '=', actor.userId), eb('approvalRequests.subjectUserId', '=', actor.userId), ...(grant.employeeId ? [eb('approvalRequests.employeeId', '=', grant.employeeId)] : [])]));
    if (q.status) base = base.where('approvalRequests.status', '=', q.status);
    if (q.entityType) base = base.where('approvalRequests.entityType', '=', q.entityType);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    const rows = await base.selectAll('approvalRequests').orderBy('approvalRequests.createdAt', 'desc').orderBy('approvalRequests.id').limit(page.pageSize).offset(page.offset).execute();
    return { data: await hydrateRequests(trx, actor, grant, orgId, rows, {}), total };
  });
}

/** Load one request's DTO after a mutation in the same transaction (the caller holds a user transaction). */
export async function requestDtoWithin(trx: Parameters<typeof hydrateRequests>[0], actor: Actor, orgId: string, id: string, opts: { withEvents?: boolean } = {}): Promise<ApprovalRequestDto> {
  const grant = requireMembership(actor.principal, orgId);
  const row = await trx.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!row) throw errors.notFound('Approval request', id);
  const [dto] = await hydrateRequests(trx, actor, grant, orgId, [row], opts);
  return dto!;
}

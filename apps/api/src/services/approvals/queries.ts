import { sql, type ExpressionBuilder } from 'kysely';
import { DateTime } from 'luxon';
import { APPROVAL_HISTORY_EXPORT_MAX_ROWS, type ApprovalInboxQuery, type ApprovalRequestDto, type MyApprovalsQuery } from '@flowza/contracts';
import type { DB, Trx } from '@flowza/database';
import type { MembershipGrant } from '@flowza/domain';
import { errors } from '@flowza/shared';
import type { ApiDeps } from '../../deps.js';
import { branchFilter, hasPermission, requireMembership } from '../../lib/authorize.js';
import { toCsvDocument } from '../../lib/csv.js';
import { likeContains, pageOf, toCount } from '../../lib/pagination.js';
import { type Actor, audit, runUser, withSystemScope } from '../../lib/service.js';
import { dv } from '../features/sql-helpers.js';
import { hydrateRequests } from './dto.js';

const ORG_WIDE = ['attendance.view', 'leave.view', 'approval.manage'] as const;
const TEAM_KEYS = ['attendance.view_team', 'leave.view_team'] as const;
const NIL = '00000000-0000-0000-0000-000000000000';

type RB = ExpressionBuilder<DB, 'approvalRequests'>;

/**
 * `mine`, pending: the requests waiting for the caller on their current level — their own pending seat (a stamped delegate
 * seat only while that delegation is still in force; an escalation seat included) or the pending seat of somebody who
 * delegates to them today, by the ORGANISATION's date. `app.approval_actionable_request_ids` is the one definition, shared
 * with the dashboard count and /me `approvals.actionable` (review P2-1 / P2-11).
 */
function mineCurrentStep(orgId: string) {
  return sql<boolean>`approval_requests.id in (select app.approval_actionable_request_ids(${orgId}::uuid))`;
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
 * The inbox query. Rows are read under the caller's RLS (assignee / subject / team / org keys), then narrowed by scope:
 * `mine` = my queue (or my history), `team` = my direct reports' requests (needs a team key), `all` = the organisation
 * (needs an org-wide key; branch scope applies). A name / number search is matched against the organisation's employees
 * in its system scope (a team approver may not read the directory) and only ever narrows the caller's own view.
 */
async function inboxQuery(trx: Trx, actor: Actor, grant: MembershipGrant, orgId: string, q: ApprovalInboxQuery) {
  const orgWide = ORG_WIDE.some((p) => hasPermission(grant, p));
  const teamKey = TEAM_KEYS.some((p) => hasPermission(grant, p));
  if (q.scope === 'all' && !orgWide) throw errors.forbidden('Missing permission: attendance.view, leave.view or approval.manage.');
  if (q.scope === 'team' && !teamKey && !orgWide) throw errors.forbidden('Missing permission: attendance.view_team or leave.view_team.');
  // A seat is its own authority: the caller's queue is never narrowed by their branch scope, only by an explicit filter
  // (a branch manager named on another branch's request still sees it — the count on /me and the dashboard agree).
  const scope = q.scope === 'mine' ? (q.branchId ? [q.branchId] : null) : branchFilter(grant, q.branchId);
  let base = trx.selectFrom('approvalRequests').where('approvalRequests.organizationId', '=', orgId);
  if (q.view === 'pending') base = base.where('approvalRequests.status', '=', 'PENDING');
  else base = q.status && q.status !== 'PENDING' ? base.where('approvalRequests.status', '=', q.status) : base.where('approvalRequests.status', '!=', 'PENDING');
  if (q.scope === 'mine') base = q.view === 'pending' ? base.where(mineCurrentStep(orgId)) : base.where((eb) => mineInvolved(eb, actor.userId));
  else if (q.scope === 'team') base = base.where('approvalRequests.employeeId', 'in', grant.teamEmployeeIds.length ? grant.teamEmployeeIds : [NIL]);
  if (scope) base = base.where((eb) => eb.or([eb('approvalRequests.branchId', 'is', null), eb('approvalRequests.branchId', 'in', scope)]));
  if (q.entityType) base = base.where('approvalRequests.entityType', '=', q.entityType);
  if (q.employeeId) base = base.where('approvalRequests.employeeId', '=', q.employeeId);
  if (q.from) base = base.where('approvalRequests.createdAt', '>=', sql<Date>`${dv(q.from)}::timestamptz`);
  if (q.to) base = base.where('approvalRequests.createdAt', '<', sql<Date>`${dv(q.to)}::date + interval '1 day'`);
  if (q.search) {
    const like = likeContains(q.search);
    const ids = (await withSystemScope(trx, orgId, (s) => s.selectFrom('employees').select('id').where('organizationId', '=', orgId)
      .where((eb) => eb.or([eb('displayName', 'ilike', like), eb('employeeNumber', 'ilike', like)])).limit(500).execute())).map((r) => r.id);
    base = base.where('approvalRequests.employeeId', 'in', ids.length ? ids : [NIL]);
  }
  return base;
}

/** The unified inbox (pending queue oldest first, history newest first). */
export async function listInbox(deps: ApiDeps, actor: Actor, orgId: string, q: ApprovalInboxQuery): Promise<{ data: ApprovalRequestDto[]; total: number }> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const base = await inboxQuery(trx, actor, grant, orgId, q);
    const total = toCount((await base.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n);
    const page = pageOf(q);
    let rowsQ = base.selectAll('approvalRequests');
    rowsQ = q.view === 'pending' ? rowsQ.orderBy('approvalRequests.createdAt', 'asc').orderBy('approvalRequests.id') : rowsQ.orderBy('approvalRequests.completedAt', 'desc').orderBy('approvalRequests.createdAt', 'desc').orderBy('approvalRequests.id');
    const rows = await rowsQ.limit(page.pageSize).offset(page.offset).execute();
    return { data: await hydrateRequests(trx, actor, grant, orgId, rows, {}), total };
  });
}

const EXPORT_STATUS_WORDS: Record<string, string> = { APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Withdrawn', INVALIDATED: 'Superseded', SKIPPED: 'Skipped', PENDING: 'Pending' };

/**
 * The History view as CSV (Finance B-105): the same scope and filters as the inbox, newest first, at most
 * APPROVAL_HISTORY_EXPORT_MAX_ROWS rows, one line per request with a per-level audit cell. Needs report.export; every
 * export is audited with its row count; cells are formula-escaped.
 */
export async function exportHistoryCsv(deps: ApiDeps, actor: Actor, orgId: string, q: ApprovalInboxQuery): Promise<{ fileName: string; csv: string; rows: number }> {
  const grant = requireMembership(actor.principal, orgId);
  if (!hasPermission(grant, 'report.export')) throw errors.forbidden('Missing permission: report.export.');
  const query = { ...q, view: 'history' as const };
  return runUser(deps.db, actor, async (trx) => {
    const base = await inboxQuery(trx, actor, grant, orgId, query);
    const rows = await base.selectAll('approvalRequests').orderBy('approvalRequests.completedAt', 'desc').orderBy('approvalRequests.createdAt', 'desc').orderBy('approvalRequests.id').limit(APPROVAL_HISTORY_EXPORT_MAX_ROWS).execute();
    const dtos = await hydrateRequests(trx, actor, grant, orgId, rows, {});
    const tz = (await trx.selectFrom('organizations').select('timezone').where('id', '=', orgId).executeTakeFirst())?.timezone ?? 'UTC';
    const when = (iso: string | null) => (iso ? DateTime.fromISO(iso).setZone(tz).toFormat('yyyy-LL-dd HH:mm') : '');
    const levels = (r: ApprovalRequestDto) => r.steps.map((st) => {
      const people = st.actors.map((a) => `${a.userName ?? a.userId}${a.viaDelegationOfName ? ` (for ${a.viaDelegationOfName})` : ''}: ${EXPORT_STATUS_WORDS[a.decision] ?? a.decision}${a.decidedAt ? ` ${when(a.decidedAt)}` : ''}${a.comment ? ` "${a.comment}"` : ''}`).join(', ');
      return `L${st.stepNo} ${st.approverType} ${st.mode}: ${EXPORT_STATUS_WORDS[st.status] ?? st.status}${people ? ` — ${people}` : ''}`;
    }).join(' | ');
    const header = ['Request', 'Type', 'Employee', 'Employee number', 'Requested by', 'Submitted', 'Outcome', 'Decided by', 'Closed', 'Workflow', 'Levels', 'Reason'];
    const lines = dtos.map((r) => [r.id, r.entityType, r.employeeName, r.employeeNumber, r.requestedByName, when(r.createdAt), EXPORT_STATUS_WORDS[r.status] ?? r.status, r.decidedByName, when(r.completedAt), r.workflowName, levels(r), r.cancelReason ?? r.invalidationReason ?? null]);
    await audit(trx, actor, orgId, 'approval.history_exported', 'approval_request', { newValue: { rowCount: lines.length, scope: query.scope, entityType: query.entityType ?? null, status: query.status ?? null, from: query.from ?? null, to: query.to ?? null, capped: lines.length >= APPROVAL_HISTORY_EXPORT_MAX_ROWS } });
    return { fileName: `approvals-history-${DateTime.now().setZone(tz).toISODate()}.csv`, csv: toCsvDocument(header, lines), rows: lines.length };
  });
}

/** One request with its timeline; visibility is the RLS rule (404 when the caller may not see it). */
export async function getRequest(deps: ApiDeps, actor: Actor, orgId: string, id: string): Promise<ApprovalRequestDto> {
  const grant = requireMembership(actor.principal, orgId);
  return runUser(deps.db, actor, async (trx) => {
    const row = await trx.selectFrom('approvalRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
    if (!row) throw errors.notFound('Approval request', id);
    const aboutMe = row.subjectUserId === actor.userId || (!!grant.employeeId && grant.employeeId === row.employeeId);
    if (!grant.allBranches && row.branchId && !grant.branchIds.includes(row.branchId) && row.requestedBy !== actor.userId && !aboutMe) {
      // an assignee outside the branch (a seat, or a pending seat they cover through a delegation in force today) still
      // sees the request they were routed — the same rule as the read policy's assignee branch; anyone else is refused
      const { rows } = await sql<{ assigned: boolean }>`select app.approval_request_assigned(${id}::uuid, ${orgId}::uuid, ${row.entityType}::public.approval_entity) as assigned`.execute(trx);
      if (!rows[0]?.assigned) throw errors.forbidden('This request is outside your branch scope.');
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

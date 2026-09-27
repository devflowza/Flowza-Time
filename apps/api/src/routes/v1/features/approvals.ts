import type { Context, Hono } from 'hono';
import { approvalCancelSchema, approvalDecideSchema, approvalDelegationInputSchema, approvalDelegationListQuerySchema, approvalEmailActionSchema, approvalInboxQuerySchema, approvalInfoSchema, approvalLegacyDecisionSchema, approvalReassignSchema, approvalWorkflowInputSchema, approvalWorkflowUpdateSchema, myApprovalsQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf, runUser } from '../../../lib/service.js';
import * as approvals from '../../../services/approvals/index.js';

/**
 * Approval engine v2 routes. The inbox, one request, decisions (plus the `/approve` and `/reject` aliases the first
 * inbox used), cancel / reassign / ask-for-info, the e-mail one-click action, workflows and delegations.
 */
export function registerApprovalRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const decideAndReturn = async (c: Context<AppEnv>, input: { stepNo?: number | undefined; decision: 'APPROVE' | 'REJECT'; comment?: string | undefined }) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId');
    const dto = await runUser(deps.db, actor, async (trx) => {
      const outcome = await approvals.decideWithin(deps, trx, actor, orgId, id, input);
      const request = await approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true });
      return { ...request, noop: outcome.noop, terminal: outcome.terminal };
    });
    return ok(c, dto);
  };

  v1.get('/orgs/:orgId/approvals', async (c) => { const q = query(c, approvalInboxQuerySchema); const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/inbox', async (c) => { const q = query(c, approvalInboxQuerySchema); const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/history', async (c) => { const q = { ...query(c, approvalInboxQuerySchema), view: 'history' as const }; const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/mine', async (c) => { const q = query(c, myApprovalsQuerySchema); const r = await approvals.listMine(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/approvals/email-action', async (c) => {
    const input = await body(c, approvalEmailActionSchema); const actor = actorOf(c, deps); const orgId = param(c, 'orgId');
    const outcome = await approvals.redeemEmailToken(deps, actor, orgId, input);
    return ok(c, await approvals.getRequest(deps, actor, orgId, outcome.requestId).then((r) => ({ ...r, noop: outcome.noop, terminal: outcome.terminal })));
  });
  v1.get('/orgs/:orgId/approvals/:requestId', async (c) => ok(c, await approvals.getRequest(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'requestId'))));
  v1.post('/orgs/:orgId/approvals/:requestId/decide', async (c) => decideAndReturn(c, await body(c, approvalDecideSchema)));
  v1.post('/orgs/:orgId/approvals/:requestId/approve', async (c) => decideAndReturn(c, { decision: 'APPROVE', comment: (await body(c, approvalLegacyDecisionSchema)).comment }));
  v1.post('/orgs/:orgId/approvals/:requestId/reject', async (c) => decideAndReturn(c, { decision: 'REJECT', comment: (await body(c, approvalLegacyDecisionSchema)).comment }));
  v1.post('/orgs/:orgId/approvals/:requestId/cancel', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalCancelSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.cancelRequest(deps, trx, actor, orgId, id, input.reason ?? null); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });
  v1.post('/orgs/:orgId/approvals/:requestId/reassign', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalReassignSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.reassignRequest(deps, trx, actor, orgId, id, input); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });
  v1.post('/orgs/:orgId/approvals/:requestId/request-info', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalInfoSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.requestInfo(deps, trx, actor, orgId, id, input.comment); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });
  v1.post('/orgs/:orgId/approvals/:requestId/answer-info', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalInfoSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.answerInfo(deps, trx, actor, orgId, id, input.comment); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });

  v1.get('/orgs/:orgId/approval-workflows', async (c) => ok(c, await approvals.listWorkflows(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/approval-workflows', async (c) => created(c, await approvals.createWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, approvalWorkflowInputSchema))));
  v1.patch('/orgs/:orgId/approval-workflows/:id', async (c) => ok(c, await approvals.updateWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, approvalWorkflowUpdateSchema))));
  v1.delete('/orgs/:orgId/approval-workflows/:id', async (c) => { await approvals.deleteWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });

  v1.get('/orgs/:orgId/approval-delegations', async (c) => ok(c, await approvals.listDelegations(deps, actorOf(c, deps), param(c, 'orgId'), query(c, approvalDelegationListQuerySchema))));
  v1.get('/orgs/:orgId/approval-delegations/candidates', async (c) => ok(c, await approvals.listDelegateCandidates(deps, actorOf(c, deps), param(c, 'orgId'), c.req.query('search'))));
  v1.post('/orgs/:orgId/approval-delegations', async (c) => created(c, await approvals.createDelegation(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, approvalDelegationInputSchema))));
  v1.delete('/orgs/:orgId/approval-delegations/:id', async (c) => { await approvals.revokeDelegation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
}

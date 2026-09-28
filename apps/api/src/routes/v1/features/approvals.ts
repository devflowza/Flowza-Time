import type { Context, Hono } from 'hono';
import { approvalBulkDecideSchema, approvalBypassSchema, approvalCancelSchema, approvalDecideSchema, approvalDelegationInputSchema, approvalDelegationListQuerySchema, approvalEmailActionSchema, approvalInboxQuerySchema, approvalInfoSchema, approvalLegacyDecisionSchema, approvalReassignSchema, approvalWorkflowInputSchema, approvalWorkflowUpdateSchema, myApprovalsQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { rateLimit } from '../../../middleware/rate-limit.js';
import { clientIp, created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf, runUser } from '../../../lib/service.js';
import * as approvals from '../../../services/approvals/index.js';

/** The one-click e-mail action's own brute-force limit (review P2-6, Finance per-IP POST limits): per IP and per user, per minute. */
export const APPROVAL_EMAIL_ACTION_LIMIT = { windowMs: 60_000, max: 20 } as const;

/**
 * Approval engine v2 routes. The inbox, one request, decisions (plus the `/approve` and `/reject` aliases the first
 * inbox used), cancel / reassign / approve as an exception (bypass) / ask-for-info, the e-mail one-click action, workflows
 * and delegations. `decide` and `bulk-decide` name the level the caller saw (review P1-2); the aliases may omit it, and then
 * decide only a seat the caller holds.
 */
export function registerApprovalRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const emailActionByIp = rateLimit({ name: 'approval-email-ip', ...APPROVAL_EMAIL_ACTION_LIMIT, keyFn: (c) => clientIp(c, deps.config) ?? 'unknown' });
  const emailActionByUser = rateLimit({ name: 'approval-email-user', ...APPROVAL_EMAIL_ACTION_LIMIT, keyFn: (c) => c.get('principal')?.userId ?? 'anon' });
  const decideAndReturn = async (c: Context<AppEnv>, input: { stepNo?: number | undefined; decision: 'APPROVE' | 'REJECT'; comment?: string | undefined; onBehalfOfUserId?: string | undefined; payEffectDays?: 0 | 0.5 | 1 | undefined }) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId');
    const { dto, outcome } = await runUser(deps.db, actor, async (trx) => {
      const decided = await approvals.decideWithin(deps, trx, actor, orgId, id, input);
      const request = await approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true });
      return { dto: { ...request, noop: decided.noop, terminal: decided.terminal }, outcome: decided };
    });
    // committed: an approval the entity refused was rejected by the system (review P2-11) — the caller hears it as 409
    approvals.assertNotSystemRejected(outcome);
    return ok(c, dto);
  };

  v1.get('/orgs/:orgId/approvals', async (c) => { const q = query(c, approvalInboxQuerySchema); const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/inbox', async (c) => { const q = query(c, approvalInboxQuerySchema); const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/history', async (c) => { const q = { ...query(c, approvalInboxQuerySchema), view: 'history' as const }; const r = await approvals.listInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/approvals/history/export', async (c) => {
    const q = query(c, approvalInboxQuerySchema);
    const out = await approvals.exportHistoryCsv(deps, actorOf(c, deps), param(c, 'orgId'), q);
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${out.fileName}"`);
    c.header('x-row-count', String(out.rows));
    return c.body(out.csv);
  });
  v1.get('/orgs/:orgId/approvals/mine', async (c) => { const q = query(c, myApprovalsQuerySchema); const r = await approvals.listMine(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/approvals/email-action', emailActionByIp, emailActionByUser, async (c) => {
    const input = await body(c, approvalEmailActionSchema); const actor = actorOf(c, deps); const orgId = param(c, 'orgId');
    const outcome = await approvals.redeemEmailToken(deps, actor, orgId, input);
    approvals.assertNotSystemRejected(outcome);
    return ok(c, await approvals.getRequest(deps, actor, orgId, outcome.requestId).then((r) => ({ ...r, noop: outcome.noop, terminal: outcome.terminal })));
  });
  v1.post('/orgs/:orgId/approvals/bulk-decide', async (c) => ok(c, await approvals.bulkDecide(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, approvalBulkDecideSchema))));
  v1.get('/orgs/:orgId/approvals/:requestId', async (c) => ok(c, await approvals.getRequest(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'requestId'))));
  v1.post('/orgs/:orgId/approvals/:requestId/decide', async (c) => decideAndReturn(c, await body(c, approvalDecideSchema)));
  v1.post('/orgs/:orgId/approvals/:requestId/approve', async (c) => { const b = await body(c, approvalLegacyDecisionSchema); return decideAndReturn(c, { decision: 'APPROVE', comment: b.comment, stepNo: b.stepNo }); });
  v1.post('/orgs/:orgId/approvals/:requestId/reject', async (c) => { const b = await body(c, approvalLegacyDecisionSchema); return decideAndReturn(c, { decision: 'REJECT', comment: b.comment, stepNo: b.stepNo }); });
  v1.post('/orgs/:orgId/approvals/:requestId/cancel', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalCancelSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.cancelRequest(deps, trx, actor, orgId, id, input.reason); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });
  v1.post('/orgs/:orgId/approvals/:requestId/reassign', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalReassignSchema);
    return ok(c, await runUser(deps.db, actor, async (trx) => { await approvals.reassignRequest(deps, trx, actor, orgId, id, input); return approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }); }));
  });
  v1.post('/orgs/:orgId/approvals/:requestId/bypass', async (c) => {
    const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const id = param(c, 'requestId'); const input = await body(c, approvalBypassSchema);
    const { dto, outcome } = await runUser(deps.db, actor, async (trx) => { const out = await approvals.bypassRequest(deps, trx, actor, orgId, id, input.reason); return { dto: await approvals.requestDtoWithin(trx, actor, orgId, id, { withEvents: true }), outcome: out }; });
    approvals.assertNotSystemRejected(outcome);
    return ok(c, dto);
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

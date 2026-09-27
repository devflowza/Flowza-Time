import type { Hono } from 'hono';
import { approveStatementSchema, issueStatementsSchema, statementListQuerySchema, voidStatementSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as statements from '../../../services/features/statements.service.js';

/**
 * Monthly attendance statements — the HR side (docs/statements.md). Issue enqueues the worker job (202 + queue job
 * id, tracked on the Statements page); list supports `inbox=true` for the manager's pending approvals; approve is
 * open to the assigned approver even without any statement.* permission (service + RLS agree on that). The
 * employee-facing review endpoints are token-based and live under /api/portal, not here.
 */
export function registerStatementRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.post('/orgs/:orgId/statements/issue', idem, async (c) => c.json({ data: await statements.issueStatements(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, issueStatementsSchema)) }, 202));
  v1.get('/orgs/:orgId/statements', async (c) => { const q = query(c, statementListQuerySchema); const r = await statements.listStatements(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/statements/:id', async (c) => ok(c, await statements.getStatement(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/statements/:id/approve', idem, async (c) => ok(c, await statements.approveStatement(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, approveStatementSchema)).note)));
  v1.post('/orgs/:orgId/statements/:id/resend', idem, async (c) => c.json({ data: await statements.resendStatement(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')) }, 202));
  v1.post('/orgs/:orgId/statements/:id/void', idem, async (c) => ok(c, await statements.voidStatement(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, voidStatementSchema)).reason)));
}

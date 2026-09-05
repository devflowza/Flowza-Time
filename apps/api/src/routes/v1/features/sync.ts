import type { Hono } from 'hono';
import { syncAttendanceRequestSchema, syncEmployeesRequestSchema, syncJobListQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as sync from '../../../services/features/sync.service.js';
import { reconciliationQuerySchema, syncHealthCheckRequestSchema, syncJobItemsQuerySchema, syncReconcileRequestSchema } from './dto.js';

export function registerSyncRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  const accepted = (c: Parameters<Parameters<Hono<AppEnv>['post']>[1]>[0], data: unknown) => c.json({ data }, 202);
  v1.post('/orgs/:orgId/sync/attendance', idem, async (c) => accepted(c, await sync.syncAttendance(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, syncAttendanceRequestSchema))));
  v1.post('/orgs/:orgId/sync/employees', idem, async (c) => accepted(c, await sync.syncEmployees(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, syncEmployeesRequestSchema))));
  v1.post('/orgs/:orgId/sync/health-check', idem, async (c) => accepted(c, await sync.healthCheck(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, syncHealthCheckRequestSchema))));
  v1.post('/orgs/:orgId/sync/reconcile', idem, async (c) => accepted(c, await sync.reconcile(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, syncReconcileRequestSchema))));
  v1.get('/orgs/:orgId/sync/reconciliation', async (c) => ok(c, await sync.reconciliationSummary(deps, actorOf(c, deps), param(c, 'orgId'), query(c, reconciliationQuerySchema))));
  v1.get('/orgs/:orgId/sync/jobs', async (c) => { const q = query(c, syncJobListQuerySchema); const r = await sync.listJobs(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/sync/jobs/:id', async (c) => {
    const q = query(c, syncJobItemsQuerySchema);
    const r = await sync.getJob(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q);
    return c.json({ data: { ...r.job, items: r.items.data }, meta: { items: { page: q.page, pageSize: q.pageSize, total: r.items.total, totalPages: Math.max(1, Math.ceil(r.items.total / q.pageSize)) } } });
  });
  v1.get('/orgs/:orgId/sync/jobs/:id/items', async (c) => { const q = query(c, syncJobItemsQuerySchema); const r = await sync.listItems(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/sync/jobs/:id/cancel', async (c) => ok(c, await sync.cancelJob(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/sync/jobs/:id/retry-failed', idem, async (c) => accepted(c, await sync.retryFailed(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

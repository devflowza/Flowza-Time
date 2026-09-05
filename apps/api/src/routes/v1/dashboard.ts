import type { Hono } from 'hono';
import { dashboardBranchesQuerySchema, dashboardSummaryQuerySchema, dashboardTrendsQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as dash from '../../services/dashboard.service.js';

export function registerDashboardRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/dashboard/summary', async (c) => ok(c, await dash.summary(deps, actorOf(c, deps), param(c, 'orgId'), query(c, dashboardSummaryQuerySchema))));
  v1.get('/orgs/:orgId/dashboard/trends', async (c) => ok(c, await dash.trends(deps, actorOf(c, deps), param(c, 'orgId'), query(c, dashboardTrendsQuerySchema))));
  v1.get('/orgs/:orgId/dashboard/branches', async (c) => ok(c, await dash.branches(deps, actorOf(c, deps), param(c, 'orgId'), query(c, dashboardBranchesQuerySchema))));
}

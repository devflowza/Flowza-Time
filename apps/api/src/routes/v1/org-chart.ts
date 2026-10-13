import type { Hono } from 'hono';
import { orgChartFilterSchema, orgChartQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok, paginated } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as chart from '../../services/org-chart.service.js';

/** The organisation's reporting lines drawn as a tree (`employee.view`); the lines themselves are set on the employee or in bulk. */
export function registerOrgChartRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/org-chart', async (c) => {
    const q = query(c, orgChartQuerySchema);
    const { data, total } = await chart.listOrgChart(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  v1.get('/orgs/:orgId/org-chart/path/:employeeId', async (c) => ok(c, await chart.getOrgChartPath(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'employeeId'), query(c, orgChartFilterSchema))));
}

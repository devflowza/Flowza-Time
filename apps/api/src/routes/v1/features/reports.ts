import type { Hono } from 'hono';
import { createReportRequestSchema, payrollPeriodActionSchema, payrollPeriodsQuerySchema, payrollSummariesQuerySchema, reportListQuerySchema, reportTypesQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as reports from '../../../services/features/reports.service.js';

export function registerReportRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/report-types', async (c) => ok(c, reports.listReportTypes(actorOf(c, deps), query(c, reportTypesQuerySchema).orgId)));
  v1.post('/orgs/:orgId/reports', idem, async (c) => c.json({ data: await reports.createReport(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createReportRequestSchema)) }, 202));
  v1.get('/orgs/:orgId/reports', async (c) => { const q = query(c, reportListQuerySchema); const r = await reports.listReports(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/reports/:id', async (c) => ok(c, await reports.getReport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/reports/:id/download', async (c) => ok(c, await reports.downloadReport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/reports/:id/cancel', async (c) => ok(c, await reports.cancelReport(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // payroll
  v1.get('/orgs/:orgId/payroll/periods', async (c) => ok(c, await reports.listPayrollPeriods(deps, actorOf(c, deps), param(c, 'orgId'), query(c, payrollPeriodsQuerySchema))));
  v1.post('/orgs/:orgId/payroll/periods/build', idem, async (c) => c.json({ data: await reports.buildPeriod(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, payrollPeriodActionSchema), false) }, 202));
  v1.post('/orgs/:orgId/payroll/periods/finalize', idem, async (c) => c.json({ data: await reports.buildPeriod(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, payrollPeriodActionSchema), true) }, 202));
  v1.get('/orgs/:orgId/payroll/summaries', async (c) => { const q = query(c, payrollSummariesQuerySchema); const r = await reports.listSummaries(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
}

import type { Hono } from 'hono';
import { createReportScheduleSchema, reportDeliveryListQuerySchema, reportScheduleListQuerySchema, shareReportSchema, updateReportScheduleSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as rs from '../../../services/report-schedules.service.js';

/**
 * Report sharing and schedules (HR portal Prompt 6a). New routes only: schedules CRUD + run-now, Send now, the delivery trail
 * and the recipient picker. Each generation happens in the worker per recipient under the recipient's own access scope.
 */
export function registerReportScheduleRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/report-schedules', async (c) => { const q = query(c, reportScheduleListQuerySchema); const r = await rs.listSchedules(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/report-schedules', idem, async (c) => created(c, await rs.createSchedule(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createReportScheduleSchema))));
  v1.get('/orgs/:orgId/report-schedules/:id', async (c) => ok(c, await rs.getSchedule(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/report-schedules/:id', async (c) => ok(c, await rs.updateSchedule(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateReportScheduleSchema))));
  v1.delete('/orgs/:orgId/report-schedules/:id', async (c) => { await rs.deleteSchedule(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  v1.post('/orgs/:orgId/report-schedules/:id/run-now', idem, async (c) => c.json({ data: await rs.runScheduleNow(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')) }, 202));
  v1.post('/orgs/:orgId/reports/share', idem, async (c) => c.json({ data: await rs.shareReport(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, shareReportSchema)) }, 202));
  v1.get('/orgs/:orgId/report-deliveries', async (c) => { const q = query(c, reportDeliveryListQuerySchema); const r = await rs.listDeliveries(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/report-recipients', async (c) => ok(c, await rs.recipientOptions(deps, actorOf(c, deps), param(c, 'orgId'))));
}

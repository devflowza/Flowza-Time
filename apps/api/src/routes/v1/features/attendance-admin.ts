import type { Hono } from 'hono';
import {
  notesReportExportQuerySchema, notesReportQuerySchema, regularisationAdminQuerySchema, regularisationBulkDecideSchema, regularisationDecideSchema, regularisationExportQuerySchema,
} from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as regs from '../../../services/attendance/regularisations-admin.service.js';
import * as report from '../../../services/attendance/notes-report.service.js';

/** HR attendance administration (HR portal Prompt 6b): the regularisation register (engine decisions) and the comments report. */
export function registerAttendanceAdminRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/attendance/regularisations/export', async (c) => ok(c, await regs.exportRegularisations(deps, actorOf(c, deps), param(c, 'orgId'), query(c, regularisationExportQuerySchema))));
  v1.get('/orgs/:orgId/attendance/regularisations', async (c) => {
    const q = query(c, regularisationAdminQuerySchema);
    const r = await regs.listRegularisations(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, r.data, q.page, q.pageSize, r.total);
  });
  v1.post('/orgs/:orgId/attendance/regularisations/bulk-decide', idem, async (c) => ok(c, await regs.bulkDecideRegularisations(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, regularisationBulkDecideSchema))));
  v1.post('/orgs/:orgId/attendance/regularisations/:id/decide', idem, async (c) => ok(c, await regs.decideRegularisation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, regularisationDecideSchema))));
  v1.get('/orgs/:orgId/attendance/notes/report/export', async (c) => ok(c, await report.exportNotesReport(deps, actorOf(c, deps), param(c, 'orgId'), query(c, notesReportExportQuerySchema))));
  v1.get('/orgs/:orgId/attendance/notes/report', async (c) => {
    const q = query(c, notesReportQuerySchema);
    const r = await report.notesReport(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), totals: r.totals } });
  });
}

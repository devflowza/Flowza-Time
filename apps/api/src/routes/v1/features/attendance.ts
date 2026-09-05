import type { Hono } from 'hono';
import { approvalDecisionSchema, approvalInboxQuerySchema, approvalWorkflowInputSchema, approvalWorkflowUpdateSchema, attendanceEventsQuerySchema, correctionCancelSchema, correctionListQuerySchema, createCorrectionSchema, dailyAttendanceListQuerySchema, monthlyAttendanceListQuerySchema, periodLockListQuerySchema, periodLockSchema, periodUnlockSchema, rawTransactionsQuerySchema, recalculateSchema, recalculationListQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as att from '../../../services/features/attendance.service.js';

export function registerAttendanceRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/attendance/daily', async (c) => { const q = query(c, dailyAttendanceListQuerySchema); const r = await att.listDaily(deps, actorOf(c, deps), param(c, 'orgId'), q); return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), ...r.meta } }); });
  v1.get('/orgs/:orgId/attendance/monthly', async (c) => { const q = query(c, monthlyAttendanceListQuerySchema); const r = await att.listMonthly(deps, actorOf(c, deps), param(c, 'orgId'), q); return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), ...r.meta } }); });
  v1.get('/orgs/:orgId/attendance/records/:id', async (c) => ok(c, await att.getRecord(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/attendance/events', async (c) => ok(c, await att.listEvents(deps, actorOf(c, deps), param(c, 'orgId'), query(c, attendanceEventsQuerySchema))));
  v1.get('/orgs/:orgId/attendance/raw', async (c) => { const q = query(c, rawTransactionsQuerySchema); const r = await att.listRaw(deps, actorOf(c, deps), param(c, 'orgId'), q); return c.json({ data: r.data, meta: { nextCursor: r.nextCursor, limit: q.limit } }); });
  v1.post('/orgs/:orgId/attendance/raw/:id/requeue', async (c) => ok(c, await att.requeueRaw(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));

  v1.post('/orgs/:orgId/attendance/corrections', idem, async (c) => created(c, await att.createCorrection(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createCorrectionSchema))));
  v1.get('/orgs/:orgId/attendance/corrections', async (c) => { const q = query(c, correctionListQuerySchema); const r = await att.listCorrections(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/attendance/corrections/:id/cancel', async (c) => ok(c, await att.cancelCorrection(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, correctionCancelSchema)).reason)));

  v1.get('/orgs/:orgId/approvals/inbox', async (c) => { const q = query(c, approvalInboxQuerySchema); const r = await att.approvalsInbox(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/approvals/:requestId/approve', async (c) => ok(c, await att.decide(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'requestId'), 'approve', await body(c, approvalDecisionSchema))));
  v1.post('/orgs/:orgId/approvals/:requestId/reject', async (c) => ok(c, await att.decide(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'requestId'), 'reject', await body(c, approvalDecisionSchema))));
  v1.get('/orgs/:orgId/approval-workflows', async (c) => ok(c, await att.listWorkflows(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/approval-workflows', async (c) => created(c, await att.createWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, approvalWorkflowInputSchema))));
  v1.patch('/orgs/:orgId/approval-workflows/:id', async (c) => ok(c, await att.updateWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, approvalWorkflowUpdateSchema))));
  v1.delete('/orgs/:orgId/approval-workflows/:id', async (c) => { await att.deleteWorkflow(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });

  v1.post('/orgs/:orgId/attendance/recalculate', idem, async (c) => c.json({ data: await att.requestRecalculation(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, recalculateSchema)) }, 202));
  v1.get('/orgs/:orgId/attendance/recalculations', async (c) => { const q = query(c, recalculationListQuerySchema); const r = await att.listRecalculations(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/attendance/periods', async (c) => ok(c, await att.listPeriods(deps, actorOf(c, deps), param(c, 'orgId'), query(c, periodLockListQuerySchema))));
  v1.post('/orgs/:orgId/attendance/periods/lock', async (c) => created(c, await att.lockPeriod(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, periodLockSchema))));
  v1.post('/orgs/:orgId/attendance/periods/:id/unlock', async (c) => ok(c, await att.unlockPeriod(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, periodUnlockSchema)).reason)));
}

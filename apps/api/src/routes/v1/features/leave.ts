import type { Hono } from 'hono';
import { leaveAllocationGenerateSchema, leaveAllocationListQuerySchema, leaveAllocationUpsertSchema, leaveBalancesQuerySchema, leaveCalendarQuerySchema, leaveCommentInputSchema, leaveYearCloseSchema, selfCompOffPreviewQuerySchema, selfCompOffRequestSchema, selfLeaveEditSchema, selfLeaveReplySchema, selfLeaveWithdrawSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as balances from '../../../services/leave/hr-balances.service.js';
import * as comments from '../../../services/leave/comments.service.js';
import * as compOff from '../../../services/leave/comp-off.service.js';
import * as self from '../../../services/leave/self-leave.service.js';

/**
 * Leave v2 (HR portal Prompt 7). HR: balances (+ CSV), allocations (list, save, generate, year close), the team calendar and
 * the comment thread of a leave request. Portal (/me): edit, withdraw (with a reason) and reply to a request, the team's
 * upcoming leave for managers, and comp-off (credits, preview, request). Leave types and records keep their routes in
 * schedule.ts; GET/POST /me/leave and POST /me/leave/:id/cancel stay in self-service.ts (the pre-v2 contract).
 */
export function registerLeaveRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  // HR: balances and allocations
  v1.get('/orgs/:orgId/leave-balances', async (c) => { const q = query(c, leaveBalancesQuerySchema); const r = await balances.listBalances(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/leave-balances/export', async (c) => {
    const out = await balances.exportBalancesCsv(deps, actorOf(c, deps), param(c, 'orgId'), query(c, leaveBalancesQuerySchema));
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${out.fileName}"`);
    c.header('x-row-count', String(out.rows));
    return c.body(out.csv);
  });
  v1.get('/orgs/:orgId/leave-allocations', async (c) => { const q = query(c, leaveAllocationListQuerySchema); const r = await balances.listAllocations(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.put('/orgs/:orgId/leave-allocations', async (c) => ok(c, await balances.upsertAllocations(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, leaveAllocationUpsertSchema))));
  v1.post('/orgs/:orgId/leave-allocations/generate', async (c) => created(c, await balances.generateAllocations(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, leaveAllocationGenerateSchema))));
  v1.post('/orgs/:orgId/leave-allocations/year-close', async (c) => c.json({ data: await balances.queueYearClose(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, leaveYearCloseSchema)) }, 202));
  v1.get('/orgs/:orgId/leave-calendar', async (c) => ok(c, await balances.leaveCalendar(deps, actorOf(c, deps), param(c, 'orgId'), query(c, leaveCalendarQuerySchema))));
  // the comment thread (everyone who can read the leave or its approval request)
  v1.get('/orgs/:orgId/leave-records/:id/comments', async (c) => ok(c, await comments.listLeaveComments(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/leave-records/:id/comments', async (c) => created(c, await comments.addLeaveComment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, leaveCommentInputSchema)).body)));
  // portal
  v1.patch('/orgs/:orgId/me/leave/:id', async (c) => ok(c, await self.editLeave(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, selfLeaveEditSchema))));
  v1.post('/orgs/:orgId/me/leave/:id/withdraw', async (c) => ok(c, await self.withdrawLeave(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, selfLeaveWithdrawSchema)).reason)));
  v1.post('/orgs/:orgId/me/leave/:id/reply', async (c) => ok(c, await self.replyLeave(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, selfLeaveReplySchema)).body)));
  v1.get('/orgs/:orgId/me/team/leave', async (c) => ok(c, await self.getTeamLeave(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/me/comp-off', async (c) => ok(c, await compOff.getSelfCompOff(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/me/comp-off/preview', async (c) => ok(c, await compOff.previewCompOff(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfCompOffPreviewQuerySchema).workedOn)));
  v1.post('/orgs/:orgId/me/comp-off', idem, async (c) => created(c, await compOff.requestCompOff(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfCompOffRequestSchema))));
}

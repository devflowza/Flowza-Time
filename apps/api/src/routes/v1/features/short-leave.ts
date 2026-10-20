import type { Hono } from 'hono';
import { hourAllowanceInputSchema, hourAllowanceUpdateSchema, selfTimeOffQuerySchema, selfTimeOffRequestSchema, timeOffCancelSchema, timeOffRequestInputSchema, timeOffRequestListQuerySchema, timeOffTypeInputSchema, timeOffTypeUpdateSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as types from '../../../services/short-leave/types.service.js';
import * as requests from '../../../services/short-leave/requests.service.js';
import * as allowances from '../../../services/short-leave/allowances.service.js';

/**
 * Short leave (migration 20261019000310). HR: permission types (leave.view / leave.manage), the requests list, recording on an
 * employee's behalf and cancelling (leave.manage), the reduced hours of an employee (leave.view / leave.manage). Portal (/me):
 * the month's types, usage and requests, a new request and withdrawing a pending one (leave.request). Decisions go through the
 * approval engine (entity SHORT_LEAVE).
 */
export function registerShortLeaveRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  // types
  v1.get('/orgs/:orgId/time-off-types', async (c) => ok(c, await types.listTimeOffTypes(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/time-off-types', async (c) => created(c, await types.createTimeOffType(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, timeOffTypeInputSchema))));
  v1.post('/orgs/:orgId/time-off-types/seed-defaults', async (c) => created(c, await types.seedTimeOffTypes(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.patch('/orgs/:orgId/time-off-types/:id', async (c) => ok(c, await types.updateTimeOffType(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, timeOffTypeUpdateSchema))));
  v1.delete('/orgs/:orgId/time-off-types/:id', async (c) => ok(c, await types.deleteTimeOffType(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // HR: requests
  v1.get('/orgs/:orgId/time-off-requests', async (c) => { const q = query(c, timeOffRequestListQuerySchema); const r = await requests.listTimeOffRequests(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/time-off-requests', idem, async (c) => created(c, await requests.recordTimeOff(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, timeOffRequestInputSchema))));
  v1.post('/orgs/:orgId/time-off-requests/:id/cancel', async (c) => ok(c, await requests.cancelTimeOff(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, timeOffCancelSchema)).reason)));
  // HR: reduced hours on the employee profile
  v1.get('/orgs/:orgId/employees/:employeeId/hour-allowances', async (c) => ok(c, await allowances.listAllowances(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'employeeId'))));
  v1.post('/orgs/:orgId/employees/:employeeId/hour-allowances', async (c) => created(c, await allowances.createAllowance(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'employeeId'), await body(c, hourAllowanceInputSchema))));
  v1.patch('/orgs/:orgId/hour-allowances/:id', async (c) => ok(c, await allowances.updateAllowance(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, hourAllowanceUpdateSchema))));
  v1.delete('/orgs/:orgId/hour-allowances/:id', async (c) => ok(c, await allowances.deleteAllowance(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // portal
  v1.get('/orgs/:orgId/me/time-off', async (c) => ok(c, await requests.getSelfTimeOff(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfTimeOffQuerySchema))));
  v1.post('/orgs/:orgId/me/time-off', idem, async (c) => created(c, await requests.requestTimeOff(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfTimeOffRequestSchema))));
  v1.post('/orgs/:orgId/me/time-off/:id/withdraw', async (c) => ok(c, await requests.withdrawTimeOff(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, timeOffCancelSchema)).reason)));
}

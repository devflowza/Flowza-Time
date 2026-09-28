import type { Hono } from 'hono';
import { selfLeaveQuerySchema, selfLeaveRequestSchema, selfMonthQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { idempotency } from '../../middleware/idempotency.js';
import { created, ok } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as self from '../../services/self-service.service.js';
import { portalOverviewExtras } from '../../services/portal/stats.service.js';

/** Employee self-service: the caller's own employee record in the organisation (never an id from the client). */
export function registerSelfServiceRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/me/profile', async (c) => ok(c, await self.getProfile(deps, actorOf(c, deps), param(c, 'orgId'))));
  // the portal home also shows today's punch state and the open attendance items (HR portal Prompt 4: optional, additive fields)
  v1.get('/orgs/:orgId/me/overview', async (c) => { const actor = actorOf(c, deps); const orgId = param(c, 'orgId'); const overview = await self.getOverview(deps, actor, orgId); return ok(c, { ...overview, ...(await portalOverviewExtras(deps, actor, orgId)) }); });
  v1.get('/orgs/:orgId/me/attendance', async (c) => ok(c, await self.getAttendanceMonth(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfMonthQuerySchema))));
  v1.get('/orgs/:orgId/me/leave', async (c) => ok(c, await self.getLeave(deps, actorOf(c, deps), param(c, 'orgId'), query(c, selfLeaveQuerySchema))));
  v1.post('/orgs/:orgId/me/leave', idem, async (c) => created(c, await self.applyLeave(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, selfLeaveRequestSchema))));
  v1.post('/orgs/:orgId/me/leave/:id/cancel', async (c) => ok(c, await self.cancelLeave(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

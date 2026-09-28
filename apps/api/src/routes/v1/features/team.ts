import type { Hono } from 'hono';
import { teamAttendanceQuerySchema, teamLeaveQuerySchema, teamSummaryQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { ok } from '../../../lib/http.js';
import { param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as team from '../../../services/team.service.js';

/** The line manager's team workspace (HR portal Prompt 5): today, attendance, leave and the badge counts of direct reports. */
export function registerTeamRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/team/summary', async (c) => ok(c, await team.summary(deps, actorOf(c, deps), param(c, 'orgId'), query(c, teamSummaryQuerySchema))));
  v1.get('/orgs/:orgId/team/attendance', async (c) => {
    const q = query(c, teamAttendanceQuerySchema);
    const r = await team.attendance(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)), from: q.from, to: q.to } });
  });
  v1.get('/orgs/:orgId/team/leave', async (c) => ok(c, await team.leave(deps, actorOf(c, deps), param(c, 'orgId'), query(c, teamLeaveQuerySchema))));
  v1.get('/orgs/:orgId/team/pending-counts', async (c) => ok(c, await team.pendingCounts(deps, actorOf(c, deps), param(c, 'orgId'))));
}

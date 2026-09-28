import type { Hono } from 'hono';
import { shiftRosterQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { query, param } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import { shiftRoster } from '../../../services/features/roster.service.js';

/**
 * The monthly shift roster (HR portal Prompt 6b, Finance ATT-105): GET /orgs/:orgId/shift-roster?month=YYYY-MM. Its own path
 * (not /shifts/roster) so it can never be captured by /shifts/:id.
 */
export function registerRosterRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/shift-roster', async (c) => {
    const q = query(c, shiftRosterQuerySchema);
    const r = await shiftRoster(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return c.json({ data: r.data, meta: { page: q.page, pageSize: q.pageSize, total: r.total, totalPages: Math.max(1, Math.ceil(r.total / q.pageSize)) } });
  });
}

import type { Hono } from 'hono';
import { searchQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { search } from '../../services/search.service.js';

export function registerSearchRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/search', async (c) => {
    const q = query(c, searchQuerySchema);
    return ok(c, await search(deps, actorOf(c, deps), param(c, 'orgId'), q.q, q.types));
  });
}

import type { Hono } from 'hono';
import { auditLogQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { paginated } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { listAudit } from '../../services/audit.service.js';

export function registerAuditRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/audit', async (c) => {
    const q = query(c, auditLogQuerySchema);
    const { data, total } = await listAudit(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
}

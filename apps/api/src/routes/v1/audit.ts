import type { Hono } from 'hono';
import { auditLogQuerySchema, emailLogQuerySchema, emailLogSummaryQuerySchema, uuidSchema } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok, paginated } from '../../lib/http.js';
import { param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { listAudit } from '../../services/audit.service.js';
import { emailLogSummary, getEmailMessage, listEmailLog } from '../../services/email-log.service.js';

export function registerAuditRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId/audit', async (c) => {
    const q = query(c, auditLogQuerySchema);
    const { data, total } = await listAudit(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });

  // E-mail activity log (migration 20260930000500): audit.view with access to every branch
  v1.get('/orgs/:orgId/email-log', async (c) => {
    const q = query(c, emailLogQuerySchema);
    const { data, total } = await listEmailLog(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  // before /email-log/:id: a literal segment the parameter would otherwise swallow
  v1.get('/orgs/:orgId/email-log/summary', async (c) => ok(c, await emailLogSummary(deps, actorOf(c, deps), param(c, 'orgId'), query(c, emailLogSummaryQuerySchema))));
  v1.get('/orgs/:orgId/email-log/:id', async (c) => {
    const id = param(c, 'id');
    if (!uuidSchema.safeParse(id).success) throw errors.notFound('E-mail', id);
    return ok(c, await getEmailMessage(deps, actorOf(c, deps), param(c, 'orgId'), id));
  });
}

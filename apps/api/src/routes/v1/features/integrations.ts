import type { Hono } from 'hono';
import { financeIntegrationInputSchema, financeIntegrationTestSchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { ok } from '../../../lib/http.js';
import { body, optionalBody, param } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as integrations from '../../../services/features/integrations.service.js';

/** Settings → Integrations (Flowza Finance connector). All routes require `integration.manage`; the token is never returned. */
export function registerIntegrationRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/integrations/finance', async (c) => ok(c, await integrations.getFinanceIntegration(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.put('/orgs/:orgId/integrations/finance', async (c) => ok(c, await integrations.putFinanceIntegration(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, financeIntegrationInputSchema))));
  v1.post('/orgs/:orgId/integrations/finance/test', async (c) => ok(c, await integrations.testFinanceIntegration(deps, actorOf(c, deps), param(c, 'orgId'), await optionalBody(c, financeIntegrationTestSchema))));
  v1.post('/orgs/:orgId/integrations/finance/sync-now', idem, async (c) => c.json({ data: await integrations.syncFinanceNow(deps, actorOf(c, deps), param(c, 'orgId')) }, 202));
  v1.get('/orgs/:orgId/integrations/finance/status', async (c) => ok(c, await integrations.getFinanceStatus(deps, actorOf(c, deps), param(c, 'orgId'))));
}

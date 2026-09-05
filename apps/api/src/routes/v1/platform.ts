import type { Hono } from 'hono';
import { accessGrantListQuerySchema, createAccessGrantSchema, createOrganizationSchema, platformOrgListQuerySchema, putFeatureFlagsSchema, putOrgFeatureFlagsSchema, updateOrganizationStatusSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { idempotency } from '../../middleware/idempotency.js';
import * as platform from '../../services/platform.service.js';

/** Platform administration (platform_admins only; every handler calls requirePlatformAdmin inside the service). */
export function registerPlatformRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/platform/orgs', async (c) => { const q = query(c, platformOrgListQuerySchema); const r = await platform.listOrganizations(deps, actorOf(c, deps), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/platform/orgs', idem, async (c) => created(c, await platform.createOrganization(deps, actorOf(c, deps), await body(c, createOrganizationSchema))));
  v1.get('/platform/orgs/:id', async (c) => ok(c, await platform.getOrganization(deps, actorOf(c, deps), param(c, 'id'))));
  v1.patch('/platform/orgs/:id/status', async (c) => ok(c, await platform.updateOrganizationStatus(deps, actorOf(c, deps), param(c, 'id'), await body(c, updateOrganizationStatusSchema))));
  v1.get('/platform/orgs/:id/feature-flags', async (c) => ok(c, await platform.getOrgFeatureFlags(deps, actorOf(c, deps), param(c, 'id'))));
  v1.put('/platform/orgs/:id/feature-flags', async (c) => ok(c, await platform.putOrgFeatureFlags(deps, actorOf(c, deps), param(c, 'id'), await body(c, putOrgFeatureFlagsSchema))));
  v1.get('/platform/access-grants', async (c) => { const q = query(c, accessGrantListQuerySchema); const r = await platform.listGrants(deps, actorOf(c, deps), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/platform/access-grants', async (c) => created(c, await platform.createGrant(deps, actorOf(c, deps), await body(c, createAccessGrantSchema))));
  v1.delete('/platform/access-grants/:id', async (c) => ok(c, await platform.revokeGrant(deps, actorOf(c, deps), param(c, 'id'))));
  v1.get('/platform/plans', async (c) => ok(c, await platform.listPlans(deps, actorOf(c, deps))));
  v1.get('/platform/feature-flags', async (c) => ok(c, await platform.listFeatureFlags(deps, actorOf(c, deps))));
  v1.put('/platform/feature-flags', async (c) => ok(c, await platform.putFeatureFlags(deps, actorOf(c, deps), await body(c, putFeatureFlagsSchema))));
  v1.get('/platform/health', async (c) => ok(c, await platform.health(deps, actorOf(c, deps))));
}

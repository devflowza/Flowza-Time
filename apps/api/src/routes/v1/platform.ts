import type { Hono } from 'hono';
import { accessGrantListQuerySchema, createAccessGrantSchema, createOrganizationSchema, createPlatformAdminSchema, createTenantNoteSchema, platformActivityQuerySchema, platformOrgListQuerySchema, platformUserListQuerySchema, putFeatureFlagsSchema, putOrgFeatureFlagsSchema, putTenantAccountSchema, updateOrganizationSchema, updateOrganizationStatusSchema, updatePlatformAdminSchema, updateSubscriptionSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { idempotency } from '../../middleware/idempotency.js';
import * as platform from '../../services/platform.service.js';
import * as adm from '../../services/platform-admin.service.js';

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
  v1.post('/platform/access-grants/:id/approve', async (c) => ok(c, await platform.approveGrant(deps, actorOf(c, deps), param(c, 'id'))));
  v1.delete('/platform/access-grants/:id', async (c) => ok(c, await platform.revokeGrant(deps, actorOf(c, deps), param(c, 'id'))));
  v1.get('/platform/plans', async (c) => ok(c, await platform.listPlans(deps, actorOf(c, deps))));
  v1.get('/platform/feature-flags', async (c) => ok(c, await platform.listFeatureFlags(deps, actorOf(c, deps))));
  v1.put('/platform/feature-flags', async (c) => ok(c, await platform.putFeatureFlags(deps, actorOf(c, deps), await body(c, putFeatureFlagsSchema))));
  v1.get('/platform/health', async (c) => ok(c, await platform.health(deps, actorOf(c, deps))));

  // super-admin portal (/adm) — migration 20260929000400
  v1.get('/platform/overview', async (c) => ok(c, await adm.overview(deps, actorOf(c, deps))));
  v1.patch('/platform/orgs/:id', async (c) => ok(c, await adm.updateOrganizationDetails(deps, actorOf(c, deps), param(c, 'id'), await body(c, updateOrganizationSchema))));
  v1.get('/platform/orgs/:id/subscription', async (c) => ok(c, await adm.getSubscription(deps, actorOf(c, deps), param(c, 'id'))));
  v1.patch('/platform/orgs/:id/subscription', async (c) => ok(c, await adm.updateSubscription(deps, actorOf(c, deps), param(c, 'id'), await body(c, updateSubscriptionSchema))));
  v1.get('/platform/orgs/:id/members', async (c) => ok(c, await adm.listOrganizationMembers(deps, actorOf(c, deps), param(c, 'id'))));
  v1.get('/platform/orgs/:id/account', async (c) => ok(c, await adm.getTenantAccount(deps, actorOf(c, deps), param(c, 'id'))));
  v1.put('/platform/orgs/:id/account', async (c) => ok(c, await adm.putTenantAccount(deps, actorOf(c, deps), param(c, 'id'), await body(c, putTenantAccountSchema))));
  v1.get('/platform/orgs/:id/notes', async (c) => ok(c, await adm.listTenantNotes(deps, actorOf(c, deps), param(c, 'id'))));
  v1.post('/platform/orgs/:id/notes', async (c) => created(c, await adm.addTenantNote(deps, actorOf(c, deps), param(c, 'id'), await body(c, createTenantNoteSchema))));
  v1.get('/platform/activity', async (c) => { const q = query(c, platformActivityQuerySchema); const r = await adm.listActivity(deps, actorOf(c, deps), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/platform/users', async (c) => { const q = query(c, platformUserListQuerySchema); const r = await adm.listUsers(deps, actorOf(c, deps), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/platform/users/:id', async (c) => ok(c, await adm.getUser(deps, actorOf(c, deps), param(c, 'id'))));
  v1.get('/platform/admins', async (c) => ok(c, await adm.listAdmins(deps, actorOf(c, deps))));
  v1.post('/platform/admins', async (c) => created(c, await adm.addAdmin(deps, actorOf(c, deps), await body(c, createPlatformAdminSchema))));
  v1.patch('/platform/admins/:userId', async (c) => ok(c, await adm.updateAdmin(deps, actorOf(c, deps), param(c, 'userId'), await body(c, updatePlatformAdminSchema))));
}

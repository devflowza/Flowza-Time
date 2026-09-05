import type { Context, Hono } from 'hono';
import { updateOrganizationSchema } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { ok } from '../../lib/http.js';
import { body, param } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { isSettingsGroup } from '../../lib/settings.js';
import * as orgs from '../../services/organizations.service.js';

function groupParam(c: Context<AppEnv>): 'general' | 'attendance' | 'sync' | 'notifications' | 'security' | 'integrations' {
  const g = param(c, 'group');
  if (!isSettingsGroup(g)) throw errors.notFound('Settings group', g);
  return g;
}

export function registerOrganizationRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/orgs/:orgId', async (c) => ok(c, await orgs.getOrganization(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.patch('/orgs/:orgId', async (c) => ok(c, await orgs.updateOrganization(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, updateOrganizationSchema))));
  v1.get('/orgs/:orgId/settings', async (c) => ok(c, await orgs.getSettings(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/settings/:group', async (c) => ok(c, await orgs.getSettingsGroup(deps, actorOf(c, deps), param(c, 'orgId'), groupParam(c))));
  v1.put('/orgs/:orgId/settings/:group', async (c) => {
    const payload = await c.req.json().catch(() => ({}));
    return ok(c, await orgs.putSettingsGroup(deps, actorOf(c, deps), param(c, 'orgId'), groupParam(c), payload));
  });
}

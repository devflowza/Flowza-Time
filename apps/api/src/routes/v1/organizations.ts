import type { Context, Hono } from 'hono';
import { createOwnOrganizationSchema, updateOrganizationSchema, type SettingsGroup } from '@flowza/contracts';
import { errors } from '@flowza/shared';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok } from '../../lib/http.js';
import { body, param } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { isSettingsGroup } from '../../lib/settings.js';
import { idempotency } from '../../middleware/idempotency.js';
import * as orgs from '../../services/organizations.service.js';
import * as billing from '../../services/billing.service.js';

function groupParam(c: Context<AppEnv>): SettingsGroup {
  const g = param(c, 'group');
  if (!isSettingsGroup(g)) throw errors.notFound('Settings group', g);
  return g;
}

export function registerOrganizationRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // Self-service: any signed-in user without a membership creates their own (trial) organisation and becomes its owner.
  v1.post('/orgs', idempotency(), async (c) => created(c, await orgs.createOwnOrganization(deps, actorOf(c, deps), await body(c, createOwnOrganizationSchema))));
  v1.get('/orgs/:orgId', async (c) => ok(c, await orgs.getOrganization(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.patch('/orgs/:orgId', async (c) => ok(c, await orgs.updateOrganization(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, updateOrganizationSchema))));
  v1.get('/orgs/:orgId/settings', async (c) => ok(c, await orgs.getSettings(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/settings/:group', async (c) => ok(c, await orgs.getSettingsGroup(deps, actorOf(c, deps), param(c, 'orgId'), groupParam(c))));
  v1.put('/orgs/:orgId/settings/:group', async (c) => {
    const payload = await c.req.json().catch(() => ({}));
    return ok(c, await orgs.putSettingsGroup(deps, actorOf(c, deps), param(c, 'orgId'), groupParam(c), payload));
  });
  // the tenant's own plan, price, usage and modules (organization.view) and invoices (organization.manage) — migration 20260929000600
  v1.get('/orgs/:orgId/subscription', async (c) => ok(c, await billing.getTenantSubscription(deps, actorOf(c, deps), param(c, 'orgId'))));
  // licensed users against the user limit only a platform admin changes (migration 20261001000300)
  v1.get('/orgs/:orgId/user-limit', async (c) => ok(c, await billing.getTenantUserLimit(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.get('/orgs/:orgId/billing/invoices', async (c) => ok(c, await billing.listTenantInvoices(deps, actorOf(c, deps), param(c, 'orgId'))));
}

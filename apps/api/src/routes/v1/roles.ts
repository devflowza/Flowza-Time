import type { Hono } from 'hono';
import { roleInputSchema, updateRoleSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, noContent, ok } from '../../lib/http.js';
import { body, param } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as roles from '../../services/roles.service.js';

export function registerRoleRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  v1.get('/permissions', async (c) => ok(c, await roles.listPermissions(deps, actorOf(c, deps))));
  v1.get('/orgs/:orgId/roles', async (c) => ok(c, await roles.listRoles(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/roles', async (c) => created(c, await roles.createRole(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, roleInputSchema))));
  v1.patch('/orgs/:orgId/roles/:id', async (c) => ok(c, await roles.updateRole(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateRoleSchema))));
  v1.delete('/orgs/:orgId/roles/:id', async (c) => { await roles.deleteRole(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
}

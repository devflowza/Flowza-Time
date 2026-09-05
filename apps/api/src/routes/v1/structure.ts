import type { Hono } from 'hono';
import { branchInputSchema, departmentInputSchema, designationInputSchema, structureListQuerySchema, teamInputSchema, updateTeamSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as s from '../../services/structure.service.js';

export function registerStructureRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // Branches
  v1.get('/orgs/:orgId/branches', async (c) => { const q = query(c, structureListQuerySchema); const r = await s.listBranches(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/branches', async (c) => created(c, await s.createBranch(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, branchInputSchema))));
  v1.get('/orgs/:orgId/branches/:id', async (c) => ok(c, await s.getBranch(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/branches/:id', async (c) => ok(c, await s.updateBranch(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, branchInputSchema.partial()))));
  v1.delete('/orgs/:orgId/branches/:id', async (c) => ok(c, await s.archiveBranch(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // Departments
  v1.get('/orgs/:orgId/departments', async (c) => { const q = query(c, structureListQuerySchema); const r = await s.listDepartments(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/departments', async (c) => created(c, await s.createDepartment(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, departmentInputSchema))));
  v1.get('/orgs/:orgId/departments/:id', async (c) => ok(c, await s.getDepartment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/departments/:id', async (c) => ok(c, await s.updateDepartment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, departmentInputSchema.partial()))));
  v1.delete('/orgs/:orgId/departments/:id', async (c) => ok(c, await s.archiveDepartment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // Designations
  v1.get('/orgs/:orgId/designations', async (c) => { const q = query(c, structureListQuerySchema); const r = await s.listDesignations(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/designations', async (c) => created(c, await s.createDesignation(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, designationInputSchema))));
  v1.patch('/orgs/:orgId/designations/:id', async (c) => ok(c, await s.updateDesignation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, designationInputSchema.partial()))));
  v1.delete('/orgs/:orgId/designations/:id', async (c) => ok(c, await s.archiveDesignation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // Teams
  v1.get('/orgs/:orgId/teams', async (c) => { const q = query(c, structureListQuerySchema); const r = await s.listTeams(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/teams', async (c) => created(c, await s.createTeam(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, teamInputSchema))));
  v1.get('/orgs/:orgId/teams/:id', async (c) => ok(c, await s.getTeam(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/teams/:id', async (c) => ok(c, await s.updateTeam(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateTeamSchema))));
  v1.delete('/orgs/:orgId/teams/:id', async (c) => ok(c, await s.archiveTeam(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

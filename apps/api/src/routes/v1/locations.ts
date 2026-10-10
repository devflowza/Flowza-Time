import type { Hono } from 'hono';
import { applyLocationTemplateSchema, locationInputSchema, locationLevelInputSchema, locationListQuerySchema, updateLocationLevelSchema, updateLocationSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { created, ok } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import * as s from '../../services/locations.service.js';

/**
 * Location hierarchy (docs/locations.md §5): the organisation's levels and its location tree. Core routes (no module gate);
 * read with branch.view, write with branch.manage — levels and group nodes with every branch, places with their branch in scope.
 * Level writes answer with the whole ordered list (an insert or a delete moves the levels below it).
 */
export function registerLocationRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // Levels
  v1.get('/orgs/:orgId/location-levels', async (c) => ok(c, await s.listLocationLevels(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/location-levels', async (c) => created(c, await s.createLocationLevel(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, locationLevelInputSchema))));
  v1.post('/orgs/:orgId/location-levels/apply-template', async (c) => ok(c, await s.applyLocationTemplate(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, applyLocationTemplateSchema))));
  v1.patch('/orgs/:orgId/location-levels/:id', async (c) => ok(c, await s.updateLocationLevel(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateLocationLevelSchema))));
  v1.delete('/orgs/:orgId/location-levels/:id', async (c) => ok(c, await s.deleteLocationLevel(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // Locations
  v1.get('/orgs/:orgId/locations', async (c) => ok(c, await s.listLocations(deps, actorOf(c, deps), param(c, 'orgId'), query(c, locationListQuerySchema))));
  v1.post('/orgs/:orgId/locations', async (c) => created(c, await s.createLocation(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, locationInputSchema))));
  v1.get('/orgs/:orgId/locations/:id', async (c) => ok(c, await s.getLocation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/locations/:id', async (c) => ok(c, await s.updateLocation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateLocationSchema))));
  v1.delete('/orgs/:orgId/locations/:id', async (c) => ok(c, await s.archiveLocation(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
}

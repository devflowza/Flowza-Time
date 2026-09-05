import type { Hono } from 'hono';
import { claimPendingDeviceSchema, createDeviceSchema, deleteDeviceQuerySchema, deviceCommandQuerySchema, deviceCredentialsInputSchema, deviceEmployeeQuerySchema, deviceGroupInputSchema, deviceGroupMembersSchema, deviceListQuerySchema, deviceLogQuerySchema, deviceModelsQuerySchema, deviceProvidersQuerySchema, deviceSummaryQuerySchema, pendingDevicesQuerySchema, testConnectionSchema, updateDeviceSchema } from '@flowza/contracts';
import { z } from 'zod';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { idempotency } from '../../../middleware/idempotency.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as devices from '../../../services/features/devices.service.js';

const ACTIONS = ['sync-attendance', 'sync-employees', 'health-check', 'reconcile'] as const;

export function registerDeviceRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/device-providers', async (c) => ok(c, await devices.listProviders(deps, actorOf(c, deps), query(c, deviceProvidersQuerySchema).orgId)));
  v1.get('/device-models', async (c) => ok(c, await devices.listModels(deps, actorOf(c, deps), query(c, deviceModelsQuerySchema).providerKey)));

  v1.get('/orgs/:orgId/devices', async (c) => { const q = query(c, deviceListQuerySchema); const r = await devices.listDevices(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/devices', idem, async (c) => created(c, await devices.createDevice(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createDeviceSchema))));
  v1.post('/orgs/:orgId/devices/test-connection', async (c) => ok(c, await devices.testConnection(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, testConnectionSchema))));
  v1.get('/orgs/:orgId/devices/summary', async (c) => ok(c, await devices.summarizeDevices(deps, actorOf(c, deps), param(c, 'orgId'), query(c, deviceSummaryQuerySchema))));
  // pending (zero-touch) devices — registered before /:id so "pending" is never parsed as an id
  v1.get('/orgs/:orgId/devices/pending', async (c) => ok(c, await devices.listPending(deps, actorOf(c, deps), param(c, 'orgId'), query(c, pendingDevicesQuerySchema).serialNumber)));
  v1.post('/orgs/:orgId/devices/pending/:id/claim', idem, async (c) => created(c, await devices.claimPending(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, claimPendingDeviceSchema))));

  v1.get('/orgs/:orgId/devices/:id', async (c) => ok(c, await devices.getDevice(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/devices/:id', async (c) => ok(c, await devices.updateDevice(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateDeviceSchema))));
  v1.delete('/orgs/:orgId/devices/:id', async (c) => ok(c, await devices.removeDevice(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), query(c, deleteDeviceQuerySchema).decommission)));
  v1.post('/orgs/:orgId/devices/:id/credentials', async (c) => ok(c, await devices.putCredentials(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, deviceCredentialsInputSchema))));
  v1.post('/orgs/:orgId/devices/:id/push-token/rotate', async (c) => ok(c, await devices.rotatePushToken(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/devices/:id/logs', async (c) => { const q = query(c, deviceLogQuerySchema); const r = await devices.listDeviceLogs(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/devices/:id/employees', async (c) => { const q = query(c, deviceEmployeeQuerySchema); const r = await devices.listDeviceEmployees(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.get('/orgs/:orgId/devices/:id/commands', async (c) => { const q = query(c, deviceCommandQuerySchema); const r = await devices.listDeviceCommands(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/devices/:id/actions/:action', idem, async (c) => {
    const action = z.enum(ACTIONS).parse(param(c, 'action'));
    const job = await devices.runDeviceAction(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), action);
    return c.json({ data: { jobId: job.id, status: job.queued === 0 ? 'SUCCESS' : 'QUEUED', message: job.queued === 0 ? `${action}: already in flight, covered by the running job.` : `${action} queued.`, itemsTotal: job.itemsTotal, itemsQueued: job.queued, itemsSkipped: job.skipped, deviceCount: 1 } }, 202);
  });

  // device groups
  v1.get('/orgs/:orgId/device-groups', async (c) => ok(c, await devices.listGroups(deps, actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/device-groups', async (c) => created(c, await devices.createGroup(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, deviceGroupInputSchema))));
  v1.get('/orgs/:orgId/device-groups/:id', async (c) => ok(c, await devices.getGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/device-groups/:id', async (c) => ok(c, await devices.updateGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, deviceGroupInputSchema.partial()))));
  v1.delete('/orgs/:orgId/device-groups/:id', async (c) => { await devices.deleteGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  v1.post('/orgs/:orgId/device-groups/:id/members', async (c) => ok(c, await devices.setGroupMembers(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, deviceGroupMembersSchema)).deviceIds, 'add')));
  v1.delete('/orgs/:orgId/device-groups/:id/members', async (c) => ok(c, await devices.setGroupMembers(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), (await body(c, deviceGroupMembersSchema)).deviceIds, 'remove')));
}

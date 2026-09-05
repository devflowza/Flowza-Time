import type { Hono } from 'hono';
import { bulkEmployeeActionSchema, createEmployeeSchema, deleteEmployeeSchema, employeeListQuerySchema, identityDocumentInputSchema, updateEmployeeSchema } from '@flowza/contracts';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { accepted, created, noContent, ok, paginated } from '../../lib/http.js';
import { body, param, query } from '../../lib/validate.js';
import { actorOf } from '../../lib/service.js';
import { idempotency } from '../../middleware/idempotency.js';
import * as emp from '../../services/employees.service.js';

export function registerEmployeeRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  const idem = idempotency();
  v1.get('/orgs/:orgId/employees', async (c) => {
    const q = query(c, employeeListQuerySchema);
    const { data, total } = await emp.listEmployees(deps, actorOf(c, deps), param(c, 'orgId'), q);
    return paginated(c, data, q.page, q.pageSize, total);
  });
  v1.post('/orgs/:orgId/employees', idem, async (c) => created(c, await emp.createEmployee(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, createEmployeeSchema))));
  v1.post('/orgs/:orgId/employees/bulk', idem, async (c) => {
    const result = await emp.bulkAction(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, bulkEmployeeActionSchema));
    return result.kind === 'job' ? accepted(c, result.jobId) : ok(c, { updated: result.updated, employeeIds: result.employeeIds });
  });
  v1.get('/orgs/:orgId/employees/:id', async (c) => ok(c, await emp.getEmployee(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/employees/:id', async (c) => ok(c, await emp.updateEmployee(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, updateEmployeeSchema))));
  v1.delete('/orgs/:orgId/employees/:id', async (c) => {
    const input = c.req.header('content-length') && c.req.header('content-length') !== '0' ? await body(c, deleteEmployeeSchema) : {};
    return ok(c, await emp.deleteEmployee(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), input));
  });
  v1.get('/orgs/:orgId/employees/:id/history', async (c) => ok(c, await emp.getEmployeeHistory(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/employees/:id/devices', async (c) => ok(c, await emp.getEmployeeDevices(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.get('/orgs/:orgId/employees/:id/documents', async (c) => ok(c, await emp.listDocuments(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.post('/orgs/:orgId/employees/:id/documents', async (c) => created(c, await emp.addDocument(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, identityDocumentInputSchema))));
  v1.delete('/orgs/:orgId/employees/:id/documents/:documentId', async (c) => { await emp.deleteDocument(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), param(c, 'documentId')); return noContent(c); });
}

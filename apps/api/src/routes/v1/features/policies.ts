import type { Context, Hono } from 'hono';
import { attendancePointsDetailQuerySchema, attendancePointsQuerySchema, attendanceRuleSetInputSchema, employeeGroupInputSchema, employeeGroupListQuerySchema, employeeGroupMembersInputSchema, employeeGroupMembersQuerySchema, employeeGroupUpdateSchema, endEmployeeGroupMembershipSchema, overtimeSummaryQuerySchema, policyComplianceQuerySchema, policyResolveQuerySchema } from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as groups from '../../../services/policies/employee-groups.service.js';
import * as policies from '../../../services/policies/policies.service.js';

/**
 * Global attendance policies (Enterprise, module `attendance_policies` — the module gate refuses every path below with
 * FEATURE_DISABLED when the module is off): employee groups and their members, "which policy applies", country rule packs and
 * the compliance check, attendance points & discipline, the overtime summary. The policies themselves are the attendance rule
 * sets (schedule.ts). PATCH bodies come from `updateSchemaOf(...)` (no defaults re-applied).
 */
/** A page with extra `meta` (the date the figures are for). */
function pageWithMeta<T>(c: Context, data: T[], q: { page: number; pageSize: number }, total: number, extra: Record<string, unknown>) {
  return c.json({ data, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)), ...extra } });
}

export function registerPolicyRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // employee groups
  v1.get('/orgs/:orgId/employee-groups', async (c) => ok(c, await groups.listEmployeeGroups(deps, actorOf(c, deps), param(c, 'orgId'), query(c, employeeGroupListQuerySchema))));
  v1.post('/orgs/:orgId/employee-groups', async (c) => created(c, await groups.createEmployeeGroup(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, employeeGroupInputSchema))));
  v1.get('/orgs/:orgId/employee-groups/:id', async (c) => ok(c, await groups.getEmployeeGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  v1.patch('/orgs/:orgId/employee-groups/:id', async (c) => ok(c, await groups.updateEmployeeGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, employeeGroupUpdateSchema))));
  v1.delete('/orgs/:orgId/employee-groups/:id', async (c) => { await groups.deleteEmployeeGroup(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  // members
  v1.get('/orgs/:orgId/employee-groups/:id/members', async (c) => { const q = query(c, employeeGroupMembersQuerySchema); const r = await groups.listEmployeeGroupMembers(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/employee-groups/:id/members', async (c) => created(c, await groups.addEmployeeGroupMembers(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, employeeGroupMembersInputSchema))));
  v1.patch('/orgs/:orgId/employee-groups/:id/members/:membershipId', async (c) => ok(c, await groups.endEmployeeGroupMembership(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), param(c, 'membershipId'), await body(c, endEmployeeGroupMembershipSchema))));
  v1.delete('/orgs/:orgId/employee-groups/:id/members/:membershipId', async (c) => ok(c, await groups.deleteEmployeeGroupMembership(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), param(c, 'membershipId'))));
  // which policy applies, country packs, compliance
  v1.get('/orgs/:orgId/attendance-policies/resolve', async (c) => { const q = query(c, policyResolveQuerySchema); return ok(c, await policies.resolveEmployeePolicy(deps, actorOf(c, deps), param(c, 'orgId'), q.employeeId, q.date)); });
  v1.get('/orgs/:orgId/attendance-policies/country-packs', async (c) => ok(c, policies.listCountryPacks(actorOf(c, deps), param(c, 'orgId'))));
  v1.post('/orgs/:orgId/attendance-policies/compliance', async (c) => { const q = query(c, policyComplianceQuerySchema); return ok(c, await policies.checkCompliance(deps, actorOf(c, deps), param(c, 'orgId'), q.countryCode, await body(c, attendanceRuleSetInputSchema))); });
  // attendance points & discipline, overtime summary
  v1.get('/orgs/:orgId/attendance-policies/points', async (c) => { const q = query(c, attendancePointsQuerySchema); const r = await policies.listAttendancePoints(deps, actorOf(c, deps), param(c, 'orgId'), q); return pageWithMeta(c, r.data, q, r.total, { asOf: r.asOf }); });
  v1.get('/orgs/:orgId/attendance-policies/points/:employeeId', async (c) => ok(c, await policies.attendancePointsDetail(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'employeeId'), query(c, attendancePointsDetailQuerySchema))));
  v1.get('/orgs/:orgId/attendance-policies/overtime-summary', async (c) => { const q = query(c, overtimeSummaryQuerySchema); const r = await policies.listOvertimeSummary(deps, actorOf(c, deps), param(c, 'orgId'), q); return pageWithMeta(c, r.data, q, r.total, { month: r.month }); });
}

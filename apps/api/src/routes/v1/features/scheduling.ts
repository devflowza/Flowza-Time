import type { Hono } from 'hono';
import {
  additionalShiftAssignmentInputSchema, additionalShiftAssignmentListQuerySchema, additionalShiftAssignmentUpdateSchema, branchDeploymentInputSchema, branchDeploymentListQuerySchema,
  cancelBranchDeploymentSchema, locationMusterQuerySchema, roundTheClockInputSchema, shiftCoverageInputSchema, shiftCoverageListQuerySchema, shiftCoverageReportQuerySchema, shiftCoverageUpdateSchema,
} from '@flowza/contracts';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { created, noContent, ok, paginated } from '../../../lib/http.js';
import { body, param, query } from '../../../lib/validate.js';
import { actorOf } from '../../../lib/service.js';
import * as rtc from '../../../services/scheduling/round-the-clock.service.js';
import * as coverage from '../../../services/scheduling/coverage.service.js';
import * as additional from '../../../services/scheduling/additional-shifts.service.js';
import * as deployments from '../../../services/scheduling/deployments.service.js';
import * as muster from '../../../services/scheduling/muster.service.js';

/**
 * Round-the-clock scheduling (Enterprise, module `advanced_scheduling` — the module gate refuses every path below with 403
 * FEATURE_DISABLED while it is off; docs/enterprise/plan.md §7):
 *   round-the-clock/preview, round-the-clock                 24/7 rotation templates (shift.manage [+ shift.assign])
 *   shift-coverage (+ /:id, /report)                         coverage targets (whole branch or a place of it) and the
 *                                                            scheduled-vs-required report
 *   additional-shift-assignments (+ /:id)                    double shifts (shift.view / shift.assign)
 *   branch-deployments (+ /:id/cancel)                       temporary deployment to another branch (employee.view / employee.update)
 *   locations/:id/muster                                     who was last seen at a location on a day (attendance.view;
 *                                                            docs/locations.md §4)
 * PATCH bodies are explicit update schemas without defaults (AGENTS.md, Zod 4 `.partial()` pitfall).
 */
export function registerSchedulingRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  // round-the-clock templates
  v1.post('/orgs/:orgId/round-the-clock/preview', async (c) => ok(c, await rtc.previewRoundTheClock(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, roundTheClockInputSchema))));
  v1.post('/orgs/:orgId/round-the-clock', async (c) => created(c, await rtc.applyRoundTheClock(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, roundTheClockInputSchema))));
  // coverage targets (the report before /:id)
  v1.get('/orgs/:orgId/shift-coverage/report', async (c) => ok(c, await coverage.coverageReport(deps, actorOf(c, deps), param(c, 'orgId'), query(c, shiftCoverageReportQuerySchema))));
  v1.get('/orgs/:orgId/shift-coverage', async (c) => ok(c, await coverage.listCoverage(deps, actorOf(c, deps), param(c, 'orgId'), query(c, shiftCoverageListQuerySchema))));
  v1.post('/orgs/:orgId/shift-coverage', async (c) => created(c, await coverage.createCoverage(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, shiftCoverageInputSchema))));
  v1.patch('/orgs/:orgId/shift-coverage/:id', async (c) => ok(c, await coverage.updateCoverage(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, shiftCoverageUpdateSchema))));
  v1.delete('/orgs/:orgId/shift-coverage/:id', async (c) => { await coverage.deleteCoverage(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id')); return noContent(c); });
  // additional (double) shift assignments
  v1.get('/orgs/:orgId/additional-shift-assignments', async (c) => { const q = query(c, additionalShiftAssignmentListQuerySchema); const r = await additional.listAdditionalShifts(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/additional-shift-assignments', async (c) => created(c, await additional.createAdditionalShift(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, additionalShiftAssignmentInputSchema))));
  v1.patch('/orgs/:orgId/additional-shift-assignments/:id', async (c) => ok(c, await additional.updateAdditionalShift(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, additionalShiftAssignmentUpdateSchema))));
  v1.delete('/orgs/:orgId/additional-shift-assignments/:id', async (c) => ok(c, await additional.deleteAdditionalShift(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'))));
  // temporary branch deployments
  v1.get('/orgs/:orgId/branch-deployments', async (c) => { const q = query(c, branchDeploymentListQuerySchema); const r = await deployments.listDeployments(deps, actorOf(c, deps), param(c, 'orgId'), q); return paginated(c, r.data, q.page, q.pageSize, r.total); });
  v1.post('/orgs/:orgId/branch-deployments', async (c) => created(c, await deployments.createDeployment(deps, actorOf(c, deps), param(c, 'orgId'), await body(c, branchDeploymentInputSchema))));
  v1.post('/orgs/:orgId/branch-deployments/:id/cancel', async (c) => ok(c, await deployments.cancelDeployment(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), await body(c, cancelBranchDeploymentSchema))));
  // the muster list of a location (the location routes themselves are core: routes/v1/locations.ts)
  v1.get('/orgs/:orgId/locations/:id/muster', async (c) => ok(c, await muster.locationMuster(deps, actorOf(c, deps), param(c, 'orgId'), param(c, 'id'), query(c, locationMusterQuerySchema))));
}

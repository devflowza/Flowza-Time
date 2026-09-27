import type { Hono } from 'hono';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { registerDeviceRoutes } from './devices.js';
import { registerSyncRoutes } from './sync.js';
import { registerAttendanceRoutes } from './attendance.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerScheduleRoutes } from './schedule.js';
import { registerReportRoutes } from './reports.js';

/**
 * Feature modules: devices (+ groups, pending), sync, attendance (+ corrections, recalculation, period locks), approvals (engine v2: inbox,
 * decisions, workflows, delegations), schedule (shifts, patterns, assignments, holidays, leave, rule sets) and reports/payroll. Wire from routes/v1/index.ts:
 *   registerFeatureRoutes(v1, deps);
 */
export function registerFeatureRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  registerDeviceRoutes(v1, deps);
  registerSyncRoutes(v1, deps);
  registerAttendanceRoutes(v1, deps);
  registerApprovalRoutes(v1, deps);
  registerScheduleRoutes(v1, deps);
  registerReportRoutes(v1, deps);
}

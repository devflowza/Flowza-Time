import type { Hono } from 'hono';
import type { AppEnv } from '../../../middleware/request-context.js';
import type { ApiDeps } from '../../../deps.js';
import { registerDeviceRoutes } from './devices.js';
import { registerSyncRoutes } from './sync.js';
import { registerAttendanceRoutes } from './attendance.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerScheduleRoutes } from './schedule.js';
import { registerReportRoutes } from './reports.js';
import { registerDayMarkRoutes } from './day-marks.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerHrAttendanceRoutes } from './hr-attendance.js';
import { registerReportScheduleRoutes } from './report-schedules.js';
import { registerLeaveRoutes } from './leave.js';
import { registerAttendanceAdminRoutes } from './attendance-admin.js';
import { registerRosterRoutes } from './roster.js';

/**
 * Feature modules: devices (+ groups, pending), sync, attendance (+ corrections, recalculation, period locks, day marks),
 * approvals (engine v2: inbox, decisions, workflows, delegations), schedule (shifts, patterns, assignments, holidays,
 * leave, rule sets), reports/payroll and integrations (Flowza Finance connector). Wire from routes/v1/index.ts:
 *   registerFeatureRoutes(v1, deps);
 */
export function registerFeatureRoutes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  registerDeviceRoutes(v1, deps);
  registerSyncRoutes(v1, deps);
  registerAttendanceRoutes(v1, deps);
  registerApprovalRoutes(v1, deps);
  registerDayMarkRoutes(v1, deps);
  registerScheduleRoutes(v1, deps);
  registerReportRoutes(v1, deps);
  registerIntegrationRoutes(v1, deps);
  registerHrAttendanceRoutes(v1, deps);
  registerReportScheduleRoutes(v1, deps);
  registerLeaveRoutes(v1, deps);
  registerAttendanceAdminRoutes(v1, deps);
  registerRosterRoutes(v1, deps);
}

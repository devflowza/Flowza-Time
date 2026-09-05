import type { Hono } from 'hono';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';

/**
 * Registers all /api/v1 route modules. Each module exports `register<Name>Routes(v1, deps)` and lives in its own file
 * (me, organizations, members, roles, branches, departments, employees, imports, devices, device-groups, sync, attendance,
 * corrections, approvals, shifts, holidays, leave, rule-sets, reports, payroll, dashboard, search, audit, subscription, platform).
 */
export function registerV1Routes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  void v1; void deps;
  // Route modules are added here by feature; keep alphabetical.
}

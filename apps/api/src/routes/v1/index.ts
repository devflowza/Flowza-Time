import type { Hono } from 'hono';
import type { AppEnv } from '../../middleware/request-context.js';
import type { ApiDeps } from '../../deps.js';
import { registerAuditRoutes } from './audit.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerEmployeeRoutes } from './employees.js';
import { registerImportRoutes } from './imports.js';
import { registerMeRoutes } from './me.js';
import { registerMemberRoutes } from './members.js';
import { registerOrganizationRoutes } from './organizations.js';
import { registerPlatformRoutes } from './platform.js';
import { registerRoleRoutes } from './roles.js';
import { registerSearchRoutes } from './search.js';
import { registerStructureRoutes } from './structure.js';

/**
 * Registers all /api/v1 route modules. Each module exports `register<Name>Routes(v1, deps)` and lives in its own file
 * (me, organizations, members, roles, structure, employees, imports, devices, device-groups, sync, attendance,
 * corrections, approvals, shifts, holidays, leave, rule-sets, reports, payroll, dashboard, search, audit, subscription, platform).
 * Order matters where literal segments shadow parameters: imports (`/employees/imports/...`) must be registered before
 * employees (`/employees/:id`).
 */
export function registerV1Routes(v1: Hono<AppEnv>, deps: ApiDeps): void {
  registerMeRoutes(v1, deps);
  registerOrganizationRoutes(v1, deps);
  registerMemberRoutes(v1, deps);
  registerRoleRoutes(v1, deps);
  registerStructureRoutes(v1, deps);
  registerImportRoutes(v1, deps); // before employees: /employees/imports must not match /employees/:id
  registerEmployeeRoutes(v1, deps);
  registerSearchRoutes(v1, deps);
  registerAuditRoutes(v1, deps);
  registerDashboardRoutes(v1, deps);
  registerPlatformRoutes(v1, deps);
}

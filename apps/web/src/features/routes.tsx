import type { RouteObject } from 'react-router';
import { employeesRoutes } from './employees/routes';
import { organizationRoutes } from './organization/routes';
import { usersRoutes } from './users/routes';
import { settingsRoutes } from './settings/routes';
import { auditRoutes } from './audit/routes';
import { searchRoutes } from './search/routes';
import { devicesRoutes } from './devices/routes';
import { syncRoutes } from './sync/routes';
import { attendanceRoutes } from './attendance/routes';
import { correctionsRoutes } from './corrections/routes';
import { approvalsRoutes } from './approvals/routes';
import { scheduleRoutes } from './schedule/routes';
import { reportsRoutes } from './reports/routes';
import { payrollRoutes } from './payroll/routes';
import { platformRoutes } from './platform/routes';
import { leaveRoutes } from './leave/routes';

/** Every feature exports its RouteObject[] from features/<name>/routes.tsx (lazy pages). */
export const featureRoutes: RouteObject[] = [
  ...employeesRoutes, ...organizationRoutes, ...usersRoutes, ...settingsRoutes, ...auditRoutes, ...searchRoutes,
  ...devicesRoutes, ...syncRoutes, ...attendanceRoutes, ...correctionsRoutes, ...approvalsRoutes, ...scheduleRoutes,
  ...reportsRoutes, ...payrollRoutes, ...platformRoutes, ...leaveRoutes,
];

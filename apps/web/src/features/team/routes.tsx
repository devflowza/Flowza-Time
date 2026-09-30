import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/team.json';
import ar from '@/locales/ar/team.json';
import employeesEn from '@/locales/en/employees.json';
import employeesAr from '@/locales/ar/employees.json';
import { RequireModule } from '@/components/layout/protected-route';
import { PageFallback, TeamPage } from './pages/lazy';

registerNamespace('team', en, ar);
registerNamespace('employees', employeesEn, employeesAr);

/**
 * Line-manager workspace: /team?tab=today|attendance|leave|approvals|delegation (HR portal Prompt 5). Opens for every member
 * whose employee record has direct reports (/me: isManager) — no permission gate here: the page shows nothing to somebody
 * without a team, each tab asks the API with its own key and the API/RLS decide what of a report's data the caller may read
 * (employee.view_team / attendance.view_team / leave.view_team, or the organisation-wide keys). The sidebar lists the entry
 * for a manager holding one of those keys, or for any holder of attendance.view_team.
 */
export const teamRoutes: RouteObject[] = [
  { path: 'team', element: <RequireModule modules={['manager_workspace']}><Suspense fallback={<PageFallback />}><TeamPage /></Suspense></RequireModule> },
];

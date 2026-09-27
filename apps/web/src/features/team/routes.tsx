import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/team.json';
import ar from '@/locales/ar/team.json';
import employeesEn from '@/locales/en/employees.json';
import employeesAr from '@/locales/ar/employees.json';
import { PageFallback, TeamPage } from './pages/lazy';

registerNamespace('team', en, ar);
registerNamespace('employees', employeesEn, employeesAr);

/**
 * Line-manager workspace: /team. Opens for every member whose employee record has direct reports (/me: isManager) —
 * no permission gate here, the page itself shows nothing to somebody without a team and the API/RLS decide what of a
 * report's data the caller may read (attendance.view_team / leave.view_team). Prompt 5 fills it with the team queue.
 */
export const teamRoutes: RouteObject[] = [
  { path: 'team', element: <Suspense fallback={<PageFallback />}><TeamPage /></Suspense> },
];

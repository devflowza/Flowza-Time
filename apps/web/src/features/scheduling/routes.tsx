import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import './i18n';
import { DeploymentsPage, MusterPage, PageFallback } from './pages/lazy';

/**
 * Round-the-clock scheduling (Enterprise, module advanced_scheduling): /deployments and /attendance/muster ("On site now", the
 * muster list per location — docs/locations.md §4; a static segment, so it wins over any `attendance/:param` route). The
 * round-the-clock, coverage and double shift tabs live on /shifts (features/schedule/pages/shifts-page.tsx) and appear only
 * while the module is on.
 */
export const schedulingRoutes: RouteObject[] = [
  {
    path: 'deployments',
    element: <RequireModule modules={['advanced_scheduling']}><RequirePermission permissions={['employee.view']}><Suspense fallback={<PageFallback />}><DeploymentsPage /></Suspense></RequirePermission></RequireModule>,
  },
  {
    path: 'attendance/muster',
    element: <RequireModule modules={['advanced_scheduling']}><RequirePermission permissions={['attendance.view']}><Suspense fallback={<PageFallback />}><MusterPage /></Suspense></RequirePermission></RequireModule>,
  },
];

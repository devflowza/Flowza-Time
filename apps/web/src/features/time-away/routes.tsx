import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import './i18n';
import { PageFallback, TimeAwayPage } from './pages/lazy';

/**
 * Time away during working hours, the HR report (docs/time-away.md): /attendance/time-away — organisation-wide with
 * attendance.view, a line manager's team with attendance.view_team (the API narrows the scope). A static segment, so it wins over
 * any `attendance/:param` route.
 */
export const timeAwayRoutes: RouteObject[] = [
  { path: 'attendance/time-away', element: <RequirePermission permissions={['attendance.view', 'attendance.view_team']} any><Suspense fallback={<PageFallback />}><TimeAwayPage /></Suspense></RequirePermission> },
];

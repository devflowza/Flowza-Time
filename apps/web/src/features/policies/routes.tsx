import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import './i18n';
import { PageFallback, PoliciesPage } from './pages/lazy';

/**
 * Global attendance policies (Enterprise, module attendance_policies): /attendance/policies — employee groups, attendance points
 * & discipline, the overtime summary and the country rule packs. The policies themselves are edited on /shifts?tab=rules.
 * Static segment, so it wins over any `attendance/:param` route.
 */
export const policiesRoutes: RouteObject[] = [
  { path: 'attendance/policies', element: <RequirePermission permissions={['attendance.view']}><RequireModule modules={['attendance_policies']}><Suspense fallback={<PageFallback />}><PoliciesPage /></Suspense></RequireModule></RequirePermission> },
];

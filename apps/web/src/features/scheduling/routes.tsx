import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import './i18n';
import { DeploymentsPage, PageFallback } from './pages/lazy';

/**
 * Round-the-clock scheduling (Enterprise, module advanced_scheduling): /deployments. The round-the-clock, coverage and double
 * shift tabs live on /shifts (features/schedule/pages/shifts-page.tsx) and appear only while the module is on.
 */
export const schedulingRoutes: RouteObject[] = [
  {
    path: 'deployments',
    element: <RequireModule modules={['advanced_scheduling']}><RequirePermission permissions={['employee.view']}><Suspense fallback={<PageFallback />}><DeploymentsPage /></Suspense></RequirePermission></RequireModule>,
  },
];

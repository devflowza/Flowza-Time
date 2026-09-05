import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/reports.json';
import ar from '@/locales/ar/reports.json';
import { PageFallback, ReportsPage } from './pages/lazy';

registerNamespace('reports', en, ar);

/** Routes for the reports feature: /reports (request + my reports). */
export const reportsRoutes: RouteObject[] = [
  { path: 'reports', element: <RequirePermission permissions={['report.view']}><Suspense fallback={<PageFallback />}><ReportsPage /></Suspense></RequirePermission> },
];

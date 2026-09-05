import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/payroll.json';
import ar from '@/locales/ar/payroll.json';
import { PageFallback, PayrollPage } from './pages/lazy';

registerNamespace('payroll', en, ar);

/** Routes for the payroll feature: /payroll (periods, locks, summaries). */
export const payrollRoutes: RouteObject[] = [
  { path: 'payroll', element: <RequirePermission permissions={['payroll.view']}><Suspense fallback={<PageFallback />}><PayrollPage /></Suspense></RequirePermission> },
];

import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/corrections.json';
import ar from '@/locales/ar/corrections.json';
import { CorrectionsPage, PageFallback } from './pages/lazy';

registerNamespace('corrections', en, ar);

/** Routes for the corrections feature: /corrections (list + request dialog). */
export const correctionsRoutes: RouteObject[] = [
  { path: 'corrections', element: <RequirePermission permissions={['attendance.view']}><Suspense fallback={<PageFallback />}><CorrectionsPage /></Suspense></RequirePermission> },
];

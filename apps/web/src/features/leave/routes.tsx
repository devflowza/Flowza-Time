import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/leave.json';
import ar from '@/locales/ar/leave.json';
import { LeavePage, PageFallback } from './pages/lazy';

registerNamespace('leave', en, ar);

/** Routes for the leave feature: /leave?tab=records|types */
export const leaveRoutes: RouteObject[] = [
  { path: 'leave', element: <RequireModule modules={['leave']}><RequirePermission permissions={['leave.view']} selfServiceTo="/my/leave"><Suspense fallback={<PageFallback />}><LeavePage /></Suspense></RequirePermission></RequireModule> },
];

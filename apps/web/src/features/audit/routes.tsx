import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/audit.json';
import ar from '@/locales/ar/audit.json';
import { AuditPage, PageFallback } from './pages/lazy';

registerNamespace('audit', en, ar);

/** Routes for the audit feature: /audit */
export const auditRoutes: RouteObject[] = [
  { path: 'audit', element: <RequirePermission permissions={['audit.view']}><Suspense fallback={<PageFallback />}><AuditPage /></Suspense></RequirePermission> },
];

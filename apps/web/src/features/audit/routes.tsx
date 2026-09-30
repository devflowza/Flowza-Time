import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/audit.json';
import ar from '@/locales/ar/audit.json';
import enEmailLog from '@/locales/en/email-log.json';
import arEmailLog from '@/locales/ar/email-log.json';
import { AuditPage, EmailLogPage, PageFallback } from './pages/lazy';

registerNamespace('audit', en, ar);
registerNamespace('email-log', enEmailLog, arEmailLog);

/** Routes for the audit feature: /audit, /email-log (the e-mail activity log; the API also needs access to every branch) */
export const auditRoutes: RouteObject[] = [
  { path: 'audit', element: <RequirePermission permissions={['audit.view']}><Suspense fallback={<PageFallback />}><AuditPage /></Suspense></RequirePermission> },
  { path: 'email-log', element: <RequirePermission permissions={['audit.view']}><Suspense fallback={<PageFallback />}><EmailLogPage /></Suspense></RequirePermission> },
];

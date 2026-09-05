import { lazy, Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { PageFallback } from '@/routes';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/organization.json';
import ar from '@/locales/ar/organization.json';

registerNamespace('organization', en, ar);

const OrganizationPage = lazy(() => import('./pages/organization-page'));

/** Routes for the organization feature: /organization?tab=branches|departments|designations|teams */
export const organizationRoutes: RouteObject[] = [
  { path: 'organization', element: <RequirePermission permissions={['branch.view']}><Suspense fallback={<PageFallback />}><OrganizationPage /></Suspense></RequirePermission> },
];

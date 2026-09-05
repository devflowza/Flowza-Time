import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/sync.json';
import ar from '@/locales/ar/sync.json';
import { PageFallback, ReconciliationPage, SyncJobPage, SyncJobsPage } from './pages/lazy';

registerNamespace('sync', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the sync feature (lazy pages, permission-gated; the server enforces permissions again). */
export const syncRoutes: RouteObject[] = [
  { path: 'sync', element: wrap(['device.view'], <SyncJobsPage />) },
  { path: 'sync/:id', element: wrap(['device.view'], <SyncJobPage />) },
  { path: 'reconciliation', element: wrap(['device.sync'], <ReconciliationPage />) },
];

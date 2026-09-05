import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import { DeviceDetailPage, DeviceGroupsPage, DeviceNewPage, DevicesListPage, PageFallback } from './pages/lazy';

registerNamespace('devices', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the devices feature (lazy pages, permission-gated; the server enforces permissions again). */
export const devicesRoutes: RouteObject[] = [
  { path: 'devices', element: wrap(['device.view'], <DevicesListPage />) },
  { path: 'devices/new', element: wrap(['device.create'], <DeviceNewPage />) },
  { path: 'devices/groups', element: wrap(['device.view'], <DeviceGroupsPage />) },
  { path: 'devices/:id', element: wrap(['device.view'], <DeviceDetailPage />) },
];

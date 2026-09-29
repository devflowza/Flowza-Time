import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/devices.json';
import ar from '@/locales/ar/devices.json';
import { DeviceDetailPage, DeviceGroupsPage, DeviceNewPage, DevicesListPage, PageFallback } from './pages/lazy';

registerNamespace('devices', en, ar);

// the Devices & sync module (plan / platform switch): off ⇒ the pages explain it instead of calling a closed API
const wrap = (perms: Permission[], node: React.ReactNode) => <RequireModule modules={['devices']}><RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission></RequireModule>;

/** Routes for the devices feature (lazy pages, permission-gated; the server enforces permissions again). */
export const devicesRoutes: RouteObject[] = [
  { path: 'devices', element: wrap(['device.view'], <DevicesListPage />) },
  { path: 'devices/new', element: wrap(['device.create'], <DeviceNewPage />) },
  { path: 'devices/groups', element: wrap(['device.view'], <DeviceGroupsPage />) },
  // Devices & punches tabs (static segments rank above devices/:id)
  { path: 'devices/pin-mapping', element: wrap(['device.view', 'employee.view'], <DevicesListPage tab="pins" />) },
  { path: 'devices/unmapped-punches', element: wrap(['attendance.view_raw'], <DevicesListPage tab="unmapped" />) },
  { path: 'devices/punch-log', element: wrap(['attendance.view_raw'], <DevicesListPage tab="punches" />) },
  { path: 'devices/:id', element: wrap(['device.view'], <DeviceDetailPage />) },
];

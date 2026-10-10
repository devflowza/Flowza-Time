import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const DevicesListPage = lazyPage(() => import('./devices-list-page'));
export const DeviceNewPage = lazyPage(() => import('./device-new-page'));
export const DeviceDetailPage = lazyPage(() => import('./device-detail-page'));
export const DeviceGroupsPage = lazyPage(() => import('./device-groups-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const DevicesListPage = lazy(() => import('./devices-list-page'));
export const DeviceNewPage = lazy(() => import('./device-new-page'));
export const DeviceDetailPage = lazy(() => import('./device-detail-page'));
export const DeviceGroupsPage = lazy(() => import('./device-groups-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

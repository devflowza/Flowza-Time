import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const PortalHomePage = lazy(() => import('./home-page'));
export const MyAttendancePage = lazy(() => import('./attendance-page'));
export const MyLeavePage = lazy(() => import('./leave-page'));
export const MyProfilePage = lazy(() => import('./profile-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const PortalHomePage = lazy(() => import('./home-page'));
export const MyAttendancePage = lazy(() => import('./attendance-page'));
export const MyLeavePage = lazy(() => import('./leave-page'));
export const MyProfilePage = lazy(() => import('./profile-page'));
// HR portal Prompt 4: check-in / out, my requests, my shift
export const CheckInPage = lazy(() => import('./checkin-page'));
export const MyRequestsPage = lazy(() => import('./requests-page'));
export const MyShiftPage = lazy(() => import('./shift-page'));
// reports about the employee sent to them (each employee receives their own copy)
export const MyReportsPage = lazy(() => import('./reports-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

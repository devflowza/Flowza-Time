import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const PortalHomePage = lazyPage(() => import('./home-page'));
export const MyAttendancePage = lazyPage(() => import('./attendance-page'));
export const MyLeavePage = lazyPage(() => import('./leave-page'));
export const MyProfilePage = lazyPage(() => import('./profile-page'));
// HR portal Prompt 4: check-in / out, my requests, my shift
export const CheckInPage = lazyPage(() => import('./checkin-page'));
export const MyRequestsPage = lazyPage(() => import('./requests-page'));
export const MyShiftPage = lazyPage(() => import('./shift-page'));
// reports about the employee sent to them (each employee receives their own copy)
export const MyReportsPage = lazyPage(() => import('./reports-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

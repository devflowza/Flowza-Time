import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const SettingsLayout = lazy(() => import('./settings-layout'));
export const GeneralSection = lazy(() => import('../sections/general-section'));
export const RegionalSection = lazy(() => import('../sections/regional-section'));
export const AttendanceSection = lazy(() => import('../sections/attendance-section'));
export const SyncSection = lazy(() => import('../sections/sync-section'));
export const NotificationsSection = lazy(() => import('../sections/notifications-section'));
export const SecuritySection = lazy(() => import('../sections/security-section'));
export const SubscriptionSection = lazy(() => import('../sections/subscription-section'));
export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }
export function SectionFallback() { return <div className="space-y-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-40 w-full" /></div>; }

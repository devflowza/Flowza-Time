import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const SettingsLayout = lazyPage(() => import('./settings-layout'));
export const GeneralSection = lazyPage(() => import('../sections/general-section'));
export const DashboardSection = lazyPage(() => import('../sections/dashboard-section'));
export const RegionalSection = lazyPage(() => import('../sections/regional-section'));
export const AttendanceSection = lazyPage(() => import('../sections/attendance-section'));
export const SyncSection = lazyPage(() => import('../sections/sync-section'));
export const IntegrationsSection = lazyPage(() => import('../sections/integrations-section'));
export const ReportsSection = lazyPage(() => import('../sections/reports-section'));
export const NotificationsSection = lazyPage(() => import('../sections/notifications-section'));
export const SecuritySection = lazyPage(() => import('../sections/security-section'));
export const SubscriptionSection = lazyPage(() => import('../sections/subscription-section'));
export const LeaveSection = lazyPage(() => import('../sections/leave-section'));
export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }
export function SectionFallback() { return <div className="space-y-3"><Skeleton className="h-6 w-48" /><Skeleton className="h-40 w-full" /></div>; }

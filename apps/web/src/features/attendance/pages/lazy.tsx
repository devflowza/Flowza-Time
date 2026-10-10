import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const AttendancePage = lazyPage(() => import('./attendance-page'));
export const AttendanceSummaryPage = lazyPage(() => import('./summary-page'));
export const UnmatchedPunchesPage = lazyPage(() => import('./unmatched-page'));
export const AttendancePrintPage = lazyPage(() => import('./print-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

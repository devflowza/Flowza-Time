import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const LeavePage = lazy(() => import('./leave-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

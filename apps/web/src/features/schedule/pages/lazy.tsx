import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const ShiftsPage = lazyPage(() => import('./shifts-page'));
export const HolidaysPage = lazyPage(() => import('./holidays-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

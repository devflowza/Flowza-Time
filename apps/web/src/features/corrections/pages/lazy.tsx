import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const CorrectionsPage = lazyPage(() => import('./corrections-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

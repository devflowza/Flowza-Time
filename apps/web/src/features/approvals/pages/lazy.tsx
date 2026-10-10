import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const ApprovalsPage = lazyPage(() => import('./approvals-page'));
export const WorkflowsPage = lazyPage(() => import('./workflows-page'));
export const DelegationsPage = lazyPage(() => import('./delegations-page'));
export const ApprovalRequestPage = lazyPage(() => import('./request-page'));
export const EmailActionPage = lazyPage(() => import('./email-action-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

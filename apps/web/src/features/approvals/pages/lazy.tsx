import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const ApprovalsPage = lazy(() => import('./approvals-page'));
export const WorkflowsPage = lazy(() => import('./workflows-page'));
export const DelegationsPage = lazy(() => import('./delegations-page'));
export const ApprovalRequestPage = lazy(() => import('./request-page'));
export const EmailActionPage = lazy(() => import('./email-action-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { ApprovalsPage, PageFallback, WorkflowsPage } from './pages/lazy';

registerNamespace('approvals', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the approvals feature: inbox (/approvals) and workflow editor (/approvals/workflows). */
export const approvalsRoutes: RouteObject[] = [
  { path: 'approvals', element: wrap(['attendance.approve'], <ApprovalsPage />) },
  { path: 'approvals/workflows', element: wrap(['attendance.view'], <WorkflowsPage />) },
];

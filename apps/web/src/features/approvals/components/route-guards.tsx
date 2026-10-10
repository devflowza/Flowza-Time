import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import { useCan } from '@/features/me/use-me';
import { useApprovalAccess } from '../api';
import { ApprovalsPage, PageFallback, WorkflowsPage } from '../pages/lazy';

/** Guard by a predicate (any of several keys, or line-manager status) — RequirePermission requires all of its keys. */
export function RequireAccess({ allowed, children }: { allowed: boolean; children: React.ReactNode }) {
  const { t } = useTranslation();
  if (!allowed) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

/**
 * /approvals: every active member of the organisation (review P1-6). The API scopes each row, so a delegate, a named
 * approver or an escalated approver who holds no approve key reaches the requests waiting for them, and anybody reaches
 * "My requests".
 */
export function InboxRoute() {
  const access = useApprovalAccess();
  return <RequireAccess allowed={access.inbox}><ApprovalsPage /></RequireAccess>;
}
// the guards hide the lazy pages from the route tree, so they carry the pages' preload (lib/route-preload.ts)
InboxRoute.preload = ApprovalsPage.preload;

/** /approvals/workflows: readable by whoever reads approvals organisation-wide; editing needs approval.manage. */
export function WorkflowsRoute() {
  const can = useCan();
  const access = useApprovalAccess();
  return <RequireAccess allowed={access.configure || can('attendance.view') || can('leave.view')}><WorkflowsPage /></RequireAccess>;
}
WorkflowsRoute.preload = WorkflowsPage.preload;

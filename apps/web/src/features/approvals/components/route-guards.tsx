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

/** /approvals: approvers (any approve key or approval.manage) and line managers. */
export function InboxRoute() {
  const access = useApprovalAccess();
  return <RequireAccess allowed={access.inbox}><ApprovalsPage /></RequireAccess>;
}

/** /approvals/workflows: readable by whoever reads approvals organisation-wide; editing needs approval.manage. */
export function WorkflowsRoute() {
  const can = useCan();
  const access = useApprovalAccess();
  return <RequireAccess allowed={access.configure || can('attendance.view') || can('leave.view')}><WorkflowsPage /></RequireAccess>;
}

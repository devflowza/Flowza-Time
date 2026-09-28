import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/approvals.json';
import ar from '@/locales/ar/approvals.json';
import { InboxRoute, RequireAccess, WorkflowsRoute } from './components/route-guards';
import { ApprovalRequestPage, DelegationsPage, EmailActionPage } from './pages/lazy';

registerNamespace('approvals', en, ar);

/**
 * Approvals (engine v2): the inbox for approvers and line managers; workflows for their readers (editing needs
 * approval.manage); delegations, one request and the e-mail landing page for every member — the API decides what each
 * of them may see or do.
 */
export const approvalsRoutes: RouteObject[] = [
  { path: 'approvals', element: <InboxRoute /> },
  { path: 'approvals/workflows', element: <WorkflowsRoute /> },
  { path: 'approvals/delegations', element: <RequireAccess allowed><DelegationsPage /></RequireAccess> },
  { path: 'approvals/requests/:id', element: <RequireAccess allowed><ApprovalRequestPage /></RequireAccess> },
  { path: 'approvals/email-action', element: <RequireAccess allowed><EmailActionPage /></RequireAccess> },
];

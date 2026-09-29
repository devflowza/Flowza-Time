import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/app-shell';
import { RequireAuth } from '@/components/layout/protected-route';
import { SignInPage } from '@/features/auth/sign-in-page';
import { SignUpPage } from '@/features/auth/sign-up-page';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/forgot-password-page';
import { AcceptInvitationPage } from '@/features/auth/accept-invitation-page';
import { MfaRequiredGate } from '@/features/auth/mfa-required-gate';
import { NotificationsPage } from '@/features/notifications/notifications-page';
import { EmptyState, Skeleton } from '@/components/ui';
import { FileQuestion } from 'lucide-react';
import { featureRoutes } from '@/features/routes';
import { useCan, useEmployeeId } from '@/features/me/use-me';
import { admRoutes } from '@/features/adm/routes';
import { UnlinkedHome } from '@/components/layout/unlinked-home';

function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }
function NotFound() {
  const { t } = useTranslation();
  return <div className="page-container"><EmptyState icon={FileQuestion} title={t('common.notFound')} description={t('common.notFoundHint')} /></div>;
}
function ComingSoonPage() {
  const { t } = useTranslation();
  return <div className="page-container"><EmptyState title={t('common.comingSoon')} /></div>;
}
const ComingSoon = lazy(async () => ({ default: ComingSoonPage }));
// Lazy like every other page: the dashboard carries the charts vendor chunk, which the shell itself never needs.
const DashboardPage = lazy(() => import('@/features/dashboard/dashboard-page'));
// Notifications review 8-P1-4: the member's own notification preferences, on a page every active member can open.
const AccountNotificationsPage = lazy(() => import('@/features/notifications/account-notifications-page'));

/**
 * Enrolment reachable on a valid session alone, without the shell and without `/me`.
 *
 * AppShell renders the same gate automatically on a 403 `MFA_REQUIRED`, which is the normal path. This route is the
 * one that survives the API being unreachable: enrolment and verification talk only to Supabase Auth, so a platform
 * admin can still reach `aal2` while the API is down instead of being stuck behind an error screen.
 */
function MfaSetupRoute() {
  const navigate = useNavigate();
  return <MfaRequiredGate onVerified={() => void navigate('/', { replace: true })} />;
}

/** `/`: the dashboard, or the self-service overview for a member who has no dashboard but is an employee. */
function HomeRoute() {
  const can = useCan();
  const employeeId = useEmployeeId();
  if (!can('dashboard.view')) return employeeId ? <Navigate to="/my" replace /> : <UnlinkedHome />;
  return <Suspense fallback={<PageFallback />}><DashboardPage /></Suspense>;
}

export const router = createBrowserRouter([
  { path: '/auth/sign-in', element: <SignInPage /> },
  { path: '/auth/sign-up', element: <SignUpPage /> },
  { path: '/auth/forgot', element: <ForgotPasswordPage /> },
  { path: '/auth/reset', element: <ResetPasswordPage /> },
  // Public on purpose: the invitee has no account yet, so this cannot sit behind RequireAuth.
  { path: '/auth/invite', element: <AcceptInvitationPage /> },
  { path: '/auth/callback', element: <Navigate to="/" replace /> },
  // the super-admin portal: own sign-in (/adm/login) and shell, outside the tenant AppShell
  ...admRoutes,
  {
    element: <RequireAuth />,
    children: [
      { path: 'auth/mfa', element: <MfaSetupRoute /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRoute /> },
          { path: 'notifications', element: <NotificationsPage /> },
          // membership only (no permission, no employee link): the e-mail footer of a member without an employee link lands here
          { path: 'account/notifications', element: <Suspense fallback={<PageFallback />}><AccountNotificationsPage /></Suspense> },
          ...featureRoutes,
          { path: '*', element: <Suspense fallback={<PageFallback />}><Outlet /><NotFound /></Suspense> },
        ],
      },
    ],
  },
]);
export { ComingSoon, PageFallback };

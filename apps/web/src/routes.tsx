import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/app-shell';
import { RequireAuth } from '@/components/layout/protected-route';
import { SignInPage } from '@/features/auth/sign-in-page';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/forgot-password-page';
import { MfaRequiredGate } from '@/features/auth/mfa-required-gate';
import { DashboardPage } from '@/features/dashboard/dashboard-page';
import { NotificationsPage } from '@/features/notifications/notifications-page';
import { EmptyState, Skeleton } from '@/components/ui';
import { FileQuestion } from 'lucide-react';
import { featureRoutes } from '@/features/routes';

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

export const router = createBrowserRouter([
  { path: '/auth/sign-in', element: <SignInPage /> },
  { path: '/auth/forgot', element: <ForgotPasswordPage /> },
  { path: '/auth/reset', element: <ResetPasswordPage /> },
  { path: '/auth/callback', element: <Navigate to="/" replace /> },
  {
    element: <RequireAuth />,
    children: [
      { path: 'auth/mfa', element: <MfaSetupRoute /> },
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'notifications', element: <NotificationsPage /> },
          ...featureRoutes,
          { path: '*', element: <Suspense fallback={<PageFallback />}><Outlet /><NotFound /></Suspense> },
        ],
      },
    ],
  },
]);
export { ComingSoon, PageFallback };

import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AppShell } from '@/components/layout/app-shell';
import { RequireAuth } from '@/components/layout/protected-route';
import { SignInPage } from '@/features/auth/sign-in-page';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/forgot-password-page';
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

export const router = createBrowserRouter([
  { path: '/auth/sign-in', element: <SignInPage /> },
  { path: '/auth/forgot', element: <ForgotPasswordPage /> },
  { path: '/auth/reset', element: <ResetPasswordPage /> },
  { path: '/auth/callback', element: <Navigate to="/" replace /> },
  {
    element: <RequireAuth />,
    children: [
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

import { lazy } from 'react';
import { Navigate, useParams } from 'react-router';
import { Skeleton } from '@/components/ui';

export const AdminLoginPage = lazy(() => import('../admin-login-page'));
export const DashboardPage = lazy(() => import('./dashboard-page'));
export const TenantsPage = lazy(() => import('./tenants-page'));
export const TenantDetailPage = lazy(() => import('./tenant-detail-page'));
export const UsersPage = lazy(() => import('./users-page'));
export const TeamPage = lazy(() => import('./team-page'));
export const GrantsPage = lazy(() => import('./grants-page'));
export const PlansPage = lazy(() => import('./plans-page'));
export const FlagsPage = lazy(() => import('./flags-page'));
export const ActivityPage = lazy(() => import('./activity-page'));
export const HealthPage = lazy(() => import('./health-page'));
export const AccountPage = lazy(() => import('./account-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

/** The old in-app console (`/platform/orgs/:id`) now lives in the portal. */
export function LegacyOrgRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/adm/tenants/${id}`} replace />;
}

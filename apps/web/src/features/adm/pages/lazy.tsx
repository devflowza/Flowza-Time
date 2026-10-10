import { Navigate, useParams } from 'react-router';
import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const AdminLoginPage = lazyPage(() => import('../admin-login-page'));
export const DashboardPage = lazyPage(() => import('./dashboard-page'));
export const TenantsPage = lazyPage(() => import('./tenants-page'));
export const TenantDetailPage = lazyPage(() => import('./tenant-detail-page'));
export const UsersPage = lazyPage(() => import('./users-page'));
export const TeamPage = lazyPage(() => import('./team-page'));
export const GrantsPage = lazyPage(() => import('./grants-page'));
export const PlansPage = lazyPage(() => import('./plans-page'));
export const FlagsPage = lazyPage(() => import('./flags-page'));
export const ActivityPage = lazyPage(() => import('./activity-page'));
export const HealthPage = lazyPage(() => import('./health-page'));
export const AccountPage = lazyPage(() => import('./account-page'));
// modules, plans & pricing, billing, platform settings (migration 20260929000600)
export const ModulesPage = lazyPage(() => import('./modules-page'));
export const BillingPage = lazyPage(() => import('./billing-page'));
export const SettingsPage = lazyPage(() => import('./settings-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

/** The old in-app console (`/platform/orgs/:id`) now lives in the portal. */
export function LegacyOrgRedirect() {
  const { id = '' } = useParams();
  return <Navigate to={`/adm/tenants/${id}`} replace />;
}

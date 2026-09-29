import { Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import './i18n';
import { AdminGate } from './admin-gate';
import { AdminLayout } from './admin-layout';
import { AccountPage, ActivityPage, AdminLoginPage, BillingPage, DashboardPage, FlagsPage, GrantsPage, HealthPage, LegacyOrgRedirect, ModulesPage, PageFallback, PlansPage, SettingsPage, TeamPage, TenantDetailPage, TenantsPage, UsersPage } from './pages/lazy';

const s = (node: React.ReactNode) => <Suspense fallback={<PageFallback />}>{node}</Suspense>;

/**
 * The super-admin portal (Flowza Finance /adm parity): its own sign-in and shell, outside the tenant AppShell — a platform
 * administrator acts for no tenant. `AdminGate` requires a session, aal2 and `isPlatformAdmin`; the API enforces all three.
 */
export const admRoutes: RouteObject[] = [
  { path: '/adm/login', element: s(<AdminLoginPage />) },
  {
    path: '/adm',
    element: <AdminGate />,
    children: [{
      element: <AdminLayout />,
      children: [
        { index: true, element: s(<DashboardPage />) },
        { path: 'tenants', element: s(<TenantsPage />) },
        { path: 'tenants/:id', element: s(<TenantDetailPage />) },
        { path: 'users', element: s(<UsersPage />) },
        { path: 'team', element: s(<TeamPage />) },
        { path: 'grants', element: s(<GrantsPage />) },
        { path: 'plans', element: s(<PlansPage />) },
        { path: 'modules', element: s(<ModulesPage />) },
        { path: 'billing', element: s(<BillingPage />) },
        { path: 'settings', element: s(<SettingsPage />) },
        { path: 'feature-flags', element: s(<FlagsPage />) },
        { path: 'activity', element: s(<ActivityPage />) },
        { path: 'health', element: s(<HealthPage />) },
        { path: 'account', element: s(<AccountPage />) },
        { path: '*', element: <Navigate to="/adm" replace /> },
      ],
    }],
  },
  { path: '/platform', element: <Navigate to="/adm/tenants" replace /> },
  { path: '/platform/orgs/:id', element: <LegacyOrgRedirect /> },
];

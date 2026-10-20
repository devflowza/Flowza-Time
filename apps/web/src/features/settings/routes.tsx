import { Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/settings.json';
import ar from '@/locales/ar/settings.json';
import { ApprovalsSection, AttendanceSection, DashboardSection, GeneralSection, HrmsSection, IntegrationsSection, LeaveSection, NotificationsSection, PageFallback, RegionalSection, ReportsSection, SectionFallback, SecuritySection, SettingsLayout, SubscriptionSection, SyncSection } from './pages/lazy';

registerNamespace('settings', en, ar);

const section = (node: React.ReactNode) => <Suspense fallback={<SectionFallback />}>{node}</Suspense>;

/** Routes for the settings feature: /settings/<general|dashboard|regional|attendance|sync|integrations|hrms|reports|notifications|security|subscription|leave|approvals> */
export const settingsRoutes: RouteObject[] = [
  {
    path: 'settings',
    element: <RequirePermission permissions={['organization.view']}><Suspense fallback={<PageFallback />}><SettingsLayout /></Suspense></RequirePermission>,
    children: [
      { index: true, element: <Navigate to="/settings/general" replace /> },
      { path: 'general', element: section(<GeneralSection />) },
      { path: 'dashboard', element: section(<DashboardSection />) },
      { path: 'regional', element: section(<RegionalSection />) },
      { path: 'attendance', element: section(<AttendanceSection />) },
      { path: 'sync', element: section(<SyncSection />) },
      // Flowza Finance connector: its own permission (the connector is platform plumbing, delegated independently of organization.manage)
      { path: 'integrations', element: <RequireModule modules={['finance_integration']}><RequirePermission permissions={['integration.manage']}>{section(<IntegrationsSection />)}</RequirePermission></RequireModule> },
      // HR system feed (Mawred Plus or any HRMS): API keys + field mapping, integration.manage (no module)
      { path: 'hrms', element: <RequirePermission permissions={['integration.manage']}>{section(<HrmsSection />)}</RequirePermission> },
      { path: 'reports', element: section(<ReportsSection />) },
      { path: 'notifications', element: section(<NotificationsSection />) },
      { path: 'security', element: section(<SecuritySection />) },
      { path: 'subscription', element: section(<SubscriptionSection />) },
      { path: 'leave', element: section(<LeaveSection />) },
      { path: 'approvals', element: section(<ApprovalsSection />) },
    ],
  },
];

import { Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/settings.json';
import ar from '@/locales/ar/settings.json';
import { AttendanceSection, GeneralSection, NotificationsSection, PageFallback, RegionalSection, SectionFallback, SecuritySection, SettingsLayout, SubscriptionSection, SyncSection } from './pages/lazy';

registerNamespace('settings', en, ar);

const section = (node: React.ReactNode) => <Suspense fallback={<SectionFallback />}>{node}</Suspense>;

/** Routes for the settings feature: /settings/<general|regional|attendance|sync|notifications|security|subscription> */
export const settingsRoutes: RouteObject[] = [
  {
    path: 'settings',
    element: <RequirePermission permissions={['organization.view']}><Suspense fallback={<PageFallback />}><SettingsLayout /></Suspense></RequirePermission>,
    children: [
      { index: true, element: <Navigate to="/settings/general" replace /> },
      { path: 'general', element: section(<GeneralSection />) },
      { path: 'regional', element: section(<RegionalSection />) },
      { path: 'attendance', element: section(<AttendanceSection />) },
      { path: 'sync', element: section(<SyncSection />) },
      { path: 'notifications', element: section(<NotificationsSection />) },
      { path: 'security', element: section(<SecuritySection />) },
      { path: 'subscription', element: section(<SubscriptionSection />) },
    ],
  },
];

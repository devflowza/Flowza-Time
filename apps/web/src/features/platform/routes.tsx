import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/platform.json';
import ar from '@/locales/ar/platform.json';
import { RequirePlatformAdmin } from './require-platform-admin';
import { PageFallback, PlatformOrgPage, PlatformPage } from './pages/lazy';

registerNamespace('platform', en, ar);

const wrap = (node: React.ReactNode) => <RequirePlatformAdmin><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePlatformAdmin>;

/** Routes for the platform-admin feature (only rendered for platform administrators; the API enforces it again). */
export const platformRoutes: RouteObject[] = [
  { path: 'platform', element: wrap(<PlatformPage />) },
  { path: 'platform/orgs/:id', element: wrap(<PlatformOrgPage />) },
];

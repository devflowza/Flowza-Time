import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequireModule, RequirePermission } from '@/components/layout/protected-route';
import './i18n';
import { MeetingsPage, PageFallback } from './pages/lazy';

/**
 * Meeting rooms & access (Enterprise, module meeting_rooms — docs/time-away.md §4): /meetings?tab=meetings|rooms|access. The
 * guards wrap the lazy page directly, so the sidebar's preload finds it in the route tree (lib/route-preload.ts).
 */
export const meetingsRoutes: RouteObject[] = [
  { path: 'meetings', element: <RequireModule modules={['meeting_rooms']}><RequirePermission permissions={['meeting.view']}><Suspense fallback={<PageFallback />}><MeetingsPage /></Suspense></RequirePermission></RequireModule> },
];

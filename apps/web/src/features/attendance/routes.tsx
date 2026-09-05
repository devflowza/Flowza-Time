import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { AttendancePage, PageFallback } from './pages/lazy';

registerNamespace('attendance', en, ar);

/** Routes for the attendance feature: /attendance?tab=daily|monthly|raw|recalc|periods (attendance.view_own users see their own rows). */
export const attendanceRoutes: RouteObject[] = [
  { path: 'attendance', element: <RequirePermission permissions={['attendance.view']}><Suspense fallback={<PageFallback />}><AttendancePage /></Suspense></RequirePermission> },
];

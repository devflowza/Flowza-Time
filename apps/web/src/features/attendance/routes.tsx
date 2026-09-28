import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/attendance.json';
import ar from '@/locales/ar/attendance.json';
import { AttendancePage, AttendancePrintPage, AttendanceSummaryPage, PageFallback, UnmatchedPunchesPage } from './pages/lazy';

registerNamespace('attendance', en, ar);

/** Routes for the attendance feature: /attendance?tab=daily|monthly|raw|recalc|periods (attendance.view_own users see their own rows). */
export const attendanceRoutes: RouteObject[] = [
  { path: 'attendance', element: <RequirePermission permissions={['attendance.view']} selfServiceTo="/my/attendance"><Suspense fallback={<PageFallback />}><AttendancePage /></Suspense></RequirePermission> },
  // HR attendance workspace (HR portal Prompt 6a): the monthly summary (org-wide or a manager's team), unmatched-punch triage, print view
  { path: 'attendance/summary', element: <RequirePermission permissions={['attendance.view', 'attendance.view_team']} any><Suspense fallback={<PageFallback />}><AttendanceSummaryPage /></Suspense></RequirePermission> },
  { path: 'attendance/unmatched', element: <RequirePermission permissions={['attendance.view_raw']}><Suspense fallback={<PageFallback />}><UnmatchedPunchesPage /></Suspense></RequirePermission> },
  { path: 'attendance/print', element: <RequirePermission permissions={['attendance.view', 'attendance.view_team']} any><Suspense fallback={<PageFallback />}><AttendancePrintPage /></Suspense></RequirePermission> },
];

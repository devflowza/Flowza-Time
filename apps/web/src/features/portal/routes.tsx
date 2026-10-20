import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/portal.json';
import ar from '@/locales/ar/portal.json';
import attendanceEn from '@/locales/en/attendance.json';
import attendanceAr from '@/locales/ar/attendance.json';
import leaveEn from '@/locales/en/leave.json';
import leaveAr from '@/locales/ar/leave.json';
import employeesEn from '@/locales/en/employees.json';
import employeesAr from '@/locales/ar/employees.json';
import type { ModuleKey } from '@flowza/contracts';
import { RequireModule } from '@/components/layout/protected-route';
import { RequireEmployeeLink, RequirePortalAccess } from './components/parts';
import type { PortalPage } from './access';
import { MyAttendancePage, MyLeavePage, MyProfilePage, PageFallback, PortalHomePage } from './pages/lazy';
import { CheckInPage, MyReportsPage, MyRequestsPage, MyShiftPage } from './pages/lazy';
import './attendance-i18n';

registerNamespace('portal', en, ar);
// the portal reuses the attendance badges / record dialog, the leave labels and the employee activity view
registerNamespace('attendance', attendanceEn, attendanceAr);
registerNamespace('leave', leaveEn, leaveAr);
registerNamespace('employees', employeesEn, employeesAr);

// the self-service portal module, plus the module of the page itself (leave, web check-in) — migration 20260929000600 — and
// the keys the page's own endpoints admit (access.ts): a role without them gets "permission denied", not a failing page
const page = (node: React.ReactNode, extra: ModuleKey[] = [], access?: PortalPage) => <RequireModule modules={['self_service', ...extra]}><RequireEmployeeLink><RequirePortalAccess page={access}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePortalAccess></RequireEmployeeLink></RequireModule>;

/**
 * Employee self-service: /my (overview), /my/attendance, /my/leave, /my/profile. Available to every member whose
 * membership is linked to an employee record; the API scopes every call to that record. The overview and the profile need
 * the link only; every other page also needs the keys its endpoints admit (access.ts).
 */
export const portalRoutes: RouteObject[] = [
  { path: 'my', element: page(<PortalHomePage />) },
  { path: 'my/attendance', element: page(<MyAttendancePage />, [], 'attendance') },
  { path: 'my/leave', element: page(<MyLeavePage />, ['leave'], 'leave') },
  { path: 'my/profile', element: page(<MyProfilePage />) },
  // HR portal Prompt 4: check-in / out (geofence, selfie, offline queue), requests (reasons, regularisations, swaps, selfies), shift
  { path: 'my/checkin', element: page(<CheckInPage />, ['geofences'], 'checkin') },
  { path: 'my/requests', element: page(<MyRequestsPage />, [], 'requests') },
  { path: 'my/shift', element: page(<MyShiftPage />, [], 'shift') },
  // reports about the employee that HR / a manager sent them — viewed and downloaded through their own session
  { path: 'my/reports', element: page(<MyReportsPage />, [], 'reports') },
];

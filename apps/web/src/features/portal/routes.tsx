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
import { RequireEmployeeLink } from './components/parts';
import { MyAttendancePage, MyLeavePage, MyProfilePage, PageFallback, PortalHomePage } from './pages/lazy';
import { CheckInPage, MyRequestsPage, MyShiftPage } from './pages/lazy';
import './attendance-i18n';

registerNamespace('portal', en, ar);
// the portal reuses the attendance badges / record dialog, the leave labels and the employee activity view
registerNamespace('attendance', attendanceEn, attendanceAr);
registerNamespace('leave', leaveEn, leaveAr);
registerNamespace('employees', employeesEn, employeesAr);

// the self-service portal module, plus the module of the page itself (leave, web check-in) — migration 20260929000600
const page = (node: React.ReactNode, extra: ModuleKey[] = []) => <RequireModule modules={['self_service', ...extra]}><RequireEmployeeLink><Suspense fallback={<PageFallback />}>{node}</Suspense></RequireEmployeeLink></RequireModule>;

/**
 * Employee self-service: /my (overview), /my/attendance, /my/leave, /my/profile. Available to every member whose
 * membership is linked to an employee record; the API scopes every call to that record.
 */
export const portalRoutes: RouteObject[] = [
  { path: 'my', element: page(<PortalHomePage />) },
  { path: 'my/attendance', element: page(<MyAttendancePage />) },
  { path: 'my/leave', element: page(<MyLeavePage />, ['leave']) },
  { path: 'my/profile', element: page(<MyProfilePage />) },
  // HR portal Prompt 4: check-in / out (geofence, selfie, offline queue), requests (reasons, regularisations, swaps, selfies), shift
  { path: 'my/checkin', element: page(<CheckInPage />, ['geofences']) },
  { path: 'my/requests', element: page(<MyRequestsPage />) },
  { path: 'my/shift', element: page(<MyShiftPage />) },
];

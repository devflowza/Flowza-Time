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
import { RequireEmployeeLink } from './components/parts';
import { MyAttendancePage, MyLeavePage, MyProfilePage, PageFallback, PortalHomePage } from './pages/lazy';

registerNamespace('portal', en, ar);
// the portal reuses the attendance badges / record dialog, the leave labels and the employee activity view
registerNamespace('attendance', attendanceEn, attendanceAr);
registerNamespace('leave', leaveEn, leaveAr);
registerNamespace('employees', employeesEn, employeesAr);

const page = (node: React.ReactNode) => <RequireEmployeeLink><Suspense fallback={<PageFallback />}>{node}</Suspense></RequireEmployeeLink>;

/**
 * Employee self-service: /my (overview), /my/attendance, /my/leave, /my/profile. Available to every member whose
 * membership is linked to an employee record; the API scopes every call to that record.
 */
export const portalRoutes: RouteObject[] = [
  { path: 'my', element: page(<PortalHomePage />) },
  { path: 'my/attendance', element: page(<MyAttendancePage />) },
  { path: 'my/leave', element: page(<MyLeavePage />) },
  { path: 'my/profile', element: page(<MyProfilePage />) },
];

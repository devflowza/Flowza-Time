import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import attendanceEn from '@/locales/en/attendance.json';
import attendanceAr from '@/locales/ar/attendance.json';
import './i18n';
import { RegularisationsRoute } from './components/route-guards';

// the register reuses the attendance badges and labels
registerNamespace('attendance', attendanceEn, attendanceAr);

/**
 * HR portal Prompt 6b — HR attendance administration: /attendance/regularisations (the regularisation register). The comments &
 * approvals report is a tab of /attendance/notes. Static segment, so it wins over any `attendance/:param` route.
 */
export const attendanceAdminRoutes: RouteObject[] = [
  { path: 'attendance/regularisations', element: <RegularisationsRoute /> },
];

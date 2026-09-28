import type { RouteObject } from 'react-router';
import { registerNamespace } from '@/lib/i18n-namespace';
import attendanceEn from '@/locales/en/attendance.json';
import attendanceAr from '@/locales/ar/attendance.json';
import './i18n';
import { GeofencesRoute, NotesRoute } from './components/route-guards';

// the review pages reuse the attendance badges (status / flags)
registerNamespace('attendance', attendanceEn, attendanceAr);

/**
 * HR portal Prompt 4 — manager / HR review surfaces: /attendance/notes?tab=reasons|selfies (reasons employees gave for their
 * days, selfie check-ins) and /attendance/geofences. Static segments, so they win over any `attendance/:param` route.
 */
export const attendanceReviewRoutes: RouteObject[] = [
  { path: 'attendance/notes', element: <NotesRoute /> },
  { path: 'attendance/geofences', element: <GeofencesRoute /> },
];

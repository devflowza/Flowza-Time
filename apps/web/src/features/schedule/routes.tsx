import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/schedule.json';
import ar from '@/locales/ar/schedule.json';
import { HolidaysPage, PageFallback, ShiftsPage } from './pages/lazy';

registerNamespace('schedule', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the schedule feature: /shifts (shifts, patterns, assignments, rule sets) and /holidays. */
export const scheduleRoutes: RouteObject[] = [
  { path: 'shifts', element: wrap(['shift.view'], <ShiftsPage />) },
  { path: 'holidays', element: wrap(['holiday.view'], <HolidaysPage />) },
];

import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/employees.json';
import ar from '@/locales/ar/employees.json';
import { EmployeeImportPage, EmployeeNewPage, EmployeeProfilePage, EmployeesListPage, PageFallback } from './pages/lazy';

registerNamespace('employees', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the employees feature (lazy pages, permission-gated; the server enforces permissions again). */
export const employeesRoutes: RouteObject[] = [
  { path: 'employees', element: wrap(['employee.view'], <EmployeesListPage />) },
  { path: 'employees/new', element: wrap(['employee.create'], <EmployeeNewPage />) },
  { path: 'employees/import', element: wrap(['employee.import'], <EmployeeImportPage />) },
  { path: 'employees/:id', element: wrap(['employee.view'], <EmployeeProfilePage />) },
];

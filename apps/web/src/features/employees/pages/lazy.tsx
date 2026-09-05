import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const EmployeesListPage = lazy(() => import('./employees-list-page'));
export const EmployeeNewPage = lazy(() => import('./employee-new-page'));
export const EmployeeImportPage = lazy(() => import('./employee-import-page'));
export const EmployeeProfilePage = lazy(() => import('./employee-profile-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

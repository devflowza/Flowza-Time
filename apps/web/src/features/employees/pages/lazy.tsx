import { Skeleton } from '@/components/ui';
import { lazyPage } from '@/lib/lazy-page';

export const EmployeesListPage = lazyPage(() => import('./employees-list-page'));
export const EmployeeNewPage = lazyPage(() => import('./employee-new-page'));
export const EmployeeImportPage = lazyPage(() => import('./employee-import-page'));
export const EmployeeProfilePage = lazyPage(() => import('./employee-profile-page'));

export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

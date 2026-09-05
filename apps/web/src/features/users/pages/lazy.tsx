import { lazy } from 'react';
import { Skeleton } from '@/components/ui';

export const UsersPage = lazy(() => import('./users-page'));
export const RoleEditorPage = lazy(() => import('./role-editor-page'));
export function PageFallback() { return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>; }

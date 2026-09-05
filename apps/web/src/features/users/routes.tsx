import { Suspense } from 'react';
import type { RouteObject } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { RequirePermission } from '@/components/layout/protected-route';
import { registerNamespace } from '@/lib/i18n-namespace';
import en from '@/locales/en/users.json';
import ar from '@/locales/ar/users.json';
import { PageFallback, RoleEditorPage, UsersPage } from './pages/lazy';

registerNamespace('users', en, ar);

const wrap = (perms: Permission[], node: React.ReactNode) => <RequirePermission permissions={perms}><Suspense fallback={<PageFallback />}>{node}</Suspense></RequirePermission>;

/** Routes for the users feature: members, invitations, roles and the role editor. */
export const usersRoutes: RouteObject[] = [
  { path: 'users', element: wrap(['user.view'], <UsersPage />) },
  { path: 'users/roles/:id', element: wrap(['user.view'], <RoleEditorPage />) },
];

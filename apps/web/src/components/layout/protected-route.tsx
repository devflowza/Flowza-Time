import { Navigate, Outlet, useLocation } from 'react-router';
import type { ModuleKey, Permission } from '@flowza/contracts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/auth-provider';
import { useCan, useEmployeeId, useModulesEnabled } from '@/features/me/use-me';
import { EmptyState } from '@/components/ui';
import { PackageX, ShieldOff } from 'lucide-react';

export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!session) return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/**
 * `selfServiceTo`: where a member without the permission but linked to an employee record goes instead — the
 * self-service page for the same thing (e.g. /attendance → /my/attendance), so links in notifications keep working.
 * `any`: one of the permissions is enough (e.g. an employee profile opens with `employee.view` or `employee.view_team`;
 * the API and RLS decide which records each key reveals). Default: every permission is required.
 */
export function RequirePermission({ permissions, children, selfServiceTo, any = false }: { permissions: Permission[]; children: React.ReactNode; selfServiceTo?: string; any?: boolean }) {
  const { t } = useTranslation();
  const can = useCan();
  const employeeId = useEmployeeId();
  const allowed = any ? permissions.some((p) => can(p)) : can(...permissions);
  if (!allowed && selfServiceTo && employeeId) return <Navigate to={selfServiceTo} replace />;
  if (!allowed) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <>{children}</>;
}

/**
 * A module the organisation does not have (plan, platform switch or lapsed subscription — migration 20260929000600): the
 * page explains it instead of rendering screens whose every request the API would refuse with MODULE_DISABLED.
 */
export function RequireModule({ modules, children }: { modules: ModuleKey[]; children: React.ReactNode }) {
  const { t } = useTranslation();
  const enabled = useModulesEnabled();
  if (!enabled(...modules)) {
    const names = modules.map((m) => t(`modules.${m}.name`)).join(', ');
    return <div className="page-container"><EmptyState icon={PackageX} title={t('modules.disabledTitle', { names })} description={t('modules.disabledHint')} /></div>;
  }
  return <>{children}</>;
}

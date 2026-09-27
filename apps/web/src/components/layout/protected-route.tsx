import { Navigate, Outlet, useLocation } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/auth-provider';
import { useCan, useEmployeeId } from '@/features/me/use-me';
import { EmptyState } from '@/components/ui';
import { ShieldOff } from 'lucide-react';

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
 */
export function RequirePermission({ permissions, children, selfServiceTo }: { permissions: Permission[]; children: React.ReactNode; selfServiceTo?: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const employeeId = useEmployeeId();
  if (!can(...permissions) && selfServiceTo && employeeId) return <Navigate to={selfServiceTo} replace />;
  if (!can(...permissions)) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <>{children}</>;
}

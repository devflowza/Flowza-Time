import { Navigate, Outlet, useLocation } from 'react-router';
import type { Permission } from '@flowza/contracts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/auth-provider';
import { useCan } from '@/features/me/use-me';
import { EmptyState } from '@/components/ui';
import { ShieldOff } from 'lucide-react';

export function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!session) return <Navigate to="/auth/sign-in" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

export function RequirePermission({ permissions, children }: { permissions: Permission[]; children: React.ReactNode }) {
  const { t } = useTranslation();
  const can = useCan();
  if (!can(...permissions)) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <>{children}</>;
}

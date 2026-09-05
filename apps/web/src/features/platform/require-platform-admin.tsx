import { ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState, Skeleton } from '@/components/ui';
import { useMe } from '@/features/me/use-me';

/** Platform pages are only rendered for platform administrators (`me.user.isPlatformAdmin`); the API re-checks on every call. */
export function RequirePlatformAdmin({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isLoading) return <div className="page-container space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>;
  if (!me.data?.user.isPlatformAdmin) return <div className="page-container"><EmptyState icon={ShieldOff} title={t('common.permissionDenied')} /></div>;
  return <>{children}</>;
}

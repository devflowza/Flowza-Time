import { Navigate, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '@/features/auth/auth-provider';
import { useMe } from '@/features/me/use-me';
import { MfaRequiredGate } from '@/features/auth/mfa-required-gate';
import { isMfaRequiredError } from '@/lib/api-client';
import { supabase } from '@/lib/supabase';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';

function GateSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-64 bg-slate-950 md:block" />
      <div className="flex-1 space-y-4 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
    </div>
  );
}

/**
 * Everything under /adm (except the sign-in): a session, then `aal2` (the API refuses platform admins below it, so /me
 * answering MFA_REQUIRED routes to enrolment / verification), then `isPlatformAdmin`. The API re-checks every call —
 * this gate only decides what to render.
 */
export function AdminGate() {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { session, loading } = useAuth();
  const location = useLocation();
  const me = useMe();
  if (loading) return <GateSkeleton />;
  if (!session) return <Navigate to="/adm/login" replace state={{ from: location.pathname + location.search }} />;
  if (me.isError && isMfaRequiredError(me.error)) return <MfaRequiredGate onVerified={() => void me.refetch()} />;
  if (me.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        <Button variant="ghost" size="sm" onClick={() => void supabase.auth.signOut()}>{t('nav.signOut')}</Button>
      </div>
    );
  }
  if (!me.data) return <GateSkeleton />;
  if (!me.data.user.isPlatformAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <EmptyState icon={ShieldOff} title={t('gate.notAdminTitle')} description={t('gate.notAdminHint', { email: me.data.user.email })}
          action={<div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => void supabase.auth.signOut()}>{t('gate.switchAccount')}</Button>
            {me.data.memberships.length > 0 ? <Button variant="outline" asChild><a href="/">{t('nav.openApp')}</a></Button> : null}
          </div>} />
        <span className="sr-only">{tc('common.permissionDenied')}</span>
      </div>
    );
  }
  return <Outlet />;
}

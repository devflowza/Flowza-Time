import { useState } from 'react';
import { Link, Navigate, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { Dialog, DialogContent } from '@/components/ui';
import { useMe } from '@/features/me/use-me';
import { isMfaRequiredError } from '@/lib/api-client';
import { MfaRequiredGate } from '@/features/auth/mfa-required-gate';
import { Skeleton } from '@/components/ui';
import { ErrorState } from '@/components/ui';
import { useAuth } from '@/features/auth/auth-provider';
import { CreateOrganizationScreen } from '@/features/auth/create-organization-screen';
import { Button } from '@/components/ui';
import { useApplyDashboardTheme } from '@/features/dashboard/theme';

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const { signOut } = useAuth();
  const [mobileNav, setMobileNav] = useState(false);
  // Before any early return: the tenant's style must be on <html> for every state the shell can render.
  useApplyDashboardTheme();

  // A platform admin is gated at aal2 on every route, so /me itself fails before the shell can render any way out.
  if (me.isError && isMfaRequiredError(me.error)) return <MfaRequiredGate onVerified={() => void me.refetch()} />;
  if (me.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        {/* /me answering is what normally routes a platform admin to the gate. When it cannot answer at all there is
            no other way in, and enrolment itself only needs Supabase Auth — so offer the door directly. */}
        <Link to="/auth/mfa" className="text-sm underline underline-offset-4">{t('auth.mfaSetUpLink')}</Link>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>{t('nav.signOut')}</Button>
      </div>
    );
  }
  // Not loading, not errored, but no data yet — the gap between retry attempts, where `isLoading` is false because
  // nothing is in flight. Falling through here renders the Outlet without a membership and useOrgId() throws.
  if (!me.data) {
    return (
      <div className="flex min-h-screen">
        <div className="hidden w-60 bg-sidebar md:block" />
        <div className="flex-1 p-8 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }
  // No membership yet: self-service onboarding (create the organisation and become its owner), or sign out and wait
  // for an invitation. This is where a sign-up that needed email confirmation finishes.
  if (me.data.memberships.length === 0 && !me.data.user.isPlatformAdmin) return <CreateOrganizationScreen />;
  // A platform admin is let through with no membership on purpose — but the index route is the org-scoped dashboard,
  // which calls useOrgId() and throws. Send them where they can actually act: the platform console. Below the guard
  // above so an ordinary member-less user still gets the onboarding screen rather than a 403 from /platform.
  if (me.data.memberships.length === 0) return <Navigate to="/platform" replace />;
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <DialogContent size="sm" className="start-0 top-0 h-full max-h-none w-72 translate-x-0 translate-y-0 rounded-none bg-sidebar p-0 text-sidebar-foreground rtl:translate-x-0 md:hidden">
          <div className="[&>aside]:flex [&>aside]:w-72" onClick={() => setMobileNav(false)}><Sidebar /></div>
        </DialogContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenMobileNav={() => setMobileNav(true)} />
        <main className="flex-1"><Outlet /></main>
      </div>
    </div>
  );
}

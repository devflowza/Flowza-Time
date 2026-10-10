import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigationType } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui';
import { useActiveMembership, useMe } from '@/features/me/use-me';
import { TriangleAlert } from 'lucide-react';
import { isMfaRequiredError } from '@/lib/api-client';
import { MfaRequiredGate } from '@/features/auth/mfa-required-gate';
import { Skeleton } from '@/components/ui';
import { ErrorState } from '@/components/ui';
import { useAuth } from '@/features/auth/auth-provider';
import { CreateOrganizationScreen } from '@/features/auth/create-organization-screen';
import { readPendingInvitation } from '@/features/auth/pending-invitation';
import { Button } from '@/components/ui';
import { useApplyDashboardTheme } from '@/features/dashboard/theme';
import { APP_SCROLL_ID, scrollPageToTop } from '@/lib/scroll';

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const { signOut } = useAuth();
  const [mobileNav, setMobileNav] = useState(false);
  // the platform expired / cancelled the subscription: only the core remains (modules, migration 20260929000600)
  const lapsed = useActiveMembership()?.subscriptionLapsed === true;
  // Before any early return: the tenant's style must be on <html> for every state the shell can render.
  useApplyDashboardTheme();
  // A new page opens at its top; Back and Forward leave the position alone.
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => { if (navigationType !== 'POP') scrollPageToTop(); }, [pathname, navigationType]);

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
      <div className="flex min-h-dvh bg-background md:h-dvh md:bg-sidebar">
        <div className="hidden w-60 md:block" />
        <div className="flex-1 md:py-2 md:pe-2">
          <div className="h-full bg-background md:rounded-2xl md:border md:border-black/[0.06] dark:md:border-white/[0.07]">
            <div className="h-14 border-b border-border/70" />
            <div className="space-y-4 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
          </div>
        </div>
      </div>
    );
  }
  // No membership yet: self-service onboarding (create the organisation and become its owner), or sign out and wait
  // for an invitation. This is where a sign-up that needed email confirmation finishes — and an invitee who created
  // their account from an invitation link is sent back to that invitation to join, not asked to found an organisation.
  if (me.data.memberships.length === 0 && !me.data.user.isPlatformAdmin) {
    const invitation = readPendingInvitation();
    if (invitation) return <Navigate to={`/auth/invite?token=${encodeURIComponent(invitation)}`} replace />;
    return <CreateOrganizationScreen />;
  }
  // A platform admin is let through with no membership on purpose — but the index route is the org-scoped dashboard,
  // which calls useOrgId() and throws. Send them where they can actually act: the super-admin portal (/adm). Below the
  // guard above so an ordinary member-less user still gets the onboarding screen rather than the portal's refusal.
  if (me.data.memberships.length === 0) return <Navigate to="/adm" replace />;
  return (
    // The frame: from `md` up the shell is exactly one screen tall, painted in the tenant's sidebar colour, and the page sits
    // in a rounded panel inset from its edges that scrolls on its own (#app-scroll). On a phone the document scrolls as usual.
    <div className="flex min-h-dvh bg-background md:h-dvh md:overflow-hidden md:bg-sidebar">
      <a href="#main" className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm font-medium shadow-md focus:not-sr-only focus:fixed focus:start-3 focus:top-3">{t('app.skipToContent')}</a>
      <Sidebar />
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <DialogContent variant="sheet" aria-describedby={undefined} className="bg-sidebar p-0 text-sidebar-foreground md:hidden">
          <DialogTitle className="sr-only">{t('nav.navigation')}</DialogTitle>
          <div className="h-full [&>aside]:flex [&>aside]:h-full [&>aside]:w-72" onClick={() => setMobileNav(false)}><Sidebar /></div>
        </DialogContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pe-2">
        {/* the panel's background carries the tenant's colour as a faint light at its top (globals.css .app-ambient): it
            belongs to the scroll container itself, so it is painted once and the content scrolls over it */}
        <div id={APP_SCROLL_ID} className="app-ambient flex min-w-0 flex-1 flex-col bg-background md:overflow-y-auto md:overscroll-contain md:rounded-2xl md:border md:border-black/[0.06] md:shadow-[0_1px_3px_rgb(0_0_0/0.12),0_12px_40px_-12px_rgb(0_0_0/0.35)] dark:md:border-white/[0.07]">
          <Topbar onOpenMobileNav={() => setMobileNav(true)} />
          {lapsed ? (
            <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <TriangleAlert className="size-4 shrink-0" aria-hidden /> {t('modules.lapsedBanner')}
              <Link to="/settings/subscription" className="font-medium underline underline-offset-4">{t('modules.lapsedAction')}</Link>
            </div>
          ) : null}
          <main id="main" tabIndex={-1} className="flex-1 focus:outline-none"><Outlet /></main>
        </div>
      </div>
    </div>
  );
}

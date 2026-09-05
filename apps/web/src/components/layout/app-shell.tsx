import { useState } from 'react';
import { Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { Dialog, DialogContent } from '@/components/ui';
import { useMe } from '@/features/me/use-me';
import { Skeleton } from '@/components/ui';
import { ErrorState } from '@/components/ui';
import { useAuth } from '@/features/auth/auth-provider';
import { AuthLayout } from '@/features/auth/auth-layout';
import { Button } from '@/components/ui';

export function AppShell() {
  const { t } = useTranslation();
  const me = useMe();
  const { signOut } = useAuth();
  const [mobileNav, setMobileNav] = useState(false);

  if (me.isLoading) {
    return (
      <div className="flex min-h-screen">
        <div className="hidden w-60 bg-sidebar md:block" />
        <div className="flex-1 p-8 space-y-4"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>
      </div>
    );
  }
  if (me.isError) return <div className="p-8"><ErrorState error={me.error} onRetry={() => void me.refetch()} /></div>;
  if (me.data && me.data.memberships.length === 0 && !me.data.user.isPlatformAdmin) {
    return (
      <AuthLayout>
        <div className="max-w-sm space-y-4 text-center">
          <p className="text-sm">{t('auth.noOrg')}</p>
          <Button variant="outline" onClick={() => void signOut()}>{t('nav.signOut')}</Button>
        </div>
      </AuthLayout>
    );
  }
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

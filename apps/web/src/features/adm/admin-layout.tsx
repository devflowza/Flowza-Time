import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowLeftFromLine, Building2, Flag, HeartPulse, KeyRound, LayoutDashboard, LogOut, Menu, ShieldAlert, ShieldCheck, Tags, TriangleAlert, UserCog, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { useMe } from '@/features/me/use-me';
import { Dialog, DialogContent } from '@/components/ui';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { AdmBrand } from './components/adm-brand';
import { usePlatformAdmins, usePlatformOverview } from './api';
import { useTemporaryPassword } from './use-temporary-password';

interface Item { to: string; icon: LucideIcon; label: string; badge?: number }

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation('adm');
  const navigate = useNavigate();
  const { data: me } = useMe();
  const admins = usePlatformAdmins();
  const overview = usePlatformOverview();
  const self = admins.data?.find((a) => a.isSelf);
  const sections: Array<{ label?: string; items: Item[] }> = [
    { items: [
      { to: '/adm', icon: LayoutDashboard, label: t('nav.dashboard') },
      { to: '/adm/tenants', icon: Building2, label: t('nav.tenants') },
    ] },
    { label: t('nav.sections.people'), items: [
      { to: '/adm/users', icon: Users, label: t('nav.users') },
      { to: '/adm/team', icon: UserCog, label: t('nav.team') },
    ] },
    { label: t('nav.sections.business'), items: [
      { to: '/adm/grants', icon: KeyRound, label: t('nav.grants'), badge: overview.data?.pendingGrants },
      { to: '/adm/plans', icon: Tags, label: t('nav.plans') },
    ] },
    { label: t('nav.sections.system'), items: [
      { to: '/adm/feature-flags', icon: Flag, label: t('nav.flags') },
      { to: '/adm/activity', icon: Activity, label: t('nav.activity') },
      { to: '/adm/health', icon: HeartPulse, label: t('nav.health') },
    ] },
  ];
  const signOut = async () => { await supabase.auth.signOut(); void navigate('/adm/login', { replace: true }); };
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-slate-950 text-slate-300">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-4">
        <AdmBrand />
        {me && me.memberships.length > 0 ? (
          <a href="/" title={t('nav.openApp')} aria-label={t('nav.openApp')} className="inline-flex size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
            <ArrowLeftFromLine className="size-4 rtl:rotate-180" aria-hidden />
          </a>
        ) : null}
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label={t('portal')}>
        {sections.map((s, i) => (
          <div key={i}>
            {s.label ? <div className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{s.label}</div> : null}
            <div className="space-y-0.5">
              {s.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === '/adm'} onClick={onNavigate}
                  className={({ isActive }) => cn('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500',
                    isActive ? 'bg-white/10 font-medium text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white')}>
                  <item.icon className="size-[18px] shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                  {item.badge ? <span className="ms-auto min-w-[18px] rounded-full bg-amber-500 px-1.5 py-0.5 text-center text-[10px] font-bold text-white tnum">{item.badge}</span> : null}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="space-y-1 border-t border-white/10 px-3 py-4">
        <Link to="/adm/account" onClick={onNavigate} className="block rounded-lg px-3 py-2 hover:bg-white/5">
          <div className="truncate text-sm text-white">{me?.user.fullName || me?.user.email}</div>
          <div className="truncate text-xs text-slate-500" dir="ltr">{me?.user.email}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-300">{self ? `${t('superAdmin')} · ${t(`levels.${self.level}`)}` : t('superAdmin')}</span>
            {me?.user.mfaEnrolled
              ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"><ShieldCheck className="size-2.5" aria-hidden />{t('mfaOn')}</span>
              : <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-300"><ShieldAlert className="size-2.5" aria-hidden />{t('mfaOff')}</span>}
          </div>
        </Link>
        <button type="button" onClick={() => void signOut()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
          <LogOut className="size-[18px] rtl:rotate-180" aria-hidden /> {t('nav.signOut')}
        </button>
      </div>
    </aside>
  );
}

/** The /adm shell: a fixed dark sidebar (never the tenant's theme — a platform admin acts for no tenant), a slim top bar and the page. */
export function AdminLayout() {
  const { t } = useTranslation('adm');
  const [mobile, setMobile] = useState(false);
  const temporary = useTemporaryPassword();
  return (
    <div className="flex min-h-screen bg-muted/30">
      <div className="sticky top-0 hidden h-screen md:block"><Nav /></div>
      <Dialog open={mobile} onOpenChange={setMobile}>
        <DialogContent size="sm" className="start-0 top-0 h-full max-h-none w-64 translate-x-0 translate-y-0 rounded-none border-0 bg-slate-950 p-0 rtl:translate-x-0 md:hidden">
          <Nav onNavigate={() => setMobile(false)} />
        </DialogContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <button type="button" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent md:hidden" onClick={() => setMobile(true)} aria-label={t('nav.menu')}><Menu className="size-5" /></button>
          <AdmBrand tone="light" className="md:hidden" compact />
          <div className="ms-auto flex items-center gap-1"><LanguageSwitcher /></div>
        </header>
        {temporary ? (
          <div role="status" className="flex flex-wrap items-center gap-2 border-b border-amber-300/60 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <TriangleAlert className="size-4 shrink-0" aria-hidden /> {t('tempPassword.banner')}
            <Link to="/adm/account" className="font-medium underline underline-offset-4">{t('tempPassword.action')}</Link>
          </div>
        ) : null}
        <main className="flex-1"><Outlet /></main>
      </div>
    </div>
  );
}

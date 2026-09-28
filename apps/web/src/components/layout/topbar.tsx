import { useState } from 'react';
import { Bell, ChevronsUpDown, LogOut, Menu, Moon, Search, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Avatar, Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui';
import { useAuth } from '@/features/auth/auth-provider';
import { useActiveMembership, useMe } from '@/features/me/use-me';
import { useUiStore } from '@/stores/ui-store';
import { LanguageSwitcher } from './language-switcher';
import { useUnreadCount } from '@/features/notifications/use-notifications';
import { GlobalSearchDialog } from '@/features/search/global-search';
import { PendingChip } from '@/features/team/components/pending-chip';

/**
 * The global top bar. At phone width (390 px) it must never be wider than the screen (HR portal Prompt 4 review, P2-15): the
 * organisation switcher is the one element that shrinks (its name truncates), the action cluster keeps its size, and the
 * language switcher shows its icon only below `sm`.
 */
export function Topbar({ onOpenMobileNav }: { onOpenMobileNav: () => void }) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: me } = useMe();
  const membership = useActiveMembership();
  const setActiveOrg = useUiStore((s) => s.setActiveOrg);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const unread = useUnreadCount();

  return (
    <header className="sticky top-0 z-30 flex h-14 min-w-0 items-center gap-2 border-b bg-card/80 px-4 backdrop-blur sm:gap-3 sm:px-6">
      <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={onOpenMobileNav} aria-label="Open navigation"><Menu /></Button>
      {me && me.memberships.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 max-w-[240px] items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent" aria-label={t('common.switchOrg')}>
              <span className="min-w-0 truncate font-medium">{membership?.organization.displayName}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>{t('common.switchOrg')}</DropdownMenuLabel>
            {me.memberships.map((m) => (
              <DropdownMenuItem key={m.membershipId} onSelect={() => { setActiveOrg(m.organization.id); navigate('/'); }}>
                <span className="truncate">{m.organization.displayName}</span>
                <span className="ms-auto text-xs text-muted-foreground">{m.roleName}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* Search is organisation-scoped, so it has nothing to offer a platform admin who has not selected one. */}
      {membership ? (
        <>
          <button type="button" onClick={() => setSearchOpen(true)} className="ms-auto hidden h-9 w-64 items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground hover:bg-accent lg:flex">
            <Search className="size-4" /> {t('common.searchPlaceholder')} <kbd className="ms-auto rounded border px-1.5 text-[10px]">⌘K</kbd>
          </button>
          <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
        </>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5 ms-auto sm:gap-1 lg:ms-0">
        {membership ? <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t('common.searchPlaceholder')} onClick={() => setSearchOpen(true)}><Search /></Button> : null}
        <LanguageSwitcher />
        <Button variant="ghost" size="icon" aria-label={t('common.theme')} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
        {/* managers / approvers: what waits for them (team/pending-counts), next to the unread-notification badge */}
        {membership ? <PendingChip /> : null}
        <Button variant="ghost" size="icon" asChild aria-label={t('nav.notifications')}>
          <Link to="/notifications" className="relative">
            <Bell />
            {unread > 0 ? <Badge variant="danger" className="absolute -end-1 -top-1 h-4 min-w-4 justify-center px-1 text-[10px]">{unread > 99 ? '99+' : unread}</Badge> : null}
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded-full focus-visible:ring-2 focus-visible:ring-ring" aria-label="Account menu"><Avatar name={me?.user.fullName || me?.user.email || '?'} src={me?.user.avatarUrl} /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <p className="truncate text-sm font-medium text-foreground">{me?.user.fullName}</p>
              <p className="truncate text-xs">{me?.user.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/settings/security')}>{t('nav.settings')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()} destructive><LogOut /> {t('nav.signOut')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

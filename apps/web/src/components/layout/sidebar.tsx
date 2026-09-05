import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, BarChart3, Bell, Building2, CalendarDays, CalendarOff, CheckSquare, ClipboardList, Cpu, FileText, GitCompare, LayoutDashboard, Lock, Network, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings, ShieldCheck, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { Permission } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { useCan, useMe } from '@/features/me/use-me';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';

interface NavItem { to: string; label: string; icon: LucideIcon; permissions?: Permission[]; any?: boolean }
interface NavSection { label?: string; items: NavItem[] }

export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const can = useCan();
  const { data: me } = useMe();

  const sections: NavSection[] = [
    { items: [{ to: '/', label: t('nav.dashboard'), icon: LayoutDashboard, permissions: ['dashboard.view'] }] },
    { label: t('nav.sections.workforce'), items: [
      { to: '/employees', label: t('nav.employees'), icon: Users, permissions: ['employee.view'] },
      { to: '/attendance', label: t('nav.attendance'), icon: Activity, permissions: ['attendance.view'] },
      { to: '/corrections', label: t('nav.corrections'), icon: ClipboardList, permissions: ['attendance.view'] },
      { to: '/approvals', label: t('nav.approvals'), icon: CheckSquare, permissions: ['attendance.approve'] },
      { to: '/leave', label: t('nav.leave'), icon: CalendarOff, permissions: ['leave.view'] },
    ] },
    { label: t('nav.sections.devices'), items: [
      { to: '/devices', label: t('nav.devices'), icon: Cpu, permissions: ['device.view'] },
      { to: '/sync', label: t('nav.sync'), icon: RefreshCw, permissions: ['device.view'] },
      { to: '/reconciliation', label: t('nav.reconciliation'), icon: GitCompare, permissions: ['device.sync'] },
    ] },
    { label: t('nav.sections.time'), items: [
      { to: '/shifts', label: t('nav.shifts'), icon: CalendarDays, permissions: ['shift.view'] },
      { to: '/holidays', label: t('nav.holidays'), icon: CalendarOff, permissions: ['holiday.view'] },
      { to: '/reports', label: t('nav.reports'), icon: BarChart3, permissions: ['report.view'] },
      { to: '/payroll', label: t('nav.payroll'), icon: Wallet, permissions: ['payroll.view'] },
    ] },
    { label: t('nav.sections.admin'), items: [
      { to: '/organization', label: t('nav.structure'), icon: Building2, permissions: ['branch.view'] },
      { to: '/users', label: t('nav.users'), icon: ShieldCheck, permissions: ['user.view'] },
      { to: '/settings', label: t('nav.settings'), icon: Settings, permissions: ['organization.view'] },
      { to: '/audit', label: t('nav.audit'), icon: FileText, permissions: ['audit.view'] },
    ] },
  ];
  if (me?.user.isPlatformAdmin) sections.push({ items: [{ to: '/platform', label: t('nav.platform'), icon: Network }] });

  return (
    <aside className={cn('hidden shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex', collapsed ? 'w-[68px]' : 'w-60')} aria-label="Primary">
      <div className={cn('flex h-14 items-center gap-3 px-4', collapsed && 'justify-center px-0')}>
        <img src="/favicon.svg" alt="" className="size-8 rounded-lg" />
        {!collapsed ? <span className="truncate font-semibold text-white">{t('app.name')}</span> : null}
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-2 py-2 scrollbar-thin">
        {sections.map((section, i) => {
          const items = section.items.filter((it) => !it.permissions || can(...it.permissions));
          if (items.length === 0) return null;
          return (
            <div key={i}>
              {section.label && !collapsed ? <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/50">{section.label}</p> : null}
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.to}>
                    <Tooltip delayDuration={collapsed ? 0 : 10_000}>
                      <TooltipTrigger asChild>
                        <NavLink to={item.to} end={item.to === '/'} className={({ isActive }) => cn('flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-white/10 hover:text-white', isActive && 'bg-white/15 text-white font-medium', collapsed && 'justify-center px-0')}>
                          <item.icon className="size-4 shrink-0" aria-hidden />
                          {!collapsed ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
                        </NavLink>
                      </TooltipTrigger>
                      {collapsed ? <TooltipContent side="right">{item.label}</TooltipContent> : null}
                    </Tooltip>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-2">
        <button type="button" onClick={toggle} className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-sidebar-foreground/70 hover:bg-white/10 hover:text-white" aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}>
          {collapsed ? <PanelLeftOpen className="size-4 rtl:rotate-180" /> : <><PanelLeftClose className="size-4 rtl:rotate-180" /> {t('nav.collapse')}</>}
        </button>
      </div>
      <span className="sr-only"><Bell /><Lock /></span>
    </aside>
  );
}

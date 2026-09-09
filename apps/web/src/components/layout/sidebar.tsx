import { NavLink } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, BarChart3, Building2, CalendarDays, CalendarOff, CheckSquare, ClipboardList, Cpu, FileText, GitCompare, LayoutDashboard, Network, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings, ShieldCheck, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { Permission } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { useCan, useMe } from '@/features/me/use-me';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';

interface NavItem { to: string; label: string; icon: LucideIcon; permissions?: Permission[]; any?: boolean }
interface NavSection { label?: string; items: NavItem[] }

/**
 * Every colour here is a `sidebar-*` token (globals.css), never a literal white: the tenant's dashboard style decides
 * whether the sidebar is deep green, navy, maroon — or white with a filled active item (Classic Light), where a
 * hard-coded `text-white` would vanish.
 *
 * Active styling keys off `aria-current`, which NavLink sets itself, rather than the `className={({isActive}) => …}`
 * render prop. That prop cannot be used here: TooltipTrigger's `asChild` renders through Radix's Slot, which merges
 * className by string concatenation — so a function is coerced to its own source text and lands in the class
 * attribute verbatim. The layout silently collapsed to `display: inline`, stacking every icon above its label.
 */
const itemClass = (collapsed: boolean) =>
  cn(
    'group relative flex h-9 items-center rounded-md text-[13px] text-sidebar-foreground/85 transition-colors',
    'hover:bg-sidebar-hover hover:text-sidebar-strong',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=page]:bg-sidebar-active aria-[current=page]:font-medium aria-[current=page]:text-sidebar-active-foreground',
    // The 3px rail is the "you are here" anchor; logical inset keeps it on the correct edge in Arabic.
    'before:absolute before:start-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-e-full before:bg-sidebar-rail before:opacity-0 before:transition-opacity aria-[current=page]:before:opacity-100',
    collapsed ? 'justify-center px-0' : 'gap-2.5 ps-3 pe-2.5',
  );

const iconClass = 'size-[18px] shrink-0 text-sidebar-foreground/70 transition-colors group-hover:text-sidebar-strong group-aria-[current=page]:text-sidebar-active-icon';

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
    <aside
      className={cn('hidden shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex', collapsed ? 'w-16' : 'w-60')}
      aria-label="Primary"
    >
      <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border', collapsed ? 'justify-center px-0' : 'px-3')}>
        <img src="/favicon.svg" alt="" className="size-7 shrink-0 rounded-lg" />
        {!collapsed ? <span className="truncate text-[15px] font-semibold tracking-tight text-sidebar-strong">{t('app.name')}</span> : null}
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-2 py-2">
        {sections.map((section, i) => {
          const items = section.items.filter((it) => !it.permissions || can(...it.permissions));
          if (items.length === 0) return null;
          return (
            <div key={i} className={i === 0 ? undefined : 'mt-3'}>
              {section.label && !collapsed ? (
                <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/60">{section.label}</p>
              ) : null}
              {/* A hairline stands in for the heading when collapsed, so the grouping survives without the text. */}
              {section.label && collapsed ? <div className="mx-3 mb-1 border-t border-sidebar-border" /> : null}
              <ul className="space-y-px">
                {items.map((item) => {
                  const link = (
                    <NavLink to={item.to} end={item.to === '/'} className={itemClass(collapsed)}>
                      <item.icon className={iconClass} aria-hidden />
                      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                    </NavLink>
                  );
                  return (
                    <li key={item.to}>
                      {collapsed ? (
                        <Tooltip delayDuration={0}>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <button
          type="button"
          onClick={toggle}
          className={cn(
            'flex h-9 w-full items-center gap-2.5 rounded-md text-[13px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong',
            collapsed ? 'justify-center px-0' : 'ps-3 pe-2.5',
          )}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[18px] shrink-0 rtl:rotate-180" />
          ) : (
            <>
              <PanelLeftClose className="size-[18px] shrink-0 rtl:rotate-180" />
              <span className="truncate">{t('nav.collapse')}</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

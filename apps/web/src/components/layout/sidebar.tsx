import { NavLink, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Activity, BarChart3, Building2, CalendarCheck, CalendarClock, CalendarDays, CalendarOff, CheckSquare, ClipboardCheck, ClipboardList, ContactRound, Cpu, FileText, Fingerprint, GitCompare, House, Inbox, KeyRound, LayoutDashboard, ListChecks, MapPinned, MessageSquareText, Network, Palmtree, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings, ShieldCheck, Sigma, UserRound, Users, UserX, Wallet, type LucideIcon } from 'lucide-react';
import type { ModuleKey, Permission } from '@flowza/contracts';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { useActiveMembership, useModulesEnabled, useCan, useEmployeeId, useMe } from '@/features/me/use-me';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { registerNamespace } from '@/lib/i18n-namespace';
import portalEn from '@/locales/en/portal.json';
import portalAr from '@/locales/ar/portal.json';
import portalAttendanceEn from '@/locales/en/portal-attendance.json';
import portalAttendanceAr from '@/locales/ar/portal-attendance.json';
import attendanceReviewEn from '@/locales/en/attendance-review.json';
import attendanceReviewAr from '@/locales/ar/attendance-review.json';
import attendanceAdminEn from '@/locales/en/attendance-admin.json';
import attendanceAdminAr from '@/locales/ar/attendance-admin.json';
import { usePendingCounts, useTeamAccess } from '@/features/team/api';
import '@/features/team/i18n';

registerNamespace('portal', portalEn, portalAr);
// HR portal Prompt 4: check-in / requests / shift entries and the reasons / geofences review pages
registerNamespace('portal-attendance', portalAttendanceEn, portalAttendanceAr);
registerNamespace('attendance-review', attendanceReviewEn, attendanceReviewAr);
// HR portal Prompt 6b: the regularisation register and the comments & approvals report
registerNamespace('attendance-admin', attendanceAdminEn, attendanceAdminAr);

interface NavItem { to: string; label: string; icon: LucideIcon; permissions?: Permission[]; any?: boolean; /** Overrides `permissions` when set (e.g. any of several keys, or line-manager status). */ visible?: boolean; /** A count shown on the item (0 hides it). */ badge?: number; /** Modules the item belongs to (plan / platform switch — migration 20260929000600); hidden when one is off. */ modules?: ModuleKey[] }
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
    'group relative flex h-9 items-center rounded-md text-[13px] text-sidebar-foreground transition-colors',
    'hover:bg-sidebar-hover hover:text-sidebar-strong',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=page]:bg-sidebar-active aria-[current=page]:font-medium aria-[current=page]:text-sidebar-active-foreground',
    // The 3px rail is the "you are here" anchor; logical inset keeps it on the correct edge in Arabic.
    'before:absolute before:start-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-e-full before:bg-sidebar-rail before:opacity-0 before:transition-opacity aria-[current=page]:before:opacity-100',
    collapsed ? 'justify-center px-0' : 'gap-2.5 ps-3 pe-2.5',
  );

const iconClass = 'size-[18px] shrink-0 text-sidebar-foreground/85 transition-colors group-hover:text-sidebar-strong group-aria-[current=page]:text-sidebar-active-icon';

export function Sidebar() {
  const { t } = useTranslation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const can = useCan();
  const { data: me } = useMe();
  const employeeId = useEmployeeId();
  const membership = useActiveMembership();
  const modulesOn = useModulesEnabled();
  const { pathname } = useLocation();
  // Direct reports (/me: isManager) is a reporting RELATIONSHIP. The approval engine routes MANAGER steps to it whatever
  // the manager's role, and the inbox is actor-scoped (membership only), so it alone opens Approvals.
  const hasDirectReports = membership?.isManager ?? false;
  // /me also says when approvals wait for somebody who holds no approve key — a delegate, a named or escalated approver —
  // or when a delegation to them is in force today (review P1-6). A /me cached before the field existed has none.
  const approvalsSignal = membership?.approvals as { actionable?: number; delegatedToMe?: boolean } | undefined;
  const approvalsWaiting = (approvalsSignal?.actionable ?? 0) > 0 || approvalsSignal?.delegatedToMe === true;
  // The "My team" workspace additionally needs a key that can read those reports' records (employee.view_team, or the
  // organisation-wide employee.view) — the RLS team predicate is key-gated, so without one it would only ever show an
  // empty page.
  const isManager = hasDirectReports && (can('employee.view_team') || can('employee.view'));
  // HR portal Prompt 5: the team workspace also opens with a team attendance / leave key (always with direct reports), and
  // the Approvals item carries THE "waiting for you" number (review P2-3: the same figure as the topbar chip, the dashboard
  // KPI and widget — team/pending-counts.total), /me.approvals.actionable until the badge query has answered
  const team = useTeamAccess();
  const counts = usePendingCounts(team.pendingChip);
  const approvalsBadge = counts.data?.total ?? approvalsSignal?.actionable ?? 0;

  const sections: NavSection[] = [
    { items: [{ to: '/', label: t('nav.dashboard'), icon: LayoutDashboard, permissions: ['dashboard.view'] }] },
    // Self-service: every member linked to an employee record (the API scopes each call to that record).
    ...(employeeId ? [{ label: t('portal:nav.section'), items: [
      { to: '/my', label: t('portal:nav.home'), icon: House, modules: ['self_service'] },
      { to: '/my/attendance', label: t('portal:nav.attendance'), icon: CalendarCheck, modules: ['self_service'] },
      { to: '/my/leave', label: t('portal:nav.leave'), icon: Palmtree, modules: ['self_service', 'leave'] },
      { to: '/my/profile', label: t('portal:nav.profile'), icon: UserRound, modules: ['self_service'] },
      { to: '/my/checkin', label: t('portal-attendance:nav.checkin'), icon: Fingerprint, modules: ['self_service', 'geofences'] },
      { to: '/my/requests', label: t('portal-attendance:nav.requests'), icon: Inbox, modules: ['self_service'] },
      { to: '/my/shift', label: t('portal-attendance:nav.shift'), icon: CalendarClock, modules: ['self_service'] },
      { to: '/my/reports', label: t('portal:nav.reports'), icon: FileText, modules: ['self_service'] },
    ] as NavItem[] }] : []),
    ...(isManager || team.page ? [{ label: t('nav.sections.team'), items: [{ to: '/team', label: t('nav.team'), icon: ContactRound, modules: ['manager_workspace'] }] as NavItem[] }] : []),
    { label: t('nav.sections.workforce'), items: [
      { to: '/employees', label: t('nav.employees'), icon: Users, permissions: ['employee.view'] },
      { to: '/attendance', label: t('nav.attendance'), icon: Activity, permissions: ['attendance.view'] },
      { to: '/corrections', label: t('nav.corrections'), icon: ClipboardList, permissions: ['attendance.view'] },
      // engine v2: approvers of attendance or leave, approval admins, line managers (their team's requests) and anybody
      // with approvals waiting for them or a delegation to them in force today
      { to: '/approvals', label: t('nav.approvals'), icon: CheckSquare, visible: can('attendance.approve') || can('leave.approve') || can('approval.manage') || hasDirectReports || approvalsWaiting, badge: approvalsBadge },
      { to: '/leave', label: t('nav.leave'), icon: CalendarOff, permissions: ['leave.view'], modules: ['leave'] },
      // HR attendance workspace (HR portal Prompt 6a)
      { to: '/attendance/summary', label: t('nav.attendanceSummary'), icon: Sigma, permissions: ['attendance.view', 'attendance.view_team'], any: true },
      { to: '/attendance/unmatched', label: t('nav.unmatchedPunches'), icon: UserX, permissions: ['attendance.view_raw'] },
      // HR portal Prompt 4: reasons (line managers review their team's, HR organisation-wide) and the geofences
      { to: '/attendance/notes', label: t('attendance-review:nav.notes'), icon: MessageSquareText, visible: can('attendance.review_notes') || can('attendance.approve') || hasDirectReports },
      { to: '/attendance/geofences', label: t('attendance-review:nav.geofences'), icon: MapPinned, permissions: ['attendance.manage_geofences'], modules: ['geofences'] },
      // HR portal Prompt 6b: the regularisation register (approvers and reviewers; RLS scopes the rows to their branches)
      { to: '/attendance/regularisations', label: t('attendance-admin:nav.regularisations'), icon: ClipboardCheck, permissions: ['attendance.approve', 'attendance.review_notes'], any: true },
    ] },
    { label: t('nav.sections.devices'), items: [
      { to: '/devices', label: t('nav.devices'), icon: Cpu, permissions: ['device.view'], modules: ['devices'] },
      { to: '/devices/pin-mapping', label: t('nav.pinMapping'), icon: KeyRound, permissions: ['device.view', 'employee.view'], modules: ['devices'] },
      { to: '/devices/punch-log', label: t('nav.punchLog'), icon: ListChecks, permissions: ['attendance.view_raw'], modules: ['devices'] },
      { to: '/sync', label: t('nav.sync'), icon: RefreshCw, permissions: ['device.view'], modules: ['devices'] },
      { to: '/reconciliation', label: t('nav.reconciliation'), icon: GitCompare, permissions: ['device.sync'], modules: ['devices'] },
    ] },
    { label: t('nav.sections.time'), items: [
      { to: '/shifts', label: t('nav.shifts'), icon: CalendarDays, permissions: ['shift.view'] },
      { to: '/holidays', label: t('nav.holidays'), icon: CalendarOff, permissions: ['holiday.view'] },
      { to: '/reports', label: t('nav.reports'), icon: BarChart3, permissions: ['report.view'] },
      { to: '/payroll', label: t('nav.payroll'), icon: Wallet, permissions: ['payroll.view'], modules: ['payroll'] },
    ] },
    { label: t('nav.sections.admin'), items: [
      { to: '/organization', label: t('nav.structure'), icon: Building2, permissions: ['branch.view'] },
      { to: '/users', label: t('nav.users'), icon: ShieldCheck, permissions: ['user.view'] },
      { to: '/settings', label: t('nav.settings'), icon: Settings, permissions: ['organization.view'] },
      { to: '/audit', label: t('nav.audit'), icon: FileText, permissions: ['audit.view'] },
    ] },
  ];
  if (me?.user.isPlatformAdmin) sections.push({ items: [{ to: '/adm', label: t('nav.platform'), icon: Network }] });
  // An item with nested items of its own (/attendance → /attendance/summary) yields to the nested item on that item's paths and
  // stays active on its other sub-paths (/attendance/print is still Attendance) — HR portal Prompt 6a review, minor 15a.
  const navPaths = sections.flatMap((s) => s.items.map((it) => it.to));
  const nestedItemMatches = (to: string) => navPaths.some((p) => p !== to && p.startsWith(`${to}/`) && (pathname === p || pathname.startsWith(`${p}/`)));

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
          const items = section.items.filter((it) => (!it.modules || modulesOn(...it.modules)) && (it.visible !== undefined ? it.visible : !it.permissions || (it.any ? it.permissions.some((p) => can(p)) : can(...it.permissions))));
          if (items.length === 0) return null;
          return (
            <div key={i} className={i === 0 ? undefined : 'mt-3'}>
              {section.label && !collapsed ? (
                <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-sidebar-foreground/80">{section.label}</p>
              ) : null}
              {/* A hairline stands in for the heading when collapsed, so the grouping survives without the text. */}
              {section.label && collapsed ? <div className="mx-3 mb-1 border-t border-sidebar-border" /> : null}
              <ul className="space-y-px">
                {items.map((item) => {
                  const badgeId = item.badge && item.badge > 0 ? `nav-badge-${item.to.replace(/\W+/g, '-')}` : undefined;
                  const link = (
                    <NavLink to={item.to} end={item.to === '/' || item.to === '/my' || nestedItemMatches(item.to)} className={itemClass(collapsed)} aria-describedby={badgeId}>
                      <item.icon className={iconClass} aria-hidden />
                      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="truncate">{item.label}</span>}
                      {/* the count is decorative here; the link DESCRIBES it (aria-describedby) so its name stays the label */}
                      {item.badge && item.badge > 0 ? (
                        collapsed
                          ? <span className="absolute end-2 top-1.5 size-2 rounded-full bg-destructive ring-2 ring-sidebar" aria-hidden data-testid={`nav-badge-${item.to}`} />
                          : <span className="ms-auto min-w-5 rounded-full bg-destructive px-1.5 text-center text-[10px] font-semibold leading-5 text-destructive-foreground tnum" aria-hidden data-testid={`nav-badge-${item.to}`}>{item.badge > 99 ? '99+' : item.badge}</span>
                      ) : null}
                    </NavLink>
                  );
                  return (
                    <li key={item.to}>
                      {badgeId ? <span id={badgeId} className="sr-only">{t('team:chip.label', { count: item.badge })}</span> : null}
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
            'flex h-9 w-full items-center gap-2.5 rounded-md text-[13px] text-sidebar-foreground/90 transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong',
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

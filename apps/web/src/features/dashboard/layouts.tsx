import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarOff, ClipboardCheck, Clock, Cpu, Gauge, LogOut, Timer, UserCheck, Users, UserX, WifiOff } from 'lucide-react';
import type { DashboardBranchRow, DashboardSummary, DashboardTrendRange, Permission } from '@flowza/contracts';
import { fmtMinutes, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { DashboardSettings } from './theme';
import { deltaVsLastWeek, pct, sparkValues, type TrendKey, type TrendPoint } from './model';
import { KpiTile, type KpiDelta, type KpiTileProps } from './widgets/kpi-tile';
import { TrendCard } from './widgets/trend-card';
import { TodayCard } from './widgets/today-card';
import { BranchesCard } from './widgets/branches-card';
import { ApprovalsCard } from './widgets/approvals-card';
import { HolidaysCard } from './widgets/holidays-card';
import { ActivityCard, RecentAttendanceCard } from './widgets/activity-card';
import { DevicesCard } from './widgets/devices-card';
import { SyncCard } from './widgets/sync-card';
import { HighlightCard, QuoteCard } from './widgets/rail-cards';

/** Everything a layout needs, gathered once by the page so the three layouts stay declarative. */
export interface DashboardData {
  date: string;
  isToday: boolean;
  summary: DashboardSummary | undefined;
  summaryLoading: boolean;
  points: TrendPoint[];
  trendsLoading: boolean;
  trendsError: unknown;
  retryTrends: () => void;
  range: DashboardTrendRange;
  setRange: (r: DashboardTrendRange) => void;
  branches: DashboardBranchRow[] | undefined;
  branchesLoading: boolean;
  branchesError: unknown;
  retryBranches: () => void;
  settings: DashboardSettings;
  can: (...perms: Permission[]) => boolean;
  rtl: boolean;
}

type TileKey = 'employees' | 'present' | 'absent' | 'onLeave' | 'late' | 'earlyDeparture' | 'overtime' | 'missingPunch' | 'devicesOnline' | 'devicesOffline' | 'syncFailures' | 'pendingApprovals' | 'attendanceRate';

/** Every KPI the layouts can show, computed from the summary and the trend series. */
function useTiles(d: DashboardData): Record<TileKey, KpiTileProps> {
  const { t } = useTranslation('dashboard');
  const s = d.summary;
  const loading = d.summaryLoading && !s;
  const employees = s?.employees ?? 0;
  const devices = (s?.devicesOnline ?? 0) + (s?.devicesOffline ?? 0) + (s?.devicesUnknown ?? 0);
  const n = (v: number | undefined) => (v === undefined ? '—' : fmtNumber(v));
  const ofEmployees = (v: number | undefined) => (s ? `${pct(v ?? 0, employees)}% ${t('kpi.ofEmployees')}` : undefined);
  const ofDevices = (v: number | undefined) => (s ? `${pct(v ?? 0, devices)}% ${t('kpi.ofDevices')}` : undefined);
  const delta = (key: TrendKey, goodWhenUp: boolean): KpiDelta | null => {
    const v = deltaVsLastWeek(d.points, d.date, key);
    return v === null ? null : { value: v, goodWhenUp, label: t('kpi.vsLastWeek'), sameLabel: t('kpi.sameAsLastWeek') };
  };
  const spark = (key: TrendKey) => sparkValues(d.points, key);
  const percent = (v: number | undefined, whole: number) => (s ? pct(v ?? 0, whole) : null);
  return {
    employees: { label: t('kpi.employees'), value: n(s?.employees), icon: Users, tone: 'brand', loading, hint: s ? t('kpi.activeEmployees') : undefined, spark: spark('total') },
    present: { label: t('kpi.present'), value: n(s?.presentToday), icon: UserCheck, tone: 'present', loading, percent: percent(s?.presentToday, employees), hint: ofEmployees(s?.presentToday), delta: delta('present', true), spark: spark('present') },
    absent: { label: t('kpi.absent'), value: n(s?.absent), icon: UserX, tone: 'absent', loading, percent: percent(s?.absent, employees), hint: ofEmployees(s?.absent), delta: delta('absent', false), spark: spark('absent') },
    onLeave: { label: t('kpi.onLeave'), value: n(s?.onLeave), icon: CalendarOff, tone: 'leave', loading, percent: percent(s?.onLeave, employees), hint: ofEmployees(s?.onLeave), spark: spark('onLeave') },
    late: { label: t('kpi.late'), value: n(s?.late), icon: Clock, tone: 'late', loading, percent: percent(s?.late, employees), hint: ofEmployees(s?.late), delta: delta('late', false), spark: spark('late') },
    earlyDeparture: { label: t('kpi.earlyDeparture'), value: n(s?.earlyDeparture), icon: LogOut, tone: 'early', loading, percent: percent(s?.earlyDeparture, employees), hint: ofEmployees(s?.earlyDeparture) },
    overtime: { label: t('kpi.overtime'), value: s ? fmtMinutes(s.overtimeMinutes) : '—', icon: Timer, tone: 'overtime', loading, hint: s ? t('kpi.lastDays', { count: 7 }) : undefined, spark: spark('overtimeMinutes') },
    missingPunch: { label: t('kpi.missingPunch'), value: n(s?.missingPunch), icon: AlertTriangle, tone: 'missing', loading, percent: percent(s?.missingPunch, employees), hint: ofEmployees(s?.missingPunch), delta: delta('missingPunch', false), spark: spark('missingPunch'), to: d.can('attendance.view') ? '/attendance' : undefined },
    devicesOnline: { label: t('kpi.devicesOnline'), value: n(s?.devicesOnline), icon: Cpu, tone: 'success', loading, percent: percent(s?.devicesOnline, devices), hint: ofDevices(s?.devicesOnline), to: d.can('device.view') ? '/devices' : undefined },
    devicesOffline: { label: t('kpi.devicesOffline'), value: n(s?.devicesOffline), icon: WifiOff, tone: s && s.devicesOffline > 0 ? 'danger' : 'neutral', loading, percent: percent(s?.devicesOffline, devices), hint: ofDevices(s?.devicesOffline), to: d.can('device.view') ? '/devices' : undefined },
    syncFailures: { label: t('kpi.syncFailures'), value: n(s?.syncFailures24h), icon: AlertTriangle, tone: s && s.syncFailures24h > 0 ? 'danger' : 'neutral', loading, to: d.can('device.view') ? '/sync' : undefined },
    pendingApprovals: { label: t('kpi.pendingApprovals'), value: n(s?.pendingApprovals), icon: ClipboardCheck, tone: 'info', loading, to: d.can('attendance.approve') ? '/approvals' : undefined },
    attendanceRate: { label: t('kpi.attendanceRate'), value: s ? `${pct(s.presentToday, employees)}%` : '—', icon: Gauge, tone: 'present', loading, hint: s ? `${fmtNumber(s.presentToday)} / ${fmtNumber(employees)} ${t('kpi.ofEmployees')}` : undefined, delta: delta('present', true), spark: spark('present') },
  };
}

function TileGrid({ tiles, keys, spark, size, className, rtl }: { tiles: Record<TileKey, KpiTileProps>; keys: TileKey[]; spark: boolean; size?: 'md' | 'lg'; className: string; rtl: boolean }) {
  return (
    <div className={cn('grid gap-3', className)}>
      {keys.map((k) => { const tile = tiles[k]; return <KpiTile key={k} {...tile} spark={spark ? tile.spark : null} size={size} rtl={rtl} />; })}
    </div>
  );
}

function Rail({ d, className }: { d: DashboardData; className?: string }) {
  const { settings, can, summary } = d;
  const items = [
    settings.showHighlight ? <HighlightCard key="highlight" to={can('report.view') ? '/reports' : '/attendance'} /> : null,
    can('attendance.approve') ? <ApprovalsCard key="approvals" pending={summary?.pendingApprovals} enabled /> : null,
    can('holiday.view') ? <HolidaysCard key="holidays" date={d.date} enabled /> : null,
    settings.showQuote ? <QuoteCard key="quote" date={d.date} /> : null,
  ].filter(Boolean);
  if (items.length === 0) return null;
  return <aside className={cn('min-w-0 space-y-4', className)}>{items}</aside>;
}
const railIsEmpty = (d: DashboardData) => !d.settings.showHighlight && !d.settings.showQuote && !d.can('attendance.approve') && !d.can('holiday.view');

/** Balanced: today's numbers, the trend, who is where, branches and recent activity, with approvals and holidays on the side. */
export function OverviewLayout({ d }: { d: DashboardData }) {
  const tiles = useTiles(d);
  const full = railIsEmpty(d);
  return (
    <div className="space-y-4">
      {/* The KPI band spans the whole width: six tiles need ~190px each to keep their labels and deltas on one line. */}
      <TileGrid tiles={tiles} keys={['employees', 'present', 'absent', 'onLeave', 'late', 'earlyDeparture']} spark={false} rtl={d.rtl} className="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" />
      <div className="grid gap-4 xl:grid-cols-12">
        <div className={cn('min-w-0 space-y-4', full ? 'xl:col-span-12' : 'xl:col-span-9')}>
          <div className="grid gap-4 lg:grid-cols-5">
            <TrendCard className="lg:col-span-3" points={d.points} loading={d.trendsLoading} error={d.trendsError} onRetry={d.retryTrends} range={d.range} onRangeChange={d.setRange} />
            <TodayCard className="lg:col-span-2" summary={d.summary} loading={d.summaryLoading} stacked />
          </div>
          <div className={cn('grid gap-4', d.can('attendance.view') && 'lg:grid-cols-2')}>
            <BranchesCard rows={d.branches} loading={d.branchesLoading} error={d.branchesError} onRetry={d.retryBranches} canManage={d.can('branch.view')} />
            {d.can('attendance.view') ? <ActivityCard date={d.date} enabled /> : null}
          </div>
        </div>
        <Rail d={d} className="xl:col-span-3" />
      </div>
    </div>
  );
}

/** Devices, sync and today's punches first, for the people who keep the terminals running. */
export function OperationsLayout({ d }: { d: DashboardData }) {
  const tiles = useTiles(d);
  const full = railIsEmpty(d);
  const canDevices = d.can('device.view');
  const canAttendance = d.can('attendance.view');
  return (
    <div className="space-y-4">
      <TileGrid tiles={tiles} keys={['present', 'absent', 'late', 'missingPunch', 'devicesOnline', 'devicesOffline', 'syncFailures', 'pendingApprovals']} spark={false} rtl={d.rtl} className="sm:grid-cols-2 lg:grid-cols-4" />
      <div className="grid gap-4 xl:grid-cols-12">
        <div className={cn('min-w-0 space-y-4', full ? 'xl:col-span-12' : 'xl:col-span-9')}>
          <div className="grid gap-4 lg:grid-cols-5">
            <TrendCard className="lg:col-span-3" points={d.points} loading={d.trendsLoading} error={d.trendsError} onRetry={d.retryTrends} range={d.range} onRangeChange={d.setRange} />
            <DevicesCard className="lg:col-span-2" summary={d.summary} loading={d.summaryLoading} canView={canDevices} canSync={d.can('device.sync')} />
          </div>
          {canAttendance || canDevices ? (
            <div className="grid gap-4 lg:grid-cols-5">
              {canAttendance ? <RecentAttendanceCard className={canDevices ? 'lg:col-span-3' : 'lg:col-span-5'} date={d.date} enabled /> : null}
              {canDevices ? <SyncCard className={canAttendance ? 'lg:col-span-2' : 'lg:col-span-5'} enabled /> : null}
            </div>
          ) : null}
          <BranchesCard rows={d.branches} loading={d.branchesLoading} error={d.branchesError} onRetry={d.retryBranches} canManage={d.can('branch.view')} />
        </div>
        <Rail d={d} className="xl:col-span-3" />
      </div>
    </div>
  );
}

/** Compact: headline figures with sparklines, the trend and the branch table. No rail. */
export function ExecutiveLayout({ d }: { d: DashboardData }) {
  const tiles = useTiles(d);
  return (
    <div className="space-y-4">
      <TileGrid tiles={tiles} keys={['attendanceRate', 'absent', 'late', 'overtime']} spark size="lg" rtl={d.rtl} className="sm:grid-cols-2 xl:grid-cols-4" />
      <TrendCard points={d.points} loading={d.trendsLoading} error={d.trendsError} onRetry={d.retryTrends} range={d.range} onRangeChange={d.setRange} />
      <div className="grid gap-4 lg:grid-cols-5">
        <BranchesCard className="lg:col-span-3" rows={d.branches} loading={d.branchesLoading} error={d.branchesError} onRetry={d.retryBranches} canManage={d.can('branch.view')} limit={10} />
        <TodayCard className="lg:col-span-2" summary={d.summary} loading={d.summaryLoading} stacked />
      </div>
    </div>
  );
}

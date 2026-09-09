import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DashboardTrendRange } from '@flowza/contracts';
import { Button, ErrorState } from '@/components/ui';
import { fmtDate, fmtRelative, todayIso } from '@/lib/format';
import { registerNamespace } from '@/lib/i18n-namespace';
import { cn } from '@/lib/utils';
import en from '@/locales/en/dashboard.json';
import ar from '@/locales/ar/dashboard.json';
import { useActiveMembership, useCan, useMe, useOrgTimezone } from '@/features/me/use-me';
import { useDashboardBranches, useDashboardSummary, useDashboardTrends } from './api';
import { daypart, firstName, shiftDate, toTrendPoints, trendWindow } from './model';
import { useDashboardSettings } from './theme';
import { ExecutiveLayout, OperationsLayout, OverviewLayout, type DashboardData } from './layouts';

registerNamespace('dashboard', en, ar);

/** The trend query always covers at least eight days so "vs last week" has its comparison day, whatever the range. */
const MIN_TREND_DAYS = 8;

export default function DashboardPage() {
  const { t, i18n } = useTranslation('dashboard');
  const settings = useDashboardSettings();
  const tz = useOrgTimezone();
  const membership = useActiveMembership();
  const user = useMe().data?.user;
  const can = useCan();
  const today = todayIso(tz);
  const [date, setDate] = useState(today);
  const [range, setRange] = useState<DashboardTrendRange>(settings.trendDays);
  const isToday = date === today;

  const summary = useDashboardSummary(date);
  const win = trendWindow(date, Math.max(range, MIN_TREND_DAYS));
  const trends = useDashboardTrends(win.from, win.to);
  const branches = useDashboardBranches(date);
  const points = useMemo(() => toTrendPoints(trends.data ?? []), [trends.data]);

  const data: DashboardData = {
    date, isToday,
    summary: summary.data, summaryLoading: summary.isLoading,
    points, trendsLoading: trends.isLoading, trendsError: trends.isError ? trends.error : null, retryTrends: () => void trends.refetch(),
    range, setRange,
    branches: branches.data, branchesLoading: branches.isLoading, branchesError: branches.isError ? branches.error : null, retryBranches: () => void branches.refetch(),
    settings, can, rtl: i18n.dir() === 'rtl',
  };

  const part = daypart(DateTime.now().setZone(tz).hour);
  const name = firstName(user?.fullName);
  const org = membership?.organization.displayName ?? '';
  const heading = settings.showGreeting ? (name ? t(`greeting.${part}`, { name }) : t(`greeting.${part}Anon`)) : t('title');
  const subtitle = isToday ? t('greeting.subtitle', { org }) : t('greeting.subtitlePast', { org, date: fmtDate(date) });
  const Layout = settings.layout === 'operations' ? OperationsLayout : settings.layout === 'executive' ? ExecutiveLayout : OverviewLayout;

  return (
    <div className="page-container">
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-[28px]">
            {heading}{settings.showGreeting ? <span className="ms-2" aria-hidden>👋</span> : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex" aria-live="polite">
            <span className={cn('size-2 rounded-full', summary.isError ? 'bg-red-500' : 'bg-emerald-500')} aria-hidden />
            {summary.isFetching ? t('date.loading') : summary.dataUpdatedAt ? t('date.updated', { when: fmtRelative(new Date(summary.dataUpdatedAt).toISOString()) }) : t('date.live')}
          </span>
          <div className="inline-flex items-center rounded-md border bg-card shadow-card">
            <Button variant="ghost" size="icon" aria-label={t('date.previous')} onClick={() => setDate(shiftDate(date, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
            <span className="tnum inline-flex items-center gap-2 px-1 text-sm font-medium"><CalendarDays className="size-4 text-muted-foreground" aria-hidden />{fmtDate(date, 'EEE, dd MMM yyyy')}</span>
            <Button variant="ghost" size="icon" aria-label={t('date.next')} disabled={isToday} onClick={() => setDate(shiftDate(date, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
          </div>
          {!isToday ? <Button variant="outline" size="sm" onClick={() => setDate(today)}>{t('date.today')}</Button> : null}
        </div>
      </div>
      {summary.isError && !summary.data ? <ErrorState error={summary.error} onRetry={() => void summary.refetch()} /> : <Layout d={data} />}
    </div>
  );
}

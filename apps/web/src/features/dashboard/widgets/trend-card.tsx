import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';
import { DASHBOARD_TREND_RANGES, type DashboardTrendRange } from '@flowza/contracts';
import { ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { StackedBars, type Series } from '../charts';
import type { TrendPoint } from '../model';
import { WidgetCard, WidgetEmpty } from './widget-card';

export function TrendCard({ points, loading, error, onRetry, range, onRangeChange, className }: { points: TrendPoint[]; loading: boolean; error: unknown; onRetry: () => void; range: DashboardTrendRange; onRangeChange: (r: DashboardTrendRange) => void; className?: string }) {
  const { t, i18n } = useTranslation('dashboard');
  const rtl = i18n.dir() === 'rtl';
  const series = useMemo<Series[]>(() => [
    { key: 'onTime', label: t('trend.onTime'), color: 'var(--color-chart-present)' },
    { key: 'late', label: t('trend.late'), color: 'var(--color-chart-late)' },
    { key: 'absent', label: t('trend.absent'), color: 'var(--color-chart-absent)' },
    { key: 'onLeave', label: t('trend.onLeave'), color: 'var(--color-chart-leave)' },
  ], [t]);
  const shown = useMemo(() => points.slice(-range), [points, range]);
  const data = useMemo(() => shown.map((p) => ({ label: fmtDate(p.date, 'dd MMM'), onTime: p.onTime, late: p.late, absent: p.absent, onLeave: p.onLeave })), [shown]);
  const empty = !loading && shown.every((p) => p.total === 0);
  return (
    <WidgetCard
      title={t('trend.title')} subtitle={t('trend.subtitle', { count: range })} icon={BarChart3} className={className}
      action={
        <Select value={String(range)} onValueChange={(v) => onRangeChange(Number(v) as DashboardTrendRange)}>
          <SelectTrigger className="h-8 w-[130px] text-xs" aria-label={t('trend.range')}><SelectValue /></SelectTrigger>
          <SelectContent>{DASHBOARD_TREND_RANGES.map((d) => <SelectItem key={d} value={String(d)}>{t('trend.days', { count: d })}</SelectItem>)}</SelectContent>
        </Select>
      }
    >
      <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-hidden>
        {series.map((s) => <li key={s.key} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.label}</li>)}
      </ul>
      {error ? <ErrorState error={error} onRetry={onRetry} /> : loading && points.length === 0 ? (
        <div className="flex h-[260px] items-end gap-2" aria-busy>{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="flex-1" style={{ height: `${30 + ((i * 37) % 60)}%` }} />)}</div>
      ) : empty ? (
        <WidgetEmpty icon={BarChart3} title={t('trend.empty')} hint={t('trend.emptyHint')} />
      ) : (
        <StackedBars data={data} series={series} xKey="label" rtl={rtl} totalLabel={t('trend.total')} />
      )}
    </WidgetCard>
  );
}

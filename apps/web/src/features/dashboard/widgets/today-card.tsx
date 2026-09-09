import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PieChart } from 'lucide-react';
import type { DashboardSummary } from '@flowza/contracts';
import { Skeleton } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Donut, type DonutSlice } from '../charts';
import { pct, todaySlices, type TodaySliceKey } from '../model';
import { WidgetCard } from './widget-card';

const COLOR: Record<TodaySliceKey, string> = {
  onTime: 'var(--color-chart-present)',
  late: 'var(--color-chart-late)',
  absent: 'var(--color-chart-absent)',
  onLeave: 'var(--color-chart-leave)',
  unrecorded: 'var(--color-border)',
};

/** Headcount ring: who is where today. Slices are disjoint (see `todaySlices`) so the ring always adds up. */
export function TodayCard({ summary, loading, className, stacked }: { summary: DashboardSummary | undefined; loading: boolean; className?: string; stacked?: boolean }) {
  const { t } = useTranslation('dashboard');
  const slices = useMemo<DonutSlice[]>(() => (summary ? todaySlices(summary) : []).map((s) => ({ key: s.key, label: t(`today.${s.key}`), value: s.value, color: COLOR[s.key] })), [summary, t]);
  const employees = summary?.employees ?? 0;
  return (
    <WidgetCard title={t('today.title')} icon={PieChart} className={className}>
      {loading && !summary ? (
        <div className={cn('flex items-center gap-6', stacked && 'flex-col')} aria-busy><Skeleton className="size-40 shrink-0 rounded-full" /><div className="flex-1 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}</div></div>
      ) : (
        <div className={cn('flex items-center gap-4', stacked ? 'flex-col' : 'flex-col sm:flex-row')}>
          <Donut slices={slices} center={{ value: fmtNumber(employees), label: t('today.employees') }} className="w-full max-w-[190px] shrink-0 sm:w-[190px]" />
          <ul className="w-full min-w-0 flex-1 space-y-2 text-sm">
            {slices.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="tnum w-10 text-end font-medium">{fmtNumber(s.value)}</span>
                <span className="tnum w-10 text-end text-xs text-muted-foreground">{pct(s.value, employees)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </WidgetCard>
  );
}

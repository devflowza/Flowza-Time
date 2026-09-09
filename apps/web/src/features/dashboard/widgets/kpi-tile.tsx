import { Link } from 'react-router';
import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { fmtNumber } from '@/lib/format';
import { Sparkline } from '../charts';

/** Tones map to the chart tokens so a tile and the bar that plots the same figure share a colour in every style. */
export type KpiTone = 'brand' | 'present' | 'absent' | 'late' | 'leave' | 'early' | 'overtime' | 'missing' | 'success' | 'danger' | 'info' | 'neutral';
const TONE: Record<KpiTone, { icon: string; bar: string; color: string }> = {
  brand: { icon: 'bg-accent text-brand-700 dark:text-brand-300', bar: 'bg-brand-500', color: 'var(--color-brand-500)' },
  present: { icon: 'bg-chart-present/12 text-chart-present', bar: 'bg-chart-present', color: 'var(--color-chart-present)' },
  absent: { icon: 'bg-chart-absent/12 text-chart-absent', bar: 'bg-chart-absent', color: 'var(--color-chart-absent)' },
  late: { icon: 'bg-chart-late/12 text-chart-late', bar: 'bg-chart-late', color: 'var(--color-chart-late)' },
  leave: { icon: 'bg-chart-leave/12 text-chart-leave', bar: 'bg-chart-leave', color: 'var(--color-chart-leave)' },
  early: { icon: 'bg-chart-early/12 text-chart-early', bar: 'bg-chart-early', color: 'var(--color-chart-early)' },
  overtime: { icon: 'bg-chart-overtime/12 text-chart-overtime', bar: 'bg-chart-overtime', color: 'var(--color-chart-overtime)' },
  missing: { icon: 'bg-chart-missing/12 text-chart-missing', bar: 'bg-chart-missing', color: 'var(--color-chart-missing)' },
  success: { icon: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300', bar: 'bg-emerald-500', color: '#10b981' },
  danger: { icon: 'bg-red-500/12 text-red-700 dark:text-red-300', bar: 'bg-red-500', color: '#ef4444' },
  info: { icon: 'bg-blue-500/12 text-blue-700 dark:text-blue-300', bar: 'bg-blue-500', color: '#3b82f6' },
  neutral: { icon: 'bg-muted text-muted-foreground', bar: 'bg-muted-foreground/50', color: 'var(--color-muted-foreground)' },
};

export interface KpiDelta { value: number; goodWhenUp: boolean; label: string; sameLabel: string }

export interface KpiTileProps {
  label: string;
  value: string;
  icon: LucideIcon;
  tone: KpiTone;
  loading?: boolean;
  /** 0–100 for the progress bar; null hides the bar. */
  percent?: number | null;
  /** Small text on the end side of the footer, e.g. "76% of employees". */
  hint?: string;
  delta?: KpiDelta | null;
  /** Series for a sparkline; replaces the progress bar. */
  spark?: number[] | null;
  rtl?: boolean;
  /** Renders the tile as a link. */
  to?: string;
  /** Larger figure for the executive layout. */
  size?: 'md' | 'lg';
}

export function KpiTile({ label, value, icon: Icon, tone, loading, percent, hint, delta, spark, rtl = false, to, size = 'md' }: KpiTileProps) {
  const t = TONE[tone];
  const showSpark = !!spark && spark.length > 1;
  const showBar = !showSpark && percent !== null && percent !== undefined;
  const body = (
    <>
      <div className="flex items-start gap-3">
        <span className={cn('flex shrink-0 items-center justify-center rounded-lg', t.icon, size === 'lg' ? 'size-11' : 'size-10')}><Icon className={size === 'lg' ? 'size-[22px]' : 'size-5'} aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? <Skeleton className={cn('mt-1', size === 'lg' ? 'h-8 w-20' : 'h-7 w-16')} /> : <p className={cn('tnum font-semibold leading-tight', size === 'lg' ? 'text-3xl' : 'text-2xl')}>{value}</p>}
        </div>
      </div>
      {delta || hint ? (
        // The footer is one row when the tile is wide enough for both halves and stacks otherwise (container query),
        // so a six-tile band and a four-tile band read the same and nothing truncates mid-word.
        <div className="mt-2.5 flex min-h-4 flex-col gap-1 text-xs @min-[15rem]:flex-row @min-[15rem]:items-center @min-[15rem]:justify-between">
          {delta ? (
            delta.value === 0 ? (
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground"><Minus className="size-3.5 shrink-0" aria-hidden />{delta.sameLabel}</span>
            ) : (
              <span className={cn('inline-flex items-center gap-1 whitespace-nowrap font-medium', (delta.value > 0) === delta.goodWhenUp ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300')}>
                {delta.value > 0 ? <TrendingUp className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden /> : <TrendingDown className="size-3.5 shrink-0 rtl:-scale-x-100" aria-hidden />}
                <span className="tnum">{delta.value > 0 ? '+' : '−'}{fmtNumber(Math.abs(delta.value))}</span>
                <span className="font-normal text-muted-foreground">{delta.label}</span>
              </span>
            )
          ) : null}
          {hint ? <span className="truncate text-muted-foreground">{hint}</span> : null}
        </div>
      ) : null}
      {showSpark ? <div className="mt-auto pt-2 -mb-1"><Sparkline values={spark} color={t.color} rtl={rtl} /></div> : null}
      {showBar ? (
        <div className="mt-auto pt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
            <div className={cn('h-full rounded-full transition-[width] duration-500', t.bar)} style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} />
          </div>
        </div>
      ) : null}
    </>
  );
  // `@container` lets the footer adapt to the tile's own width; flex-col + mt-auto keep bars level across a band.
  const frame = '@container flex min-w-0 flex-col p-4';
  // A link tile is the Card surface on an <a>: same classes, one interactive element, nothing nested inside it.
  if (to) return <Link to={to} className={cn(frame, 'rounded-lg border bg-card text-card-foreground shadow-card transition-colors hover:border-brand-300 focus-visible:ring-2 focus-visible:ring-ring')}>{body}</Link>;
  return <Card className={frame}>{body}</Card>;
}

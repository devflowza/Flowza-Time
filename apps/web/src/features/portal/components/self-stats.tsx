import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlarmClock, CalendarX2, Clock, Lightbulb, LogOut, Target } from 'lucide-react';
import { SELF_STATS_RANGES, type PunctualityWindowDto, type SelfStatsDto } from '@flowza/contracts';
import { Button, Card, CardContent, ErrorState, Skeleton, StatCard } from '@/components/ui';
import { fmtDate, fmtMinutes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PA_NS } from '../attendance-i18n';
import { useMyStats } from '../attendance-api';
import { fmtDays } from '../model';

type Range = (typeof SELF_STATS_RANGES)[number];

function PunctualityCard({ title, w }: { title: string; w: PunctualityWindowDto }) {
  const { t } = useTranslation(PA_NS);
  const share = w.days > 0 ? w.onTimeDays / w.days : null;
  return (
    <div className="rounded-lg border p-3" data-testid="punctuality-window">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-semibold tnum">{share === null ? '—' : `${Math.round(share * 100)}%`}</p>
      <p className="text-xs text-muted-foreground tnum">{w.days > 0 ? t('stats.onTime', { onTime: w.onTimeDays, days: w.days }) : t('stats.noDays')}</p>
      {w.lateDays > 0 && w.avgDelayMinutes !== null ? <p className="text-xs text-amber-700 tnum dark:text-amber-300">{t('stats.avgDelay', { minutes: fmtMinutes(Math.round(w.avgDelayMinutes)) })}</p> : null}
      {share !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-emerald-500" style={{ width: `${share * 100}%` }} /></div> : null}
    </div>
  );
}

function hintText(t: (k: string, o?: Record<string, unknown>) => string, h: SelfStatsDto['hints'][number]): string {
  const value = h.kind === 'short_hours' ? h.value.toFixed(1) : h.kind === 'low_attendance' ? h.value.toFixed(1) : fmtDays(h.value);
  return t(`stats.hints.${h.kind}`, { value, target: h.target ?? '' , count: h.value });
}

/**
 * The employee's own statistics for the last 30 days / this month / this year: attendance against the organisation's
 * target, average hours against the full-day hours, late / leave / missing check-out days, punctuality (last 7 days, this
 * month, last month) and "improvement" hints. Leave days are excluded from the attendance share.
 */
export function SelfStats({ initialRange = '30d' }: { initialRange?: Range }) {
  const { t } = useTranslation(PA_NS);
  const [range, setRange] = useState<Range>(initialRange);
  const q = useMyStats(range);
  const s = q.data;
  if (q.isError && !s) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const belowTarget = s && s.attendancePct !== null && s.attendancePct < s.targets.attendancePct;
  const shortHours = s && s.avgHoursPerDay !== null && s.avgHoursPerDay < s.targets.fullDayHours;
  return (
    <div className="space-y-4" data-testid="self-stats">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border bg-card p-0.5 shadow-card" role="group" aria-label={t('stats.title')}>
          {SELF_STATS_RANGES.map((r) => <Button key={r} size="sm" variant={r === range ? 'default' : 'ghost'} aria-pressed={r === range} onClick={() => setRange(r)}>{t(`stats.ranges.${r}`)}</Button>)}
        </div>
        {s ? <p className="text-xs text-muted-foreground tnum">{fmtDate(s.from, 'dd MMM yyyy')} → {fmtDate(s.to, 'dd MMM yyyy')}</p> : null}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label={t('stats.attendance')} value={s?.attendancePct === null || s?.attendancePct === undefined ? '—' : `${s.attendancePct.toFixed(1)}%`} hint={s ? t('stats.attendanceHint', { target: s.targets.attendancePct }) : undefined} icon={Target} tone={belowTarget ? 'warning' : 'success'} loading={q.isLoading} />
        <StatCard label={t('stats.avgHours')} value={s?.avgHoursPerDay === null || s?.avgHoursPerDay === undefined ? '—' : `${s.avgHoursPerDay.toFixed(1)} h`} hint={s ? t('stats.avgHoursHint', { hours: s.targets.fullDayHours }) : undefined} icon={Clock} tone={shortHours ? 'warning' : 'default'} loading={q.isLoading} />
        <StatCard label={t('stats.lateDays')} value={s?.lateDays ?? '—'} icon={AlarmClock} tone={s && s.lateDays > 0 ? 'warning' : 'default'} loading={q.isLoading} />
        <StatCard label={t('stats.leaveDays')} value={s ? fmtDays(s.leaveDays) : '—'} icon={CalendarX2} loading={q.isLoading} />
        <StatCard label={t('stats.missingCheckouts')} value={s?.missingCheckouts ?? '—'} icon={LogOut} tone={s && s.missingCheckouts > 0 ? 'danger' : 'default'} loading={q.isLoading} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-3 pt-4">
            <h3 className="text-sm font-semibold">{t('stats.punctuality')}</h3>
            {s ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <PunctualityCard title={t('stats.windows.last7Days')} w={s.punctuality.last7Days} />
                <PunctualityCard title={t('stats.windows.thisMonth')} w={s.punctuality.thisMonth} />
                <PunctualityCard title={t('stats.windows.lastMonth')} w={s.punctuality.lastMonth} />
              </div>
            ) : <Skeleton className="h-28 w-full" />}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 pt-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="size-4 text-amber-500" aria-hidden />{t('stats.hints.title')}</h3>
            {!s ? <Skeleton className="h-20 w-full" /> : s.hints.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="stats-hints">{t('stats.hints.none')}</p> : (
              <ul className="space-y-1.5 text-sm" data-testid="stats-hints">
                {s.hints.map((h) => <li key={h.kind} className={cn('rounded-md border-s-2 px-2 py-1', h.kind === 'low_attendance' || h.kind === 'absent_days' ? 'border-red-400' : 'border-amber-400')}>{hintText(t, h)}</li>)}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

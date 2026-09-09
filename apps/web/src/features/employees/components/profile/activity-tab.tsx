import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { Activity, ChevronLeft, ChevronRight, Clock, MapPin, Timer, TrendingUp } from 'lucide-react';
import { ACTIVITY_RANGES, type ActivityRange, type AttendanceActivityDayDto, type AttendanceActivityDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, StatCard } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeActivity } from '@/features/attendance/api';
import { StackedBars, type Series } from '@/features/dashboard/charts';
import { ActivityTimeline } from './activity-timeline';
import { ActivityDetails } from './activity-details';
import { datesOf, targetMinutes } from './activity-model';

const UNIT: Record<ActivityRange, 'days' | 'weeks' | 'months' | 'years'> = { day: 'days', week: 'weeks', month: 'months', year: 'years' };

/**
 * Activity history: how the employee's days were actually shaped. The bars stack the productive hours (green, the time
 * the engine counted as worked) on the hours spent away between the first and the last punch (blue — field work, a
 * client visit or a break), and the heartbeat below them puts those spans back on the clock. The year range is charted
 * by month, because 365 timelines show nothing.
 */
export function ActivityTab({ employeeId }: { employeeId: string }) {
  const { t, i18n } = useTranslation('employees');
  const rtl = i18n.dir() === 'rtl';
  const tz = useOrgTimezone();
  const [range, setRange] = useState<ActivityRange>('week');
  const [anchor, setAnchor] = useState(() => todayIso(tz));
  const q = useEmployeeActivity({ employeeId, range, anchor });
  const data = q.data;

  // The anchor survives a range change: a week in August becomes August, not this month.
  const shift = (direction: -1 | 1) => setAnchor((a) => DateTime.fromISO(a, { zone: 'utc' }).plus({ [UNIT[range]]: direction }).toISODate() ?? a);

  const series = useMemo<Series[]>(() => [
    { key: 'office', label: t('activity.legend.office'), color: 'var(--color-chart-office)' },
    { key: 'field', label: t('activity.legend.field'), color: 'var(--color-chart-field)' },
  ], [t]);
  const chart = useMemo(() => toChartData(data), [data]);
  const target = useMemo(() => (data && data.range !== 'year' ? targetMinutes(data.days) : null), [data]);
  const hasRecords = !!data && (data.range === 'year' ? data.months.length > 0 : data.days.length > 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{t('activity.title')}</CardTitle>
            <CardDescription>{data ? periodLabel(data) : t('activity.subtitle')}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label={t('activity.nav.previous')}><ChevronLeft className="rtl:rotate-180" /></Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(todayIso(tz))}>{t('activity.nav.today')}</Button>
            <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label={t('activity.nav.next')}><ChevronRight className="rtl:rotate-180" /></Button>
            <Select value={range} onValueChange={(v) => setRange(v as ActivityRange)}>
              <SelectTrigger className="h-8 w-[130px] text-xs" aria-label={t('activity.range.label')}><SelectValue /></SelectTrigger>
              <SelectContent>{ACTIVITY_RANGES.map((r) => <SelectItem key={r} value={r}>{t(`activity.range.${r}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
            : q.isLoading || !data ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
            : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard icon={Clock} tone="success" label={t('activity.stats.productive')} value={fmtMinutes(data.totals.officeMinutes)} hint={t('activity.stats.productiveHint', { average: fmtMinutes(data.totals.averageOfficeMinutes) })} />
                <StatCard icon={MapPin} tone="info" label={t('activity.stats.field')} value={fmtMinutes(data.totals.fieldMinutes)} hint={t('activity.stats.fieldHint', { percent: sharePercent(data.totals.fieldMinutes, data.totals.spanMinutes) })} />
                <StatCard icon={TrendingUp} tone="default" label={t('activity.stats.overtime')} value={fmtMinutes(data.totals.overtimeMinutes)} hint={t('activity.stats.overtimeHint', { scheduled: fmtMinutes(data.totals.scheduledMinutes) })} />
                <StatCard icon={Timer} tone={data.totals.lateDays > 0 ? 'warning' : 'default'} label={t('activity.stats.attendance')} value={t('activity.stats.presentOf', { present: data.totals.presentDays, total: data.totals.workingDays })} hint={t('activity.stats.lateHint', { count: data.totals.lateDays, minutes: fmtMinutes(data.totals.lateMinutes) })} />
              </div>
            )}
        </CardContent>
      </Card>

      {q.isError ? null : (
      <Card>
        <CardHeader>
          <CardTitle>{t('activity.chart.title')}</CardTitle>
          <CardDescription>{t('activity.chart.hint')}</CardDescription>
          <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => <li key={s.key} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden />{s.label}</li>)}
            {target ? <li className="inline-flex items-center gap-1.5"><span className="h-px w-4 border-t border-dashed border-muted-foreground" aria-hidden />{t('activity.legend.scheduled', { hours: fmtMinutes(target) })}</li> : null}
          </ul>
        </CardHeader>
        <CardContent className="space-y-6">
          {q.isLoading && !data ? <Skeleton className="h-64 w-full" />
            : !hasRecords || !data ? <EmptyState icon={Activity} title={t('activity.chart.empty')} description={t('activity.chart.emptyHint')} />
            : (
              <>
                <StackedBars data={chart} series={series} xKey="label" rtl={rtl} allowDecimals totalLabel={t('activity.chart.span')} format={(hours) => fmtMinutes(Math.round(hours * 60))} reference={target ? { value: target / 60, label: t('activity.chart.target') } : undefined} />
                {data.range === 'year' ? null : (
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('activity.timeline.title')}</h3>
                    <p className="text-xs text-muted-foreground">{t('activity.timeline.hint')}</p>
                    <ActivityTimeline from={data.from} to={data.to} days={data.days} timezone={data.timezone} />
                  </section>
                )}
                {data.range === 'day' && data.days[0] ? <PunchLog day={data.days[0]} timezone={data.timezone} /> : null}
              </>
            )}
        </CardContent>
      </Card>
      )}

      {hasRecords && data ? (
        <Card>
          <CardHeader><CardTitle>{t('activity.table.title')}</CardTitle><CardDescription>{t('activity.table.hint')}</CardDescription></CardHeader>
          <CardContent><ActivityDetails data={data} /></CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** The day's punches as the engine read them, so a disputed day can be checked against the device without leaving the tab. */
function PunchLog({ day, timezone }: { day: AttendanceActivityDayDto; timezone: string }) {
  const { t } = useTranslation('employees');
  if (day.punches.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{t('activity.punches.title')}</h3>
      <ul className="flex flex-wrap gap-2">
        {day.punches.map((p, i) => (
          <li key={`${p.at}-${i}`}>
            <Badge variant={p.role === 'IN' || p.role === 'BREAK_END' ? 'success' : p.role === 'OUT' || p.role === 'BREAK_START' ? 'info' : 'neutral'}>
              <span className="tnum" dir="ltr">{fmtTime(p.at, timezone)}</span>
              <span className="opacity-80">{t(`activity.punches.role.${p.role}`, { defaultValue: p.role })}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bars are drawn in hours: minutes would put four-digit ticks on the axis for a month. */
function toChartData(data: AttendanceActivityDto | undefined): Record<string, string | number>[] {
  if (!data) return [];
  const hours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;
  if (data.range === 'year') return data.months.map((m) => ({ label: fmtDate(`${m.month}-01`, 'MMM'), office: hours(m.officeMinutes), field: hours(m.fieldMinutes) }));
  // Every calendar day of the period, not only the recorded ones, so the bars and the heartbeat below them line up.
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  return datesOf(data.from, data.to).map((date) => {
    const d = byDate.get(date);
    return { label: fmtDate(date, data.range === 'day' ? 'EEE dd MMM' : 'dd MMM'), office: hours(d?.officeMinutes ?? 0), field: hours(d?.fieldMinutes ?? 0) };
  });
}

function periodLabel(data: AttendanceActivityDto): string {
  switch (data.range) {
    case 'day': return fmtDate(data.from, 'EEEE, dd MMMM yyyy');
    case 'week': return `${fmtDate(data.from, 'dd MMM')} – ${fmtDate(data.to, 'dd MMM yyyy')}`;
    case 'month': return fmtDate(data.from, 'MMMM yyyy');
    case 'year': return fmtDate(data.from, 'yyyy');
    default: return `${data.from} – ${data.to}`;
  }
}

function sharePercent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

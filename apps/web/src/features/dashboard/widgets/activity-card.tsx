import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ListChecks } from 'lucide-react';
import { Avatar, Badge, ErrorState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDailyAttendance } from '@/features/attendance/api';
import type { DailyRecord } from '@/features/attendance/types';
import { statusTone } from '@/features/attendance/status';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

interface Punch { record: DailyRecord; kind: 'in' | 'out'; at: string }

/**
 * Today's most recent punches, derived from the daily records of employees who are present or still clocked in (every
 * one of them has a first check-in, so "newest first" is well defined). The latest event of a record wins: a check-out
 * replaces its check-in in the feed.
 */
function useRecentPunches(date: string, enabled: boolean, limit: number) {
  const query = { date, sort: 'firstInAt' as const, order: 'desc' as const, page: 1, pageSize: limit };
  const present = useDailyAttendance({ ...query, status: 'PRESENT' }, enabled);
  // Someone who has clocked in but not yet out stays PENDING until their punch window closes; they belong in the feed too.
  const working = useDailyAttendance({ ...query, status: 'PENDING' }, enabled);
  const punches = useMemo<Punch[]>(() => {
    const seen = new Set<string>();
    return [...(present.data?.data ?? []), ...(working.data?.data ?? [])]
      .filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; })
      .map((r): Punch | null => (r.lastOutAt ? { record: r, kind: 'out', at: r.lastOutAt } : r.firstInAt ? { record: r, kind: 'in', at: r.firstInAt } : null))
      .filter((p): p is Punch => p !== null)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }, [present.data, working.data, limit]);
  const q = { isLoading: present.isLoading || working.isLoading, isError: present.isError || working.isError, error: present.error ?? working.error, refetch: () => { void present.refetch(); void working.refetch(); } };
  return { q, punches };
}

export function ActivityCard({ date, enabled, className, limit = 6 }: { date: string; enabled: boolean; className?: string; limit?: number }) {
  const { t } = useTranslation('dashboard');
  const { q, punches } = useRecentPunches(date, enabled, limit);
  return (
    <WidgetCard title={t('activity.title')} icon={Activity} className={className} action={<ViewAllLink to="/attendance" label={t('activity.viewAll')} />}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading ? <WidgetRowsSkeleton rows={5} /> : punches.length === 0 ? (
        <WidgetEmpty icon={Activity} title={t('activity.empty')} hint={t('activity.emptyHint')} />
      ) : (
        <ul className="space-y-3">
          {punches.map(({ record: r, kind, at }) => {
            const late = kind === 'in' && r.lateMinutes > 0;
            return (
              <li key={r.id} className="flex items-center gap-3">
                <span className={cn('size-2 shrink-0 rounded-full', late ? 'bg-chart-late' : kind === 'in' ? 'bg-chart-present' : 'bg-chart-leave')} aria-hidden />
                <Avatar name={r.employeeName ?? r.employeeNumber ?? '?'} className="size-8" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.employeeName ?? r.employeeNumber ?? '—'}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {late ? t('activity.lateCheckIn') : kind === 'in' ? t('activity.checkedIn') : t('activity.checkedOut')}{r.branchName ? ` · ${r.branchName}` : ''}
                  </span>
                </span>
                <span className="tnum shrink-0 text-xs text-muted-foreground" dir="ltr">{fmtTime(at, r.timezone)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetCard>
  );
}

/** The same punches as a table, for the operations layout. */
export function RecentAttendanceCard({ date, enabled, className, limit = 6 }: { date: string; enabled: boolean; className?: string; limit?: number }) {
  const { t } = useTranslation('dashboard');
  const { t: tt } = useTranslation('attendance');
  const { q, punches } = useRecentPunches(date, enabled, limit);
  return (
    <WidgetCard title={t('recent.title')} icon={ListChecks} className={className} action={<ViewAllLink to="/attendance" label={t('activity.viewAll')} />} bodyClassName="px-0 pb-2">
      {q.isError ? <div className="px-5 pb-3"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-5 pb-3"><WidgetRowsSkeleton rows={5} /></div> : punches.length === 0 ? (
        <div className="px-5 pb-3"><WidgetEmpty icon={ListChecks} title={t('activity.empty')} hint={t('activity.emptyHint')} /></div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-5">{t('recent.employee')}</TableHead>
              <TableHead>{t('recent.time')}</TableHead>
              <TableHead>{t('recent.status')}</TableHead>
              <TableHead className="pe-5">{t('recent.location')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {punches.map(({ record: r, at }) => (
              <TableRow key={r.id}>
                <TableCell className="ps-5"><span className="flex items-center gap-2"><Avatar name={r.employeeName ?? r.employeeNumber ?? '?'} className="size-7" /><span className="truncate text-sm font-medium">{r.employeeName ?? r.employeeNumber ?? '—'}</span></span></TableCell>
                <TableCell className="tnum whitespace-nowrap text-sm" dir="ltr">{fmtTime(at, r.timezone)}</TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    <Badge variant={statusTone(r.status)}>{tt(`status.${r.status}`, { defaultValue: r.status })}</Badge>
                    {r.lateMinutes > 0 ? <Badge variant="warning">{tt('flags.LATE')}</Badge> : null}
                    {r.earlyDepartureMinutes > 0 ? <Badge variant="warning">{tt('flags.EARLY_DEPARTURE')}</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="pe-5 text-sm text-muted-foreground">{r.branchName ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </WidgetCard>
  );
}

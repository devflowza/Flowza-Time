import { useTranslation } from 'react-i18next';
import { CalendarRange, Network } from 'lucide-react';
import type { DashboardDepartmentRow, DashboardMonthToDate } from '@flowza/contracts';
import { ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDashboardDepartments, useDashboardMonthToDate } from '../api';
import { WidgetCard, WidgetEmpty } from './widget-card';

/**
 * Statistics and indicators (customer requirement 2026-10-19). Both cards read the caller's own scope from the API (their
 * branches, RLS) for the day / location the page shows. Colours are the tenant's chart tokens only (docs/design.md §11).
 */

/** The day's attendance per department: rate (present ÷ expected to work), late and absent, departments without one last. */
export function DepartmentsCard({ date, locationId, className, limit = 10 }: { date: string; locationId: string | null; className?: string; limit?: number }) {
  const { t } = useTranslation('dashboard');
  const q = useDashboardDepartments(date, locationId);
  const rows: DashboardDepartmentRow[] = (q.data ?? []).slice(0, limit);
  return (
    <WidgetCard title={t('departments.title')} subtitle={t('departments.subtitle')} icon={Network} className={className}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.isLoading && !q.data ? (
        <div className="space-y-3" aria-busy>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <WidgetEmpty icon={Network} title={t('departments.empty')} hint={t('departments.emptyHint')} />
      ) : (
        <table className="w-full text-sm" data-testid="department-breakdown">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pe-2 text-start font-medium">{t('departments.department')}</th>
              <th scope="col" className="pb-2 pe-2 text-start font-medium">{t('departments.rate')}</th>
              <th scope="col" className="pb-2 pe-2 text-end font-medium">{t('departments.late')}</th>
              <th scope="col" className="pb-2 text-end font-medium">{t('departments.absent')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const name = r.departmentName ?? t('departments.none');
              const rate = r.attendanceRate;
              return (
                <tr key={r.departmentId ?? 'none'} className="border-t">
                  <td className="py-2 pe-2 align-middle"><p className="truncate font-medium">{name}</p><p className="text-[11px] text-muted-foreground tnum">{t('departments.present')} {fmtNumber(r.present)} / {fmtNumber(r.employees)}</p></td>
                  <td className="py-2 pe-2 align-middle">
                    <div className="flex items-center gap-2">
                      <span className="tnum w-11 shrink-0 text-end text-xs font-medium">{rate === null ? '—' : `${rate}%`}</span>
                      <div className="h-2 min-w-12 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rate ?? 0} aria-label={name}>
                        <div className="bar-fill h-full rounded-full transition-[width] duration-500" style={{ width: `${rate ?? 0}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pe-2 text-end align-middle"><span className="inline-flex items-center gap-1.5 tnum"><span className="size-2 rounded-full bg-chart-late" aria-hidden />{fmtNumber(r.late)}</span></td>
                  <td className="py-2 text-end align-middle"><span className="inline-flex items-center gap-1.5 tnum"><span className="size-2 rounded-full bg-chart-absent" aria-hidden />{fmtNumber(r.absent)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </WidgetCard>
  );
}

function Indicator({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'present' | 'late' | 'absent' }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/30 p-3">
      <p className="flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
        {tone ? <span className={cn('size-2 shrink-0 rounded-full', tone === 'present' ? 'bg-chart-present' : tone === 'late' ? 'bg-chart-late' : 'bg-chart-absent')} aria-hidden /> : null}{label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold tnum">{value}</p>
      {hint ? <p className="truncate text-[11px] text-muted-foreground tnum">{hint}</p> : null}
    </div>
  );
}

/** Month to date: attendance rate, late arrivals (and minutes), absences, average worked time and short hours since the 1st. */
export function MonthToDateCard({ date, locationId, className }: { date: string; locationId: string | null; className?: string }) {
  const { t } = useTranslation('dashboard');
  const q = useDashboardMonthToDate(date, locationId);
  const m: DashboardMonthToDate | undefined = q.data;
  return (
    <WidgetCard title={t('mtd.title')} subtitle={m ? t('mtd.subtitle', { from: fmtDate(m.from, 'dd MMM'), to: fmtDate(m.to, 'dd MMM') }) : undefined} icon={CalendarRange} className={className}>
      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !m ? (
        <div className="grid grid-cols-2 gap-2" aria-busy>{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2" data-testid="month-to-date">
          <Indicator label={t('mtd.attendanceRate')} tone="present" value={m.attendanceRate === null ? t('mtd.noData') : `${m.attendanceRate}%`} hint={t('mtd.attendanceRateHint', { present: fmtNumber(m.presentDays), working: fmtNumber(m.workingDays) })} />
          <Indicator label={t('mtd.late')} tone="late" value={fmtNumber(m.lateDays)} hint={t('mtd.lateHint', { minutes: fmtMinutes(m.lateMinutes) })} />
          <Indicator label={t('mtd.absences')} tone="absent" value={fmtNumber(m.absentDays)} hint={t('mtd.absencesHint', { count: m.missingPunchDays })} />
          <Indicator label={t('mtd.avgWorked')} value={m.avgWorkedMinutes === null ? t('mtd.noData') : fmtMinutes(m.avgWorkedMinutes)} hint={t('mtd.avgWorkedHint')} />
          <Indicator label={t('mtd.shortfall')} value={fmtMinutes(m.shortfallMinutes)} hint={t('mtd.shortfallHint', { count: m.earlyDepartureDays })} />
        </div>
      )}
    </WidgetCard>
  );
}

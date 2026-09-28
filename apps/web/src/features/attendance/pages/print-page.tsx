import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, Lock, PencilLine, Printer } from 'lucide-react';
import { Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, fmtMinutes, fmtTime, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import '../workspace-i18n';
import { useAttendanceCalendar, useAttendanceSummary } from '../workspace-api';
import { fmtDays, fmtHm, shiftMonth } from '../status';
import { monthWeeks } from '../workspace-utils';

/** While this page is mounted, printing drops the app chrome (sidebar, top bar, toasts) so the statement prints alone. */
const PRINT_CSS = '@media print { aside, header, [data-sonner-toaster], [data-print-hide] { display: none !important; } main { padding: 0 !important; } body { background: #fff !important; } }';
/** Without report.export the statement is a screen view: the browser's own print command prints a notice instead of it. */
const SCREEN_ONLY_CSS = '@media print { [data-testid="print-sheet"] { display: none !important; } [data-print-denied] { display: block !important; } }';

/**
 * /attendance/print?employeeId=&month= (HR portal Prompt 6a): a print-friendly monthly attendance statement of one employee —
 * every day with status, in / out, worked, late, early and overtime, the month totals and signature lines. Opened from the
 * employee profile and the summary page; the browser's print dialog saves it as PDF.
 *
 * Printing / saving it is an EXPORT (review minor 11): the Print button is for report.export holders. Without it (a line
 * manager reading a team member's month from the summary) the statement is a screen view, and the page's print stylesheet
 * replaces it with a notice — a UX guard, not a security boundary (the figures are on screen either way).
 */
export default function AttendancePrintPage() {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const tz = useOrgTimezone();
  const org = useActiveMembership()?.organization;
  const can = useCan();
  const canPrint = can('report.export');
  const [params, setParams] = useSearchParams();
  const employeeId = params.get('employeeId') ?? '';
  const currentMonth = todayIso(tz).slice(0, 7);
  const m = params.get('month');
  const month = m && /^\d{4}-\d{2}$/.test(m) ? m : currentMonth;
  const enabled = /^[0-9a-f-]{36}$/i.test(employeeId);
  const cal = useAttendanceCalendar({ month, employeeId, pageSize: 1 }, enabled);
  const sum = useAttendanceSummary({ month, employeeId, pageSize: 1 }, enabled);
  const row = cal.data?.data[0];
  const totals = sum.data?.data[0];
  const days = useMemo(() => monthWeeks(month).flat().filter((d): d is string => !!d), [month]);
  const [generatedAt] = useState(() => new Date().toISOString());
  const setMonth = (next: string) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('month', next); return n; }, { replace: true });

  if (!enabled) return <div className="page-container"><EmptyState title={t('print.noEmployee')} description={t('print.noEmployeeHint')} /></div>;
  return (
    <div className="page-container space-y-4 print:space-y-3" data-testid="print-page">
      <style>{canPrint ? PRINT_CSS : `${PRINT_CSS} ${SCREEN_ONLY_CSS}`}</style>
      {!canPrint ? <p className="hidden text-sm" data-print-denied>{t('print.notAllowed')}</p> : null}
      <div className="flex flex-wrap items-center gap-2 print:hidden" data-print-hide>
        <Button asChild variant="ghost" size="sm"><Link to={`/employees/${employeeId}`}><ArrowLeft className="rtl:rotate-180" /> {t('print.back')}</Link></Button>
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={ta('monthly.previousMonth')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
          <span className="px-2 text-sm tnum">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
          <Button variant="ghost" size="icon" className="size-8" aria-label={ta('monthly.nextMonth')} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        {canPrint
          ? <Button size="sm" className="ms-auto" onClick={() => window.print()} disabled={!row} data-testid="print-button"><Printer /> {t('print.print')}</Button>
          : <span className="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="print-locked"><Lock className="size-3" /> {t('print.screenOnly')}</span>}
      </div>
      {cal.isError ? <ErrorState error={cal.error} onRetry={() => void cal.refetch()} />
        : cal.isLoading ? <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-96 w-full" /></div>
        : !row ? <EmptyState title={t('print.notFound')} description={t('print.notFoundHint')} />
        : (
          <article className="mx-auto max-w-4xl space-y-4 rounded-lg border bg-card p-6 text-sm shadow-card print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none" data-testid="print-sheet">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{org?.legalName ?? org?.displayName ?? ''}</p>
                <h1 className="text-lg font-semibold">{t('print.title')}</h1>
                <p className="text-muted-foreground">{fmtDate(`${month}-01`, 'MMMM yyyy')}</p>
              </div>
              <div className="text-end">
                <p className="font-medium">{row.employeeName}</p>
                <p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.employeeNumber}</p>
                <p className="text-xs text-muted-foreground">{t('print.generated', { at: fmtDateTime(generatedAt, tz) })}</p>
              </div>
            </header>
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-1.5 pe-2 text-start font-medium">{t('print.date')}</th>
                  <th className="py-1.5 pe-2 text-start font-medium">{t('print.status')}</th>
                  <th className="py-1.5 pe-2 text-start font-medium">{ta('columns.firstIn')}</th>
                  <th className="py-1.5 pe-2 text-start font-medium">{ta('columns.lastOut')}</th>
                  <th className="py-1.5 pe-2 text-end font-medium">{ta('columns.worked')}</th>
                  <th className="py-1.5 pe-2 text-end font-medium">{ta('columns.late')}</th>
                  <th className="py-1.5 pe-2 text-end font-medium">{ta('columns.early')}</th>
                  <th className="py-1.5 pe-2 text-end font-medium">{ta('columns.overtime')}</th>
                  <th className="py-1.5 text-start font-medium">{ta('columns.flags')}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => {
                  const day = row.days[d];
                  const zone = day?.timezone || tz;
                  return (
                    <tr key={d} className={cn('border-b last:border-0 break-inside-avoid', !day && 'text-muted-foreground')} data-day={d}>
                      <td className="py-1 pe-2 whitespace-nowrap tnum">{fmtDate(d, 'EEE dd')}</td>
                      <td className="py-1 pe-2 whitespace-nowrap">{day ? <>{ta(`status.${day.status}`, { defaultValue: day.status })}{day.statusSource === 'MANUAL' ? <PencilLine className="ms-1 inline size-3" aria-label={t('source.MANUAL')} /> : null}</> : '—'}</td>
                      <td className="py-1 pe-2 tnum" dir="ltr">{day ? fmtTime(day.firstInAt, zone) : ''}</td>
                      <td className="py-1 pe-2 tnum" dir="ltr">{day ? fmtTime(day.lastOutAt, zone) : ''}</td>
                      <td className="py-1 pe-2 text-end tnum">{day?.workedMinutes ? fmtMinutes(day.workedMinutes) : ''}</td>
                      <td className="py-1 pe-2 text-end tnum">{day?.lateMinutes ? fmtMinutes(day.lateMinutes) : ''}</td>
                      <td className="py-1 pe-2 text-end tnum">{day?.earlyDepartureMinutes ? fmtMinutes(day.earlyDepartureMinutes) : ''}</td>
                      <td className="py-1 pe-2 text-end tnum">{day?.overtimeMinutes ? fmtMinutes(day.overtimeMinutes) : ''}</td>
                      <td className="py-1">{day ? day.flags.filter((f) => !['LATE', 'EARLY_DEPARTURE', 'OVERTIME'].includes(f)).map((f) => ta(`flags.${f}`, { defaultValue: f })).join(', ') : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {totals ? (
              <dl className="grid grid-cols-3 gap-x-4 gap-y-1 border-t pt-3 text-xs sm:grid-cols-6" data-testid="print-totals">
                {([
                  ['present', fmtDays(totals.presentDays)], ['late', fmtDays(totals.lateDays)], ['half', fmtDays(totals.halfDays)], ['leave', fmtDays(totals.leaveDays)],
                  ['absent', fmtDays(totals.absentDays)], ['missing', fmtDays(totals.missingPunchDays)], ['holiday', fmtDays(totals.holidayDays)], ['weeklyOff', fmtDays(totals.weeklyOffDays)],
                  ['worked', fmtHm(totals.workedMinutes)], ['average', fmtHm(totals.averageWorkedMinutes)], ['overtime', fmtHm(totals.overtimeMinutes)], ['lop', fmtDays(totals.lopDays)],
                ] as const).map(([k, v]) => <div key={k}><dt className="text-muted-foreground">{t(`summary.columns.${k}`)}</dt><dd className="font-semibold tnum">{v}</dd></div>)}
              </dl>
            ) : null}
            {totals?.source === 'FINALIZED' ? <p className="text-xs text-muted-foreground">{t('print.finalized')}</p> : null}
            <div className="grid grid-cols-2 gap-8 pt-10 text-xs text-muted-foreground">
              <p className="border-t pt-1">{t('print.signEmployee')}</p>
              <p className="border-t pt-1">{t('print.signHr')}</p>
            </div>
          </article>
        )}
    </div>
  );
}

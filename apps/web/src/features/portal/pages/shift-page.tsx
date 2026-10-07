import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, CalendarClock, CalendarDays, History, Repeat } from 'lucide-react';
import type { SelfShiftDayDto, ShiftChangeRequestDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useModuleEnabled } from '@/features/me/use-me';
import { SR_NS } from '@/features/shift-requests/i18n';
import { useMyShiftChanges } from '@/features/shift-requests/api';
import { ShiftChangeDialog } from '@/features/shift-requests/components/shift-change-dialog';
import { ShiftChangesTable } from '@/features/shift-requests/components/shift-changes-table';
import { PA_NS } from '../attendance-i18n';
import { useMyShift, useMySwaps } from '../attendance-api';
import { dayShiftText, swappableDays } from '../shift-format';
import { SwapDialog } from '../components/swap-dialog';
import { SectionTitle } from '../components/parts';
import { SwapsTable } from '../components/swaps-table';

/** A pending shift change covering the day, else an approved additional shift (Enterprise shift change requests). */
function changeOn(changes: readonly ShiftChangeRequestDto[] | undefined, date: string): ShiftChangeRequestDto | null {
  const covering = (changes ?? []).filter((c) => c.fromDate <= date && date <= c.toDate);
  return covering.find((c) => c.status === 'pending') ?? covering.find((c) => c.status === 'approved' && c.kind === 'ADDITIONAL') ?? null;
}

/** One day of the schedule: the shift (and where it came from), or why there is none (off, holiday, leave). */
function DayLine({ d, emphasis = false, change = null }: { d: SelfShiftDayDto; emphasis?: boolean; change?: ShiftChangeRequestDto | null }) {
  const { t } = useTranslation(PA_NS);
  const { t: ts } = useTranslation(SR_NS);
  const what = dayShiftText(d, t);
  const quiet = d.onLeave || !!d.holidayName || d.isOff || !d.shift;
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1', emphasis ? 'py-1' : 'py-2')} data-testid="shift-day">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {d.shift?.color && !quiet ? <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.shift.color }} aria-hidden /> : <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />}
        <span className={cn('shrink-0 tnum', emphasis ? 'text-base font-semibold' : 'w-28 text-sm font-medium')}>{fmtDate(d.date, emphasis ? 'EEEE, dd MMMM' : 'EEE dd MMM')}</span>
        <span className={cn('truncate text-sm', quiet ? 'text-muted-foreground' : 'font-medium')} dir="auto">{what}</span>
      </div>
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        {d.swap ? <Badge variant={d.swap.status === 'approved' ? 'success' : 'warning'} className="max-w-full truncate">{t(d.swap.status === 'approved' ? 'shift.swapApproved' : 'shift.swapPending', { name: d.swap.withEmployeeName ?? '—' })}</Badge> : null}
        {change ? <Badge variant={change.status === 'pending' ? 'warning' : 'info'} className="max-w-full truncate" data-testid="shift-change-badge">{change.status === 'pending' ? ts('badge.pending') : ts('badge.additional', { shift: change.requestedShift?.name ?? '—' })}</Badge> : null}
        {d.shift && !quiet ? <Badge variant="outline" className="text-[10px]">{t(`shift.source.${d.source}`)}</Badge> : null}
      </span>
    </div>
  );
}

/**
 * /my/shift — today's shift, the coming days, the assignment history, and (Enterprise, module shift_requests) shift change
 * requests and shift swaps. Without the module the page shows the schedule only and never calls the request endpoints.
 */
export default function MyShiftPage() {
  const { t } = useTranslation(PA_NS);
  const { t: ts } = useTranslation(SR_NS);
  const requestsOn = useModuleEnabled('shift_requests');
  const doubleOn = useModuleEnabled('advanced_scheduling');
  const q = useMyShift();
  const swaps = useMySwaps(requestsOn);
  const changes = useMyShiftChanges(requestsOn);
  const [swapOpen, setSwapOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const d = q.data;
  if (q.isError && !d) return <div className="page-container"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>;
  const days = d ? [d.today, ...d.upcoming] : [];
  const canSwap = swappableDays(days).length > 0;

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('shift.title')} description={t('shift.subtitle')}
        actions={requestsOn ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setChangeOpen(true)} disabled={!d}><Repeat /> {ts('request')}</Button>
            <Button onClick={() => setSwapOpen(true)} disabled={!d || !canSwap}><ArrowLeftRight /> {t('shift.requestSwap')}</Button>
          </div>
        ) : undefined} />

      <Card className="min-w-0 p-5">
        <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CalendarClock className="size-4" aria-hidden />{t('shift.today')}</p>
        {d ? <DayLine d={d.today} emphasis change={changeOn(changes.data, d.today.date)} /> : <Skeleton className="h-8 w-72" />}
        {d?.today.shift?.graceInMinutes ? <p className="text-xs text-muted-foreground">{t('shift.grace', { minutes: d.today.shift.graceInMinutes })}</p> : null}
      </Card>

      {/* grid items never grow past the screen (review P2-15: 390 px): min-w-0 lets the day rows truncate and wrap */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <SectionTitle title={t('shift.upcoming', { count: d?.upcoming.length ?? 0 })} />
          <CardContent>
            {!d ? <Skeleton className="h-64 w-full" /> : d.upcoming.length ? <div className="divide-y">{d.upcoming.map((day) => <DayLine key={day.date} d={day} change={changeOn(changes.data, day.date)} />)}</div>
              : <EmptyState icon={CalendarDays} title={t('shift.noUpcoming')} className="py-6" />}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <SectionTitle title={t('shift.history')} />
          <CardContent>
            {!d ? <Skeleton className="h-32 w-full" /> : d.history.length ? (
              <ul className="divide-y">
                {d.history.map((h) => (
                  <li key={h.id} className="py-2 text-sm">
                    <p className="flex items-center justify-between gap-2"><span className="truncate font-medium" dir="auto">{h.shiftName ?? h.patternName ?? '—'}</span>{h.isSwap ? <Badge variant="info">{t('shift.swapAssignment')}</Badge> : <Badge variant="outline" className="text-[10px]">{t(`shift.target.${h.targetType}`)}</Badge>}</p>
                    <p className="text-xs text-muted-foreground tnum">{h.effectiveTo ? t('shift.fromTo', { from: fmtDate(h.effectiveFrom), to: fmtDate(h.effectiveTo) }) : t('shift.from', { date: fmtDate(h.effectiveFrom) })}</p>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={History} title={t('shift.noHistory')} className="py-6" />}
          </CardContent>
        </Card>
      </div>

      {requestsOn ? (
        <>
          <section aria-label={ts('mine')} className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{ts('mine')}</h2>
            {changes.isLoading ? <Skeleton className="h-24 w-full" /> : changes.data && changes.data.length ? <ShiftChangesTable rows={changes.data} /> : <p className="text-sm text-muted-foreground">{ts('emptyHint')}</p>}
          </section>
          <section aria-label={t('shift.swaps')} className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{t('shift.swaps')}</h2>
            {swaps.isLoading ? <Skeleton className="h-24 w-full" /> : swaps.data && swaps.data.length ? <SwapsTable rows={swaps.data} /> : <p className="text-sm text-muted-foreground">{t('swap.emptyHint')}</p>}
          </section>
        </>
      ) : null}

      {requestsOn && swapOpen && d ? <SwapDialog open onOpenChange={setSwapOpen} days={days} /> : null}
      {requestsOn && changeOpen && d ? <ShiftChangeDialog open onOpenChange={setChangeOpen} today={d.date} additionalAllowed={doubleOn} /> : null}
    </div>
  );
}

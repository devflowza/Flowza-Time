import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { CalendarOff, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmDialog, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { useHolidayCalendars, useHolidayMutations, useHolidays } from '../api';
import type { HolidayCalendarDto, HolidayDto } from '../types';
import { CalendarDialog, HolidayDialog } from '../components/holiday-dialogs';

const TYPE_TONE: Record<string, 'info' | 'secondary' | 'success' | 'warning'> = { PUBLIC: 'info', RELIGIOUS: 'success', COMPANY: 'secondary', REGIONAL: 'warning' };

/** /holidays?calendarId=&year= — calendars on the left, the selected calendar's holidays grouped by month on the right. */
export default function HolidaysPage() {
  const { t } = useTranslation('schedule');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const canManage = can('holiday.manage');
  const branches = useBranchOptions();
  const [params, setParams] = useSearchParams();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const year = Number(params.get('year') ?? thisYear) || thisYear;
  const calendars = useHolidayCalendars();
  const calendarId = params.get('calendarId') ?? calendars.data?.find((c) => c.isDefault)?.id ?? calendars.data?.[0]?.id ?? null;
  const holidays = useHolidays({ calendarId: calendarId ?? undefined, year }, !!calendarId);
  const { removeCalendar, removeHoliday } = useHolidayMutations();
  const [calDialog, setCalDialog] = useState<{ open: boolean; calendar: HolidayCalendarDto | null }>({ open: false, calendar: null });
  const [holDialog, setHolDialog] = useState<{ open: boolean; holiday: HolidayDto | null }>({ open: false, holiday: null });
  const [deletingCal, setDeletingCal] = useState<HolidayCalendarDto | null>(null);
  const [deletingHol, setDeletingHol] = useState<HolidayDto | null>(null);
  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); n.set(k, v); return n; });
  const groups = useMemo(() => {
    const map = new Map<string, HolidayDto[]>();
    for (const h of holidays.data ?? []) { const k = h.date.slice(0, 7); map.set(k, [...(map.get(k) ?? []), h]); }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [holidays.data]);
  const years = [thisYear + 1, thisYear, thisYear - 1];
  const selected = calendars.data?.find((c) => c.id === calendarId) ?? null;
  const today = todayIso(tz);

  return (
    <div className="page-container">
      <PageHeader title={t('holidays.title')} description={t('holidays.subtitle')} actions={canManage ? <Button variant="outline" size="sm" onClick={() => setCalDialog({ open: true, calendar: null })}><Plus /> {t('holidays.addCalendar')}</Button> : undefined} />
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="space-y-2">
          <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('holidays.calendars')}</h2>
          {calendars.isLoading ? <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
            : calendars.isError ? <ErrorState error={calendars.error} onRetry={() => void calendars.refetch()} />
            : !calendars.data || calendars.data.length === 0 ? <EmptyState icon={CalendarOff} title={t('holidays.noCalendars')} description={t('holidays.noCalendarsHint')} action={canManage ? <Button size="sm" onClick={() => setCalDialog({ open: true, calendar: null })}><Plus /> {t('holidays.addCalendar')}</Button> : undefined} />
            : (
              <ul className="space-y-1.5">
                {calendars.data.map((c) => (
                  <li key={c.id}>
                    <div className={cn('flex w-full items-center gap-2 rounded-lg border bg-card p-2 ps-3 transition-colors hover:border-brand-300', c.id === calendarId && 'border-brand-500 ring-1 ring-brand-500')}>
                      <button type="button" aria-current={c.id === calendarId} onClick={() => setParam('calendarId', c.id)} className="min-w-0 flex-1 rounded text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium">{c.name}{c.isDefault ? <Star className="size-3.5 fill-amber-400 text-amber-400" aria-label={t('holidays.default')} /> : null}</p>
                        <p className="text-xs text-muted-foreground">{c.countryCode ?? '—'} · {t('holidays.count', { count: c.holidayCount ?? 0 })}</p>
                      </button>
                      {canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setCalDialog({ open: true, calendar: c }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeletingCal(c) }]} /> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </aside>
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(year)} onValueChange={(v) => setParam('year', v)}>
              <SelectTrigger className="h-8 w-28" aria-label={t('holidays.year')}><SelectValue /></SelectTrigger>
              <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
            {selected ? <p className="text-sm text-muted-foreground">{selected.name}</p> : null}
            {canManage && calendarId ? <Button size="sm" className="ms-auto" onClick={() => setHolDialog({ open: true, holiday: null })}><Plus /> {t('holidays.add')}</Button> : null}
          </div>
          {!calendarId ? <EmptyState icon={CalendarOff} title={t('holidays.selectCalendar')} />
            : holidays.isLoading && !holidays.data ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
            : holidays.isError ? <ErrorState error={holidays.error} onRetry={() => void holidays.refetch()} />
            : groups.length === 0 ? <EmptyState icon={CalendarOff} title={t('holidays.empty', { year })} description={t('holidays.emptyHint')} action={canManage ? <Button onClick={() => setHolDialog({ open: true, holiday: null })}><Plus /> {t('holidays.add')}</Button> : undefined} />
            : (
              <div className={cn('space-y-4', holidays.isFetching && 'opacity-70')}>
                {groups.map(([month, items]) => (
                  <Card key={month}>
                    <CardHeader className="py-3"><CardTitle className="text-sm">{fmtDate(`${month}-01`, 'MMMM yyyy')} <span className="text-xs font-normal text-muted-foreground">· {t('holidays.count', { count: items.length })}</span></CardTitle></CardHeader>
                    <CardContent className="divide-y p-0">
                      {items.map((h) => (
                        <div key={h.id} className={cn('flex items-center gap-3 px-5 py-2.5', h.date < today && 'text-muted-foreground')}>
                          <div className="w-14 shrink-0 text-center"><p className="text-lg font-semibold leading-none tnum">{h.date.slice(8, 10)}</p><p className="text-[10px] uppercase text-muted-foreground">{fmtDate(h.date, 'ccc')}</p></div>
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium"><span className="truncate">{h.name}</span>{h.nameAr ? <span className="text-xs font-normal text-muted-foreground" dir="rtl">{h.nameAr}</span> : null}{h.isTentative ? <Badge variant="warning">{t('holidays.tentative')}</Badge> : null}{h.isHalfDay ? <Badge variant="outline">{t('holidays.halfDay')}</Badge> : null}</p>
                            <p className="text-xs text-muted-foreground">{h.endDate && h.endDate !== h.date ? <span className="tnum">{fmtDate(h.date)} → {fmtDate(h.endDate)} · </span> : null}<Badge variant={TYPE_TONE[h.type] ?? 'secondary'} className="me-1">{t(`holidays.types.${h.type}`, { defaultValue: h.type })}</Badge>{h.branchIds && h.branchIds.length ? h.branchIds.map((b) => branches.byId.get(b)?.name ?? b.slice(0, 8)).join(', ') : t('holidays.allBranches')}</p>
                          </div>
                          {canManage ? <RowActions actions={[{ key: 'edit', label: tc('common.edit'), icon: <Pencil />, onSelect: () => setHolDialog({ open: true, holiday: h }) }, { key: 'delete', label: tc('common.delete'), icon: <Trash2 />, destructive: true, onSelect: () => setDeletingHol(h) }]} /> : null}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
        </section>
      </div>
      <CalendarDialog key={`${calDialog.open}-${calDialog.calendar?.id ?? 'new'}`} open={calDialog.open} onOpenChange={(o) => setCalDialog((d) => ({ ...d, open: o }))} calendar={calDialog.calendar} />
      {calendarId ? <HolidayDialog key={`${holDialog.open}-${holDialog.holiday?.id ?? 'new'}`} open={holDialog.open} onOpenChange={(o) => setHolDialog((d) => ({ ...d, open: o }))} calendarId={calendarId} holiday={holDialog.holiday} /> : null}
      <ConfirmDialog open={!!deletingCal} onOpenChange={(o) => !o && setDeletingCal(null)} title={t('holidays.deleteCalendarTitle', { name: deletingCal?.name ?? '' })} description={t('holidays.deleteCalendarHint')} confirmLabel={tc('common.delete')} destructive loading={removeCalendar.isPending}
        onConfirm={() => { if (!deletingCal) return; removeCalendar.mutate(deletingCal.id, { onSuccess: () => { toast.success(t('holidays.calendarDeleted')); setDeletingCal(null); if (deletingCal.id === calendarId) setParams((p) => { const n = new URLSearchParams(p); n.delete('calendarId'); return n; }); }, onError: toastError }); }} />
      <ConfirmDialog open={!!deletingHol} onOpenChange={(o) => !o && setDeletingHol(null)} title={t('holidays.deleteTitle', { name: deletingHol?.name ?? '' })} description={t('holidays.deleteHint')} confirmLabel={tc('common.delete')} destructive loading={removeHoliday.isPending}
        onConfirm={() => { if (!deletingHol) return; removeHoliday.mutate(deletingHol.id, { onSuccess: () => { toast.success(t('holidays.deleted')); setDeletingHol(null); }, onError: toastError }); }} />
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight, DoorOpen, Plus } from 'lucide-react';
import type { MeetingDto } from '@flowza/contracts';
import { Button, EmptyState, ErrorState, Input, Label, Skeleton, Switch } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { fmtDate, fmtTime, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useCan, useOrgTimezone } from '@/features/me/use-me';
import { useMeetingRooms, useMeetings } from '../api';
import { MEETINGS_NS } from '../i18n';
import { ISO_DATE, meetingDay, periodDays, shiftPeriod, type MeetingsView } from '../model';
import { MeetingPhaseBadge } from './badges';
import { MeetingDetailDialog } from './meeting-detail-dialog';
import { MeetingDialog } from './meeting-dialog';

/**
 * The meetings of a day or a week (`?view=day|week&date=`; the week starts on the organisation's first day of the week), each with
 * its room, window, organiser, phase and how the invitees came. A meeting opens in a dialog (`?meeting=<id>`, so a link to it can
 * be shared); meeting.manage holders book new ones.
 */
export function MeetingsTab() {
  const { t } = useTranslation(MEETINGS_NS);
  const { t: tc } = useTranslation();
  const can = useCan();
  const orgTz = useOrgTimezone();
  const firstDay = useActiveMembership()?.settings.general?.firstDayOfWeek ?? 0;
  const [params, setParams] = useSearchParams();
  const today = todayIso(orgTz);
  const view: MeetingsView = params.get('view') === 'week' ? 'week' : 'day';
  const dateParam = params.get('date');
  const date = dateParam && ISO_DATE.test(dateParam) ? dateParam : today;
  const roomId = params.get('room');
  const includeCancelled = params.get('cancelled') === '1';
  const openId = params.get('meeting');
  const days = useMemo(() => periodDays(view, date, firstDay), [view, date, firstDay]);
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const q = useMeetings({ from, to, roomId: roomId ?? undefined, includeCancelled });
  const rooms = useMeetingRooms();
  const [creating, setCreating] = useState(false);
  const canManage = can('meeting.manage');
  const activeRooms = (rooms.data ?? []).filter((r) => r.status === 'active');

  const set = (patch: Record<string, string | null>, replace = true) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace });
  const open = (id: string) => set({ meeting: id }, false);

  // the API widens the window by the timezone spread: keep the meetings whose local day (their branch's zone, from the API) is on screen
  const byDay = useMemo(() => {
    const map = new Map<string, MeetingDto[]>(days.map((d) => [d, []]));
    for (const m of q.data ?? []) map.get(meetingDay(m, m.timezone))?.push(m);
    return map;
  }, [q.data, days]);
  const total = [...byDay.values()].reduce((n, list) => n + list.length, 0);
  const roomOptions = useMemo<ComboboxOption[]>(() => (rooms.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.locationName ?? r.branchName ?? undefined })), [rooms.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t('meetings.view')} className="inline-flex rounded-md border bg-card p-0.5">
          {(['day', 'week'] as const).map((v) => (
            <Button key={v} type="button" variant={view === v ? 'secondary' : 'ghost'} size="sm" className="h-7" aria-pressed={view === v} onClick={() => set({ view: v === 'day' ? null : v })}>{t(`meetings.${v}`)}</Button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          <Button variant="ghost" size="icon" className="size-8" aria-label={t(view === 'day' ? 'meetings.previousDay' : 'meetings.previousWeek')} onClick={() => set({ date: shiftPeriod(view, date, -1) })}><ChevronLeft className="rtl:rotate-180" /></Button>
          <Input type="date" value={date} onChange={(e) => ISO_DATE.test(e.target.value) && set({ date: e.target.value === today ? null : e.target.value })} className="h-8 w-[150px] border-0 shadow-none" dir="ltr" aria-label={t('meetings.date')} />
          <Button variant="ghost" size="icon" className="size-8" aria-label={t(view === 'day' ? 'meetings.nextDay' : 'meetings.nextWeek')} onClick={() => set({ date: shiftPeriod(view, date, 1) })}><ChevronRight className="rtl:rotate-180" /></Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => set({ date: null })} disabled={date === today}><CalendarDays /> {tc('common.today')}</Button>
        <Combobox value={roomId} onChange={(v) => set({ room: v })} options={roomOptions} loading={rooms.isLoading} clearable placeholder={t('meetings.allRooms')} aria-label={t('meetings.room')} className="h-8 w-48" />
        <div className="flex items-center gap-2">
          <Switch id="mtg-cancelled" checked={includeCancelled} onCheckedChange={(v) => set({ cancelled: v ? '1' : null })} />
          <Label htmlFor="mtg-cancelled" className="text-sm font-normal">{t('meetings.includeCancelled')}</Label>
        </div>
        {canManage ? <Button size="sm" className="ms-auto" onClick={() => setCreating(true)} disabled={rooms.isSuccess && activeRooms.length === 0}><Plus /> {t('meetings.new')}</Button> : null}
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">{view === 'day' ? fmtDate(date, 'cccc dd MMMM yyyy') : t('meetings.range', { from: fmtDate(from), to: fmtDate(to) })}</p>
      {canManage && rooms.isSuccess && activeRooms.length === 0 ? <p className="text-sm text-muted-foreground">{t('meetings.noRoomsHint')}</p> : null}

      {q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : !q.data ? <div className="space-y-2" data-testid="meetings-loading"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>
        : total === 0 ? <EmptyState icon={DoorOpen} title={t('meetings.empty')} description={t('meetings.emptyHint')} action={canManage && activeRooms.length > 0 ? <Button onClick={() => setCreating(true)}><Plus /> {t('meetings.new')}</Button> : undefined} />
        : (
          <div className={cn('space-y-5', q.isFetching && 'opacity-80')}>
            {days.filter((d) => (byDay.get(d)?.length ?? 0) > 0).map((d) => (
              <section key={d} aria-label={fmtDate(d, 'cccc dd MMMM')} className="space-y-2">
                {view === 'week' ? <h3 className="text-sm font-semibold">{fmtDate(d, 'cccc dd MMM')}</h3> : null}
                <ul className="space-y-2">
                  {byDay.get(d)!.map((m) => <li key={m.id}><MeetingCard meeting={m} zone={m.timezone} onOpen={() => open(m.id)} /></li>)}
                </ul>
              </section>
            ))}
          </div>
        )}

      {creating ? (
        <MeetingDialog open onOpenChange={setCreating} rooms={rooms.data ?? []} roomId={roomId} day={date}
          onCreated={(m) => set({ meeting: m.id, date: meetingDay(m, m.timezone) === today ? null : meetingDay(m, m.timezone) }, false)} />
      ) : null}
      <MeetingDetailDialog meetingId={openId} onClose={() => set({ meeting: null }, false)} />
    </div>
  );
}

/** One meeting in the list: a button that opens it. Its contents are phrasing elements (a button holds no blocks). */
function MeetingCard({ meeting: m, zone, onOpen }: { meeting: MeetingDto; zone: string; onOpen: () => void }) {
  const { t } = useTranslation(MEETINGS_NS);
  const measured = m.status === 'scheduled' && m.phase !== 'upcoming';
  return (
    <button type="button" onClick={onOpen} data-testid={`meeting-${m.id}`}
      className={cn('flex w-full items-start gap-4 rounded-xl border bg-card p-3 text-start shadow-card transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', m.status === 'cancelled' && 'opacity-70')}>
      <span className="w-[5.5rem] shrink-0 pt-0.5 text-sm font-medium tnum" dir="ltr">{fmtTime(m.startsAt, zone)}–{fmtTime(m.endsAt, zone)}</span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={cn('truncate font-medium', m.status === 'cancelled' && 'line-through decoration-1')}>{m.title}</span>
          <MeetingPhaseBadge meeting={m} />
        </span>
        <span className="block truncate text-xs text-muted-foreground">{[m.roomName, m.organizerName ? t('meetings.organizer', { name: m.organizerName }) : null].filter(Boolean).join(' · ')}</span>
        <span className="block text-xs tnum" data-testid={`meeting-counts-${m.id}`}>
          {measured
            ? <>{t('meetings.counts', { attended: m.attendedCount, invited: m.invitedCount, late: m.lateCount, absent: m.absentCount, walkIns: m.walkInCount })}</>
            : <span className="text-muted-foreground">{t('meetings.invited', { count: m.invitedCount })}</span>}
        </span>
      </span>
    </button>
  );
}

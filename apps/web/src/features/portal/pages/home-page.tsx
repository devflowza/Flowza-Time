import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { DateTime } from 'luxon';
import { AlarmClock, CalendarCheck, CalendarPlus, ClipboardList, Clock, Hourglass, Palmtree, PartyPopper, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton, StatCard } from '@/components/ui';
import { fmtDate, fmtMinutes, fmtTime } from '@/lib/format';
import { useActiveMembership, useMe } from '@/features/me/use-me';
import { AttendanceStatusBadge, FlagChips } from '@/features/attendance/components/badges';
import { daypart, firstName } from '@/features/dashboard/model';
import { useSelfLeave, useSelfOverview, useSelfProfile } from '../api';
import { fmtDays } from '../model';
import { ApplyLeaveDialog } from '../components/apply-leave-dialog';
import { BalanceRow, LeaveStatusBadge, SectionTitle, TypeDot } from '../components/parts';
import { HomePunchCard, PendingSelfItems } from '../components/home-attendance';
import { TeamUpcomingLeave } from '@/features/leave/components/team-upcoming-leave';

function TodayCard() {
  const { t } = useTranslation('portal');
  const q = useSelfOverview();
  const r = q.data?.today;
  const tz = r?.timezone ?? q.data?.timezone ?? 'UTC';
  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('home.today')}</p>
          {q.data ? <p className="text-lg font-semibold tnum">{fmtDate(q.data.date, 'EEEE, dd MMMM yyyy')}</p> : <Skeleton className="h-6 w-48" />}
        </div>
        {r ? <span className="flex flex-wrap items-center gap-1.5"><AttendanceStatusBadge status={r.status} /><FlagChips flags={r.flags} max={3} size="xs" /></span> : null}
      </div>
      {q.isLoading ? <Skeleton className="h-16 w-full" /> : r ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            [t('home.shift'), r.shiftName ?? t('home.noShift'), r.expectedStartAt && r.expectedEndAt ? `${fmtTime(r.expectedStartAt, tz)} – ${fmtTime(r.expectedEndAt, tz)}` : undefined],
            [t('home.firstIn'), fmtTime(r.firstInAt, tz)],
            [t('home.lastOut'), fmtTime(r.lastOutAt, tz)],
            [t('home.worked'), fmtMinutes(r.workedMinutes)],
            [t('home.late'), fmtMinutes(r.lateMinutes)],
          ].map(([label, value, sub]) => (
            <div key={label} className="min-w-0 rounded-md border bg-muted/30 p-2.5">
              <dt className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
              <dd className="truncate text-sm font-semibold tnum" dir="auto">{value}</dd>
              {sub ? <dd className="truncate text-xs text-muted-foreground tnum" dir="ltr">{sub}</dd> : null}
            </div>
          ))}
        </dl>
      ) : (
        <div className="flex items-center gap-3 rounded-md border border-dashed p-4 text-sm"><Clock className="size-5 shrink-0 text-muted-foreground" aria-hidden /><div><p className="font-medium">{t('home.todayEmpty')}</p><p className="text-xs text-muted-foreground">{t('home.todayEmptyHint')}</p></div></div>
      )}
    </Card>
  );
}

/** /my — the employee's home: today, this month, balances, upcoming leave, recent days and holidays. */
export default function PortalHomePage() {
  const { t } = useTranslation('portal');
  const navigate = useNavigate();
  const user = useMe().data?.user;
  const membership = useActiveMembership();
  const overview = useSelfOverview();
  const profile = useSelfProfile();
  const year = Number((overview.data?.date ?? DateTime.now().toISODate()!).slice(0, 4));
  const leave = useSelfLeave(year);
  const [applyOpen, setApplyOpen] = useState(false);
  const d = overview.data;
  const m = d?.month.totals;
  const tz = d?.timezone ?? 'UTC';
  const name = firstName(profile.data?.displayName ?? user?.fullName);
  const part = daypart(DateTime.now().setZone(tz).hour);
  const role = [profile.data?.designation?.name, profile.data?.department?.name, profile.data?.branch?.name].filter(Boolean).join(' · ');

  if (overview.isError && !d) return <div className="page-container"><ErrorState error={overview.error} onRetry={() => void overview.refetch()} /></div>;

  return (
    <div className="page-container space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-[28px]">{name ? t(`greeting.${part}`, { name }) : t('greeting.anon')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{role || t('home.subtitle', { org: membership?.organization.displayName ?? '' })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void navigate('/my/attendance')}><CalendarCheck /> {t('home.viewAttendance')}</Button>
          <Button onClick={() => setApplyOpen(true)} disabled={!leave.data}><CalendarPlus /> {t('home.applyLeave')}</Button>
        </div>
      </div>

      {d && (d.pendingLeave > 0 || d.pendingCorrections > 0) ? (
        <div className="flex flex-wrap gap-2">
          {d.pendingLeave > 0 ? <Link to="/my/leave"><Badge variant="warning" dot>{t('home.pendingLeave', { count: d.pendingLeave })}</Badge></Link> : null}
          {d.pendingCorrections > 0 ? <Link to="/my/attendance?tab=corrections"><Badge variant="warning" dot>{t('home.pendingCorrections', { count: d.pendingCorrections })}</Badge></Link> : null}
        </div>
      ) : null}

      <PendingSelfItems overview={d} />
      <HomePunchCard overview={d} />

      <TodayCard />

      <section aria-label={t('home.thisMonth')}>
        <h2 className="mb-2 text-sm font-semibold">{t('home.thisMonth')} <span className="font-normal text-muted-foreground">· {d ? fmtDate(`${d.month.month}-01`, 'MMMM yyyy') : ''}</span></h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label={t('home.attendanceRate')} value={m?.attendanceRate === null || m?.attendanceRate === undefined ? '—' : `${Math.round(m.attendanceRate * 100)}%`} hint={m ? t('home.attendanceRateHint', { present: m.present + m.halfDay * 0.5, working: m.workingDays }) : undefined} icon={TrendingUp} tone="success" loading={overview.isLoading} onClick={() => void navigate('/my/attendance')} />
          <StatCard label={t('home.presentDays')} value={m ? fmtDays(m.present + m.halfDay * 0.5) : '—'} icon={CalendarCheck} loading={overview.isLoading} />
          <StatCard label={t('home.lateArrivals')} value={m?.late ?? '—'} hint={m && m.lateMinutes ? t('home.lateHint', { minutes: fmtMinutes(m.lateMinutes) }) : undefined} icon={AlarmClock} tone={m && m.late > 0 ? 'warning' : 'default'} loading={overview.isLoading} />
          <StatCard label={t('home.workedHours')} value={m ? fmtMinutes(m.workedMinutes) : '—'} icon={Clock} loading={overview.isLoading} />
          <StatCard label={t('home.overtime')} value={m ? fmtMinutes(m.overtimeMinutes) : '—'} icon={Hourglass} tone="info" loading={overview.isLoading} />
          <StatCard label={t('home.leaveDays')} value={m ? m.leave : '—'} icon={Palmtree} loading={overview.isLoading} onClick={() => void navigate('/my/leave')} />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <SectionTitle title={t('home.balances', { year })} to="/my/leave" linkLabel={t('home.seeAll')} />
          <CardContent className="space-y-4">
            {overview.isLoading ? <Skeleton className="h-24 w-full" /> : d && d.balances.length ? d.balances.map((b) => <BalanceRow key={b.leaveTypeId} b={b} name={b.name} color={b.color} />) : <p className="text-sm text-muted-foreground">{t('home.balancesEmpty')}</p>}
          </CardContent>
        </Card>

        <Card>
          <SectionTitle title={t('home.upcoming')} to="/my/leave" linkLabel={t('home.seeAll')} />
          <CardContent>
            {overview.isLoading ? <Skeleton className="h-24 w-full" /> : d && d.upcomingLeave.length ? (
              <ul className="divide-y">
                {d.upcomingLeave.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-medium"><TypeDot color={l.color} />{l.leaveTypeName}</p>
                      <p className="text-xs text-muted-foreground tnum">{l.startDate === l.endDate ? fmtDate(l.startDate, 'EEE dd MMM') : `${fmtDate(l.startDate, 'dd MMM')} → ${fmtDate(l.endDate, 'dd MMM')}`} · {fmtDays(l.days)}d</p>
                    </div>
                    <LeaveStatusBadge status={l.status} />
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={Palmtree} title={t('home.upcomingEmpty')} className="py-6" action={<Button size="sm" variant="outline" onClick={() => setApplyOpen(true)} disabled={!leave.data}>{t('home.applyLeave')}</Button>} />}
          </CardContent>
        </Card>

        <Card>
          <SectionTitle title={t('home.holidays')} />
          <CardContent>
            {overview.isLoading ? <Skeleton className="h-24 w-full" /> : d && d.upcomingHolidays.length ? (
              <ul className="divide-y">
                {d.upcomingHolidays.map((h) => (
                  <li key={`${h.date}-${h.name}`} className="flex items-center gap-3 py-2.5 first:pt-0">
                    <div className="flex size-10 shrink-0 flex-col items-center justify-center rounded-md bg-accent text-accent-foreground"><span className="text-[10px] font-semibold uppercase leading-none">{fmtDate(h.date, 'MMM')}</span><span className="text-sm font-bold leading-tight tnum">{fmtDate(h.date, 'd')}</span></div>
                    <div className="min-w-0"><p className="truncate text-sm font-medium" dir="auto">{h.name}</p><p className="text-xs text-muted-foreground tnum">{h.endDate && h.endDate !== h.date ? `${fmtDate(h.date, 'EEE dd MMM')} → ${fmtDate(h.endDate, 'EEE dd MMM')}` : fmtDate(h.date, 'EEEE')}</p></div>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon={PartyPopper} title={t('home.holidaysEmpty')} className="py-6" />}
          </CardContent>
        </Card>
      </div>

      {/* managers (leave.view_team): the team's upcoming leave */}
      <TeamUpcomingLeave />

      <Card>
        <SectionTitle title={t('home.recent')} to="/my/attendance?tab=log" linkLabel={t('home.seeAll')} />
        <CardContent>
          {overview.isLoading ? <Skeleton className="h-32 w-full" /> : d && d.recent.length ? (
            <ul className="divide-y">
              {d.recent.map((r) => (
                <li key={r.id}>
                  <Link to={`/my/attendance?month=${r.attendanceDate.slice(0, 7)}&tab=log&day=${r.id}`} className="grid grid-cols-[1fr_auto] items-center gap-2 py-2.5 hover:bg-accent/30 sm:grid-cols-[160px_1fr_auto_auto]">
                    <span className="text-sm font-medium tnum">{fmtDate(r.attendanceDate, 'EEE, dd MMM')}</span>
                    <span className="hidden sm:block"><AttendanceStatusBadge status={r.status} /></span>
                    <span className="hidden text-xs text-muted-foreground tnum sm:block" dir="ltr">{fmtTime(r.firstInAt, r.timezone)} – {fmtTime(r.lastOutAt, r.timezone)}</span>
                    <span className="text-end text-sm tnum">{fmtMinutes(r.workedMinutes)}<span className="ms-2 sm:hidden"><AttendanceStatusBadge status={r.status} /></span></span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <EmptyState icon={ClipboardList} title={t('home.recentEmpty')} className="py-6" />}
        </CardContent>
      </Card>

      <ApplyLeaveDialog key={String(applyOpen)} open={applyOpen} onOpenChange={setApplyOpen} data={leave.data} />
    </div>
  );
}

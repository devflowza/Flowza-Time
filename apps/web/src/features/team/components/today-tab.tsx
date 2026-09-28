import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarOff, Clock, LogIn, RefreshCw, Search, UserCheck, UsersRound, UserX } from 'lucide-react';
import type { TeamMemberTodayDto, TeamTotalsDto } from '@flowza/contracts';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton, StatCard } from '@/components/ui';
import { fmtMinutes, fmtRelative, fmtTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCan } from '@/features/me/use-me';
import { FlagChips } from '@/features/attendance/components/badges';
import { LeaveTypeDot } from '@/features/leave/components/leave-status';
import { useTeamSummary } from '../api';
import { TEAM_NS } from '../i18n';
import { TEAM_STATUS_TONE, filterMembers, needsSearch } from '../model';
import { MembersDirectory } from './members-directory';

const LIVE_DOT: Record<TeamMemberTodayDto['liveState'], string> = { IN: 'bg-emerald-500', OUT: 'bg-slate-400', NONE: 'bg-slate-300 dark:bg-slate-600' };

function Totals({ totals }: { totals: TeamTotalsDto }) {
  const { t } = useTranslation(TEAM_NS);
  const of = t('today.totals.ofReports', { count: totals.reports });
  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="team-totals">
      <StatCard label={t('today.totals.present')} value={totals.present} icon={UserCheck} tone="success" hint={`${of} · ${t('today.totals.presentHint')}`} />
      <StatCard label={t('today.totals.late')} value={totals.late} icon={Clock} tone="warning" hint={of} />
      <StatCard label={t('today.totals.absent')} value={totals.absent} icon={UserX} tone="danger" hint={of} />
      <StatCard label={t('today.totals.onLeave')} value={totals.onLeave} icon={CalendarOff} tone="info" hint={of} />
      <StatCard label={t('today.totals.missingPunch')} value={totals.missingPunch} icon={AlertTriangle} tone="danger" hint={of} />
      <StatCard label={t('today.totals.inNow')} value={totals.inNow} icon={LogIn} tone="default" hint={of} />
    </div>
  );
}

/** One report's day: status, in / out, live state, worked so far, leave, flags and what of theirs waits for the caller. */
export function MemberCard({ m, canOpenProfile, onOpenRecord, onPending }: { m: TeamMemberTodayDto; canOpenProfile: boolean; onOpenRecord: (recordId: string) => void; onPending: () => void }) {
  const { t } = useTranslation(TEAM_NS);
  const { t: tl } = useTranslation('leave');
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4" data-testid="team-member-card" data-status={m.status}>
      <div className="flex items-start gap-3">
        <Avatar name={m.employeeName} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{canOpenProfile ? <Link to={`/employees/${m.employeeId}`} className="hover:underline">{m.employeeName}</Link> : m.employeeName}</p>
          <p className="truncate text-xs text-muted-foreground">{m.designationName ?? m.departmentName ?? '—'} · <span className="font-mono" dir="ltr">{m.employeeNumber}</span></p>
        </div>
        <Badge variant={TEAM_STATUS_TONE[m.status]} dot data-testid="team-status">{t(`today.status.${m.status}`)}</Badge>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted-foreground">{t('today.firstIn')}</dt><dd className="font-medium tnum" dir="ltr">{fmtTime(m.firstInAt, m.timezone)}</dd></div>
        <div><dt className="text-muted-foreground">{t('today.lastOut')}</dt><dd className="font-medium tnum" dir="ltr">{fmtTime(m.lastOutAt, m.timezone)}</dd></div>
        <div><dt className="text-muted-foreground">{m.workedIsLive ? t('today.workedLive') : t('today.worked')}</dt><dd className="font-medium tnum">{fmtMinutes(m.workedMinutes)}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="live-state" data-state={m.liveState}>
          <span className={cn('size-2 rounded-full', LIVE_DOT[m.liveState], m.liveState === 'IN' && 'animate-pulse')} aria-hidden />{t(`today.live.${m.liveState}`)}
        </span>
        {m.leave ? <Badge variant="info"><LeaveTypeDot color={m.leave.color} />{m.leave.isHalfDay ? t('today.halfDay', { type: m.leave.leaveTypeName }) : m.leave.leaveTypeName}{m.leave.isHalfDay && m.leave.halfDayPart ? ` · ${tl(`halfDayParts.${m.leave.halfDayPart}`, { defaultValue: m.leave.halfDayPart })}` : ''}</Badge> : null}
        {m.lateMinutes > 0 ? <Badge variant="warning">{t('today.lateBy', { time: fmtMinutes(m.lateMinutes) })}</Badge> : null}
        {m.relation === 'secondary' ? <Badge variant="neutral">{t('relation.secondary')}</Badge> : null}
        <FlagChips flags={m.flags.filter((f) => f !== 'LATE')} max={2} size="xs" />
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        {m.pendingItems > 0 ? <button type="button" onClick={onPending} className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Badge variant="danger" data-testid="pending-badge">{t('today.pending', { count: m.pendingItems })}</Badge></button> : <span />}
        {m.recordId ? <Button size="sm" variant="ghost" onClick={() => onOpenRecord(m.recordId!)}>{t('today.openDay')}</Button> : <span className="text-xs text-muted-foreground">{t('today.noRecord')}</span>}
      </div>
    </Card>
  );
}

/**
 * Today's board of the caller's direct reports (Finance B-61): totals, one card per report, a search once the team is larger
 * than five. Refreshes every minute; a report's day is read in their branch zone.
 */
export function TodayTab({ enabled, onOpenRecord, onPending }: { enabled: boolean; onOpenRecord: (recordId: string) => void; onPending: () => void }) {
  const { t } = useTranslation(TEAM_NS);
  const can = useCan();
  const q = useTeamSummary(undefined, enabled);
  const [search, setSearch] = useState('');
  const members = useMemo(() => q.data?.members ?? [], [q.data]);
  const shown = useMemo(() => filterMembers(members, search), [members, search]);
  if (!enabled) {
    return (
      <div className="space-y-4">
        <p role="note" className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">{t('today.noAttendanceKey')}</p>
        <MembersDirectory />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) return <div className="space-y-4"><Skeleton className="h-24 w-full" /><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-44" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div></div>;
  const canOpenProfile = can('employee.view_team') || can('employee.view');
  return (
    <div className="space-y-4">
      <Totals totals={q.data.totals} />
      <div className="flex flex-wrap items-center gap-2">
        {needsSearch(members.length) ? (
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('today.searchPlaceholder')} aria-label={t('today.search')} className="ps-8" />
          </div>
        ) : null}
        <span className="ms-auto text-xs text-muted-foreground" aria-live="polite">{t('updated', { when: fmtRelative(q.data.generatedAt) })}</span>
        <Button size="sm" variant="outline" loading={q.isFetching} onClick={() => void q.refetch()}><RefreshCw /> {t('refresh')}</Button>
      </div>
      {members.length === 0 ? <EmptyState icon={UsersRound} title={t('today.empty')} description={t('today.emptyHint')} />
        : shown.length === 0 ? <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{t('today.noMatch', { search })}</p>
        : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t('tabs.today')}>
            {shown.map((m) => <MemberCard key={m.employeeId} m={m} canOpenProfile={canOpenProfile} onOpenRecord={onOpenRecord} onPending={onPending} />)}
          </div>
        )}
    </div>
  );
}

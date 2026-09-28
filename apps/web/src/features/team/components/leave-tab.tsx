import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import type { TeamLeaveDto } from '@flowza/contracts';
import { Button, Card, CardContent, EmptyState, ErrorState, Label, Switch, TableSkeleton } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveMembership, useOrgTimezone } from '@/features/me/use-me';
import { LeaveStatusBadge, LeaveTypeDot } from '@/features/leave/components/leave-status';
import { fmtLeaveDays, monthDates, shiftLeaveMonth, weekdayOf } from '@/features/leave/model';
import { useTeamLeave } from '../api';
import { TEAM_NS } from '../i18n';
import { leaveOn, leaveRows, monthBounds } from '../model';

const range = (l: TeamLeaveDto) => (l.startDate === l.endDate ? fmtDate(l.startDate, 'EEE dd MMM') : `${fmtDate(l.startDate, 'dd MMM')} → ${fmtDate(l.endDate, 'dd MMM')}`);

/** Finance B-62: the team's leave ending today or later, soonest first — the card is not rendered at all when there is none. */
function UpcomingCard({ items }: { items: TeamLeaveDto[] }) {
  const { t } = useTranslation(TEAM_NS);
  const { t: tl } = useTranslation('leave');
  if (items.length === 0) return null;
  return (
    <Card data-testid="team-upcoming-leave">
      <div className="px-5 pt-4 pb-2"><h2 className="text-sm font-semibold">{t('leave.upcoming')}</h2><p className="text-xs text-muted-foreground">{t('leave.upcomingHint')}</p></div>
      <CardContent>
        <ul className="divide-y" aria-label={t('leave.upcoming')}>
          {items.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{l.employeeName}</p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground tnum"><LeaveTypeDot color={l.color} />{l.leaveTypeName} · {range(l)}{l.days !== null ? ` · ${tl('team.days', { count: l.days, days: fmtLeaveDays(l.days) })}` : ''}</p>
              </div>
              <LeaveStatusBadge status={l.status} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Cell({ items, date }: { items: TeamLeaveDto[]; date: string }) {
  const { t } = useTranslation('leave');
  if (!items.length) return null;
  const label = items.map((e) => `${e.leaveTypeName} · ${t(`status.${e.status}`, { defaultValue: e.status })}${e.isHalfDay && e.halfDayPart ? ` · ${t(`halfDayParts.${e.halfDayPart}`)}` : ''}`).join('\n');
  return (
    <span className="flex h-6 w-full flex-col gap-px" title={`${fmtDate(date)}\n${label}`} aria-label={label}>
      {items.map((e) => <span key={e.id} className={cn('min-h-0 flex-1 rounded-sm', e.status !== 'APPROVED' && 'border border-dashed border-foreground/40 opacity-60')} style={{ backgroundColor: e.color ?? '#94a3b8' }} data-status={e.status} />)}
    </span>
  );
}

/**
 * Leave of the caller's direct reports (/team/leave): the upcoming-leave card, what waits for the caller (a link into the
 * Approvals tab) and the month calendar of Prompt 7 — one row per report with leave in the month, cells coloured by the
 * leave type, pending / info-requested drawn dashed.
 */
export function LeaveTab({ onOpenApprovals }: { onOpenApprovals: () => void }) {
  const { t } = useTranslation(TEAM_NS);
  const tz = useOrgTimezone();
  const weeklyOff = useActiveMembership()?.organization.weeklyOffDays ?? [];
  const [month, setMonth] = useState(() => todayIso(tz).slice(0, 7));
  const [includePending, setIncludePending] = useState(true);
  const { from, to } = monthBounds(month);
  const q = useTeamLeave(from, to);
  const dates = useMemo(() => monthDates(month), [month]);
  const entries = useMemo(() => (q.data?.entries ?? []).filter((e) => includePending || e.status === 'APPROVED'), [q.data, includePending]);
  const rows = useMemo(() => leaveRows(entries), [entries]);
  const legend = useMemo(() => [...new Map(entries.map((e) => [e.leaveTypeId, e])).values()], [entries]);
  const today = q.data?.today ?? todayIso(tz);
  const pending = q.data?.pendingForMe ?? 0;
  return (
    <div className="space-y-4">
      {pending > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100" role="status" data-testid="team-leave-pending">
          <span className="inline-flex items-center gap-2"><Inbox className="size-4" aria-hidden />{t('leave.pendingForMe', { count: pending })}</span>
          <Button size="sm" variant="outline" onClick={onOpenApprovals}>{t('leave.review')}</Button>
        </div>
      ) : null}
      <UpcomingCard items={q.data?.upcoming ?? []} />
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="me-2 text-sm font-semibold">{t('leave.calendar')}</h2>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="outline" className="size-8" aria-label={t('leave.previous')} onClick={() => setMonth((m) => shiftLeaveMonth(m, -1))}><ChevronLeft className="rtl:rotate-180" /></Button>
            <span className="min-w-36 text-center text-sm font-semibold tnum" aria-live="polite">{fmtDate(`${month}-01`, 'MMMM yyyy')}</span>
            <Button size="icon" variant="outline" className="size-8" aria-label={t('leave.next')} onClick={() => setMonth((m) => shiftLeaveMonth(m, 1))}><ChevronRight className="rtl:rotate-180" /></Button>
          </div>
          <div className="flex items-center gap-2"><Switch id="team-leave-pending" checked={includePending} onCheckedChange={setIncludePending} /><Label htmlFor="team-leave-pending" className="text-sm">{t('leave.includePending')}</Label></div>
          {legend.length ? <ul className="ms-auto flex flex-wrap gap-3 text-xs">{legend.map((e) => <li key={e.leaveTypeId} className="flex items-center gap-1.5"><LeaveTypeDot color={e.color} />{e.leaveTypeName}</li>)}</ul> : null}
        </div>
        <div className="rounded-lg border bg-card shadow-card">
          {q.isError ? <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
            : q.isLoading ? <TableSkeleton cols={8} rows={4} />
            : rows.length === 0 ? <div className="p-4"><EmptyState icon={CalendarDays} title={t('leave.empty')} description={t('leave.emptyHint')} /></div>
            : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs" aria-label={t('leave.calendar')} data-testid="team-leave-calendar">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th scope="col" className="sticky start-0 z-10 min-w-44 bg-muted/50 px-3 py-2 text-start font-semibold">{t('attendance.columns.employee')}</th>
                      {dates.map((d) => <th key={d} scope="col" className={cn('min-w-7 px-0.5 py-2 text-center font-medium tnum', weeklyOff.includes(weekdayOf(d)) && 'bg-muted', d === today && 'text-primary')}>{d.slice(8)}</th>)}
                      <th scope="col" className="px-2 py-2 text-end font-semibold">{t('leave.days')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.employeeId} className="border-b last:border-0">
                        <th scope="row" className="sticky start-0 z-10 bg-card px-3 py-1.5 text-start font-normal"><span className="block truncate font-medium">{r.employeeName}</span><span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{r.employeeNumber}</span></th>
                        {dates.map((d) => <td key={d} className={cn('px-0.5 py-1', weeklyOff.includes(weekdayOf(d)) && 'bg-muted/60')}><Cell items={leaveOn(r.entries, d)} date={d} /></td>)}
                        <td className="px-2 text-end tnum">{fmtLeaveDays(r.entries.reduce((a, e) => a + (e.days ?? 0), 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

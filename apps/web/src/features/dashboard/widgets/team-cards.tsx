import { useTranslation } from 'react-i18next';
import { CalendarOff, Clock } from 'lucide-react';
import type { TeamMemberTodayDto } from '@flowza/contracts';
import { Avatar, ErrorState } from '@/components/ui';
import { fmtMinutes, fmtTime } from '@/lib/format';
import { LeaveTypeDot } from '@/features/leave/components/leave-status';
import { useTeamSummary } from '@/features/team/api';
import { ViewAllLink, WidgetCard, WidgetEmpty, WidgetRowsSkeleton } from './widget-card';

const LIMIT = 6;

function MemberRows({ members, trailing }: { members: TeamMemberTodayDto[]; trailing: (m: TeamMemberTodayDto) => React.ReactNode }) {
  return (
    <ul className="divide-y">
      {members.slice(0, LIMIT).map((m) => (
        <li key={m.employeeId} className="flex items-center gap-3 px-2 py-2">
          <Avatar name={m.employeeName} className="size-8" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{m.employeeName}</span><span className="block truncate text-xs text-muted-foreground">{m.designationName ?? m.departmentName ?? ''}</span></span>
          <span className="shrink-0 text-end text-xs text-muted-foreground tnum">{trailing(m)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The team board of the dashboard's date (HR portal Prompt 5), both cards on ONE query — the same one the team page's Today tab
 * uses for today (a report's today is read in their branch zone), so the dashboard adds no request of its own there.
 */
function useBoard(date: string, isToday: boolean) {
  return useTeamSummary(isToday ? undefined : date);
}

/** "Team on leave today": direct reports with approved leave covering the day. */
export function TeamOnLeaveCard({ date, isToday, className }: { date: string; isToday: boolean; className?: string }) {
  const { t } = useTranslation('dashboard');
  const q = useBoard(date, isToday);
  const members = (q.data?.members ?? []).filter((m) => m.status === 'on_leave' || m.leave !== null);
  return (
    <WidgetCard title={isToday ? t('team.onLeaveTitle') : t('team.onLeaveTitleOn')} icon={CalendarOff} className={className} action={<ViewAllLink to="/team?tab=leave" label={t('approvals.viewAll')} />} bodyClassName="px-3">
      {q.isError ? <div className="px-2"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-2"><WidgetRowsSkeleton rows={2} /></div> : members.length === 0 ? (
        <div className="px-2"><WidgetEmpty icon={CalendarOff} title={t('team.onLeaveEmpty')} /></div>
      ) : (
        <div data-testid="team-on-leave">
          <MemberRows members={members} trailing={(m) => m.leave ? <span className="inline-flex items-center gap-1.5"><LeaveTypeDot color={m.leave.color} />{m.leave.leaveTypeName}{m.leave.isHalfDay ? ` · ${t('team.halfDay')}` : ''}</span> : null} />
          {members.length > LIMIT ? <p className="px-2 pt-1 text-xs text-muted-foreground">{t('team.more', { count: members.length - LIMIT })}</p> : null}
        </div>
      )}
    </WidgetCard>
  );
}

/** "Team late today": direct reports who arrived after their grace time, with how late and when they came in. */
export function TeamLateCard({ date, isToday, className }: { date: string; isToday: boolean; className?: string }) {
  const { t } = useTranslation('dashboard');
  const q = useBoard(date, isToday);
  const members = (q.data?.members ?? []).filter((m) => m.status === 'late').sort((a, b) => b.lateMinutes - a.lateMinutes);
  return (
    <WidgetCard title={isToday ? t('team.lateTitle') : t('team.lateTitleOn')} icon={Clock} className={className} action={<ViewAllLink to="/team" label={t('approvals.viewAll')} />} bodyClassName="px-3">
      {q.isError ? <div className="px-2"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div> : q.isLoading ? <div className="px-2"><WidgetRowsSkeleton rows={2} /></div> : members.length === 0 ? (
        <div className="px-2"><WidgetEmpty icon={Clock} title={t('team.lateEmpty')} /></div>
      ) : (
        <div data-testid="team-late">
          <MemberRows members={members} trailing={(m) => <><span className="block font-medium text-amber-700 dark:text-amber-300">{t('team.lateBy', { time: fmtMinutes(m.lateMinutes) })}</span><span className="block" dir="ltr">{fmtTime(m.firstInAt, m.timezone)}</span></>} />
          {members.length > LIMIT ? <p className="px-2 pt-1 text-xs text-muted-foreground">{t('team.more', { count: members.length - LIMIT })}</p> : null}
        </div>
      )}
    </WidgetCard>
  );
}

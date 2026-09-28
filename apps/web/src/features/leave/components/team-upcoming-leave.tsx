import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, ErrorState, Skeleton } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { useActiveMembership, useCan } from '@/features/me/use-me';
import { useTeamLeave } from '@/features/portal/leave-api';
import { fmtLeaveDays } from '../model';
import { LeaveStatusBadge, LeaveTypeDot } from './leave-status';

/**
 * A manager's view on /my: the team's approved or pending leave that ends today or later (at most 20). Shown only to members
 * with direct reports who hold leave.view_team; the API scopes the list to the caller's team. Hidden when there is nothing
 * to show (Finance parity B-62, leave v2 review P2-7) — it stays while loading and on error, so a failure is visible.
 */
export function TeamUpcomingLeave() {
  const { t } = useTranslation('leave');
  const can = useCan();
  const membership = useActiveMembership();
  const visible = !!membership?.isManager && can('leave.view_team');
  const q = useTeamLeave(visible);
  const ln = useLocalName();
  if (!visible) return null;
  if (q.isSuccess && (q.data?.length ?? 0) === 0) return null;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
        <h2 className="text-sm font-semibold">{t('team.title')}</h2>
        {can('leave.view') ? <Link to="/leave?tab=calendar" className="text-xs font-medium text-primary hover:underline">{t('team.calendar')}</Link> : null}
      </div>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-24 w-full" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data && q.data.length ? (
          <ul className="divide-y" aria-label={t('team.title')}>
            {q.data.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{l.employeeName}</p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground tnum"><LeaveTypeDot color={l.color} />{ln(l.leaveTypeName, l.leaveTypeNameAr)} · {l.startDate === l.endDate ? fmtDate(l.startDate, 'EEE dd MMM') : `${fmtDate(l.startDate, 'dd MMM')} → ${fmtDate(l.endDate, 'dd MMM')}`}{l.days !== null ? ` · ${t('team.days', { count: l.days, days: fmtLeaveDays(l.days) })}` : ''}</p>
                </div>
                <LeaveStatusBadge status={l.status} />
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

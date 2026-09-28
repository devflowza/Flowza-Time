import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { usePendingCounts, useTeamAccess } from '../api';
import { TEAM_NS } from '../i18n';

/**
 * The manager / approver chip next to the notification bell (Finance B-63): `team/pending-counts.total` — the approval
 * requests waiting for the caller (exactly /me.approvals.actionable) plus the attendance reasons they may review as the
 * mapped line manager — refreshed every minute and when the window regains focus; the tooltip splits the two halves.
 * Nothing renders while nothing waits, or for a member who is neither a manager nor an approver.
 */
export function PendingChip() {
  const { t } = useTranslation(TEAM_NS);
  const access = useTeamAccess();
  const q = usePendingCounts(access.pendingChip);
  const total = q.data?.total ?? 0;
  const approvals = q.data?.approvals ?? 0;
  const notes = q.data?.notes ?? 0;
  if (!access.pendingChip || !(total > 0)) return null;
  // only reasons waiting: a line manager reviews them on /team, anybody else on the review page
  const to = approvals === 0 && notes > 0 ? (access.hasReports ? '/team?tab=approvals' : '/attendance/notes') : access.approvalsHome;
  const label = t('chip.label', { count: total });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to={to} aria-label={`${label} · ${t('chip.split', { approvals, notes })}`} data-testid="pending-chip"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <ClipboardCheck className="size-3.5" aria-hidden />
          <span className="tnum">{total > 99 ? '99+' : total}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="font-medium">{label}</p>
        <p>{t('chip.split', { approvals, notes })}</p>
      </TooltipContent>
    </Tooltip>
  );
}

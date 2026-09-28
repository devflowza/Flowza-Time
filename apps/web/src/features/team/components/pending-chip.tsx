import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ClipboardCheck } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { TEAM_NS } from '../i18n';
import { useWaitingForYou, waitingBreakdown } from '../waiting';

/**
 * The manager / approver chip next to the notification bell (Finance B-63): THE "waiting for you" number (`useWaitingForYou`
 * — the same figure as the sidebar badge, the dashboard KPI and the "Awaiting your approval" widget), refreshed every minute
 * and when the window regains focus; the tooltip splits it into its halves, pluralised, a zero half left out. Nothing
 * renders while nothing waits, or for a member who is neither a manager nor an approver.
 */
export function PendingChip() {
  const { t } = useTranslation(TEAM_NS);
  const w = useWaitingForYou();
  if (!w.enabled || !(w.total > 0)) return null;
  const label = t('chip.label', { count: w.total });
  const split = waitingBreakdown(t, w);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to={w.to} aria-label={split ? `${label} · ${split}` : label} data-testid="pending-chip"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <ClipboardCheck className="size-3.5" aria-hidden />
          <span className="tnum">{w.total > 99 ? '99+' : w.total}</span>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="font-medium">{label}</p>
        {split ? <p>{split}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

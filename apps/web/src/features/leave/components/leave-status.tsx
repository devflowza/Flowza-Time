import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { LEAVE_STATUS_TONE } from '../model';

const INDIGO = 'bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200';

/**
 * One colour per leave status, everywhere (HR Leave page, portal, team views): approved emerald, rejected red, pending amber,
 * cancelled slate — and "info requested" indigo (the badge has no indigo variant; the class overrides the neutral one).
 */
export function LeaveStatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useTranslation('leave');
  return (
    <Badge variant={LEAVE_STATUS_TONE[status] ?? 'neutral'} dot className={cn(status === 'INFO_REQUESTED' && INDIGO, className)} data-status={status}>
      {t(`status.${status}`, { defaultValue: status })}
    </Badge>
  );
}

/** The leave type's own colour; types without one fall back to a neutral token. */
export function LeaveTypeDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full bg-muted-foreground/50', className)} style={color ? { backgroundColor: color } : undefined} aria-hidden />;
}

import { useTranslation } from 'react-i18next';
import { UserRoundX, UsersRound } from 'lucide-react';
import type { UserLimitDto } from '@flowza/contracts';
import { UserLimitMeter } from '@/components/user-limit-meter';
import { fmtNumber } from '@/lib/format';
import { USER_LIMIT_WARN_PERCENT, userLimitPercent } from '@/lib/user-limit';
import { cn } from '@/lib/utils';

/**
 * "Maximum users reached" (red) once the tenant uses every user the platform set, or "N users left" (amber) close to it —
 * on the screens that add employees. Nothing without a limit, below the warning share, or while the limit is unknown.
 */
export function UserLimitBanner({ value, className }: { value: UserLimitDto | undefined; className?: string }) {
  const { t } = useTranslation();
  if (!value || value.limit === null) return null;
  const pct = userLimitPercent(value) ?? 0;
  if (!value.reached && pct < USER_LIMIT_WARN_PERCENT) return null;
  const vars = { used: fmtNumber(value.used), limit: fmtNumber(value.limit), remaining: fmtNumber(value.remaining ?? 0) };
  const Icon = value.reached ? UserRoundX : UsersRound;
  return (
    <div role={value.reached ? 'alert' : 'status'} data-testid="user-limit-banner"
      className={cn('mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm', value.reached
        ? 'border-red-300/60 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
        : 'border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200', className)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{value.reached ? t('userLimit.reachedTitle') : t('userLimit.nearTitle', vars)}</p>
        <p>{value.reached ? t('userLimit.reachedHint', vars) : t('userLimit.nearHint', vars)}</p>
        <UserLimitMeter value={value} size="sm" showStatus={false} className="max-w-sm pt-1" />
      </div>
    </div>
  );
}

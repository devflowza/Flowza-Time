import { useTranslation } from 'react-i18next';
import type { UserLimitDto } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtNumber } from '@/lib/format';
import { userLimitPercent } from '@/lib/user-limit';
import { cn } from '@/lib/utils';

/**
 * A tenant's licensed users against its user limit (only a platform admin changes it): "used / limit" with a bar that turns
 * amber from 80 % and red with "Max users reached" once no more users can be added.
 */
export function UserLimitMeter({ value, size = 'md', showStatus = true, className }: { value: UserLimitDto; size?: 'sm' | 'md'; showStatus?: boolean; className?: string }) {
  const { t } = useTranslation();
  const pct = userLimitPercent(value);
  const tone = value.reached ? 'bg-destructive' : pct !== null && pct >= 80 ? 'bg-amber-500' : 'bg-primary';
  const label = value.limit === null ? t('userLimit.usageNoLimit', { used: fmtNumber(value.used) }) : t('userLimit.usage', { used: fmtNumber(value.used), limit: fmtNumber(value.limit) });
  return (
    <div className={cn('min-w-0', className)} data-testid="user-limit-meter" data-reached={value.reached || undefined}>
      <div className={cn('flex flex-wrap items-center justify-between gap-x-2 gap-y-1', size === 'sm' ? 'text-xs' : 'text-sm')}>
        <span className="tnum font-medium">{label}</span>
        {!showStatus ? null : value.reached
          ? <Badge variant="danger">{t('userLimit.reached')}</Badge>
          : value.remaining !== null && size === 'md' ? <span className="text-xs text-muted-foreground">{t('userLimit.remaining', { remaining: fmtNumber(value.remaining) })}</span> : null}
      </div>
      {pct !== null ? (
        <div role="progressbar" aria-label={t('userLimit.title')} aria-valuemin={0} aria-valuemax={value.limit ?? undefined} aria-valuenow={value.used} aria-valuetext={label}
          className={cn('overflow-hidden rounded-full bg-muted', size === 'sm' ? 'mt-1 h-1.5' : 'mt-2 h-2')}>
          <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

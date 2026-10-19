import { useTranslation } from 'react-i18next';
import type { ShortLeaveContextDto } from '@flowza/contracts';
import { Badge } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { cn } from '@/lib/utils';
import { SL_NS } from '../i18n';
import { fmtDuration } from '../model';

/** The approvals inbox / detail context of a short leave: type, day and window, its length, the month's use of the type before it. */
export function ShortLeaveApprovalContext({ c, compact }: { c: ShortLeaveContextDto; compact: boolean }) {
  const { t } = useTranslation(SL_NS);
  const ln = useLocalName();
  const clip = cn('text-xs text-muted-foreground', compact && 'max-w-[260px] truncate');
  return (
    <div className="min-w-0 space-y-1 text-sm" data-testid="context-short-leave">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{ln(c.typeName, c.typeNameAr)}</span>
        <span className="tnum text-xs">{fmtDate(c.date)} · <span dir="ltr">{c.startTime}–{c.endTime}</span></span>
        <Badge variant="outline" className="tnum">{fmtDuration(c.minutes)}</Badge>
        {c.countsAsWork ? <Badge variant="secondary">{t('context.work')}</Badge> : null}
      </p>
      {c.monthQuotaMinutes !== null ? <p className="text-xs text-muted-foreground tnum">{t('context.quota', { used: fmtDuration(c.monthUsedMinutes), quota: fmtDuration(c.monthQuotaMinutes) })}</p> : null}
      {c.monthQuotaCount !== null ? <p className="text-xs text-muted-foreground tnum">{t('context.quotaCount', { used: c.monthUsedCount, quota: c.monthQuotaCount })}</p> : null}
      <p className={clip} title={c.reason} dir="auto">{c.reason}</p>
    </div>
  );
}

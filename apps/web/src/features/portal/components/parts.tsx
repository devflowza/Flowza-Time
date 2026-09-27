import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { UserX } from 'lucide-react';
import type { SelfLeaveBalanceDto } from '@flowza/contracts';
import { Badge, EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useEmployeeId } from '@/features/me/use-me';
import { balanceShares, fmtDays } from '../model';

const LEAVE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { APPROVED: 'success', PENDING: 'warning', REJECTED: 'danger', CANCELLED: 'neutral' };

export function LeaveStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('leave');
  return <Badge variant={LEAVE_TONE[status] ?? 'neutral'} dot>{t(`status.${status}`, { defaultValue: status })}</Badge>;
}

/** The leave type's own colour; types without one fall back to a neutral token. */
export function TypeDot({ color, className }: { color: string | null | undefined; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full bg-muted-foreground/50', className)} style={color ? { backgroundColor: color } : undefined} aria-hidden />;
}

/** Allowance bar: used (solid) and pending (striped) shares of the yearly allowance. */
export function BalanceRow({ b, name, color }: { b: SelfLeaveBalanceDto; name: string; color: string | null }) {
  const { t } = useTranslation('portal');
  const shares = balanceShares(b);
  const over = b.remainingDays !== null && b.remainingDays < 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-2 font-medium"><TypeDot color={color} /><span className="truncate">{name}</span></span>
        <span className={cn('shrink-0 text-xs tnum', over ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          {b.allowanceDays === null ? t('leave.usedOnly', { days: fmtDays(b.usedDays) }) : t('leave.remainingOf', { remaining: fmtDays(b.remainingDays ?? 0), allowance: fmtDays(b.allowanceDays) })}
        </span>
      </div>
      {shares ? (
        <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${t('leave.used')} ${fmtDays(b.usedDays)} · ${t('leave.pending')} ${fmtDays(b.pendingDays)}`}>
          <div className="h-full bg-primary" style={{ width: `${shares.used * 100}%`, backgroundColor: color ?? undefined }} />
          <div className="h-full bg-primary/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgb(255_255_255/0.45)_3px,rgb(255_255_255/0.45)_6px)]" style={{ width: `${shares.pending * 100}%`, backgroundColor: color ? `${color}66` : undefined }} />
        </div>
      ) : null}
      {b.pendingDays > 0 ? <p className="text-[11px] text-muted-foreground tnum">{t('leave.pending')}: {fmtDays(b.pendingDays)}</p> : null}
    </div>
  );
}

/** Portal pages act on the membership's employee link; without one there is nothing to show. */
export function RequireEmployeeLink({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('portal');
  const { t: tc } = useTranslation();
  const employeeId = useEmployeeId();
  if (!employeeId) return <div className="page-container"><EmptyState icon={UserX} title={t('notLinked.title')} description={t('notLinked.hint')} action={<Link to="/" className="text-sm font-medium text-primary hover:underline">{tc('nav.dashboard')}</Link>} /></div>;
  return <>{children}</>;
}

/** Card section header with an optional trailing link. */
export function SectionTitle({ title, to, linkLabel }: { title: string; to?: string; linkLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-5 pt-4 pb-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {to && linkLabel ? <Link to={to} className="text-xs font-medium text-primary hover:underline">{linkLabel}</Link> : null}
    </div>
  );
}

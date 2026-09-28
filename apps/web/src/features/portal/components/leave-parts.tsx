import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarCheck, CalendarClock, CalendarRange, Hourglass, Wallet } from 'lucide-react';
import type { SelfLeaveBalanceDto, SelfLeaveDto, SelfLeaveRecordDto } from '@flowza/contracts';
import { Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, StatCard, Textarea } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { toastMutationError } from '@/features/attendance/period-locked';
import { LeaveThread } from '@/features/leave/components/leave-thread';
import { LeaveStatusBadge } from '@/features/leave/components/leave-status';
import { useSelfLeaveActions } from '../leave-api';
import { balanceShares, fmtDays } from '../model';
import { TypeDot } from './parts';

/** The five tiles of /my/leave: entitlement, used, pending, available, accrued to date (ordinary tracked types summed). */
export function LeaveTotalsTiles({ data, loading }: { data: SelfLeaveDto | undefined; loading: boolean }) {
  const { t } = useTranslation('leave');
  const tot = data?.totals;
  const v = (n: number | undefined) => (n === undefined ? '—' : fmtDays(n));
  return (
    <section aria-label={t('portal.totals')} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <StatCard label={t('portal.tiles.entitlement')} value={v(tot?.entitlementDays)} icon={Wallet} loading={loading} />
      <StatCard label={t('portal.tiles.used')} value={v(tot?.takenDays)} icon={CalendarCheck} tone="success" loading={loading} />
      <StatCard label={t('portal.tiles.pending')} value={v(tot?.pendingDays)} icon={Hourglass} tone="warning" loading={loading} />
      <StatCard label={t('portal.tiles.available')} value={v(tot?.availableDays)} icon={CalendarRange} tone="info" loading={loading} />
      <StatCard label={t('portal.tiles.accrued')} value={v(tot?.accruedToDateDays)} icon={CalendarClock} loading={loading} />
    </section>
  );
}

/** One card per leave type: what is available, of what, and how it is made up (carry-forward and its expiry, accrual). */
export function LeaveTypeBalanceCard({ b, name, color }: { b: SelfLeaveBalanceDto; name: string; color: string | null }) {
  const { t } = useTranslation('leave');
  const { t: tp } = useTranslation('portal');
  const tracked = b.tracked ?? b.allowanceDays !== null;
  const available = b.availableDays ?? b.remainingDays;
  const shares = tracked ? balanceShares(b) : null;
  const over = b.remainingDays !== null && b.remainingDays < 0;
  return (
    <Card className="space-y-2 p-4" data-testid="leave-type-card">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><TypeDot color={color} /><span className="truncate">{name}</span></p>
        {b.accrual === 'monthly' ? <span className="text-[11px] text-muted-foreground">{t('portal.monthly')}</span> : null}
      </div>
      {tracked ? (
        <>
          <p className="flex items-baseline gap-1.5"><span className={cn('text-2xl font-semibold tnum', over && 'text-destructive')}>{fmtDays(available ?? 0)}</span><span className="text-xs text-muted-foreground">{t('portal.available')}</span></p>
          {shares ? (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${tp('leave.used')} ${fmtDays(b.usedDays)} · ${tp('leave.pending')} ${fmtDays(b.pendingDays)}`}>
              <div className="h-full bg-primary" style={{ width: `${shares.used * 100}%`, backgroundColor: color ?? undefined }} />
              <div className="h-full bg-primary/40" style={{ width: `${shares.pending * 100}%`, backgroundColor: color ? `${color}66` : undefined }} />
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs tnum">
            <dt className="text-muted-foreground">{t('portal.entitlement')}</dt><dd className="text-end">{fmtDays(b.allowanceDays ?? 0)}</dd>
            <dt className="text-muted-foreground">{tp('leave.used')}</dt><dd className="text-end">{fmtDays(b.usedDays)}</dd>
            <dt className="text-muted-foreground">{tp('leave.pending')}</dt><dd className="text-end">{fmtDays(b.pendingDays)}</dd>
            {b.accrual === 'monthly' && b.accruedToDateDays !== null && b.accruedToDateDays !== undefined ? <><dt className="text-muted-foreground">{t('portal.accruedToDate')}</dt><dd className="text-end">{fmtDays(b.accruedToDateDays)}</dd></> : null}
          </dl>
          <p className={cn('text-[11px] tnum', over ? 'font-medium text-destructive' : 'text-muted-foreground')}>{tp('leave.remainingOf', { remaining: fmtDays(b.remainingDays ?? 0), allowance: fmtDays(b.allowanceDays ?? 0) })}</p>
          {b.carriedForwardDays ? <p className="text-[11px] text-muted-foreground">{b.carriedForwardExpiresOn ? t('portal.carriedExpiring', { days: fmtDays(b.carriedForwardDays), date: fmtDate(b.carriedForwardExpiresOn) }) : t('portal.carried', { days: fmtDays(b.carriedForwardDays) })}</p> : null}
          {b.carriedForwardExpiredDays ? <p className="text-[11px] text-muted-foreground">{t('portal.carriedExpired', { days: fmtDays(b.carriedForwardExpiredDays) })}</p> : null}
        </>
      ) : (
        <p className="flex flex-wrap gap-x-1 text-xs text-muted-foreground tnum"><span>{tp('leave.notTracked')}</span><span aria-hidden>·</span><span>{tp('leave.usedOnly', { days: fmtDays(b.usedDays) })}</span>{b.pendingDays > 0 ? <span>· {tp('leave.pending')}: {fmtDays(b.pendingDays)}</span> : null}</p>
      )}
    </Card>
  );
}

/** Withdraw a pending request: the reason is required and reaches the approvers and the timeline (B-98). */
export function WithdrawLeaveDialog({ record, onClose }: { record: SelfLeaveRecordDto | null; onClose: () => void }) {
  const { t } = useTranslation('leave');
  const { t: tp } = useTranslation('portal');
  const { t: tc } = useTranslation();
  const { withdraw } = useSelfLeaveActions();
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 3;
  const close = () => { setReason(''); onClose(); };
  const submit = () => {
    if (!record || !valid) return;
    withdraw.mutate({ id: record.id, reason: reason.trim() }, { onSuccess: () => { toast.success(tp('leave.withdrawn')); close(); }, onError: (e) => toastMutationError(e) });
  };
  return (
    <Dialog open={!!record} onOpenChange={(o) => !o && close()}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{tp('leave.withdrawTitle')}</DialogTitle><DialogDescription>{t('portal.withdrawHint')}</DialogDescription></DialogHeader>
        <FormField label={t('portal.withdrawReason')} htmlFor="leave-withdraw-reason" required hint={t('portal.withdrawReasonHint')}>
          <Textarea id="leave-withdraw-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>{tc('common.cancel')}</Button>
          <Button type="button" variant="destructive" disabled={!valid} loading={withdraw.isPending} onClick={submit}>{tp('leave.withdraw')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The conversation on a request: the approver's open question (answered here while the request is INFO_REQUESTED — the
 * answer sends it back to PENDING) and the whole thread.
 */
export function LeaveConversationDialog({ record, onClose }: { record: SelfLeaveRecordDto | null; onClose: () => void }) {
  const { t } = useTranslation('leave');
  const { reply } = useSelfLeaveActions();
  const r = record;
  return (
    <Dialog open={!!r} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('portal.conversationTitle')}</DialogTitle>
          <DialogDescription>{r ? `${r.leaveTypeName} · ${r.startDate === r.endDate ? fmtDate(r.startDate) : `${fmtDate(r.startDate, 'dd MMM')} → ${fmtDate(r.endDate)}`}` : null}</DialogDescription>
        </DialogHeader>
        {r ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2"><LeaveStatusBadge status={r.status} /></div>
            {r.infoRequest ? (
              <div className="rounded-md border border-indigo-300 bg-indigo-50 p-3 text-sm text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100" role="status">
                <p className="font-medium">{r.infoRequest.askedByName ? t('portal.askedBy', { name: r.infoRequest.askedByName }) : t('portal.asked')}</p>
                <p className="mt-1 whitespace-pre-wrap" dir="auto">{r.infoRequest.message}</p>
              </div>
            ) : null}
            <LeaveThread leaveId={r.id} reply={r.canReply ? { onSubmit: (body) => reply.mutateAsync({ id: r.id, body }).then(() => onClose()), pending: reply.isPending } : undefined} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

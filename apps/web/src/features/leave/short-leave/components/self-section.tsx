import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Clock3, GitCommitVertical, Plus, Undo2 } from 'lucide-react';
import type { TimeOffRequestDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, ConfirmDialog, EmptyState, ErrorState, FormField, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton, Textarea } from '@/components/ui';
import { fmtDate, todayIso } from '@/lib/format';
import { useLocalName } from '@/lib/local-name';
import { toast } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useSelfTimeOff, useSelfTimeOffActions } from '../api';
import { SL_NS } from '../i18n';
import { fmtDuration } from '../model';
import { SelfShortLeaveDialog } from './request-dialog';
import { ShortLeaveStatusBadge } from './requests-tab';

const shiftMonth = (month: string, delta: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

function WithdrawDialog({ request, onClose }: { request: TimeOffRequestDto | null; onClose: () => void }) {
  const { t } = useTranslation(SL_NS);
  const navigate = useNavigate();
  const { withdraw } = useSelfTimeOffActions();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog open={!!request} onOpenChange={(o) => { if (!o) { setReason(''); onClose(); } }} title={t('portal.withdrawTitle')} description={t('portal.withdrawHint')} confirmLabel={t('portal.withdraw')} destructive loading={withdraw.isPending}
      onConfirm={() => {
        if (!request || reason.trim().length < 3) return;
        withdraw.mutate({ id: request.id, reason: reason.trim() }, { onSuccess: () => { toast.success(t('portal.withdrawn')); setReason(''); onClose(); }, onError: (e) => toastMutationError(e, navigate) });
      }}>
      <FormField label={t('fields.reason')} htmlFor="slw-reason" required>
        <Textarea id="slw-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
      </FormField>
    </ConfirmDialog>
  );
}

/**
 * The employee's short leave on /my/leave: the month's requests with their status (and the way into the approval timeline),
 * the month's quota use per type, the reduced daily hours in force, a new request and withdrawing a pending one.
 */
export function SelfShortLeaveSection({ onTimeline }: { onTimeline?: (requestId: string) => void }) {
  const { t } = useTranslation(SL_NS);
  const tz = useOrgTimezone();
  const ln = useLocalName();
  const thisMonth = todayIso(tz).slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const q = useSelfTimeOff(month);
  const [open, setOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState<TimeOffRequestDto | null>(null);
  const data = q.data;
  const quotas = (data?.usage ?? []).filter((u) => u.quotaMinutes !== null || u.quotaCount !== null);
  const typeName = (id: string) => { const x = data?.types.find((y) => y.id === id); return x ? ln(x.name, x.nameAr) : ''; };
  const row = (r: TimeOffRequestDto) => ({
    type: <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">{ln(r.typeName, r.typeNameAr)}{r.countsAsWork ? <Badge variant="secondary" className="font-normal">{t('context.work')}</Badge> : null}</span>,
    when: <span className="whitespace-nowrap text-xs tnum">{fmtDate(r.date, 'EEE dd MMM')} · <span dir="ltr">{r.startTime}–{r.endTime}</span> · {fmtDuration(r.minutes)}</span>,
    actions: (
      <span className="flex flex-wrap justify-end gap-1">
        {r.approvalRequestId && onTimeline ? <Button size="sm" variant="ghost" onClick={() => onTimeline(r.approvalRequestId!)} aria-label={t('requests.columns.approval')}><GitCommitVertical /></Button> : null}
        {r.canWithdraw ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(r)}><Undo2 /> {t('portal.withdraw')}</Button> : null}
      </span>
    ),
  });
  return (
    <Card data-testid="self-short-leave">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-2">
        <div><h2 className="text-sm font-semibold">{t('portal.title')}</h2><p className="text-xs text-muted-foreground">{t('portal.hint')}</p></div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label={t('portal.month')}><ChevronLeft className="rtl:rotate-180" /></Button>
          <span className="w-24 text-center text-sm tnum" data-testid="short-leave-month">{fmtDate(`${month}-01`, 'MMM yyyy')}</span>
          <Button size="icon" variant="ghost" className="size-8" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label={t('portal.month')}><ChevronRight className="rtl:rotate-180" /></Button>
          <Button size="sm" className="ms-2" onClick={() => setOpen(true)} disabled={!data}><Plus /> {t('portal.request')}</Button>
        </div>
      </div>
      <CardContent className="space-y-3 px-0 pb-0">
        {quotas.length || data?.allowances.length ? (
          <div className="flex flex-wrap gap-2 px-5 text-xs">
            {quotas.map((u) => (
              <Badge key={u.typeId} variant="outline" className="font-normal tnum">{typeName(u.typeId)}: {u.quotaMinutes !== null ? t('portal.usage', { used: fmtDuration(u.usedMinutes), quota: fmtDuration(u.quotaMinutes) }) : t('portal.usageCount', { used: u.usedCount, quota: u.quotaCount })}</Badge>
            ))}
            {(data?.allowances ?? []).map((a) => (
              <Badge key={a.id} variant="info" className="font-normal">{t('portal.allowances')}: {t('portal.allowanceLine', { kind: t(`allowances.kinds.${a.kind}`), minutes: fmtDuration(a.minutesPerDay), position: t(`allowances.positions.${a.position}`) })}{a.validTo ? ` · ${t('portal.allowanceUntil', { date: fmtDate(a.validTo) })}` : ''}</Badge>
            ))}
          </div>
        ) : null}
        {q.isError && !data ? <div className="p-5 pt-0"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
          : q.isLoading ? <TableSkeleton cols={4} rows={2} />
          : !data || data.requests.length === 0 ? <div className="p-5 pt-0"><EmptyState icon={Clock3} title={t('portal.empty')} description={t('portal.emptyHint')} /></div>
          : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader><TableRow><TableHead>{t('requests.columns.type')}</TableHead><TableHead>{t('requests.columns.date')}</TableHead><TableHead>{t('requests.columns.reason')}</TableHead><TableHead>{t('requests.columns.status')}</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {data.requests.map((r) => { const x = row(r); return (
                      <TableRow key={r.id} data-testid={`short-leave-row-${r.id}`}>
                        <TableCell>{x.type}</TableCell>
                        <TableCell>{x.when}</TableCell>
                        <TableCell className="max-w-[240px] text-xs"><span className="block truncate" title={r.reason} dir="auto">{r.reason}</span>{r.decisionNote || r.cancelReason ? <span className="block truncate text-muted-foreground" dir="auto">{r.decisionNote ?? r.cancelReason}</span> : null}</TableCell>
                        <TableCell><span className="flex flex-wrap items-center gap-1"><ShortLeaveStatusBadge status={r.status} />{r.recordedByHr ? <Badge variant="outline" className="font-normal">{t('requests.recordedByHr')}</Badge> : null}</span></TableCell>
                        <TableCell className="text-end">{x.actions}</TableCell>
                      </TableRow>
                    ); })}
                  </TableBody>
                </Table>
              </div>
              <ul className="space-y-2 p-3 md:hidden">
                {data.requests.map((r) => { const x = row(r); return (
                  <li key={r.id} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">{x.type}<ShortLeaveStatusBadge status={r.status} /></div>
                    <p className="mt-1 text-muted-foreground">{x.when}</p>
                    <p className="mt-1 text-xs" dir="auto">{r.reason}</p>
                    <div className="mt-2">{x.actions}</div>
                  </li>
                ); })}
              </ul>
            </>
          )}
      </CardContent>
      <SelfShortLeaveDialog key={`sl-${String(open)}`} open={open} onOpenChange={setOpen} data={data} />
      <WithdrawDialog key={withdrawing?.id ?? 'none'} request={withdrawing} onClose={() => setWithdrawing(null)} />
    </Card>
  );
}

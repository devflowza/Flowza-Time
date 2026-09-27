import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, GitCommitVertical, Palmtree, Undo2 } from 'lucide-react';
import type { SelfLeaveRecordDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, ConfirmDialog, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useOrgTimezone } from '@/features/me/use-me';
import { toastMutationError } from '@/features/attendance/period-locked';
import { useSelfLeave, useSelfLeaveMutations } from '../api';
import { fmtDays } from '../model';
import { ApplyLeaveDialog } from '../components/apply-leave-dialog';
import { BalanceRow, LeaveStatusBadge, SectionTitle, TypeDot } from '../components/parts';
import { RequestDialog } from '@/features/approvals/components/request-detail';

function Dates({ r }: { r: SelfLeaveRecordDto }) {
  const { t } = useTranslation('leave');
  return (
    <span className="whitespace-nowrap text-xs tnum">
      {r.startDate === r.endDate ? fmtDate(r.startDate, 'EEE dd MMM yyyy') : `${fmtDate(r.startDate, 'dd MMM')} → ${fmtDate(r.endDate, 'dd MMM yyyy')}`}
      {r.isHalfDay ? <Badge variant="outline" className="ms-2">{r.halfDayPart ? t(`halfDayParts.${r.halfDayPart}`) : t('fields.halfDay')}</Badge> : null}
    </span>
  );
}

/** Where the request stands in the approval engine: the level it waits at, and the way into its timeline. */
function Approval({ r, onOpen }: { r: SelfLeaveRecordDto; onOpen: (id: string) => void }) {
  const { t } = useTranslation('portal');
  if (!r.approvalRequestId) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col items-start gap-1 text-xs">
      {r.approvalStatus === 'PENDING' && r.approvalStepCount ? <span className="tnum">{r.approvalStepCount > 1 ? t('leave.approvalLevel', { n: r.approvalCurrentStep ?? 1, count: r.approvalStepCount }) : t('leave.approvalWaiting')}</span> : null}
      <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={() => onOpen(r.approvalRequestId!)}><GitCommitVertical className="size-3.5" /> {t('leave.timeline')}</Button>
    </span>
  );
}

function Decision({ r }: { r: SelfLeaveRecordDto }) {
  const { t } = useTranslation('portal');
  if (!r.decisionNote && !r.approvedByName) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="block max-w-[240px] text-xs">
      {r.decisionNote ? <span className="block truncate" title={r.decisionNote}>{r.decisionNote}</span> : null}
      {r.approvedByName ? <span className="block truncate text-muted-foreground">{t('leave.decidedBy', { name: r.approvedByName })}</span> : null}
    </span>
  );
}

/** /my/leave?year=yyyy — balances, own requests (all statuses), where each stands in the approval engine (level, timeline) and the decisions; apply and withdraw. */
export default function MyLeavePage() {
  const { t } = useTranslation('portal');
  const tz = useOrgTimezone();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('year'));
  const year = Number.isInteger(requested) && requested >= thisYear - 5 && requested <= thisYear + 1 ? requested : thisYear;
  const q = useSelfLeave(year);
  const { withdraw } = useSelfLeaveMutations();
  const [applyOpen, setApplyOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState<SelfLeaveRecordDto | null>(null);
  const [timeline, setTimeline] = useState<string | null>(null);
  const data = q.data;
  const typeById = new Map((data?.types ?? []).map((x) => [x.id, x]));
  const balances = (data?.balances ?? []).filter((b) => b.allowanceDays !== null || b.usedDays > 0 || b.pendingDays > 0);
  const years = Array.from({ length: 7 }, (_, i) => thisYear + 1 - i);

  return (
    <div className="page-container space-y-5">
      <PageHeader title={t('leave.title')} description={t('leave.subtitle')}
        actions={<div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setParams({ year: v }, { replace: true })}>
            <SelectTrigger className="h-9 w-28" aria-label={t('leave.year')}><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={() => setApplyOpen(true)} disabled={!data}><CalendarPlus /> {t('leave.apply')}</Button>
        </div>} />

      {q.isError && !data ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="order-2 lg:order-1">
            <SectionTitle title={t('leave.requests')} />
            <CardContent className="px-0 pb-0">
              {q.isLoading ? <TableSkeleton cols={6} rows={4} /> : !data || data.records.length === 0 ? (
                <div className="p-5 pt-0"><EmptyState icon={Palmtree} title={t('leave.empty', { year })} description={t('leave.emptyHint')} action={<Button onClick={() => setApplyOpen(true)}><CalendarPlus /> {t('leave.apply')}</Button>} /></div>
              ) : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <Table>
                      <TableHeader><TableRow>{(['type', 'dates', 'days', 'reason', 'status', 'approval', 'decision', 'submitted'] as const).map((c) => <TableHead key={c}>{t(`leave.columns.${c}`)}</TableHead>)}<TableHead /></TableRow></TableHeader>
                      <TableBody>
                        {data.records.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell><span className="flex items-center gap-2 whitespace-nowrap text-sm font-medium"><TypeDot color={r.color} />{r.leaveTypeName}{!r.isPaid ? <Badge variant="outline">{t('leave.unpaid')}</Badge> : null}</span></TableCell>
                            <TableCell><Dates r={r} /></TableCell>
                            <TableCell className="text-sm tnum">{fmtDays(r.days)}</TableCell>
                            <TableCell className="max-w-[220px] text-xs"><span className="block truncate" title={r.reason ?? undefined}>{r.reason ?? '—'}</span></TableCell>
                            <TableCell><LeaveStatusBadge status={r.status} /></TableCell>
                            <TableCell><Approval r={r} onOpen={setTimeline} /></TableCell>
                            <TableCell><Decision r={r} /></TableCell>
                            <TableCell className="whitespace-nowrap text-xs tnum">{fmtDateTime(r.createdAt, tz, 'dd MMM yyyy')}</TableCell>
                            <TableCell className="text-end">{r.status === 'PENDING' ? <Button size="sm" variant="ghost" onClick={() => setWithdrawing(r)}><Undo2 /> {t('leave.withdraw')}</Button> : null}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <ul className="space-y-2 p-3 md:hidden">
                    {data.records.map((r) => (
                      <li key={r.id} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-2 font-medium"><TypeDot color={r.color} />{r.leaveTypeName}</span><LeaveStatusBadge status={r.status} /></div>
                        <p className="mt-1 text-xs text-muted-foreground"><Dates r={r} /> · {fmtDays(r.days)}d</p>
                        {r.reason ? <p className="mt-1 text-xs">{r.reason}</p> : null}
                        {r.decisionNote ? <p className="mt-1 text-xs text-muted-foreground">{r.decisionNote}</p> : null}
                        <div className="mt-2"><Approval r={r} onOpen={setTimeline} /></div>
                        {r.status === 'PENDING' ? <Button size="sm" variant="outline" className="mt-2" onClick={() => setWithdrawing(r)}><Undo2 /> {t('leave.withdraw')}</Button> : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="order-1 lg:order-2">
            <SectionTitle title={t('leave.balances', { year })} />
            <CardContent className="space-y-4">
              {q.isLoading ? <Skeleton className="h-32 w-full" /> : balances.length ? balances.map((b) => { const lt = typeById.get(b.leaveTypeId); return <BalanceRow key={b.leaveTypeId} b={b} name={lt?.name ?? ''} color={lt?.color ?? null} />; }) : <p className="text-sm text-muted-foreground">{t('home.balancesEmpty')}</p>}
            </CardContent>
          </Card>
        </div>
      )}

      <ApplyLeaveDialog key={String(applyOpen)} open={applyOpen} onOpenChange={setApplyOpen} data={data} />
      <RequestDialog requestId={timeline} onClose={() => setTimeline(null)} />
      <ConfirmDialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)} title={t('leave.withdrawTitle')} description={t('leave.withdrawHint')} confirmLabel={t('leave.withdraw')} destructive loading={withdraw.isPending}
        onConfirm={() => { if (!withdrawing) return; withdraw.mutate(withdrawing.id, { onSuccess: () => { toast.success(t('leave.withdrawn')); setWithdrawing(null); }, onError: (e) => toastMutationError(e) }); }} />
    </div>
  );
}

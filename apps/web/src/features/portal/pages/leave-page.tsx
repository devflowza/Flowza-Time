import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CalendarPlus, GitCommitVertical, HelpCircle, MessageSquare, MessageSquareReply, Palmtree, Pencil, Undo2 } from 'lucide-react';
import type { SelfLeaveRecordDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableSkeleton } from '@/components/ui';
import { fmtDate, fmtDateTime, todayIso } from '@/lib/format';
import { useOrgTimezone } from '@/features/me/use-me';
import { LeaveStatusBadge } from '@/features/leave/components/leave-status';
import { RequestDialog } from '@/features/approvals/components/request-detail';
import { useSelfLeave } from '../api';
import { fmtDays } from '../model';
import { ApplyLeaveDialog } from '../components/apply-leave-dialog';
import { CompOffCard } from '../components/comp-off';
import { LeaveConversationDialog, LeaveTotalsTiles, LeaveTypeBalanceCard, WithdrawLeaveDialog } from '../components/leave-parts';
import { SectionTitle, TypeDot } from '../components/parts';

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

/** What the employee may do with a request (the API says so per row; a pre-v2 API answer only allows withdrawing pending ones). */
const mayWithdraw = (r: SelfLeaveRecordDto) => r.canWithdraw ?? r.status === 'PENDING';
const mayEdit = (r: SelfLeaveRecordDto) => r.canEdit ?? false;

function RowActions({ r, onEdit, onWithdraw, onConversation }: { r: SelfLeaveRecordDto; onEdit: () => void; onWithdraw: () => void; onConversation: () => void }) {
  const { t } = useTranslation('leave');
  const { t: tp } = useTranslation('portal');
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {r.canReply ? <Button size="sm" variant="outline" onClick={onConversation}><MessageSquareReply /> {t('portal.reply')}</Button>
        : <Button size="sm" variant="ghost" onClick={onConversation} aria-label={t('portal.comments')}><MessageSquare />{r.commentCount ? <span className="tnum">{r.commentCount}</span> : null}</Button>}
      {mayEdit(r) ? <Button size="sm" variant="ghost" onClick={onEdit}><Pencil /> {t('portal.edit')}</Button> : null}
      {mayWithdraw(r) ? <Button size="sm" variant="ghost" onClick={onWithdraw}><Undo2 /> {tp('leave.withdraw')}</Button> : null}
    </span>
  );
}

/**
 * /my/leave?year=yyyy — the five totals, a card per leave type, own requests (all statuses) with where each stands in the
 * approval engine, the conversation with the approvers (questions answered here), comp-off credits; apply, edit, withdraw.
 */
export default function MyLeavePage() {
  const { t } = useTranslation('portal');
  const { t: tl } = useTranslation('leave');
  const tz = useOrgTimezone();
  const thisYear = Number(todayIso(tz).slice(0, 4));
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get('year'));
  const year = Number.isInteger(requested) && requested >= thisYear - 5 && requested <= thisYear + 1 ? requested : thisYear;
  const q = useSelfLeave(year);
  const [applyOpen, setApplyOpen] = useState(false);
  const [compOffOpen, setCompOffOpen] = useState(false);
  const [editing, setEditing] = useState<SelfLeaveRecordDto | null>(null);
  const [withdrawing, setWithdrawing] = useState<SelfLeaveRecordDto | null>(null);
  const [conversation, setConversation] = useState<SelfLeaveRecordDto | null>(null);
  const [timeline, setTimeline] = useState<string | null>(null);
  const data = q.data;
  const typeById = new Map((data?.types ?? []).map((x) => [x.id, x]));
  const balances = (data?.balances ?? []).filter((b) => (b.tracked ?? b.allowanceDays !== null) || b.usedDays > 0 || b.pendingDays > 0);
  const questions = (data?.records ?? []).filter((r) => r.status === 'INFO_REQUESTED');
  const years = Array.from({ length: 7 }, (_, i) => thisYear + 1 - i);
  const hasCompOff = !!data?.compOff?.leaveTypeId;
  const actions = (r: SelfLeaveRecordDto) => <RowActions r={r} onEdit={() => setEditing(r)} onWithdraw={() => setWithdrawing(r)} onConversation={() => setConversation(r)} />;

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
        <>
          {q.isLoading || data?.totals ? <LeaveTotalsTiles data={data} loading={q.isLoading} /> : null}

          {questions.length ? (
            <ul className="space-y-2" aria-label={t('leave.infoRequested')}>
              {questions.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-indigo-300 bg-indigo-50 p-3 text-sm text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100" role="status">
                  <span className="flex min-w-0 items-start gap-2"><HelpCircle className="mt-0.5 size-4 shrink-0" aria-hidden /><span className="min-w-0"><span className="block font-medium">{t('leave.infoRequested')} · {r.leaveTypeName} · <Dates r={r} /></span>{r.infoRequest ? <span className="block truncate" dir="auto" title={r.infoRequest.message}>{r.infoRequest.message}</span> : null}</span></span>
                  <Button size="sm" onClick={() => setConversation(r)}><MessageSquareReply /> {tl('portal.reply')}</Button>
                </li>
              ))}
            </ul>
          ) : null}

          <section aria-label={t('leave.balances', { year })}>
            <SectionTitle title={t('leave.balances', { year })} />
            {q.isLoading ? <Skeleton className="h-28 w-full" /> : balances.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {balances.map((b) => { const lt = typeById.get(b.leaveTypeId); return <LeaveTypeBalanceCard key={b.leaveTypeId} b={b} name={lt?.name ?? ''} color={lt?.color ?? null} />; })}
              </div>
            ) : <p className="px-5 text-sm text-muted-foreground">{t('home.balancesEmpty')}</p>}
          </section>

          <div className={hasCompOff ? 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]' : undefined}>
            <Card>
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
                            <TableRow key={r.id} data-testid={`leave-row-${r.id}`}>
                              <TableCell><span className="flex items-center gap-2 whitespace-nowrap text-sm font-medium"><TypeDot color={r.color} />{r.leaveTypeName}{!r.isPaid ? <Badge variant="outline">{t('leave.unpaid')}</Badge> : null}</span></TableCell>
                              <TableCell><Dates r={r} /></TableCell>
                              <TableCell className="text-sm tnum">{fmtDays(r.days)}</TableCell>
                              <TableCell className="max-w-[220px] text-xs"><span className="block truncate" title={r.reason ?? undefined}>{r.reason ?? '—'}</span></TableCell>
                              <TableCell><LeaveStatusBadge status={r.status} /></TableCell>
                              <TableCell><Approval r={r} onOpen={setTimeline} /></TableCell>
                              <TableCell><Decision r={r} /></TableCell>
                              <TableCell className="whitespace-nowrap text-xs tnum">{fmtDateTime(r.createdAt, tz, 'dd MMM yyyy')}</TableCell>
                              <TableCell className="text-end">{actions(r)}</TableCell>
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
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><Approval r={r} onOpen={setTimeline} />{actions(r)}</div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
            {hasCompOff ? <CompOffCard canUse={!!data} onUse={() => setCompOffOpen(true)} onTimeline={setTimeline} /> : null}
          </div>
        </>
      )}

      <ApplyLeaveDialog key={`apply-${String(applyOpen)}`} open={applyOpen} onOpenChange={setApplyOpen} data={data} />
      <ApplyLeaveDialog key={`co-${String(compOffOpen)}`} open={compOffOpen} onOpenChange={setCompOffOpen} data={data} compOff />
      <ApplyLeaveDialog key={`edit-${editing?.id ?? ''}`} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} data={data} record={editing} />
      <WithdrawLeaveDialog key={`wd-${withdrawing?.id ?? ''}`} record={withdrawing} onClose={() => setWithdrawing(null)} />
      <LeaveConversationDialog record={conversation} onClose={() => setConversation(null)} />
      <RequestDialog requestId={timeline} onClose={() => setTimeline(null)} />
    </div>
  );
}

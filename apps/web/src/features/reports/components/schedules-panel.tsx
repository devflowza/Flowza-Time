import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Bell, CalendarClock, Eye, Mail, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { ReportDeliveryDto, ReportScheduleDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Switch } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useMe, useOrgTimezone } from '@/features/me/use-me';
import '../schedules-i18n';
import { useReportDeliveries, useReportSchedules, useScheduleMutations } from '../schedules-api';
import { ScheduleDialog } from './schedule-dialog';
import { ReportViewerDialog, type ViewableReport } from './report-viewer';
import { cadenceSummary, skipReasonLabel } from '../schedule-utils';

type T = (k: string, o?: Record<string, unknown>) => string;
const RUN_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { success: 'success', partial: 'warning', failed: 'danger', skipped: 'neutral' };
const DELIVERY_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info'> = { delivered: 'success', queued: 'info', skipped: 'warning', failed: 'danger' };

function scopeLabel(t: T, d: ReportDeliveryDto): string {
  if (d.scope.kind === 'TEAM') return t('scope.team', { count: d.scope.employeeCount ?? 0 });
  if (d.scope.kind === 'BRANCHES') return t('scope.branches', { count: d.scope.branchCount ?? 0 });
  if (d.scope.kind === 'ORGANIZATION') return t('scope.organization');
  if (d.scope.kind === 'SELF') return t('scope.self');
  return '—';
}

/** Delivery trail: one row per recipient per run or share, with the scope their copy was generated under or why it was skipped. */
export function DeliveryLog({ scheduleId }: { scheduleId?: string }) {
  const { t } = useTranslation('reportSchedules');
  const { t: tr } = useTranslation('reports');
  const tz = useOrgTimezone();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const q = useReportDeliveries({ page, pageSize, scheduleId });
  const tt = t as unknown as T;
  // a delivered copy can be opened by its recipient, or by a report.manage holder (the API re-checks both, and the branch scope)
  const can = useCan();
  const me = useMe().data?.user.id;
  const [viewing, setViewing] = useState<ViewableReport | null>(null);
  const canOpen = (d: ReportDeliveryDto) => d.status === 'delivered' && !!d.reportRequestId && can('report.export') && (can('report.manage') || d.recipientUserId === me);
  const columns = useMemo<ColumnDef<ReportDeliveryDto, unknown>[]>(() => [
    { id: 'createdAt', header: t('log.when'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'report', header: t('log.report'), cell: ({ row }) => <div className="min-w-0 text-xs"><p className="truncate font-medium">{tr(`types.${row.original.reportType}.name`, { defaultValue: row.original.reportType })}</p><p className="text-muted-foreground">{row.original.scheduleName ?? t(`mode.${row.original.mode}`)}{row.original.periodFrom ? ` · ${fmtDate(row.original.periodFrom)} → ${fmtDate(row.original.periodTo)}` : ''}</p></div> },
    { id: 'recipient', header: t('log.recipient'), cell: ({ row }) => <span className="text-xs">{row.original.recipientName ?? row.original.recipientUserId.slice(0, 8)}</span> },
    { id: 'status', header: t('log.status'), cell: ({ row }) => <div className="flex flex-col gap-0.5"><Badge variant={DELIVERY_TONE[row.original.status] ?? 'neutral'} dot>{t(`deliveryStatus.${row.original.status}`)}</Badge>{row.original.skipReason ? <span className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={row.original.skipReason}>{skipReasonLabel(tt, row.original.skipReason)}</span> : null}{row.original.error ? <span className="max-w-[220px] truncate text-[11px] text-destructive" title={row.original.error}>{row.original.error}</span> : null}</div> },
    { id: 'scope', header: t('log.scope'), cell: ({ row }) => <span className="text-xs">{scopeLabel(tt, row.original)}</span> },
    { id: 'channels', header: t('channels.label'), cell: ({ row }) => <span className="flex gap-1 text-muted-foreground">{row.original.channels.includes('in_app') ? <Bell className="size-3.5" aria-label={t('channels.in_app')} /> : null}{row.original.channels.includes('email') ? <Mail className="size-3.5" aria-label={t('channels.email')} /> : null}</span> },
    { id: 'open', header: '', cell: ({ row }) => (canOpen(row.original) ? <Button size="sm" variant="ghost" onClick={() => setViewing({ id: row.original.reportRequestId!, reportType: row.original.reportType, format: row.original.format })}><Eye /> {tr('list.view')}</Button> : null) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, tr, tt, tz, me]);
  return (
    <>
    <DataTable
      columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
      isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('log.empty')} emptyDescription={t('log.emptyHint')}
      renderCard={(d) => <div className="space-y-1 text-xs"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{d.recipientName ?? '—'}</span><Badge variant={DELIVERY_TONE[d.status] ?? 'neutral'} dot>{t(`deliveryStatus.${d.status}`)}</Badge></div><p className="text-muted-foreground">{tr(`types.${d.reportType}.name`, { defaultValue: d.reportType })} · {fmtDateTime(d.createdAt, tz)}</p>{d.skipReason ? <p className="text-muted-foreground">{skipReasonLabel(tt, d.skipReason)}</p> : null}{canOpen(d) ? <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setViewing({ id: d.reportRequestId!, reportType: d.reportType, format: d.format }); }}><Eye /> {tr('list.view')}</Button> : null}</div>}
    />
    <ReportViewerDialog report={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

/**
 * Scheduled reports (HR portal Prompt 6a), shown to report.schedule holders on the Reports page: the schedules with their next
 * run and period, run now / edit / pause / delete, and the delivery trail of every run and share.
 */
export function SchedulesPanel() {
  const { t } = useTranslation('reportSchedules');
  const { t: tr } = useTranslation('reports');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const q = useReportSchedules({ page, pageSize });
  const { update, remove, runNow } = useScheduleMutations();
  const [editing, setEditing] = useState<ReportScheduleDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ReportScheduleDto | null>(null);
  const tt = t as unknown as T;
  const doRun = (s: ReportScheduleDto) => runNow.mutate(s.id, {
    onSuccess: (res) => toast.success(t('schedule.runQueued'), { description: res.period ? t('schedule.runQueuedHint', { from: fmtDate(res.period.from), to: fmtDate(res.period.to) }) : undefined }),
    onError: toastError,
  });
  const toggle = (s: ReportScheduleDto, on: boolean) => update.mutate({ id: s.id, input: { isActive: on } }, { onSuccess: () => toast.success(on ? t('schedule.resumed') : t('schedule.paused')), onError: toastError });

  const columns = useMemo<ColumnDef<ReportScheduleDto, unknown>[]>(() => [
    { id: 'name', header: t('schedule.name'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.name}</p><p className="truncate text-xs text-muted-foreground">{tr(`types.${row.original.reportType}.name`, { defaultValue: row.original.reportType })} · <span className="uppercase">{row.original.format}</span></p></div> },
    { id: 'when', header: t('schedule.when'), cell: ({ row }) => <span className="text-xs">{cadenceSummary(tt, row.original)}</span> },
    { id: 'next', header: t('schedule.nextRun'), cell: ({ row }) => row.original.isActive && row.original.nextRunAt ? <div className="text-xs tnum"><p>{fmtDateTime(row.original.nextRunAt, row.original.timezone || tz)}</p>{row.original.nextPeriod ? <p className="text-muted-foreground">{fmtDate(row.original.nextPeriod.from)} → {fmtDate(row.original.nextPeriod.to)}</p> : null}</div> : <Badge variant="neutral">{t('schedule.pausedBadge')}</Badge> },
    { id: 'last', header: t('schedule.lastRun'), cell: ({ row }) => row.original.lastRunAt ? <div className="flex flex-col gap-0.5 text-xs"><Badge variant={RUN_TONE[row.original.lastStatus ?? ''] ?? 'neutral'} dot>{t(`runStatus.${row.original.lastStatus ?? 'skipped'}`)}</Badge><span className="text-muted-foreground tnum">{fmtDateTime(row.original.lastRunAt, tz)}</span>{row.original.lastSummary ? <span className="text-muted-foreground">{t('schedule.lastSummary', { queued: row.original.lastSummary.queued, skipped: row.original.lastSummary.skipped })}</span> : null}</div> : <span className="text-xs text-muted-foreground">{t('schedule.never')}</span> },
    { id: 'recipients', header: t('recipients.label'), cell: ({ row }) => <span className="text-xs">{t('schedule.recipientCount', { users: row.original.recipients.userIds.length, roles: row.original.recipients.roleKeys.length })}</span> },
    { id: 'active', header: t('schedule.active'), cell: ({ row }) => <Switch checked={row.original.isActive} onCheckedChange={(on) => toggle(row.original, on)} aria-label={t('schedule.active')} onClick={(e) => e.stopPropagation()} /> },
    { id: 'actions', header: '', cell: ({ row }) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" onClick={() => doRun(row.original)} loading={runNow.isPending && runNow.variables === row.original.id} disabled={!row.original.isActive} title={t('schedule.runNow')}><Play /> <span className="sr-only sm:not-sr-only">{t('schedule.runNow')}</span></Button>
        <Button size="icon" variant="ghost" className="size-8" aria-label={tc('common.edit')} onClick={() => setEditing(row.original)}><Pencil /></Button>
        <Button size="icon" variant="ghost" className="size-8 text-destructive" aria-label={tc('common.delete')} onClick={() => setDeleting(row.original)}><Trash2 /></Button>
      </div>
    ) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, tr, tc, tt, tz, runNow.isPending, runNow.variables]);

  return (
    <Card data-testid="schedules-panel">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div><CardTitle className="flex items-center gap-2"><CalendarClock className="size-4" /> {t('panel.title')}</CardTitle><CardDescription>{t('panel.subtitle')}</CardDescription></div>
        <Button size="sm" onClick={() => setEditing('new')}><Plus /> {t('schedule.newTitle')}</Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <DataTable
          columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('panel.empty')} emptyDescription={t('panel.emptyHint')}
          emptyAction={<Button size="sm" onClick={() => setEditing('new')}><Plus /> {t('schedule.newTitle')}</Button>}
          renderCard={(s) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{s.name}</span>{s.isActive ? null : <Badge variant="neutral">{t('schedule.pausedBadge')}</Badge>}</div><p className="text-xs text-muted-foreground">{cadenceSummary(tt, s)}</p><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setEditing(s)}><Pencil /> {tc('common.edit')}</Button><Button size="sm" variant="ghost" onClick={() => doRun(s)} disabled={!s.isActive}><Play /> {t('schedule.runNow')}</Button></div></div>}
        />
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('log.title')}</h3>
          <DeliveryLog />
        </section>
      </CardContent>
      {editing ? <ScheduleDialog schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t('schedule.deleteTitle')} description={deleting ? t('schedule.deleteHint', { name: deleting.name }) : undefined} confirmLabel={tc('common.delete')} destructive loading={remove.isPending}
        onConfirm={() => { if (!deleting) return; remove.mutate(deleting.id, { onSuccess: () => { toast.success(t('schedule.deleted')); setDeleting(null); }, onError: toastError }); }} />
    </Card>
  );
}

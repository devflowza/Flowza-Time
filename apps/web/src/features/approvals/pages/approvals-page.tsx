import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, Inbox, Settings2, X } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { buttonVariants } from '@/components/ui/button';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useCan, useMe, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import type { CorrectionDto } from '@/features/attendance/types';
import { CorrectionStatusBadge, CorrectionTypeBadge } from '@/features/attendance/components/badges';
import { CorrectionSummary } from '@/features/attendance/components/record-dialog';
import { useCorrections } from '@/features/corrections/api';
import { useApprovalInbox, type InboxItem } from '../api';
import { DecisionDialog, type Decision } from '../components/decision-dialog';

const TABS = ['pending', 'decided'] as const;
type Tab = (typeof TABS)[number];
const DECIDED = ['APPROVED', 'APPLIED', 'REJECTED', 'CANCELLED'] as const;

function PendingTab() {
  const { t } = useTranslation('approvals');
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  const table = useTabTable();
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize }), [table.state.page, table.state.pageSize]);
  const q = useApprovalInbox(query);
  const myId = useMe().data?.user.id;
  const isOwn = (i: InboxItem) => !!myId && i.requestedBy === myId;
  const [dialog, setDialog] = useState<{ item: InboxItem | null; decision: Decision }>({ item: null, decision: 'approve' });
  const byId = branches.byId;
  const tzOf = useMemo(() => (branchId: string | null) => (branchId ? byId.get(branchId)?.timezone : undefined) ?? tz, [byId, tz]);

  const columns = useMemo<ColumnDef<InboxItem, unknown>[]>(() => [
    { id: 'employee', header: t('columns.employee'), cell: ({ row }) => { const c = row.original.correction; return <div className="min-w-0"><p className="truncate font-medium">{c?.employeeName ?? row.original.employeeId ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{c?.employeeNumber}</p></div>; } },
    { id: 'date', header: t('columns.date'), cell: ({ row }) => <span className="tnum">{row.original.correction ? fmtDate(row.original.correction.attendanceDate) : '—'}</span> },
    { id: 'type', header: t('columns.type'), cell: ({ row }) => row.original.correction ? <CorrectionTypeBadge type={row.original.correction.type} /> : <Badge variant="secondary">{t(`entity.${row.original.entityType}`, { defaultValue: row.original.entityType })}</Badge> },
    { id: 'change', header: t('columns.change'), cell: ({ row }) => row.original.correction ? <CorrectionSummary c={row.original.correction} timezone={tzOf(row.original.branchId)} /> : '—' },
    { id: 'reason', header: t('columns.reason'), cell: ({ row }) => <span className="block max-w-[240px] truncate text-xs" title={row.original.correction?.reason}>{row.original.correction?.reason ?? '—'}</span> },
    { id: 'requester', header: t('columns.requester'), cell: ({ row }) => <div className="text-xs"><p>{row.original.requestedByName ?? '—'}</p><p className="text-muted-foreground tnum">{fmtDateTime(row.original.createdAt, tz)}</p></div> },
    { id: 'step', header: t('columns.step'), cell: ({ row }) => <Badge variant="outline" className="tnum">{t('columns.stepN', { n: row.original.stepNo })} · {t(`approverType.${row.original.approverType}`, { defaultValue: row.original.approverType })}</Badge> },
    { id: 'actions', header: '', cell: ({ row }) => !!myId && row.original.requestedBy === myId ? (
      // Separation of duties: the requester never decides on their own request (the API rejects it); they can cancel it instead.
      <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()} title={t('inbox.ownRequestHint')}><Badge variant="outline">{t('inbox.ownRequest')}</Badge><Link to="/corrections?status=PENDING" className="text-xs text-muted-foreground underline-offset-2 hover:underline">{t('inbox.cancelInstead')}</Link></div>
    ) : (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="outline" onClick={() => setDialog({ item: row.original, decision: 'reject' })}><X /> {t('actions.reject')}</Button>
        <Button size="sm" onClick={() => setDialog({ item: row.original, decision: 'approve' })}><Check /> {t('actions.approve')}</Button>
      </div>
    ) },
  ], [t, tz, tzOf, myId]);

  return (
    <>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={t('inbox.empty')} emptyDescription={t('inbox.emptyHint')}
        renderCard={(i) => <div className="space-y-2"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{i.correction?.employeeName ?? '—'}</span>{i.correction ? <CorrectionTypeBadge type={i.correction.type} /> : null}</div><p className="text-xs text-muted-foreground">{i.correction ? fmtDate(i.correction.attendanceDate) : ''} · {i.correction?.reason}</p>{isOwn(i) ? <p className="text-xs text-muted-foreground">{t('inbox.ownRequestHint')}</p> : <div className="flex gap-2"><Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setDialog({ item: i, decision: 'reject' }); }}><X /> {t('actions.reject')}</Button><Button size="sm" onClick={(e) => { e.stopPropagation(); setDialog({ item: i, decision: 'approve' }); }}><Check /> {t('actions.approve')}</Button></div>}</div>}
      />
      <DecisionDialog key={`${dialog.item?.stepId ?? ''}-${dialog.decision}`} item={dialog.item} decision={dialog.decision} timezone={tzOf(dialog.item?.branchId ?? null)} onClose={() => setDialog((d) => ({ ...d, item: null }))} />
    </>
  );
}

function DecidedTab() {
  const { t } = useTranslation('approvals');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const branches = useBranchOptions();
  const table = useTabTable();
  const status = (DECIDED as readonly string[]).includes(table.state.filters['status'] ?? '') ? table.state.filters['status']! : 'APPROVED';
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status }), [table.state.page, table.state.pageSize, status]);
  const q = useCorrections(query);
  const columns = useMemo<ColumnDef<CorrectionDto, unknown>[]>(() => [
    { id: 'employee', header: t('columns.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div> },
    { id: 'date', header: t('columns.date'), cell: ({ row }) => <span className="tnum">{fmtDate(row.original.attendanceDate)}</span> },
    { id: 'type', header: t('columns.type'), cell: ({ row }) => <CorrectionTypeBadge type={row.original.type} /> },
    { id: 'change', header: t('columns.change'), cell: ({ row }) => <CorrectionSummary c={row.original} timezone={branches.byId.get(row.original.branchId)?.timezone ?? tz} /> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <div className="flex flex-col gap-0.5"><CorrectionStatusBadge status={row.original.status} />{row.original.rejectionReason ? <span className="max-w-[220px] truncate text-[11px] text-muted-foreground" title={row.original.rejectionReason}>{row.original.rejectionReason}</span> : null}</div> },
    { id: 'decidedAt', header: t('columns.decidedAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.appliedAt ?? row.original.updatedAt, tz)}</span> },
  ], [t, tc, tz, branches.byId]);
  return (
    <DataTable
      columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
      onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
      emptyTitle={t('decided.empty')} emptyDescription={t('decided.emptyHint')}
      toolbar={
        <Select value={status} onValueChange={(v) => table.setFilter('status', v)}>
          <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
          <SelectContent>{DECIDED.map((s) => <SelectItem key={s} value={s}>{ta(`correctionStatus.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
      }
      renderCard={(c) => <div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{c.employeeName}</p><p className="text-xs text-muted-foreground tnum">{fmtDate(c.attendanceDate)}</p></div><CorrectionStatusBadge status={c.status} /></div>}
    />
  );
}

/** /approvals?tab=pending|decided — my pending steps and the decided corrections. */
export default function ApprovalsPage() {
  const { t } = useTranslation('approvals');
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'pending';
  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={can('organization.manage') ? <Link to="/approvals/workflows" className={buttonVariants({ variant: 'outline', size: 'sm' })}><Settings2 /> {t('workflows.title')}</Link> : undefined} />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label={t('title')}>
          <TabsTrigger value="pending"><Inbox className="me-1.5 size-4" /> {t('tabs.pending')}</TabsTrigger>
          <TabsTrigger value="decided">{t('tabs.decided')}</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">{tab === 'pending' ? <PendingTab /> : null}</TabsContent>
        <TabsContent value="decided">{tab === 'decided' ? <DecidedTab /> : null}</TabsContent>
      </Tabs>
    </div>
  );
}

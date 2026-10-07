import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Ban, Plus, X } from 'lucide-react';
import { BRANCH_DEPLOYMENT_STATUSES, type BranchDeploymentDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDate } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { RowActions } from '@/features/organization/components/row-actions';
import { useServerTable } from '@/hooks/use-server-table';
import { useDeploymentMutations, useDeployments } from '../api';
import { SCHED_NS } from '../i18n';
import { deploymentTone } from '../model';
import { DeploymentDialog } from '../components/deployment-dialog';

const ALL = '__all__';

/**
 * /deployments (Enterprise, advanced_scheduling): employees temporarily working at another branch. A deployment lets the
 * portal check-in accept the host branch's geofences, enrols the employee on its terminals (a sync job, opened at /sync/:id)
 * and takes them off again after the end date. The attendance calendar and payroll stay with the home branch.
 */
export default function DeploymentsPage() {
  const { t } = useTranslation(SCHED_NS);
  const { t: tc } = useTranslation();
  const can = useCan();
  const canUpdate = can('employee.update');
  const table = useServerTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'], branchId: f['branchId'] }), [table.state.page, table.state.pageSize, f]);
  const q = useDeployments(query);
  const branches = useBranchOptions();
  const { cancel } = useDeploymentMutations();
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelling, setCancelling] = useState<BranchDeploymentDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const hasFilters = !!f['status'] || !!f['branchId'];

  const columns = useMemo<ColumnDef<BranchDeploymentDto, unknown>[]>(() => [
    { id: 'employee', header: t('deployments.employee'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? row.original.employeeId.slice(0, 8)}</p><p className="text-xs text-muted-foreground">{row.original.employeeNumber ?? ''}</p></div> },
    { id: 'branches', header: t('deployments.move'), cell: ({ row }) => <span className="flex items-center gap-1.5 text-sm"><span className="text-muted-foreground">{row.original.homeBranchName ?? '—'}</span><ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden /><span className="font-medium">{row.original.branchName ?? '—'}</span></span> },
    { id: 'range', header: t('deployments.range'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDate(row.original.fromDate)} → {fmtDate(row.original.toDate)}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <Badge variant={deploymentTone(row.original.status)}>{t(`deployments.status.${row.original.status}`)}</Badge> },
    {
      id: 'terminals', header: t('deployments.terminals'), cell: ({ row }) => {
        const d = row.original;
        // sync_jobs ids: the sync job page renders them (AGENTS.md "job ids are not interchangeable")
        if (d.cleanupJobId) return <Link className="text-xs underline-offset-2 hover:underline" to={`/sync/${d.cleanupJobId}`}>{t('deployments.cleanupJob')}</Link>;
        if (d.enrolJobId) return <Link className="text-xs underline-offset-2 hover:underline" to={`/sync/${d.enrolJobId}`}>{t('deployments.enrolJob')}</Link>;
        return <span className="text-xs text-muted-foreground">{d.enrolOnDevices ? t('deployments.noTerminals') : t('deployments.notEnrolled')}</span>;
      },
    },
    { id: 'actions', header: '', cell: ({ row }) => canUpdate && (row.original.status === 'active' || row.original.status === 'scheduled') ? <RowActions actions={[{ key: 'cancel', label: t('deployments.cancel'), icon: <Ban />, destructive: true, onSelect: () => { setCancelReason(''); setCancelling(row.original); } }]} /> : null },
  ], [t, tc, canUpdate]);

  return (
    <div className="page-container">
      <PageHeader title={t('deployments.title')} description={t('deployments.subtitle')} actions={canUpdate ? <Button onClick={() => setCreateOpen(true)}><Plus /> {t('deployments.add')}</Button> : undefined} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="branch-deployments"
        emptyTitle={t('deployments.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('deployments.emptyHint')}
        toolbar={
          <>
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('deployments.allStatuses')}</SelectItem>{BRANCH_DEPLOYMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`deployments.status.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { status: '', branchId: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(d) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{d.employeeName ?? '—'}</span><Badge variant={deploymentTone(d.status)}>{t(`deployments.status.${d.status}`)}</Badge></div><p className="text-xs text-muted-foreground">{d.homeBranchName ?? '—'} → {d.branchName ?? '—'} · <span className="tnum">{fmtDate(d.fromDate)} → {fmtDate(d.toDate)}</span></p></div>}
      />
      <DeploymentDialog key={String(createOpen)} open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)} title={t('deployments.cancelTitle')} description={t('deployments.cancelHint')} confirmLabel={t('deployments.cancel')} destructive loading={cancel.isPending}
        onConfirm={() => {
          if (!cancelling || cancelReason.trim().length < 3) return;
          cancel.mutate({ id: cancelling.id, reason: cancelReason.trim() }, { onSuccess: () => { toast.success(t('deployments.cancelled')); setCancelling(null); }, onError: toastError });
        }}>
        <div className="space-y-1.5"><Label htmlFor="dep-cancel-reason">{t('deployments.reason')}</Label><Input id="dep-cancel-reason" value={cancelReason} maxLength={1000} onChange={(e) => setCancelReason(e.target.value)} /><p className="text-xs text-muted-foreground">{t('deployments.cancelReasonHint')}</p></div>
      </ConfirmDialog>
    </div>
  );
}

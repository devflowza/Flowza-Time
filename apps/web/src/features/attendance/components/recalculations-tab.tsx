import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Calculator, ExternalLink } from 'lucide-react';
import { DataTable } from '@/components/data-table';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useRecalculations } from '../api';
import type { RecalculationDto } from '../types';
import { JobStatusBadge } from './badges';
import { RecalculateDialog } from './recalculate-dialog';

const ALL = '__all__';
const STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'];

export function RecalculationsTab() {
  const { t } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const table = useTabTable();
  const f = table.state.filters;
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status: f['status'] }), [table.state.page, table.state.pageSize, f]);
  const q = useRecalculations(query);
  const branches = useBranchOptions();
  const [open, setOpen] = useState(false);

  const columns = useMemo<ColumnDef<RecalculationDto, unknown>[]>(() => [
    { id: 'range', header: t('recalc.range'), cell: ({ row }) => <span className="whitespace-nowrap tnum">{fmtDate(row.original.fromDate)} → {fmtDate(row.original.toDate)}</span> },
    { id: 'scope', header: t('recalc.scope'), cell: ({ row }) => { const r = row.original; const parts = [r.branchId ? branches.byId.get(r.branchId)?.name ?? t('recalc.oneBranch') : t('recalc.allBranches'), r.employeeIds?.length ? t('recalc.nEmployees', { count: r.employeeIds.length }) : null].filter(Boolean); return <span className="text-xs">{parts.join(' · ')}</span>; } },
    { id: 'reason', header: t('recalc.reason'), cell: ({ row }) => <span className="block max-w-[260px] truncate text-xs" title={row.original.reason}>{row.original.reason}</span> },
    { id: 'status', header: tc('common.status'), cell: ({ row }) => <div className="flex flex-col gap-0.5"><JobStatusBadge status={row.original.status} />{row.original.summary && typeof row.original.summary['recordsUpdated'] === 'number' ? <span className="text-[11px] text-muted-foreground tnum">{t('recalc.recordsUpdated', { count: Number(row.original.summary['recordsUpdated']) })}</span> : null}</div> },
    { id: 'requestedBy', header: t('recalc.requestedBy'), cell: ({ row }) => <span className="text-xs">{row.original.requestedByName ?? '—'}</span> },
    { id: 'createdAt', header: tc('common.createdAt'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz)}</span> },
    { id: 'job', header: t('recalc.job'), cell: ({ row }) => row.original.jobId ? <Button asChild variant="link" size="sm" className="h-auto p-0"><Link to={`/sync/${row.original.jobId}`} onClick={(e) => e.stopPropagation()}>{t('recalc.viewJob')} <ExternalLink className="size-3" /></Link></Button> : '—' },
  ], [t, tc, tz, branches.byId]);

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={t('recalc.empty')} emptyDescription={t('recalc.emptyHint')}
        emptyAction={can('attendance.recalculate') ? <Button onClick={() => setOpen(true)}><Calculator /> {t('recalc.title')}</Button> : undefined}
        toolbar={
          <>
            <Select value={f['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
              <SelectTrigger className="h-8 w-40" aria-label={tc('common.status')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`jobStatus.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
            {can('attendance.recalculate') ? <Button size="sm" className="ms-auto" onClick={() => setOpen(true)}><Calculator /> {t('recalc.title')}</Button> : null}
          </>
        }
        renderCard={(r) => <div className="space-y-1"><div className="flex items-center justify-between gap-2"><span className="text-sm tnum">{fmtDate(r.fromDate)} → {fmtDate(r.toDate)}</span><JobStatusBadge status={r.status} /></div><p className="truncate text-xs text-muted-foreground">{r.reason}</p></div>}
      />
      <RecalculateDialog key={String(open)} open={open} onOpenChange={setOpen} />
    </div>
  );
}

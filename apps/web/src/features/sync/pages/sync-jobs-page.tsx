import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Radio, RefreshCw, Users, X } from 'lucide-react';
import { SYNC_JOB_TYPES, SYNC_STATUSES, type SyncJobDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { useDeviceOptions } from '@/features/devices/api';
import { isActiveJob, useSyncJobs } from '../api';
import { fmtDuration } from '../duration';
import { JobProgress, JobTypeLabel, SyncStatusBadge, TriggerBadge } from '../components/status-badges';
import { SyncAttendanceDialog, SyncEmployeesDialog } from '../components/sync-dialogs';

const ALL = '__all__';

function scopeLabel(scope: Record<string, unknown>, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (scope['all'] === true) return t('dialog.targets.all');
  if (typeof scope['branchId'] === 'string') return t('dialog.targets.branch');
  const ids = scope['deviceIds'];
  if (Array.isArray(ids)) return t('list.scopeDevices', { count: ids.length });
  const emps = scope['employeeIds'];
  if (Array.isArray(emps)) return t('list.scopeEmployees', { count: emps.length });
  return '—';
}

export default function SyncJobsPage() {
  const { t } = useTranslation('sync');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const tz = useOrgTimezone();
  const table = useServerTable();
  const q = useSyncJobs(table.query);
  const branches = useBranchOptions();
  const devices = useDeviceOptions();
  const [dialog, setDialog] = useState<'attendance' | 'employees' | null>(null);
  const filters = table.state.filters;
  const hasFilters = Object.keys(filters).length > 0;
  const activeCount = (q.data?.data ?? []).filter((j) => isActiveJob(j.status)).length;

  const columns = useMemo<ColumnDef<SyncJobDto, unknown>[]>(() => [
    { id: 'jobType', header: t('columns.type'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><JobTypeLabel type={row.original.jobType} /><p className="truncate text-xs text-muted-foreground">{scopeLabel(row.original.scope, t)}</p></div> },
    { id: 'trigger', header: t('columns.trigger'), enableSorting: false, cell: ({ row }) => <TriggerBadge trigger={row.original.trigger} /> },
    { id: 'status', header: t('columns.status'), enableSorting: false, cell: ({ row }) => <div className="space-y-1"><SyncStatusBadge status={row.original.status} /><JobProgress job={row.original} compact /></div>, size: 220 },
    { id: 'records', header: t('columns.records'), enableSorting: false, cell: ({ row }) => <span className="tnum">{fmtNumber(row.original.recordsIngested)}</span>, size: 90 },
    { id: 'requestedBy', header: t('columns.requestedBy'), enableSorting: false, cell: ({ row }) => <span className="text-xs">{row.original.requestedByName ?? (row.original.requestedBy ? row.original.requestedBy.slice(0, 8) : row.original.trigger === 'SCHEDULED' ? t('list.scheduler') : t('list.system'))}</span> },
    { id: 'startedAt', header: t('columns.started'), enableSorting: false, cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.startedAt ?? row.original.queuedAt ?? row.original.createdAt, tz)}</span> },
    { id: 'finishedAt', header: t('columns.finished'), enableSorting: false, cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.finishedAt, tz)}</span> },
    { id: 'duration', header: t('columns.duration'), enableSorting: false, cell: ({ row }) => <span className="text-xs tnum">{row.original.startedAt ? fmtDuration(row.original.startedAt, row.original.finishedAt) : '—'}</span>, size: 90 },
  ], [t, tz]);

  const toolbar = (
    <>
      <Select value={filters['status'] ?? ALL} onValueChange={(v) => table.setFilter('status', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-40" aria-label={t('columns.status')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allStatuses')}</SelectItem>{SYNC_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`status.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={filters['jobType'] ?? ALL} onValueChange={(v) => table.setFilter('jobType', v === ALL ? undefined : v)}>
        <SelectTrigger className="h-8 w-44" aria-label={t('columns.type')}><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={ALL}>{t('list.allTypes')}</SelectItem>{SYNC_JOB_TYPES.map((s) => <SelectItem key={s} value={s}>{t(`jobType.${s}`)}</SelectItem>)}</SelectContent>
      </Select>
      <Combobox value={filters['deviceId'] ?? null} onChange={(v) => table.setFilter('deviceId', v ?? undefined)} options={devices.options} loading={devices.isLoading} clearable placeholder={t('list.device')} className="h-8 w-44" />
      <Combobox value={filters['branchId'] ?? null} onChange={(v) => table.setFilter('branchId', v ?? undefined)} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-44" />
      {hasFilters ? <Button variant="ghost" size="sm" onClick={table.clearFilters}><X /> {tc('common.clearFilters')}</Button> : null}
      {activeCount > 0 ? <span className="ms-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Radio className="size-3.5 animate-pulse text-emerald-600" aria-hidden /> {t('jobs.live')} · {t('jobs.activeCount', { count: activeCount })}</span> : null}
    </>
  );

  return (
    <div className="page-container">
      <PageHeader title={t('title')} description={t('subtitle')} actions={can('device.sync') ? (
        <>
          <Button variant="outline" size="sm" onClick={() => setDialog('employees')}><Users /> {t('actions.syncEmployees')}</Button>
          <Button size="sm" onClick={() => setDialog('attendance')}><RefreshCw /> {t('actions.syncAttendance')}</Button>
        </>
      ) : undefined} />
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize}
        isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="sync-jobs"
        onRowClick={(j) => navigate(`/sync/${j.id}`)} toolbar={toolbar}
        emptyTitle={hasFilters ? tc('common.noResults') : t('jobs.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('jobs.emptyHint')}
        renderCard={(j) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2"><JobTypeLabel type={j.jobType} /><SyncStatusBadge status={j.status} /></div>
            <JobProgress job={j} compact />
            <p className="text-xs text-muted-foreground tnum">{fmtDateTime(j.startedAt ?? j.createdAt, tz)}</p>
          </div>
        )}
      />
      {dialog === 'attendance' ? <SyncAttendanceDialog open onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'employees' ? <SyncEmployeesDialog open onOpenChange={(o) => !o && setDialog(null)} /> : null}
    </div>
  );
}

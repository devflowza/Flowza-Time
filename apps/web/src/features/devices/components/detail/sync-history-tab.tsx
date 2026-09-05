import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { SyncJobDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { useSyncJobs } from '@/features/sync/api';
import { JobProgress, JobTypeLabel, SyncStatusBadge, TriggerBadge } from '@/features/sync/components/status-badges';

export function SyncHistoryTab({ deviceId, tz }: { deviceId: string; tz: string }) {
  const { t } = useTranslation('sync');
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const q = useSyncJobs(useMemo(() => ({ page, pageSize, deviceId }), [page, pageSize, deviceId]));
  const columns = useMemo<ColumnDef<SyncJobDto, unknown>[]>(() => [
    { id: 'jobType', header: t('columns.type'), cell: ({ row }) => <div><JobTypeLabel type={row.original.jobType} /><div className="mt-0.5"><TriggerBadge trigger={row.original.trigger} /></div></div> },
    { id: 'status', header: t('columns.status'), cell: ({ row }) => <SyncStatusBadge status={row.original.status} /> },
    { id: 'progress', header: t('columns.progress'), cell: ({ row }) => <JobProgress job={row.original} compact /> },
    { id: 'records', header: t('columns.records'), cell: ({ row }) => <span className="tnum">{fmtNumber(row.original.recordsIngested)}</span> },
    { id: 'createdAt', header: t('columns.started'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.startedAt ?? row.original.createdAt, tz)}</span> },
    { id: 'finishedAt', header: t('columns.finished'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.finishedAt, tz)}</span> },
  ], [t, tz]);
  return (
    <DataTable columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('jobs.empty')} emptyDescription={t('jobs.emptyDeviceHint')} onRowClick={(j) => navigate(`/sync/${j.id}`)} />
  );
}

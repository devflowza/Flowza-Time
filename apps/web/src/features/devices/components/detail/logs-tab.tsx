import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { LOG_LEVELS, type DeviceCommandDto, type DeviceLogDto, type LogLevel } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useDeviceCommands, useDeviceLogs } from '../../api';

const ALL = '__all__';
const LEVEL_TONE: Record<LogLevel, 'neutral' | 'info' | 'warning' | 'danger'> = { debug: 'neutral', info: 'info', warn: 'warning', error: 'danger' };
const CMD_TONE: Record<DeviceCommandDto['status'], 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = { pending: 'neutral', sent: 'info', acked: 'success', failed: 'danger', expired: 'warning' };

function Details({ data }: { data: Record<string, unknown> | null }) {
  const { t } = useTranslation('devices');
  if (!data || Object.keys(data).length === 0) return <span className="text-muted-foreground">—</span>;
  return <details className="text-xs"><summary className="cursor-pointer text-primary tnum">{t('logs.keys', { count: Object.keys(data).length })}</summary><pre dir="ltr" className="mt-1 max-h-48 max-w-[420px] overflow-auto rounded bg-muted p-2 font-mono text-[11px] scrollbar-thin">{JSON.stringify(data, null, 2)}</pre></details>;
}

export function LogsTab({ deviceId, tz }: { deviceId: string; tz: string }) {
  const { t } = useTranslation('devices');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [level, setLevel] = useState<string>(ALL);
  const q = useDeviceLogs(deviceId, useMemo(() => ({ page, pageSize, level: level === ALL ? undefined : level }), [page, pageSize, level]));
  const columns = useMemo<ColumnDef<DeviceLogDto, unknown>[]>(() => [
    { id: 'createdAt', header: t('logs.time'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz, 'dd MMM, HH:mm:ss')}</span>, size: 150 },
    { id: 'level', header: t('logs.level'), cell: ({ row }) => <Badge variant={LEVEL_TONE[row.original.level]}>{row.original.level}</Badge>, size: 80 },
    { id: 'event', header: t('logs.event'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.event}</span> },
    { id: 'message', header: t('logs.message'), cell: ({ row }) => <span className="text-sm">{row.original.message ?? '—'}</span> },
    { id: 'details', header: t('logs.details'), cell: ({ row }) => <Details data={row.original.details} /> },
    { id: 'job', header: t('logs.job'), cell: ({ row }) => row.original.jobId ? <Link to={`/sync/${row.original.jobId}`} className="font-mono text-xs text-primary hover:underline" dir="ltr" onClick={(e) => e.stopPropagation()}>{row.original.jobId.slice(0, 8)}</Link> : <span className="text-muted-foreground">—</span> },
  ], [t, tz]);
  return (
    <DataTable columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('logs.empty')} emptyDescription={t('logs.emptyHint')}
      toolbar={
        <Select value={level} onValueChange={(v) => { setLevel(v); setPage(1); }}>
          <SelectTrigger className="h-8 w-36" aria-label={t('logs.level')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('logs.allLevels')}</SelectItem>{LOG_LEVELS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
        </Select>
      } />
  );
}

export function CommandsTab({ deviceId, tz }: { deviceId: string; tz: string }) {
  const { t } = useTranslation('devices');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState<string>(ALL);
  const q = useDeviceCommands(deviceId, useMemo(() => ({ page, pageSize, status: status === ALL ? undefined : status }), [page, pageSize, status]));
  const columns = useMemo<ColumnDef<DeviceCommandDto, unknown>[]>(() => [
    { id: 'sequence', header: '#', cell: ({ row }) => <span className="font-mono text-xs tnum">{row.original.sequence}</span>, size: 70 },
    { id: 'commandType', header: t('commands.type'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.commandType}</span> },
    { id: 'status', header: t('commands.status'), cell: ({ row }) => <Badge variant={CMD_TONE[row.original.status]} dot>{t(`commands.statuses.${row.original.status}`)}</Badge> },
    { id: 'createdAt', header: t('commands.created'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.createdAt, tz, 'dd MMM, HH:mm:ss')}</span> },
    { id: 'sentAt', header: t('commands.sent'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.sentAt, tz, 'dd MMM, HH:mm:ss')}</span> },
    { id: 'ackedAt', header: t('commands.acked'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.ackedAt, tz, 'dd MMM, HH:mm:ss')}</span> },
    { id: 'expiresAt', header: t('commands.expires'), cell: ({ row }) => <span className="whitespace-nowrap text-xs tnum">{fmtDateTime(row.original.expiresAt, tz, 'dd MMM, HH:mm')}</span> },
    { id: 'payload', header: t('commands.payload'), cell: ({ row }) => <Details data={row.original.payload} /> },
    { id: 'result', header: t('commands.result'), cell: ({ row }) => <Details data={row.original.result} /> },
  ], [t, tz]);
  return (
    <DataTable columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} emptyTitle={t('commands.empty')} emptyDescription={t('commands.emptyHint')}
      toolbar={
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-8 w-36" aria-label={t('commands.status')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('commands.allStatuses')}</SelectItem>{(['pending', 'sent', 'acked', 'failed', 'expired'] as const).map((s) => <SelectItem key={s} value={s}>{t(`commands.statuses.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
      } />
  );
}

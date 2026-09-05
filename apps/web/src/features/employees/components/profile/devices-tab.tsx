import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Cpu, RefreshCw } from 'lucide-react';
import type { EmployeeDeviceStateDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeDevices, useEmployeeMutations } from '../../api';
import { SyncStatusBadge } from '../employee-badges';
import { toastJobQueued } from '../../job-toast';

const CONN_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = { online: 'success', offline: 'danger', degraded: 'warning', error: 'danger', unknown: 'neutral' };

export function DevicesTab({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation('employees');
  const navigate = useNavigate();
  const tz = useOrgTimezone();
  const can = useCan();
  const q = useEmployeeDevices(employeeId);
  const { bulk } = useEmployeeMutations();
  const syncNow = (deviceIds?: string[]) => bulk.mutate({ action: 'sync_devices', employeeIds: [employeeId], deviceIds }, { onSuccess: (r) => { if (r.kind === 'job') toastJobQueued(r.jobId, navigate); }, onError: toastError });

  const columns: ColumnDef<EmployeeDeviceStateDto, unknown>[] = [
    { id: 'device', header: t('devices.device'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.deviceName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.deviceCode}</p></div> },
    { id: 'connection', header: t('devices.connection'), cell: ({ row }) => <Badge variant={CONN_TONE[row.original.connectionStatus] ?? 'neutral'} dot>{t(`devices.conn.${row.original.connectionStatus}`, { defaultValue: row.original.connectionStatus })}</Badge> },
    { id: 'deviceUserId', header: t('fields.deviceUserId'), cell: ({ row }) => <span className="font-mono text-xs" dir="ltr">{row.original.deviceUserId}</span> },
    { id: 'sync', header: t('devices.syncStatus'), cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <SyncStatusBadge status={row.original.syncStatus} />
        {!row.original.desired ? <Badge variant="outline">{t('devices.removing')}</Badge> : null}
        {row.original.lastError ? <Tooltip><TooltipTrigger asChild><span className="cursor-help text-xs text-destructive underline decoration-dotted">{row.original.lastErrorCode ?? t('devices.error')}</span></TooltipTrigger><TooltipContent className="max-w-xs" dir="ltr">{row.original.lastError}</TooltipContent></Tooltip> : null}
      </div>
    ) },
    { id: 'enrolment', header: t('devices.enrolment'), cell: ({ row }) => (
      <span className="flex flex-wrap gap-1 text-xs">
        {row.original.fingerprintCount > 0 ? <Badge variant="secondary">{t('devices.fingerprints', { count: row.original.fingerprintCount })}</Badge> : null}
        {row.original.faceEnrolled ? <Badge variant="secondary">{t('devices.face')}</Badge> : null}
        {row.original.cardEnrolled ? <Badge variant="secondary">{t('devices.card')}</Badge> : null}
        {row.original.fingerprintCount === 0 && !row.original.faceEnrolled && !row.original.cardEnrolled ? <span className="text-muted-foreground">—</span> : null}
      </span>
    ) },
    { id: 'lastSync', header: t('devices.lastSync'), cell: ({ row }) => <div className="text-xs tnum"><p>{fmtDateTime(row.original.lastSyncAt, tz)}</p>{row.original.lastSuccessAt ? <p className="text-muted-foreground">{t('devices.lastSuccess', { at: fmtDateTime(row.original.lastSuccessAt, tz) })}</p> : null}</div> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => can('device.sync') ? <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); syncNow([row.original.deviceId]); }} disabled={bulk.isPending} aria-label={t('devices.syncOne')}><RefreshCw /></Button></div> : null },
  ];

  return (
    <DataTable columns={columns} data={q.data} total={q.data?.length} page={1} pageSize={Math.max(q.data?.length ?? 0, 10)} onPageChange={() => {}} onPageSizeChange={() => {}}
      isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
      emptyTitle={t('devices.empty')} emptyDescription={t('devices.emptyHint')}
      toolbar={<div className="flex w-full items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{t('devices.hint')}</p>{can('device.sync') ? <Button size="sm" onClick={() => syncNow()} loading={bulk.isPending}><RefreshCw /> {t('devices.syncNow')}</Button> : null}</div>}
      renderCard={(d) => <div className="flex items-center gap-3"><Cpu className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{d.deviceName}</p><p className="text-xs text-muted-foreground tnum">{fmtDateTime(d.lastSyncAt, tz)}</p></div><SyncStatusBadge status={d.syncStatus} /></div>}
    />
  );
}

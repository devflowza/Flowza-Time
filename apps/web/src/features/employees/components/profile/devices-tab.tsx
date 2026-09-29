import { useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Cpu, Hand, Link2, RefreshCw, Trash2 } from 'lucide-react';
import type { EmployeeDeviceStateDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useEmployeeDevices, useEmployeeMutations } from '../../api';
import { SyncStatusBadge } from '../employee-badges';
import { toastJobQueued } from '../../job-toast';
import { usePinMappingMutations } from '@/features/devices/api';
import { PinMappingDialog } from '@/features/devices/components/pin-mapping-dialog';

const CONN_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = { online: 'success', offline: 'danger', degraded: 'warning', error: 'danger', unknown: 'neutral' };

/**
 * The employee's devices and the device user id (PIN) they have on each. Map device PIN links a PIN to the employee on one device
 * (or changes their default device ID for every device); a mapped PIN (hand icon) is kept by every device sync.
 */
export function DevicesTab({ employeeId, employee }: { employeeId: string; employee?: { name: string; number: string; deviceUserId: string } }) {
  const { t } = useTranslation('employees');
  const { t: td } = useTranslation('devices');
  const navigate = useNavigate();
  const tz = useOrgTimezone();
  const can = useCan();
  const q = useEmployeeDevices(employeeId);
  const { bulk } = useEmployeeMutations();
  const { remove: unmap } = usePinMappingMutations();
  const canMap = can('device.sync') || can('employee.update');
  const [mapping, setMapping] = useState(false);
  const [unmapping, setUnmapping] = useState<EmployeeDeviceStateDto | null>(null);
  const syncNow = (deviceIds?: string[]) => bulk.mutate({ action: 'sync_devices', employeeIds: [employeeId], deviceIds }, { onSuccess: (r) => { if (r.kind === 'job') toastJobQueued(r.jobId, navigate, undefined, { to: '/sync' }); }, onError: toastError });

  const columns: ColumnDef<EmployeeDeviceStateDto, unknown>[] = [
    { id: 'device', header: t('devices.device'), cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.deviceName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{row.original.deviceCode}</p></div> },
    { id: 'connection', header: t('devices.connection'), cell: ({ row }) => <Badge variant={CONN_TONE[row.original.connectionStatus] ?? 'neutral'} dot>{t(`devices.conn.${row.original.connectionStatus}`, { defaultValue: row.original.connectionStatus })}</Badge> },
    { id: 'deviceUserId', header: t('fields.deviceUserId'), cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5"><span className="font-mono text-xs" dir="ltr">{row.original.deviceUserId}</span>{row.original.mappedAt ? <Tooltip><TooltipTrigger asChild><Hand className="size-3.5 text-brand-600" aria-label={td('pins.manual')} /></TooltipTrigger><TooltipContent>{td('pins.manualAt', { at: fmtDateTime(row.original.mappedAt, tz) })}</TooltipContent></Tooltip> : null}</span>
    ) },
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
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => can('device.sync') ? (
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); syncNow([row.original.deviceId]); }} disabled={bulk.isPending} aria-label={t('devices.syncOne')}><RefreshCw /></Button>
        {row.original.mappedAt ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setUnmapping(row.original); }} aria-label={td('pins.remove')} title={td('pins.remove')}><Trash2 className="text-destructive" /></Button> : null}
      </div>
    ) : null },
  ];

  return (
    <>
    <DataTable columns={columns} data={q.data} total={q.data?.length} page={1} pageSize={Math.max(q.data?.length ?? 0, 10)} onPageChange={() => {}} onPageSizeChange={() => {}}
      isLoading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
      emptyTitle={t('devices.empty')} emptyDescription={t('devices.emptyHint')}
      toolbar={<div className="flex w-full flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('devices.hint')}{employee ? <> {td('pins.defaultIdIs')} <span className="font-mono text-foreground" dir="ltr">{employee.deviceUserId}</span>.</> : null}</p>
        <div className="flex items-center gap-2">
          {canMap ? <Button size="sm" variant="outline" onClick={() => setMapping(true)}><Link2 /> {td('pins.addForEmployee')}</Button> : null}
          {can('device.sync') ? <Button size="sm" onClick={() => syncNow()} loading={bulk.isPending}><RefreshCw /> {t('devices.syncNow')}</Button> : null}
        </div>
      </div>}
      renderCard={(d) => <div className="flex items-center gap-3"><Cpu className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="font-medium">{d.deviceName}</p><p className="text-xs text-muted-foreground tnum">{fmtDateTime(d.lastSyncAt, tz)}</p></div><SyncStatusBadge status={d.syncStatus} /></div>}
    />
    {mapping ? <PinMappingDialog draft={{ employee: employee ? { id: employeeId, name: employee.name, number: employee.number } : { id: employeeId, name: '' } }} lockEmployee onClose={() => setMapping(false)} /> : null}
    <ConfirmDialog
      open={!!unmapping} onOpenChange={(o) => !o && setUnmapping(null)} destructive
      title={unmapping ? td('pins.removeTitle', { pin: unmapping.deviceUserId }) : ''}
      description={unmapping ? td('pins.removeHint', { pin: unmapping.deviceUserId, device: unmapping.deviceName, employee: employee?.name ?? '' }) : undefined}
      confirmLabel={td('pins.remove')} loading={unmap.isPending}
      onConfirm={() => { if (!unmapping) return; unmap.mutate(unmapping.id, { onSuccess: () => { toast.success(td('pins.removed')); setUnmapping(null); }, onError: toastError }); }}
    />
    </>
  );
}

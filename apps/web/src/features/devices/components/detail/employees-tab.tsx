import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Fingerprint, ScanFace, CreditCard, Wrench, X } from 'lucide-react';
import { DEVICE_EMPLOYEE_SYNC_STATUSES } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { SearchBox } from '@/features/organization/components/search-box';
import { useSyncMutations } from '@/features/sync/api';
import { toastJobQueued } from '@/features/sync/job-toast';
import { useDeviceEmployees, type DeviceEmployeeStateDto } from '../../api';
import { EmployeeSyncBadge } from '../device-badges';

const ALL = '__all__';

export function EmployeesTab({ deviceId, tz, canPush }: { deviceId: string; tz: string; canPush: boolean }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const can = useCan();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState<string>(ALL);
  const [search, setSearch] = useState<string | undefined>(undefined);
  const query = useMemo(() => ({ page, pageSize, syncStatus: status === ALL ? undefined : status, search }), [page, pageSize, status, search]);
  const q = useDeviceEmployees(deviceId, query);
  const { syncEmployees } = useSyncMutations();
  const [repairing, setRepairing] = useState<string | null>(null);

  const repair = (row: DeviceEmployeeStateDto) => {
    if (!row.employeeId) return;
    setRepairing(row.id);
    syncEmployees.mutate({ employeeIds: [row.employeeId], deviceIds: [deviceId], all: false, removeStale: false }, { onSuccess: (r) => toastJobQueued(r.jobId, navigate), onError: toastError, onSettled: () => setRepairing(null) });
  };

  const columns = useMemo<ColumnDef<DeviceEmployeeStateDto, unknown>[]>(() => [
    { id: 'employee', header: t('employees.employee'), cell: ({ row }) => row.original.employeeId ? (
      <div className="min-w-0"><p className="truncate font-medium">{row.original.employeeName ?? '—'}</p><p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.employeeNumber}</p></div>
    ) : <Badge variant="warning">{t('employees.deviceOnly')}</Badge> },
    { id: 'deviceUserId', header: t('employees.deviceUserId'), cell: ({ row }) => <span className="font-mono text-xs tnum" dir="ltr">{row.original.deviceUserId}</span> },
    { id: 'syncStatus', header: t('employees.syncStatus'), cell: ({ row }) => <div className="flex flex-wrap items-center gap-1"><EmployeeSyncBadge status={row.original.syncStatus} />{!row.original.desired ? <Badge variant="outline" className="font-normal">{t('employees.notDesired')}</Badge> : null}</div> },
    { id: 'enrolment', header: t('employees.enrolment'), cell: ({ row }) => (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5 tnum"><Fingerprint className="size-3.5" /> {row.original.fingerprintCount}</span></TooltipTrigger><TooltipContent>{t('employees.fingerprints', { count: row.original.fingerprintCount })}</TooltipContent></Tooltip>
        {row.original.faceEnrolled ? <Tooltip><TooltipTrigger asChild><ScanFace className="size-3.5 text-emerald-600" /></TooltipTrigger><TooltipContent>{t('employees.face')}</TooltipContent></Tooltip> : null}
        {row.original.cardEnrolled ? <Tooltip><TooltipTrigger asChild><CreditCard className="size-3.5 text-emerald-600" /></TooltipTrigger><TooltipContent>{t('employees.card')}</TooltipContent></Tooltip> : null}
      </span>
    ) },
    { id: 'lastSync', header: t('employees.lastSync'), cell: ({ row }) => <span className="text-xs tnum" title={row.original.lastSyncAt ? fmtDateTime(row.original.lastSyncAt, tz) : ''}>{fmtRelative(row.original.lastSyncAt)}</span> },
    { id: 'error', header: t('employees.lastError'), cell: ({ row }) => row.original.lastError ? <span className="max-w-[260px] truncate text-xs text-destructive" title={row.original.lastError}>{row.original.lastErrorCode ? `${row.original.lastErrorCode}: ` : ''}{row.original.lastError}</span> : <span className="text-muted-foreground">—</span> },
    { id: 'actions', header: '', enableHiding: false, cell: ({ row }) => (row.original.employeeId && canPush && can('device.sync') ? (
      <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); repair(row.original); }} loading={repairing === row.original.id} disabled={syncEmployees.isPending && repairing !== row.original.id}><Wrench /> {t('employees.repair')}</Button>
    ) : null) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, tz, canPush, repairing, syncEmployees.isPending]);

  return (
    <DataTable
      columns={columns} data={q.data?.data} total={q.data?.meta.total} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="device-employees"
      emptyTitle={t('employees.empty')} emptyDescription={t('employees.emptyHint')}
      toolbar={<>
        <SearchBox value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder={t('employees.searchPlaceholder')} />
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-8 w-44" aria-label={t('employees.syncStatus')}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>{t('employees.allStatuses')}</SelectItem>{DEVICE_EMPLOYEE_SYNC_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`syncStatus.${s}`)}</SelectItem>)}</SelectContent>
        </Select>
        {status !== ALL || search ? <Button variant="ghost" size="sm" onClick={() => { setStatus(ALL); setSearch(undefined); }}><X /> {tc('common.clearFilters')}</Button> : null}
      </>}
      onRowClick={(r) => { if (r.employeeId) navigate(`/employees/${r.employeeId}`); }}
    />
  );
}

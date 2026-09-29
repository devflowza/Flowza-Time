import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Hand, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { PinMappingDto } from '@flowza/contracts';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useTabTable } from '@/features/organization/use-tab-table';
import { useDeviceOptions, usePinMappingMutations, usePinMappings } from '../api';
import { EmployeeSyncBadge } from './device-badges';
import { ALL_DEVICES, PinMappingDialog, type PinMappingDraft } from './pin-mapping-dialog';

const ALL = '__all__';

/**
 * Devices & punches → PIN mapping: which employee every device PIN belongs to — device mappings (one device) and each
 * employee's default device ID (every device without a device mapping), in PIN order. Map, change and remove here; the
 * normaliser re-processes the PIN's unmatched punches as soon as a mapping is saved.
 */
export function PinMappingPanel() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const table = useTabTable({ pageSize: 25 });
  const f = table.state.filters;
  const deviceFilter = f['deviceId'];
  const query = useMemo(() => ({
    page: table.state.page, pageSize: table.state.pageSize, search: f['search'], branchId: f['branchId'],
    scope: deviceFilter === ALL_DEVICES ? 'default' : f['scope'], deviceId: deviceFilter && deviceFilter !== ALL_DEVICES ? deviceFilter : undefined,
  }), [table.state.page, table.state.pageSize, f, deviceFilter]);
  const q = usePinMappings(query);
  const branches = useBranchOptions();
  const devices = useDeviceOptions(f['branchId']);
  const { remove } = usePinMappingMutations();
  const canDevice = can('device.sync');
  const canDefault = can('employee.update');
  const canMap = canDevice || canDefault;
  const [draft, setDraft] = useState<{ draft: PinMappingDraft; edit: boolean } | null>(null);
  const [removing, setRemoving] = useState<PinMappingDto | null>(null);
  const hasFilters = ['search', 'branchId', 'deviceId', 'scope'].some((k) => !!f[k]);
  const deviceOptions = useMemo(() => [{ value: ALL_DEVICES, label: t('pins.allDevices') }, ...devices.options], [devices.options, t]);

  const columns = useMemo<ColumnDef<PinMappingDto, unknown>[]>(() => [
    { id: 'pin', header: t('pins.columns.pin'), enableSorting: false, cell: ({ row }) => <span className="font-mono text-sm font-semibold tnum" dir="ltr">{row.original.deviceUserId}</span> },
    { id: 'device', header: t('pins.columns.device'), enableSorting: false, cell: ({ row }) => row.original.scope === 'default'
      ? <Tooltip><TooltipTrigger asChild><span><Badge variant="secondary">{t('pins.scope.default')}</Badge></span></TooltipTrigger><TooltipContent className="max-w-xs">{t('pins.defaultTooltip')}</TooltipContent></Tooltip>
      : <div className="min-w-0"><Link to={`/devices/${row.original.deviceId}`} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.deviceName}</Link><p className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{row.original.deviceSerial ?? row.original.deviceCode}</p></div> },
    { id: 'employee', header: t('pins.columns.employee'), enableSorting: false, cell: ({ row }) => (
      <div className="min-w-0">
        <Link to={`/employees/${row.original.employeeId}`} className="block truncate font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.employeeName}</Link>
        <p className="flex items-center gap-1 truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{row.original.employeeNumber}</span>{['terminated', 'resigned'].includes(row.original.employmentStatus) ? <Badge variant="neutral" className="font-normal">{tc(`employees:employmentStatus.${row.original.employmentStatus}`, { defaultValue: row.original.employmentStatus })}</Badge> : null}</p>
      </div>
    ) },
    { id: 'status', header: t('pins.columns.status'), enableSorting: false, cell: ({ row }) => row.original.syncStatus ? <EmployeeSyncBadge status={row.original.syncStatus} /> : <span className="text-muted-foreground">—</span> },
    { id: 'mapped', header: t('pins.columns.mapped'), enableSorting: false, cell: ({ row }) => row.original.manual
      ? <span className="inline-flex items-center gap-1 text-xs"><Hand className="size-3.5 text-brand-600" aria-hidden />{t('pins.manual')}<span className="text-muted-foreground tnum">· {fmtDateTime(row.original.mappedAt, tz)}</span></span>
      : <span className="text-xs text-muted-foreground">{row.original.scope === 'default' ? t('pins.fromEmployee') : t('pins.fromSync')}</span> },
    { id: 'actions', header: '', enableSorting: false, enableHiding: false, cell: ({ row }) => {
      const m = row.original;
      const canEdit = m.scope === 'default' ? canDefault : canDevice;
      if (!canEdit) return null;
      return (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" aria-label={t('pins.edit')} title={t('pins.edit')} onClick={() => setDraft({ edit: true, draft: { employee: { id: m.employeeId, name: m.employeeName, number: m.employeeNumber }, deviceId: m.deviceId, deviceUserId: m.deviceUserId } })}><Pencil /></Button>
          {m.scope === 'device' && m.manual ? <Button size="sm" variant="ghost" aria-label={t('pins.remove')} title={t('pins.remove')} onClick={() => setRemoving(m)}><Trash2 className="text-destructive" /></Button> : null}
        </div>
      );
    } },
  ], [t, tc, tz, canDevice, canDefault]);

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()} storageKey="pin-mappings"
        emptyTitle={t('pins.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('pins.emptyHint')}
        toolbar={
          <>
            <SearchBox id="pin-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('pins.searchPlaceholder')} />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', deviceId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={deviceFilter ?? null} onChange={(v) => table.update({ filters: { deviceId: v ?? '', scope: '' } })} options={deviceOptions} loading={devices.isLoading} clearable placeholder={t('pins.anyDevice')} className="h-8 w-48" />
            {!deviceFilter ? (
              <Select value={f['scope'] ?? ALL} onValueChange={(v) => table.setFilter('scope', v === ALL ? undefined : v)}>
                <SelectTrigger className="h-8 w-44" aria-label={t('pins.scopeLabel')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('pins.allScopes')}</SelectItem>
                  <SelectItem value="device">{t('pins.scopeFilter.device')}</SelectItem>
                  <SelectItem value="default">{t('pins.scopeFilter.default')}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { search: '', branchId: '', deviceId: '', scope: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
            {canMap ? <Button size="sm" className="ms-auto" onClick={() => setDraft({ edit: false, draft: { deviceId: deviceFilter === undefined ? undefined : deviceFilter === ALL_DEVICES ? null : deviceFilter } })}><Plus /> {t('pins.add')}</Button> : null}
          </>
        }
        renderCard={(m) => (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 font-mono text-base font-semibold tnum" dir="ltr">{m.deviceUserId}</span>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{m.employeeName}</p><p className="truncate text-xs text-muted-foreground">{m.scope === 'default' ? t('pins.scope.default') : `${m.deviceName ?? ''} · ${m.deviceSerial ?? m.deviceCode ?? ''}`}</p></div>
            {m.manual ? <Badge variant="info">{t('pins.manual')}</Badge> : null}
          </div>
        )}
      />
      {draft ? <PinMappingDialog draft={draft.draft} lockEmployee={draft.edit} lockDevice={draft.edit} title={draft.edit ? t('pins.dialog.editTitle') : undefined} onClose={() => setDraft(null)} /> : null}
      <ConfirmDialog
        open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} destructive
        title={removing ? t('pins.removeTitle', { pin: removing.deviceUserId }) : ''}
        description={removing ? t('pins.removeHint', { pin: removing.deviceUserId, device: removing.deviceName ?? '', employee: removing.employeeName }) : undefined}
        confirmLabel={t('pins.remove')} loading={remove.isPending}
        onConfirm={() => { if (!removing?.stateId) return; remove.mutate(removing.stateId, { onSuccess: () => { toast.success(t('pins.removed')); setRemoving(null); }, onError: toastError }); }}
      />
    </div>
  );
}

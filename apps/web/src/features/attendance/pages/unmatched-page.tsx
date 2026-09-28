import { useMemo, useState } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ArrowLeft, EyeOff, RotateCcw, UserCheck, X } from 'lucide-react';
import type { UnmatchedPunchGroupDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { DataTable } from '@/components/data-table';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Tabs, TabsList, TabsTrigger, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { useServerTable } from '@/hooks/use-server-table';
import { fmtDateTime, fmtNumber } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useCan, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { SearchBox } from '@/features/organization/components/search-box';
import { useEmployeeOptions } from '@/features/employees/api';
import { useDeviceOptions } from '@/features/devices/api';
import '../workspace-i18n';
import { useUnmatchedPunches, useWorkspaceMutations } from '../workspace-api';

type Group = UnmatchedPunchGroupDto;

function AssignDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: tc } = useTranslation();
  const employees = useEmployeeOptions();
  const { assign } = useWorkspaceMutations();
  const first = group.suggestions[0];
  const [employeeId, setEmployeeId] = useState<string | null>(first?.employeeId ?? null);
  const options = useMemo(() => {
    const extra = group.suggestions.filter((s) => !employees.options.some((o) => o.value === s.employeeId)).map((s) => ({ value: s.employeeId, label: s.displayName, description: s.employeeNumber }));
    return [...extra, ...employees.options];
  }, [employees.options, group.suggestions]);
  const submit = () => {
    if (!employeeId) return;
    assign.mutate({ deviceId: group.deviceId, deviceEmployeeId: group.deviceEmployeeId, employeeId }, {
      onSuccess: (res) => { toast.success(t('unmatched.assigned', { count: res.rows }), { description: t('unmatched.assignedHint') }); onClose(); },
      onError: toastError,
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('unmatched.assignTitle')}</DialogTitle>
          <DialogDescription>{t('unmatched.assignHint', { id: group.deviceEmployeeId, device: group.deviceName ?? group.deviceCode ?? '—', count: group.count })}</DialogDescription>
        </DialogHeader>
        {group.suggestions.length ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">{t('unmatched.suggested')}</span>
            {group.suggestions.map((s) => <Button key={s.employeeId} type="button" size="sm" variant={s.employeeId === employeeId ? 'default' : 'outline'} className="h-7" onClick={() => setEmployeeId(s.employeeId)}>{s.displayName} <span className="font-mono text-[10px] opacity-80" dir="ltr">{s.employeeNumber}</span></Button>)}
          </div>
        ) : null}
        <FormField label={t('unmatched.employee')} htmlFor="assign-employee" required>
          <Combobox id="assign-employee" value={employeeId} onChange={setEmployeeId} options={options} onSearch={employees.setSearch} loading={employees.isLoading} placeholder={t('unmatched.pickEmployee')} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} loading={assign.isPending} disabled={!employeeId}><UserCheck /> {t('unmatched.assign')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IgnoreDialog({ group, onClose }: { group: Group; onClose: () => void }) {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: tc } = useTranslation();
  const { ignore } = useWorkspaceMutations();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const ok = reason.trim().length >= 3;
  const submit = () => {
    setTouched(true);
    if (!ok) return;
    ignore.mutate({ deviceId: group.deviceId, deviceEmployeeId: group.deviceEmployeeId, reason: reason.trim() }, {
      onSuccess: (res) => { toast.success(t('unmatched.ignored', { count: res.rows })); onClose(); },
      onError: toastError,
    });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t('unmatched.ignoreTitle')}</DialogTitle>
          <DialogDescription>{t('unmatched.ignoreHint', { id: group.deviceEmployeeId, count: group.count })}</DialogDescription>
        </DialogHeader>
        <FormField label={t('edit.reason')} htmlFor="ignore-reason" required error={touched && !ok ? t('edit.reasonRequired') : undefined}>
          <Textarea id="ignore-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('unmatched.ignorePlaceholder')} aria-invalid={touched && !ok} maxLength={500} />
        </FormField>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" variant="destructive" onClick={submit} loading={ignore.isPending}><EyeOff /> {t('unmatched.ignore')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * /attendance/unmatched (HR portal Prompt 6a): device punches the normaliser could not attribute to an employee, grouped by
 * device and device user id. Assign maps the id to an employee on that device and re-queues the punches; Ignore sets them aside
 * with a reason (raw rows stay — only their processing status changes, audited); Restore puts ignored punches back in triage.
 */
export default function UnmatchedPunchesPage() {
  const { t } = useTranslation('attendanceWorkspace');
  const { t: ta } = useTranslation('attendance');
  const { t: tc } = useTranslation();
  const tz = useOrgTimezone();
  const can = useCan();
  const table = useServerTable({ pageSize: 25 });
  const f = table.state.filters;
  const status = f['status'] === 'ignored' ? 'ignored' : 'unmatched';
  const query = useMemo(() => ({ page: table.state.page, pageSize: table.state.pageSize, status, deviceId: f['deviceId'], branchId: f['branchId'], search: f['search'] }), [table.state.page, table.state.pageSize, status, f]);
  const q = useUnmatchedPunches(query);
  const branches = useBranchOptions();
  const devices = useDeviceOptions(f['branchId']);
  const { restore } = useWorkspaceMutations();
  const canAct = can('device.sync');
  const [assigning, setAssigning] = useState<Group | null>(null);
  const [ignoring, setIgnoring] = useState<Group | null>(null);
  const [restoring, setRestoring] = useState<Group | null>(null);
  const hasFilters = ['deviceId', 'branchId', 'search'].some((k) => !!f[k]);

  const columns = useMemo<ColumnDef<Group, unknown>[]>(() => [
    { id: 'device', header: ta('raw.device'), enableSorting: false, cell: ({ row }) => <div className="min-w-0"><p className="truncate font-medium">{row.original.deviceName ?? '—'}</p><p className="truncate text-xs text-muted-foreground"><span className="font-mono" dir="ltr">{row.original.deviceCode ?? ''}</span>{row.original.branchName ? ` · ${row.original.branchName}` : ''}</p></div> },
    { id: 'deviceEmployeeId', header: ta('raw.deviceEmployeeId'), enableSorting: false, cell: ({ row }) => <span className="font-mono text-sm" dir="ltr">{row.original.deviceEmployeeId}</span> },
    { id: 'count', header: t('unmatched.punches'), enableSorting: false, cell: ({ row }) => <Badge variant={status === 'ignored' ? 'neutral' : 'danger'} className="tnum">{fmtNumber(row.original.count)}</Badge> },
    { id: 'range', header: t('unmatched.seen'), enableSorting: false, cell: ({ row }) => <div className="text-xs tnum"><p>{fmtDateTime(row.original.firstPunchAt, tz)}</p><p className="text-muted-foreground">→ {fmtDateTime(row.original.lastPunchAt, tz)}</p></div> },
    { id: 'suggestions', header: t('unmatched.suggested'), enableSorting: false, cell: ({ row }) => row.original.suggestions.length ? <span className="flex flex-wrap gap-1">{row.original.suggestions.map((s) => <Badge key={s.employeeId} variant="info" title={t(`unmatched.reason.${s.reason}`)}>{s.displayName}</Badge>)}</span> : <span className="text-xs text-muted-foreground">—</span> },
    { id: 'actions', header: '', enableSorting: false, enableHiding: false, cell: ({ row }) => !canAct ? null : (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {status === 'unmatched' ? (
          <>
            <Button size="sm" onClick={() => setAssigning(row.original)}><UserCheck /> {t('unmatched.assign')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setIgnoring(row.original)}><EyeOff /> {t('unmatched.ignore')}</Button>
          </>
        ) : <Button size="sm" variant="outline" onClick={() => setRestoring(row.original)}><RotateCcw /> {t('unmatched.restore')}</Button>}
      </div>
    ) },
  ], [t, ta, tz, status, canAct]);

  return (
    <div className="page-container space-y-4">
      <PageHeader
        title={t('unmatched.title')} description={t('unmatched.subtitle')}
        breadcrumbs={<Link to="/attendance" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3 rtl:rotate-180" /> {ta('title')}</Link>}
      />
      {!canAct ? <p className="text-sm text-muted-foreground">{t('unmatched.readOnly')}</p> : null}
      <Tabs value={status} onValueChange={(v) => table.setFilter('status', v === 'ignored' ? 'ignored' : undefined)}>
        <TabsList aria-label={t('unmatched.title')}>
          <TabsTrigger value="unmatched">{t('unmatched.tabs.unmatched')}</TabsTrigger>
          <TabsTrigger value="ignored">{t('unmatched.tabs.ignored')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <DataTable
        columns={columns} data={q.data?.data} total={q.data?.meta.total} page={table.state.page} pageSize={table.state.pageSize}
        onPageChange={table.setPage} onPageSizeChange={table.setPageSize} isLoading={q.isLoading || q.isFetching} error={q.error} onRetry={() => void q.refetch()}
        emptyTitle={status === 'ignored' ? t('unmatched.emptyIgnored') : t('unmatched.empty')} emptyDescription={hasFilters ? tc('common.noResultsHint') : t('unmatched.emptyHint')}
        toolbar={
          <>
            <SearchBox id="unmatched-search" value={f['search']} onChange={(v) => table.setFilter('search', v)} placeholder={t('unmatched.searchPlaceholder')} />
            <Combobox value={f['branchId'] ?? null} onChange={(v) => table.update({ filters: { branchId: v ?? '', deviceId: '' } })} options={branches.options} loading={branches.isLoading} clearable placeholder={tc('common.branch')} className="h-8 w-40" />
            <Combobox value={f['deviceId'] ?? null} onChange={(v) => table.setFilter('deviceId', v ?? undefined)} options={devices.options} loading={devices.isLoading} clearable placeholder={ta('raw.device')} className="h-8 w-44" />
            {hasFilters ? <Button variant="ghost" size="sm" onClick={() => table.update({ filters: { deviceId: '', branchId: '', search: '' } })}><X /> {tc('common.clearFilters')}</Button> : null}
          </>
        }
        renderCard={(g) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-sm" dir="ltr">{g.deviceEmployeeId}</span><Badge variant={status === 'ignored' ? 'neutral' : 'danger'}>{t('unmatched.count', { count: g.count })}</Badge></div>
            <p className="truncate text-xs text-muted-foreground">{g.deviceName ?? '—'} · {fmtDateTime(g.lastPunchAt, tz)}</p>
            {canAct ? (status === 'unmatched'
              ? <div className="flex gap-2"><Button size="sm" onClick={(e) => { e.stopPropagation(); setAssigning(g); }}><UserCheck /> {t('unmatched.assign')}</Button><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setIgnoring(g); }}><EyeOff /> {t('unmatched.ignore')}</Button></div>
              : <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setRestoring(g); }}><RotateCcw /> {t('unmatched.restore')}</Button>) : null}
          </div>
        )}
      />
      {assigning ? <AssignDialog group={assigning} onClose={() => setAssigning(null)} /> : null}
      {ignoring ? <IgnoreDialog group={ignoring} onClose={() => setIgnoring(null)} /> : null}
      <ConfirmDialog
        open={!!restoring} onOpenChange={(o) => !o && setRestoring(null)} title={t('unmatched.restoreTitle')} description={restoring ? t('unmatched.restoreHint', { id: restoring.deviceEmployeeId, count: restoring.count }) : undefined}
        confirmLabel={t('unmatched.restore')} loading={restore.isPending}
        onConfirm={() => { if (!restoring) return; restore.mutate({ deviceId: restoring.deviceId, deviceEmployeeId: restoring.deviceEmployeeId }, { onSuccess: (res) => { toast.success(t('unmatched.restored', { count: res.rows })); setRestoring(null); }, onError: toastError }); }}
      />
    </div>
  );
}

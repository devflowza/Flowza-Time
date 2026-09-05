import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { EMPLOYMENT_STATUSES, type BulkEmployeeAction, type EmploymentStatus } from '@flowza/contracts';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, ErrorState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { api, type Envelope, type PageEnvelope } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { todayIso } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useOrgId, useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions, useDepartmentOptions } from '@/features/organization/lookups';
import { useEmployeeMutations } from '../api';
import { toastJobQueued } from '../job-toast';

export type BulkKind = Exclude<BulkEmployeeAction['action'], 'export'> | 'export';

interface ShiftRef { id: string; name: string; code: string }
/** Shifts belong to the schedule module; the picker degrades gracefully when the endpoint is not deployed yet. */
function useShiftOptions() {
  const orgId = useOrgId();
  const q = useQuery({ queryKey: qk.list(orgId, 'shifts', { pageSize: 200 }), queryFn: async () => { const r = await api.get<PageEnvelope<ShiftRef> | Envelope<ShiftRef[]>>(`/orgs/${orgId}/shifts`, { pageSize: 200, status: 'active' }); return Array.isArray(r.data) ? r.data : []; }, retry: false });
  const options: ComboboxOption[] = (q.data ?? []).map((s) => ({ value: s.id, label: s.name, description: s.code }));
  return { ...q, options };
}

export function BulkActionDialog({ kind, employeeIds, onClose, onDone }: { kind: BulkKind | null; employeeIds: string[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation('employees');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const tz = useOrgTimezone();
  const { bulk } = useEmployeeMutations();
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIso(tz));
  const [effectiveTo, setEffectiveTo] = useState('');
  const [branchId, setBranchId] = useState<string | null>(null);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [status, setStatus] = useState<EmploymentStatus>('active');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const branches = useBranchOptions();
  const departments = useDepartmentOptions();
  const shifts = useShiftOptions();
  const count = employeeIds.length;

  const run = (action: BulkEmployeeAction) => bulk.mutate(action, {
    onSuccess: (res) => {
      if (res.kind === 'job') toastJobQueued(res.jobId, navigate, t('bulk.queuedHint'));
      else toast.success(t('bulk.updated', { count: res.updated }));
      onDone(); onClose();
    },
    onError: toastError,
  });

  if (!kind) return null;
  if (kind === 'sync_devices') {
    return <ConfirmDialog open onOpenChange={(o) => !o && onClose()} title={t('bulk.syncTitle', { count })} description={t('bulk.syncHint')} confirmLabel={t('bulk.syncConfirm')} loading={bulk.isPending} onConfirm={() => run({ action: 'sync_devices', employeeIds })} />;
  }
  const disabled = (kind === 'assign_branch' && !branchId) || (kind === 'assign_shift' && (!shiftId || !effectiveFrom));
  const submit = () => {
    if (kind === 'assign_branch' && branchId) run({ action: 'assign_branch', employeeIds, branchId, effectiveFrom: effectiveFrom || undefined });
    if (kind === 'assign_department') run({ action: 'assign_department', employeeIds, departmentId, effectiveFrom: effectiveFrom || undefined });
    if (kind === 'assign_shift' && shiftId) run({ action: 'assign_shift', employeeIds, shiftId, effectiveFrom, effectiveTo: effectiveTo || null });
    if (kind === 'set_status') run({ action: 'set_status', employeeIds, employmentStatus: status, effectiveFrom: effectiveFrom || undefined });
    if (kind === 'export') run({ action: 'export', employeeIds: employeeIds.length ? employeeIds : undefined, format });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t(`bulk.${kind}.title`, { count })}</DialogTitle>
          <DialogDescription>{t(`bulk.${kind}.hint`)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {kind === 'assign_branch' ? <FormField label={tc('common.branch')} htmlFor="bulk-branch" required><Combobox id="bulk-branch" value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} placeholder={t('fields.selectBranch')} /></FormField> : null}
          {kind === 'assign_department' ? <FormField label={tc('common.department')} htmlFor="bulk-dept" hint={t('bulk.assign_department.clearHint')}><Combobox id="bulk-dept" value={departmentId} onChange={setDepartmentId} options={departments.options} loading={departments.isLoading} clearable placeholder={tc('common.none')} /></FormField> : null}
          {kind === 'assign_shift' ? (shifts.isError ? <ErrorState error={shifts.error} onRetry={() => void shifts.refetch()} /> : <FormField label={t('bulk.assign_shift.shift')} htmlFor="bulk-shift" required><Combobox id="bulk-shift" value={shiftId} onChange={setShiftId} options={shifts.options} loading={shifts.isLoading} placeholder={t('bulk.assign_shift.select')} emptyText={t('bulk.assign_shift.none')} /></FormField>) : null}
          {kind === 'set_status' ? (
            <FormField label={t('fields.employmentStatus')} htmlFor="bulk-status" required>
              <Select value={status} onValueChange={(v) => setStatus(v as EmploymentStatus)}>
                <SelectTrigger id="bulk-status"><SelectValue /></SelectTrigger>
                <SelectContent>{EMPLOYMENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`employmentStatus.${s}`)}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          ) : null}
          {kind === 'export' ? (
            <FormField label={t('bulk.export.format')} htmlFor="bulk-format">
              <Select value={format} onValueChange={(v) => setFormat(v as 'csv' | 'xlsx')}>
                <SelectTrigger id="bulk-format"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="xlsx">Excel (.xlsx)</SelectItem><SelectItem value="csv">CSV</SelectItem></SelectContent>
              </Select>
            </FormField>
          ) : null}
          {kind !== 'export' ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('effective.effectiveFrom')} htmlFor="bulk-from" required={kind === 'assign_shift'}>
                <Input id="bulk-from" type="date" dir="ltr" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
              </FormField>
              {kind === 'assign_shift' ? <FormField label={t('bulk.assign_shift.effectiveTo')} htmlFor="bulk-to" optional><Input id="bulk-to" type="date" dir="ltr" value={effectiveTo} min={effectiveFrom} onChange={(e) => setEffectiveTo(e.target.value)} /></FormField> : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          <Button type="button" loading={bulk.isPending} disabled={disabled} onClick={submit}>{t('bulk.apply', { count })}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

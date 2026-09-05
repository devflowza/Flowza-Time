import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { SyncAttendanceRequest, SyncEmployeesRequest } from '@flowza/contracts';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Label, Switch } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useBranchOptions } from '@/features/organization/lookups';
import { useDeviceOptions } from '@/features/devices/api';
import { useEmployeeOptions } from '@/features/employees/api';
import { useSyncMutations } from '../api';
import { toastJobAccepted } from '../job-toast';

/** Chip multi-select built on the searchable Combobox: pick one at a time, remove with the chip's button. */
function MultiPick({ id, value, onChange, options, loading, placeholder, onSearch, labelOf }: { id: string; value: string[]; onChange: (ids: string[]) => void; options: ComboboxOption[]; loading?: boolean; placeholder: string; onSearch?: (q: string) => void; labelOf: (id: string) => string }) {
  const { t } = useTranslation('sync');
  const remaining = useMemo(() => options.filter((o) => !value.includes(o.value)), [options, value]);
  return (
    <div className="space-y-2">
      <Combobox id={id} value={null} onChange={(v) => { if (v && !value.includes(v)) onChange([...value, v]); }} options={remaining} loading={loading} placeholder={placeholder} onSearch={onSearch} />
      {value.length === 0 ? <p className="text-xs text-muted-foreground">{t('dialog.noneSelected')}</p> : (
        <ul className="flex flex-wrap gap-1" aria-label={placeholder}>
          {value.map((v) => (
            <li key={v}><Badge variant="secondary" className="gap-1 font-normal">{labelOf(v)}<button type="button" className="rounded-full hover:text-destructive" aria-label={t('dialog.remove', { name: labelOf(v) })} onClick={() => onChange(value.filter((x) => x !== v))}><X className="size-3" /></button></Badge></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TargetRadio<T extends string>({ name, value, onChange, options }: { name: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[] }) {
  return (
    <div role="radiogroup" className="grid gap-2 sm:grid-cols-3" aria-labelledby={`${name}-label`}>
      {options.map((o) => (
        <label key={o.value} className={cn('flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', value === o.value ? 'border-brand-500 bg-accent/50' : 'hover:border-brand-300')}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 accent-brand-600" />
          <span className="min-w-0"><span className="block font-medium">{o.label}</span>{o.hint ? <span className="block text-xs text-muted-foreground">{o.hint}</span> : null}</span>
        </label>
      ))}
    </div>
  );
}

type AttendanceTarget = 'devices' | 'branch' | 'all';

export function SyncAttendanceDialog({ open, onOpenChange, defaultDeviceIds = [] }: { open: boolean; onOpenChange: (o: boolean) => void; defaultDeviceIds?: string[] }) {
  const { t } = useTranslation('sync');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { syncAttendance } = useSyncMutations();
  const devices = useDeviceOptions();
  const branches = useBranchOptions();
  const [target, setTarget] = useState<AttendanceTarget>(defaultDeviceIds.length ? 'devices' : 'all');
  const [deviceIds, setDeviceIds] = useState<string[]>(defaultDeviceIds);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [fullResync, setFullResync] = useState(false);
  const labelOf = (id: string) => devices.options.find((o) => o.value === id)?.label ?? id;
  const body: SyncAttendanceRequest | null = target === 'all' ? { all: true, fullResync } : target === 'branch' ? (branchId ? { branchId, all: false, fullResync } : null) : deviceIds.length ? { deviceIds, all: false, fullResync } : null;
  const submit = () => { if (!body) return; syncAttendance.mutate(body, { onSuccess: (r) => { toastJobAccepted(r, navigate, t('dialog.queued', { count: r.itemsTotal, devices: r.deviceCount })); onOpenChange(false); }, onError: toastError }); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('dialog.attendanceTitle')}</DialogTitle><DialogDescription>{t('dialog.attendanceHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label id="att-target-label">{t('dialog.target')}</Label>
            <TargetRadio<AttendanceTarget> name="att-target" value={target} onChange={setTarget} options={[{ value: 'devices', label: t('dialog.targets.devices') }, { value: 'branch', label: t('dialog.targets.branch') }, { value: 'all', label: t('dialog.targets.all'), hint: t('dialog.allDevicesHint') }]} />
          </div>
          {target === 'devices' ? <FormField label={t('list.device')} htmlFor="att-devices"><MultiPick id="att-devices" value={deviceIds} onChange={setDeviceIds} options={devices.options} loading={devices.isLoading} placeholder={t('dialog.selectDevices')} labelOf={labelOf} /></FormField> : null}
          {target === 'branch' ? <FormField label={tc('common.branch')} htmlFor="att-branch" required><Combobox id="att-branch" value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} placeholder={t('dialog.selectBranch')} /></FormField> : null}
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="att-full" checked={fullResync} onCheckedChange={setFullResync} />
            <div><Label htmlFor="att-full">{t('dialog.fullResync')}</Label><p className="text-xs text-muted-foreground">{t('dialog.fullResyncHint')}</p></div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} disabled={!body} loading={syncAttendance.isPending}>{t('actions.queue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type EmployeesTarget = 'employees' | 'branch' | 'devices' | 'all';

export function SyncEmployeesDialog({ open, onOpenChange, defaultDeviceIds = [], defaultEmployeeIds = [] }: { open: boolean; onOpenChange: (o: boolean) => void; defaultDeviceIds?: string[]; defaultEmployeeIds?: string[] }) {
  const { t } = useTranslation('sync');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { syncEmployees } = useSyncMutations();
  const devices = useDeviceOptions();
  const branches = useBranchOptions();
  const employees = useEmployeeOptions();
  const [target, setTarget] = useState<EmployeesTarget>(defaultEmployeeIds.length ? 'employees' : defaultDeviceIds.length ? 'devices' : 'branch');
  const [employeeIds, setEmployeeIds] = useState<string[]>(defaultEmployeeIds);
  const [deviceIds, setDeviceIds] = useState<string[]>(defaultDeviceIds);
  const [branchId, setBranchId] = useState<string | null>(null);
  const [removeStale, setRemoveStale] = useState(false);
  const [pickedEmployees, setPickedEmployees] = useState<Record<string, string>>({});
  const deviceLabel = (id: string) => devices.options.find((o) => o.value === id)?.label ?? id;
  const employeeLabel = (id: string) => pickedEmployees[id] ?? employees.options.find((o) => o.value === id)?.label ?? id;
  const body: SyncEmployeesRequest | null =
    target === 'all' ? { all: true, removeStale }
      : target === 'branch' ? (branchId ? { branchId, all: false, removeStale } : null)
      : target === 'devices' ? (deviceIds.length ? { deviceIds, all: false, removeStale } : null)
      : employeeIds.length ? { employeeIds, deviceIds: deviceIds.length ? deviceIds : undefined, all: false, removeStale } : null;
  const submit = () => { if (!body) return; syncEmployees.mutate(body, { onSuccess: (r) => { toastJobAccepted(r, navigate, t('dialog.queued', { count: r.itemsTotal, devices: r.deviceCount })); onOpenChange(false); }, onError: toastError }); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>{t('dialog.employeesTitle')}</DialogTitle><DialogDescription>{t('dialog.employeesHint')}</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label id="emp-target-label">{t('dialog.target')}</Label>
            <TargetRadio<EmployeesTarget> name="emp-target" value={target} onChange={setTarget} options={[{ value: 'employees', label: t('dialog.targets.employees') }, { value: 'branch', label: t('dialog.targets.branch') }, { value: 'devices', label: t('dialog.targets.devices') }, { value: 'all', label: t('dialog.targets.all'), hint: t('dialog.allEmployeesHint') }]} />
          </div>
          {target === 'employees' ? (
            <>
              <FormField label={t('dialog.targets.employees')} htmlFor="emp-employees">
                <MultiPick id="emp-employees" value={employeeIds} onChange={(ids) => { setEmployeeIds(ids); setPickedEmployees((p) => { const n = { ...p }; for (const id of ids) n[id] ??= employees.options.find((o) => o.value === id)?.label ?? id; return n; }); }} options={employees.options} loading={employees.isLoading} onSearch={employees.setSearch} placeholder={t('dialog.selectEmployees')} labelOf={employeeLabel} />
              </FormField>
              <FormField label={t('dialog.devicesForEmployees')} htmlFor="emp-devices" optional hint={t('dialog.devicesForEmployeesHint')}>
                <MultiPick id="emp-devices" value={deviceIds} onChange={setDeviceIds} options={devices.options} loading={devices.isLoading} placeholder={t('dialog.selectDevices')} labelOf={deviceLabel} />
              </FormField>
            </>
          ) : null}
          {target === 'branch' ? <FormField label={tc('common.branch')} htmlFor="emp-branch" required><Combobox id="emp-branch" value={branchId} onChange={setBranchId} options={branches.options} loading={branches.isLoading} placeholder={t('dialog.selectBranch')} /></FormField> : null}
          {target === 'devices' ? <FormField label={t('list.device')} htmlFor="emp-devices-only"><MultiPick id="emp-devices-only" value={deviceIds} onChange={setDeviceIds} options={devices.options} loading={devices.isLoading} placeholder={t('dialog.selectDevices')} labelOf={deviceLabel} /></FormField> : null}
          <div className="flex items-start gap-3 rounded-md border p-3">
            <Switch id="emp-stale" checked={removeStale} onCheckedChange={setRemoveStale} />
            <div><Label htmlFor="emp-stale">{t('dialog.removeStale')}</Label><p className="text-xs text-muted-foreground">{t('dialog.removeStaleHint')}</p></div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
          <Button type="button" onClick={submit} disabled={!body} loading={syncEmployees.isPending}>{t('actions.queue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

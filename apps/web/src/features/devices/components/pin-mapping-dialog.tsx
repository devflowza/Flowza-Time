import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Link2 } from 'lucide-react';
import { DEFAULT_DEVICE_USER_ID_RE, UNMATCHED_ASSIGN_BLOCKED_PROVIDERS, type PinMappingConflict } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input } from '@/components/ui';
import { Combobox, type ComboboxOption } from '@/components/forms';
import { ApiError } from '@/lib/api-client';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { useDeviceOptions, usePinMappingMutations } from '../api';

/** Combobox value standing for "every device": the employee's default device ID. */
export const ALL_DEVICES = '__default__';
const BLOCKED = new Set(Object.keys(UNMATCHED_ASSIGN_BLOCKED_PROVIDERS));

export interface PinMappingDraft {
  employee?: { id: string; name: string; number?: string | null } | null;
  /** A device id, or null for "all devices" (the employee's default device ID). Undefined = let the user pick. */
  deviceId?: string | null;
  deviceUserId?: string;
}

/**
 * Map a device PIN (the device user id a terminal sends with every punch) to an employee — on one device, or as the employee's
 * default ID on every device. Opened from the PIN mapping tab, a device's Employees tab (device fixed), an employee's Devices tab
 * (employee fixed) and the punch log (device + PIN of an unmapped punch). A PIN or employee already mapped on the device comes
 * back as a conflict the user can confirm with Replace.
 */
export function PinMappingDialog({ draft, lockEmployee = false, lockDevice = false, title, onClose }: { draft: PinMappingDraft; lockEmployee?: boolean; lockDevice?: boolean; title?: string; onClose: () => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const can = useCan();
  const employees = useEmployeeOptions();
  const devices = useDeviceOptions();
  const { create } = usePinMappingMutations();
  const canDevice = can('device.sync');
  const canDefault = can('employee.update');
  const [employeeId, setEmployeeId] = useState<string | null>(draft.employee?.id ?? null);
  const [device, setDevice] = useState<string | null>(draft.deviceId === undefined ? (canDevice ? null : ALL_DEVICES) : draft.deviceId ?? ALL_DEVICES);
  const [pin, setPin] = useState(draft.deviceUserId ?? '');
  const [touched, setTouched] = useState(false);
  const [conflict, setConflict] = useState<{ reason: PinMappingConflict; pin: string } | null>(null);

  const employeeOptions = useMemo<ComboboxOption[]>(() => {
    const e = draft.employee;
    const extra = e && !employees.options.some((o) => o.value === e.id) ? [{ value: e.id, label: e.name, description: e.number ?? undefined }] : [];
    return [...extra, ...employees.options];
  }, [employees.options, draft.employee]);
  const deviceOptions = useMemo<ComboboxOption[]>(() => [
    ...(canDefault ? [{ value: ALL_DEVICES, label: t('pins.allDevices'), description: t('pins.allDevicesHint') }] : []),
    ...(canDevice ? devices.data.filter((d) => !BLOCKED.has(d.providerKey) && d.status !== 'decommissioned').map((d) => ({ value: d.id, label: d.name, description: d.serialNumber ?? d.code })) : []),
  ], [devices.data, canDevice, canDefault, t]);

  const isDefault = device === ALL_DEVICES;
  const value = pin.trim();
  const pinError = !value ? t('pins.dialog.pinRequired') : value.length > 64 ? t('pins.dialog.pinTooLong') : isDefault && !DEFAULT_DEVICE_USER_ID_RE.test(value) ? t('pins.dialog.defaultFormat') : null;
  const valid = !!employeeId && !!device && !pinError;

  const submit = (replace = false) => {
    setTouched(true);
    if (!valid || !employeeId || !device) return;
    create.mutate({ employeeId, deviceUserId: value, deviceId: isDefault ? null : device, ...(replace ? { replace: true } : {}) }, {
      onSuccess: (res) => {
        if (!res.changed) toast.info(t('pins.unchanged'));
        else toast.success(t('pins.saved'), { description: res.rowsRequeued > 0 ? t('pins.requeued', { count: res.rowsRequeued }) : undefined });
        onClose();
      },
      onError: (err) => {
        const details = err instanceof ApiError && err.status === 409 ? err.details : undefined;
        const reason = details?.['reason'];
        if (!isDefault && (reason === 'PIN_TAKEN' || reason === 'EMPLOYEE_MAPPED')) {
          const other = typeof details?.['deviceUserId'] === 'string' ? details['deviceUserId'] : value;
          setConflict({ reason, pin: reason === 'EMPLOYEE_MAPPED' ? other : value });
          return;
        }
        toastError(err);
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title ?? t('pins.dialog.title')}</DialogTitle>
          <DialogDescription>{t('pins.dialog.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label={t('pins.dialog.employee')} htmlFor="pin-employee" required error={touched && !employeeId ? t('pins.dialog.employeeRequired') : undefined}>
            <Combobox id="pin-employee" value={employeeId} onChange={(v) => { setEmployeeId(v); setConflict(null); }} options={employeeOptions} onSearch={employees.setSearch} loading={employees.isLoading} disabled={lockEmployee} placeholder={t('pins.dialog.pickEmployee')} aria-invalid={touched && !employeeId} />
          </FormField>
          <FormField label={t('pins.dialog.device')} htmlFor="pin-device" required error={touched && !device ? t('pins.dialog.deviceRequired') : undefined}>
            <Combobox id="pin-device" value={device} onChange={(v) => { setDevice(v); setConflict(null); }} options={deviceOptions} loading={devices.isLoading} disabled={lockDevice} placeholder={t('pins.dialog.pickDevice')} aria-invalid={touched && !device} />
          </FormField>
          <FormField label={t('pins.dialog.pin')} htmlFor="pin-value" required error={touched && pinError ? pinError : undefined} hint={isDefault ? t('pins.dialog.defaultHint') : t('pins.dialog.deviceHint')}>
            <Input id="pin-value" value={pin} onChange={(e) => { setPin(e.target.value); setConflict(null); }} placeholder={t('pins.dialog.pinPlaceholder')} className="font-mono" dir="ltr" maxLength={64} autoComplete="off" aria-invalid={touched && !!pinError}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
          </FormField>
          <p className="text-xs text-muted-foreground">{t('pins.dialog.requeueHint')}</p>
          {conflict ? (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="space-y-1"><p className="font-medium">{t(`pins.conflict.${conflict.reason}`, { pin: conflict.pin })}</p><p className="text-xs">{t('pins.conflict.replaceHint')}</p></div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
          {conflict
            ? <Button type="button" variant="destructive" onClick={() => submit(true)} loading={create.isPending}>{t('pins.conflict.replace')}</Button>
            : <Button type="button" onClick={() => submit()} loading={create.isPending} disabled={touched && !valid}><Link2 /> {t('pins.dialog.save')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

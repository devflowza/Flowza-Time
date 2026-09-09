import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2 } from 'lucide-react';
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useEmployeeOptions } from '@/features/employees/api';
import { useDeviceUserLinkMutations } from '../api';

/** The PIN being linked, plus how much attendance is waiting behind it (0 when the caller cannot read raw transactions). */
export interface LinkTarget { deviceId: string; deviceUserId: string; deviceName?: string | null; deviceUserName?: string | null; providerKey?: string | null; unmatchedPunches?: number }

/**
 * Attach a device user id (the PIN typed on the keypad) to an employee. `DEVICE` writes the mapping for this device only;
 * `PROVIDER` writes the vendor-wide identity, so every device of that make resolves the same PIN to the same person.
 * Replaying the punches already collected is the point of the dialog — it needs `attendance.view_raw`, same as a manual
 * re-queue, so the box is hidden (and the flag left off) for members without it.
 */
export function LinkDeviceUserDialog({ target, onClose }: { target: LinkTarget; onClose: () => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const can = useCan();
  const employees = useEmployeeOptions();
  const { link } = useDeviceUserLinkMutations();
  const canReplay = can('attendance.view_raw');
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [scope, setScope] = useState<'DEVICE' | 'PROVIDER'>('DEVICE');
  const [requeue, setRequeue] = useState(canReplay);
  const canScopeProvider = can('employee.update');
  const waiting = target.unmatchedPunches ?? 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) return;
    try {
      const r = await link.mutateAsync({ deviceId: target.deviceId, input: { deviceUserId: target.deviceUserId, employeeId, scope, requeueUnmatched: requeue && canReplay } });
      toast.success(r.requeued > 0 ? t('link.linkedWithReplay', { count: r.requeued }) : t('link.linked'));
      onClose();
    } catch (err) { toastError(err); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('link.title', { deviceUserId: target.deviceUserId })}</DialogTitle>
          <DialogDescription>
            {t('link.description', { device: target.deviceName ?? '' })}
            {target.deviceUserName ? <> · <span className="font-medium">{target.deviceUserName}</span></> : null}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField label={t('link.employee')} htmlFor="link-emp" required hint={t('link.employeeHint')}>
            <Combobox id="link-emp" value={employeeId} onChange={setEmployeeId} options={employees.options} onSearch={employees.setSearch} loading={employees.isLoading} clearable placeholder={t('link.employeePlaceholder')} />
          </FormField>
          <FormField label={t('link.scope')} htmlFor="link-scope" hint={scope === 'DEVICE' ? t('link.scopeDeviceHint') : t('link.scopeProviderHint', { provider: target.providerKey ?? '' })}>
            <Select value={scope} onValueChange={(v) => setScope(v as 'DEVICE' | 'PROVIDER')}>
              <SelectTrigger id="link-scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DEVICE">{t('link.scopeDevice')}</SelectItem>
                <SelectItem value="PROVIDER" disabled={!canScopeProvider}>{t('link.scopeProvider')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {canReplay ? (
            <div className="flex items-start gap-2 rounded-md border p-3">
              <Checkbox id="link-requeue" checked={requeue} onCheckedChange={(v) => setRequeue(v === true)} />
              <div className="grid gap-0.5">
                <Label htmlFor="link-requeue">{t('link.replay')}</Label>
                <p className="text-xs text-muted-foreground">{waiting > 0 ? t('link.replayHint', { count: waiting }) : t('link.replayNone')}</p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{tc('common.cancel')}</Button>
            <Button type="submit" disabled={!employeeId} loading={link.isPending}><Link2 /> {t('link.submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

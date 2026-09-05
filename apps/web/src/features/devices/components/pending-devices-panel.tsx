import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Radio, Search } from 'lucide-react';
import { claimPendingDeviceSchema, type ClaimPendingDeviceInput, type PendingDeviceDto } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Skeleton } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useDebounced } from '@/hooks/use-debounced';
import { useBranchOptions } from '@/features/organization/lookups';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { toastJobQueued } from '@/features/sync/job-toast';
import { useDeviceMutations, usePendingDevices, type DeviceCreatedDto } from '../api';
import { PushCredentialsDialog } from './push-credentials-dialog';
import { TagsInput } from './tags-input';

type ClaimValues = z.input<typeof claimPendingDeviceSchema>;

function ClaimDialog({ pending, onClose }: { pending: PendingDeviceDto | null; onClose: (createdId?: string) => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const branches = useBranchOptions();
  const { claim } = useDeviceMutations();
  const [created, setCreated] = useState<DeviceCreatedDto | null>(null);
  const form = useForm<ClaimValues, unknown, ClaimPendingDeviceInput>({ resolver: zodResolver(claimPendingDeviceSchema), defaultValues: { branchId: '', name: '', code: pending?.serialNumber.slice(-8).toUpperCase() ?? '', tags: [] } });
  const { register, control, formState: { errors }, setValue, getValues } = form;
  if (!pending) return null;
  const submit = form.handleSubmit((values) => claim.mutate({ id: pending.id, input: values }, {
    onSuccess: (res) => {
      toast.success(t('pending.claimed', { name: res.device.name }));
      if (res.testConnectionJobId) toastJobQueued(res.testConnectionJobId, navigate);
      if (res.pushToken) setCreated(res); else onClose(res.device.id);
    },
    onError: toastError,
  }));
  const info = pending.deviceInfo;
  return (
    <>
      <Dialog open={!created} onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pending.claimTitle')}</DialogTitle>
            <DialogDescription>{t('pending.claimHint', { serial: pending.serialNumber, provider: pending.providerKey })}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline" className="font-mono" dir="ltr">{pending.serialNumber}</Badge>
            <Badge variant="secondary">{t('pending.claimCode')}: <span className="font-mono">{pending.claimCode}</span></Badge>
            {typeof info.model === 'string' ? <Badge variant="secondary">{info.model}</Badge> : null}
            {typeof info.firmwareVersion === 'string' ? <Badge variant="secondary" dir="ltr">FW {info.firmwareVersion}</Badge> : null}
            {pending.remoteIp ? <Badge variant="outline" dir="ltr">{pending.remoteIp}</Badge> : null}
          </div>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <FormField label={tc('common.branch')} htmlFor="claim-branch" required error={errors.branchId?.message}>
              <Controller control={control} name="branchId" render={({ field }) => <Combobox id="claim-branch" value={field.value} options={branches.options} loading={branches.isLoading} placeholder={t('fields.selectBranch')} aria-invalid={!!errors.branchId} onChange={(v) => { field.onChange(v ?? ''); const b = v ? branches.byId.get(v) : undefined; if (b && !getValues('timezone')) setValue('timezone', b.timezone); }} />} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={tc('common.name')} htmlFor="claim-name" required error={errors.name?.message}><Input id="claim-name" {...register('name')} aria-invalid={!!errors.name} /></FormField>
              <FormField label={tc('common.code')} htmlFor="claim-code" required error={errors.code?.message}><Input id="claim-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} /></FormField>
            </div>
            <FormField label={tc('common.timezone')} htmlFor="claim-tz" optional error={errors.timezone?.message}>
              <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="claim-tz" value={field.value ?? undefined} onChange={field.onChange} />} />
            </FormField>
            <FormField label={t('fields.tags')} htmlFor="claim-tags" optional>
              <Controller control={control} name="tags" render={({ field }) => <TagsInput id="claim-tags" value={field.value ?? []} onChange={field.onChange} />} />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onClose()}>{tc('common.cancel')}</Button>
              <Button type="submit" loading={claim.isPending}>{t('pending.claim')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <PushCredentialsDialog credentials={created} onClose={() => { const id = created?.device.id; setCreated(null); onClose(id); }} />
    </>
  );
}

/** Zero-touch devices that contacted the push endpoint without being registered; admins claim them into a branch. */
export function PendingDevicesPanel() {
  const { t } = useTranslation('devices');
  const navigate = useNavigate();
  const [serial, setSerial] = useState('');
  const debounced = useDebounced(serial.trim(), 300);
  const q = usePendingDevices(debounced || undefined);
  const [claiming, setClaiming] = useState<PendingDeviceDto | null>(null);
  const rows = q.data ?? [];
  if (!q.isLoading && !q.isError && rows.length === 0 && !debounced) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <Radio className="size-3.5" aria-hidden /> {t('pending.none')}
        <div className="relative ms-auto">
          <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2" aria-hidden />
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder={t('pending.searchSerial')} className="h-7 w-56 ps-7 text-xs" dir="ltr" aria-label={t('pending.searchSerial')} />
        </div>
      </div>
    );
  }
  return (
    <Card className="border-blue-200 dark:border-blue-900">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><Radio className="size-4 text-blue-600" aria-hidden /> {t('pending.title')}</CardTitle>
          <CardDescription>{t('pending.hint')}</CardDescription>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder={t('pending.searchSerial')} className="h-8 w-56 ps-7 text-xs" dir="ltr" aria-label={t('pending.searchSerial')} />
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? <Skeleton className="h-12 w-full" /> : q.isError ? <p className="text-sm text-destructive">{t('pending.loadError')}</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('pending.noMatch')}</p> : (
          <ul className="divide-y">
            {rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-mono" dir="ltr">{p.serialNumber}</span>
                <Badge variant="outline">{p.providerKey}</Badge>
                {typeof p.deviceInfo.model === 'string' ? <span className="text-muted-foreground">{p.deviceInfo.model}</span> : null}
                <span className="text-xs text-muted-foreground tnum">{t('pending.lastSeen', { when: fmtRelative(p.lastSeenAt) })}</span>
                {p.remoteIp ? <span className="text-xs text-muted-foreground" dir="ltr">{p.remoteIp}</span> : null}
                <Button size="sm" className="ms-auto" onClick={() => setClaiming(p)}>{t('pending.claim')}</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ClaimDialog key={claiming?.id ?? 'none'} pending={claiming} onClose={(id) => { setClaiming(null); if (id) navigate(`/devices/${id}`); }} />
    </Card>
  );
}

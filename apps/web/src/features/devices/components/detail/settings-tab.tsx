import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { AlertTriangle, KeyRound, ShieldOff } from 'lucide-react';
import { updateDeviceSchema, type UpdateDeviceInput } from '@flowza/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, FormField, Input, Switch, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { blankToUndefined, toOptionalNumber } from '@/features/organization/form-utils';
import { useDeviceMutations, useProviders, type DeviceDetail } from '../../api';
import { ProviderConfigForm } from '../provider-config-form';
import { isSecretField, normalizeProviderConfig, validateProviderConfig, type ConfigValues } from '../provider-config';
import { TagsInput } from '../tags-input';

type Values = z.input<typeof updateDeviceSchema>;

function GeneralForm({ device, onCredentialsRequired }: { device: DeviceDetail; onCredentialsRequired: () => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const can = useCan();
  const branches = useBranchOptions();
  const { update } = useDeviceMutations();
  const isPush = device.integrationType === 'DEVICE_PUSH';
  const editable = can('device.update') && device.status !== 'decommissioned';
  const defaults = useMemo<Values>(() => ({
    name: device.name, code: device.code, branchId: device.branchId, timezone: device.timezone, manufacturer: device.manufacturer, modelName: device.modelName ?? undefined, serialNumber: device.serialNumber ?? undefined,
    endpointUrl: device.endpointUrl ?? undefined, offlineThresholdMinutes: device.offlineThresholdMinutes, autoSyncEnabled: device.autoSyncEnabled, syncIntervalMinutes: device.syncIntervalMinutes, tags: device.tags, notes: device.notes ?? undefined,
  }), [device]);
  const form = useForm<Values, unknown, UpdateDeviceInput>({ resolver: zodResolver(updateDeviceSchema), defaultValues: defaults });
  const { register, control, formState: { errors, isDirty }, reset } = form;
  const endpoint = useWatch({ control, name: 'endpointUrl' });
  const endpointChanged = !isPush && (endpoint ?? '') !== (device.endpointUrl ?? '');
  const autoSync = useWatch({ control, name: 'autoSyncEnabled' });

  const submit = form.handleSubmit((values) => {
    // Only send what changed: PATCH semantics, nothing is reset by omission.
    const patch: UpdateDeviceInput = {};
    for (const key of Object.keys(values) as (keyof UpdateDeviceInput)[]) {
      const next = values[key]; const prev = (defaults as Record<string, unknown>)[key];
      if (JSON.stringify(next ?? null) !== JSON.stringify(prev ?? null)) (patch as Record<string, unknown>)[key] = next;
    }
    if (Object.keys(patch).length === 0) return;
    update.mutate({ id: device.id, input: patch }, {
      onSuccess: (res) => { toast.success(t('settings.saved')); reset(values); if (res.credentialsRequired) { toast.warning(t('settings.credentialsRequired')); onCredentialsRequired(); } },
      onError: toastError,
    });
  });

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Card>
        <CardHeader><CardTitle>{t('settings.general')}</CardTitle><CardDescription>{t('settings.generalHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField label={tc('common.name')} htmlFor="set-name" required error={errors.name?.message}><Input id="set-name" disabled={!editable} {...register('name')} aria-invalid={!!errors.name} /></FormField>
          <FormField label={tc('common.code')} htmlFor="set-code" required error={errors.code?.message} hint={t('fields.codeHint')}><Input id="set-code" dir="ltr" disabled={!editable} {...register('code')} aria-invalid={!!errors.code} /></FormField>
          <FormField label={tc('common.branch')} htmlFor="set-branch" required error={errors.branchId?.message}>
            <Controller control={control} name="branchId" render={({ field }) => <Combobox id="set-branch" value={field.value ?? null} onChange={(v) => field.onChange(v ?? '')} options={branches.options} loading={branches.isLoading} disabled={!editable} placeholder={t('fields.selectBranch')} aria-invalid={!!errors.branchId} />} />
          </FormField>
          <FormField label={tc('common.timezone')} htmlFor="set-tz" error={errors.timezone?.message} hint={t('fields.timezoneHint')}>
            <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="set-tz" value={field.value ?? undefined} onChange={field.onChange} disabled={!editable} />} />
          </FormField>
          <FormField label={t('fields.manufacturer')} htmlFor="set-manufacturer" required error={errors.manufacturer?.message}><Input id="set-manufacturer" disabled={!editable} {...register('manufacturer')} aria-invalid={!!errors.manufacturer} /></FormField>
          <FormField label={t('fields.modelName')} htmlFor="set-model" optional error={errors.modelName?.message}><Input id="set-model" disabled={!editable} {...register('modelName', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('fields.serialNumber')} htmlFor="set-serial" optional error={errors.serialNumber?.message}><Input id="set-serial" dir="ltr" className="font-mono" disabled={!editable || isPush} {...register('serialNumber', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('fields.tags')} htmlFor="set-tags" optional hint={t('fields.tagsHint')}>
            <Controller control={control} name="tags" render={({ field }) => <TagsInput id="set-tags" value={field.value ?? []} onChange={field.onChange} disabled={!editable} />} />
          </FormField>
          <FormField label={t('fields.offlineThreshold')} htmlFor="set-offline" required error={errors.offlineThresholdMinutes?.message} hint={t('fields.offlineThresholdHint')}>
            <div className="flex items-center gap-2"><Input id="set-offline" type="number" min={1} max={1440} inputMode="numeric" className="w-32 tnum" dir="ltr" disabled={!editable} {...register('offlineThresholdMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.offlineThresholdMinutes} /><span className="text-sm text-muted-foreground">{tc('common.minutes')}</span></div>
          </FormField>
          <FormField label={t('fields.autoSync')} htmlFor="set-autosync" hint={t('fields.autoSyncHint')}>
            <div className="flex items-center gap-3">
              <Controller control={control} name="autoSyncEnabled" render={({ field }) => <Switch id="set-autosync" checked={!!field.value} onCheckedChange={field.onChange} disabled={!editable || !device.capabilities.attendancePull} />} />
              <span className="text-sm text-muted-foreground">{autoSync ? t('wizard.enabled') : t('wizard.disabled')}</span>
            </div>
          </FormField>
          <FormField label={t('fields.syncInterval')} htmlFor="set-interval" error={errors.syncIntervalMinutes?.message} hint={t('fields.syncIntervalHint')}>
            <div className="flex items-center gap-2"><Input id="set-interval" type="number" min={1} max={1440} inputMode="numeric" className="w-32 tnum" dir="ltr" disabled={!editable || !autoSync} {...register('syncIntervalMinutes', { setValueAs: toOptionalNumber })} aria-invalid={!!errors.syncIntervalMinutes} /><span className="text-sm text-muted-foreground">{tc('common.minutes')}</span></div>
          </FormField>
          <FormField label={t('fields.notes')} htmlFor="set-notes" optional className="sm:col-span-2"><Textarea id="set-notes" rows={3} disabled={!editable} {...register('notes', { setValueAs: blankToUndefined })} /></FormField>
        </CardContent>
      </Card>
      {!isPush ? (
        <Card>
          <CardHeader><CardTitle>{t('settings.connection')}</CardTitle><CardDescription>{t('settings.connectionHint')}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <FormField label={t('fields.endpointUrl')} htmlFor="set-endpoint" optional error={errors.endpointUrl?.message}><Input id="set-endpoint" type="url" dir="ltr" placeholder="https://" disabled={!editable} {...register('endpointUrl', { setValueAs: blankToUndefined })} aria-invalid={!!errors.endpointUrl} /></FormField>
            {endpointChanged ? <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {t('settings.endpointWarning')}</p> : null}
          </CardContent>
        </Card>
      ) : null}
      {editable ? <div className="flex justify-end"><Button type="submit" disabled={!isDirty} loading={update.isPending}>{t('settings.save')}</Button></div> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldOff className="size-4" aria-hidden /> {t('settings.readOnly')}</p>}
    </form>
  );
}

function CredentialsForm({ device, highlight }: { device: DeviceDetail; highlight: boolean }) {
  const { t } = useTranslation('devices');
  const can = useCan();
  const providers = useProviders();
  const { putCredentials } = useDeviceMutations();
  const [values, setValues] = useState<ConfigValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fields = useMemo(() => (providers.data ?? []).find((p) => p.key === device.providerKey)?.configSchema.fields.filter(isSecretField) ?? [], [providers.data, device.providerKey]);
  const masked = device.maskedCredentials ?? {};
  const storedKeys = Object.keys(masked);
  const isPush = device.integrationType === 'DEVICE_PUSH';
  if (!can('device.manage') || device.status === 'decommissioned') return null;
  const submit = () => {
    const errs = validateProviderConfig(fields, values, { requireRequired: false });
    setErrors(errs);
    const input = normalizeProviderConfig(fields, values);
    if (Object.keys(errs).length > 0 || Object.keys(input).length === 0) return;
    putCredentials.mutate({ id: device.id, input }, { onSuccess: (res) => { toast.success(t('settings.credentialsSaved', { version: res.version })); setValues({}); }, onError: toastError });
  };
  return (
    <Card className={highlight ? 'border-amber-400 ring-1 ring-amber-400' : undefined} id="device-credentials">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4 text-brand-700" aria-hidden /> {t('settings.credentials')}</CardTitle>
        <CardDescription>{t('settings.credentialsHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {highlight ? <p role="alert" className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('settings.credentialsRequired')}</p> : null}
        {isPush ? <p className="text-sm text-muted-foreground">{t('settings.pushNoCredentials')}</p>
          : fields.length === 0 ? <p className="text-sm text-muted-foreground">{providers.isLoading ? '…' : t('settings.noCredentials')}</p> : (
            <>
              <div className="flex flex-wrap gap-1 text-xs">
                {storedKeys.length === 0 ? <span className="text-muted-foreground">{t('settings.noStored')}</span> : storedKeys.map((k) => <Badge key={k} variant="secondary" className="font-mono" dir="ltr">{k}: {String(masked[k])}</Badge>)}
              </div>
              <ProviderConfigForm fields={fields} values={values} onChange={setValues} errors={errors} masked={masked} only="secret" idPrefix="cred" />
              <div className="flex justify-end"><Button type="button" variant="outline" onClick={submit} loading={putCredentials.isPending} disabled={Object.keys(values).length === 0}>{t('settings.saveCredentials')}</Button></div>
            </>
          )}
      </CardContent>
    </Card>
  );
}

export function SettingsTab({ device }: { device: DeviceDetail }) {
  const [needsCredentials, setNeedsCredentials] = useState(false);
  return (
    <div className="space-y-6">
      <GeneralForm key={device.updatedAt} device={device} onCredentialsRequired={() => { setNeedsCredentials(true); document.getElementById('device-credentials')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />
      <CredentialsForm device={device} highlight={needsCredentials} />
    </div>
  );
}

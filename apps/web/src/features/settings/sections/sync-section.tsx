import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const schema = organizationSettingsSchema.shape.sync.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

export default function SyncSection() {
  const q = useSettingsGroup('sync');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <SyncForm key={JSON.stringify(q.data)} initial={q.data} />;
}

export function SyncForm({ initial, onSaved }: { initial: OrganizationSettings['sync']; onSaved?: (v: Output) => void }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: initial, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'sync', value: values }); toast.success(t('saved')); form.reset(values); onSaved?.(values); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('sync.title')} description={t('sync.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={t('sync.interval')} htmlFor="sync-interval" hint={t('sync.intervalHint')} error={errors.defaultIntervalMinutes?.message}>
          <Input id="sync-interval" type="number" min={1} max={1440} dir="ltr" className="tnum" {...register('defaultIntervalMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.defaultIntervalMinutes} />
        </FormField>
        <FormField label={t('sync.offlineThreshold')} htmlFor="sync-offline" hint={t('sync.offlineThresholdHint')} error={errors.offlineThresholdMinutes?.message}>
          <Input id="sync-offline" type="number" min={1} max={1440} dir="ltr" className="tnum" {...register('offlineThresholdMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.offlineThresholdMinutes} />
        </FormField>
        <FormField label={t('sync.reconciliation')} htmlFor="sync-recon" hint={t('sync.reconciliationHint')} error={errors.reconciliationIntervalHours?.message}>
          <Input id="sync-recon" type="number" min={1} max={168} dir="ltr" className="tnum" {...register('reconciliationIntervalHours', { setValueAs: toNumber })} aria-invalid={!!errors.reconciliationIntervalHours} />
        </FormField>
        <FormField label={t('sync.maxInterval')} htmlFor="sync-max" hint={t('sync.maxIntervalHint')} error={errors.maxIntervalMinutes?.message}>
          <Input id="sync-max" type="number" min={1} max={1440} dir="ltr" className="tnum" {...register('maxIntervalMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.maxIntervalMinutes} />
        </FormField>
        <FormField label={t('sync.maxSkew')} htmlFor="sync-skew" hint={t('sync.maxSkewHint')} error={errors.maxClockSkewMinutes?.message}>
          <Input id="sync-skew" type="number" min={1} max={1440} dir="ltr" className="tnum" {...register('maxClockSkewMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.maxClockSkewMinutes} />
        </FormField>
      </div>
      <Controller control={control} name="adaptivePolling" render={({ field }) => <SwitchRow id="sync-adaptive" label={t('sync.adaptive')} hint={t('sync.adaptiveHint')} control={<Switch id="sync-adaptive" checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      <Controller control={control} name="autoPushNewEmployees" render={({ field }) => <SwitchRow id="sync-autopush" label={t('sync.autoPush')} hint={t('sync.autoPushHint')} control={<Switch id="sync-autopush" checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
    </SettingsSection>
  );
}

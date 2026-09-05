import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Switch, Textarea } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';
import { MfaEnrolment } from '../components/mfa-enrolment';
import { parseDomains } from '../domains';

const schema = organizationSettingsSchema.shape.security.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

export default function SecuritySection() {
  const q = useSettingsGroup('security');
  return (
    <>
      <MfaEnrolment />
      {q.isLoading ? <SectionSkeleton /> : q.isError || !q.data ? <SectionError error={q.error} onRetry={() => void q.refetch()} /> : <SecurityForm key={JSON.stringify(q.data)} initial={q.data} />}
    </>
  );
}

function SecurityForm({ initial }: { initial: OrganizationSettings['security'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: initial, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'security', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('security.title')} description={t('security.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <Controller control={control} name="mfaRequired" render={({ field }) => <SwitchRow id="sec-mfa" label={t('security.mfaRequired')} hint={t('security.mfaRequiredHint')} control={<Switch id="sec-mfa" checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      <Controller control={control} name="exportRequiresReason" render={({ field }) => <SwitchRow id="sec-export" label={t('security.exportReason')} hint={t('security.exportReasonHint')} control={<Switch id="sec-export" checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('security.sessionIdle')} htmlFor="sec-idle" hint={t('security.sessionIdleHint')} error={errors.sessionIdleMinutes?.message}>
          <Input id="sec-idle" type="number" min={5} max={1440} dir="ltr" className="tnum" {...register('sessionIdleMinutes', { setValueAs: toNumber })} aria-invalid={!!errors.sessionIdleMinutes} />
        </FormField>
        <FormField label={t('security.domains')} htmlFor="sec-domains" hint={t('security.domainsHint')} error={errors.allowedEmailDomains?.message ?? (errors.allowedEmailDomains as { root?: { message?: string } } | undefined)?.root?.message}>
          <Controller control={control} name="allowedEmailDomains" render={({ field }) => <Textarea id="sec-domains" dir="ltr" rows={3} placeholder="example.com, example.om" defaultValue={(field.value ?? []).join(', ')} onBlur={(e) => field.onChange(parseDomains(e.target.value))} onChange={(e) => field.onChange(parseDomains(e.target.value))} disabled={readOnly} aria-invalid={!!errors.allowedEmailDomains} />} />
        </FormField>
      </div>
    </SettingsSection>
  );
}

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LEAVE_SETTINGS, leaveSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection } from '../components/settings-section';

/** The form edits the whole group (every key filled with its default); the API stores it through `leaveSettingsSchema.partial()`. */
const schema = z.object({ compOffExpiryDays: leaveSettingsSchema.shape.compOffExpiryDays.unwrap() });
type Values = z.input<typeof schema>;

/** /settings/leave — leave v2 organisation settings: how long a comp-off credit stays usable after the day worked. */
export default function LeaveSection() {
  const q = useSettingsGroup('leave');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <LeaveSettingsForm key={JSON.stringify(q.data)} initial={q.data} />;
}

export function LeaveSettingsForm({ initial }: { initial: OrganizationSettings['leave'] }) {
  const { t } = useTranslation('leave');
  const { t: ts } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, z.output<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { compOffExpiryDays: initial.compOffExpiryDays ?? DEFAULT_LEAVE_SETTINGS.compOffExpiryDays }, disabled: readOnly });
  const { register, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => {
    try { await putGroup.mutateAsync({ group: 'leave', value: values }); toast.success(ts('saved')); form.reset(values); } catch (e) { toastError(e); }
  });
  return (
    <SettingsSection title={t('settings.title')} description={t('settings.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <FormField label={t('settings.compOffExpiryDays')} htmlFor="leave-co-expiry" hint={t('settings.compOffExpiryDaysHint')} error={errors.compOffExpiryDays?.message}>
        <Input id="leave-co-expiry" type="number" inputMode="numeric" min={1} max={365} step={1} dir="ltr" className="w-32 tnum" {...register('compOffExpiryDays', { valueAsNumber: true })} aria-invalid={!!errors.compOffExpiryDays} />
      </FormField>
      <p className="text-xs text-muted-foreground">{t('settings.compOffThresholds')}</p>
    </SettingsSection>
  );
}

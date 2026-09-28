import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { NOTIFICATION_ORG_SWITCHES, organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { toNumber } from '@/features/organization/form-utils';
import { NotificationPreferencesCard } from '@/features/notifications/preferences/notification-preferences-card';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const schema = organizationSettingsSchema.shape.notifications.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

/**
 * Settings → Notifications: the member's own preferences (in-app / e-mail per category), then the organisation's switches —
 * which notices the organisation also sends by e-mail (in-app notices are always written) and the missing check-out
 * reminder. The organisation group is written with `notification.manage` (HR portal Prompt 8).
 */
export default function NotificationsSection() {
  const q = useSettingsGroup('notifications');
  return (
    <div className="space-y-5">
      <NotificationPreferencesCard />
      {q.isLoading ? <SectionSkeleton /> : q.isError || !q.data ? <SectionError error={q.error} onRetry={() => void q.refetch()} /> : <NotificationsForm key={JSON.stringify(q.data)} initial={q.data} />}
    </div>
  );
}

function NotificationsForm({ initial }: { initial: OrganizationSettings['notifications'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('notification.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: initial, disabled: readOnly });
  const { control, register, formState: { isSubmitting, isDirty, errors } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'notifications', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('notifications.title')} description={t('notifications.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      {NOTIFICATION_ORG_SWITCHES.map((k) => (
        <Controller key={k} control={control} name={k} render={({ field }) => <SwitchRow id={`ntf-${k}`} label={t(`notifications.${k}`)} hint={t(`notifications.${k}Hint`)} control={<Switch id={`ntf-${k}`} checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      ))}
      <FormField label={t('notifications.missingPunchReminderHours')} htmlFor="ntf-missingPunchReminderHours" hint={t('notifications.missingPunchReminderHoursHint')} error={errors.missingPunchReminderHours?.message}>
        <Input id="ntf-missingPunchReminderHours" type="number" min={1} max={12} step={1} dir="ltr" className="tnum sm:w-40" {...register('missingPunchReminderHours', { setValueAs: toNumber })} aria-invalid={!!errors.missingPunchReminderHours} />
      </FormField>
      {readOnly ? <p className="text-xs text-muted-foreground">{t('notifications.readOnly')}</p> : null}
    </SettingsSection>
  );
}

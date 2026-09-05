import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, type OrganizationSettings } from '@flowza/contracts';
import { Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const schema = organizationSettingsSchema.shape.notifications.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;
const KEYS = ['deviceOffline', 'syncFailed', 'approvalPending', 'reportReady', 'dailyDigest'] as const;

export default function NotificationsSection() {
  const q = useSettingsGroup('notifications');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <NotificationsForm key={JSON.stringify(q.data)} initial={q.data} />;
}

function NotificationsForm({ initial }: { initial: OrganizationSettings['notifications'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: initial, disabled: readOnly });
  const { control, formState: { isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'notifications', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('notifications.title')} description={t('notifications.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      {KEYS.map((k) => (
        <Controller key={k} control={control} name={k} render={({ field }) => <SwitchRow id={`ntf-${k}`} label={t(`notifications.${k}`)} hint={t(`notifications.${k}Hint`)} control={<Switch id={`ntf-${k}`} checked={!!field.value} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      ))}
    </SettingsSection>
  );
}

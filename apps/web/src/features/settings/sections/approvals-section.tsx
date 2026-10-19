import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { APPROVAL_DEFAULT_ROUTINGS, APPROVAL_MANAGER_UNAVAILABLE_MODES, APPROVAL_SECONDARY_MANAGER_MODES, APPROVAL_TOP_LEVEL_MODES, approvalSettingsSchema, resolveApprovalSettings, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { useMembers } from '@/features/users/api';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection } from '../components/settings-section';

/** The whole group is edited (every key filled with its default); the API stores it through `approvalSettingsSchema.partial()`. */
const schema = approvalSettingsSchema.refine((v) => v.topLevel !== 'named_user' || !!v.topLevelUserId, { path: ['topLevelUserId'], message: 'routing.topLevelUserRequired' });
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

/**
 * /settings/approvals — how requests are routed when no approval workflow applies (`organization_settings.approvals`): the
 * default approver of leave, comp-off and corrections (line manager or permission holders), the secondary manager as a
 * backup or alongside the line manager, the fallback when no manager can act, and the top of the organisation.
 */
export default function ApprovalsSection() {
  const q = useSettingsGroup('approvals');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <ApprovalSettingsForm key={JSON.stringify(q.data)} initial={q.data} />;
}

export function ApprovalSettingsForm({ initial }: { initial: OrganizationSettings['approvals'] }) {
  const { t } = useTranslation('approvals');
  const { t: ts } = useTranslation('settings');
  const can = useCan();
  const readOnly = !can('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: resolveApprovalSettings(initial), disabled: readOnly });
  const { control, formState: { errors, isSubmitting, isDirty } } = form;
  const topLevel = useWatch({ control, name: 'topLevel' });
  const [memberSearch, setMemberSearch] = useState('');
  const members = useMembers({ search: memberSearch || undefined, pageSize: 50, sort: 'fullName', status: 'active' });
  const memberOptions = useMemo(() => (members.data?.data ?? []).map((m) => ({ value: m.userId, label: m.fullName || m.email, description: m.email })), [members.data]);
  const onSubmit = form.handleSubmit(async (values) => {
    const value = { ...values, topLevelUserId: values.topLevel === 'named_user' ? values.topLevelUserId : null };
    try { await putGroup.mutateAsync({ group: 'approvals', value }); toast.success(ts('saved')); form.reset(value); } catch (e) { toastError(e); }
  });
  const choice = <K extends 'defaultRouting' | 'secondaryManager' | 'managerUnavailable' | 'topLevel'>(name: K, id: string, options: readonly string[], optionsKey: string) => (
    <Controller control={control} name={name} render={({ field }) => (
      <Select value={field.value as string} onValueChange={field.onChange} disabled={readOnly}>
        <SelectTrigger id={id}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map((v) => <SelectItem key={v} value={v}>{t(`routing.${optionsKey}.${v}`)}</SelectItem>)}</SelectContent>
      </Select>
    )} />
  );
  return (
    <SettingsSection title={t('routing.title')} description={t('routing.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:max-w-xl">
        <FormField label={t('routing.defaultRouting')} htmlFor="apr-default" hint={t('routing.defaultRoutingHint')}>
          {choice('defaultRouting', 'apr-default', APPROVAL_DEFAULT_ROUTINGS, 'defaultRoutingOptions')}
        </FormField>
        <FormField label={t('routing.secondaryManager')} htmlFor="apr-secondary" hint={t('routing.secondaryManagerHint')}>
          {choice('secondaryManager', 'apr-secondary', APPROVAL_SECONDARY_MANAGER_MODES, 'secondaryManagerOptions')}
        </FormField>
        <FormField label={t('routing.managerUnavailable')} htmlFor="apr-unavailable" hint={t('routing.managerUnavailableHint')}>
          {choice('managerUnavailable', 'apr-unavailable', APPROVAL_MANAGER_UNAVAILABLE_MODES, 'managerUnavailableOptions')}
        </FormField>
        <FormField label={t('routing.topLevel')} htmlFor="apr-top" hint={t('routing.topLevelHint')}>
          {choice('topLevel', 'apr-top', APPROVAL_TOP_LEVEL_MODES, 'topLevelOptions')}
        </FormField>
        {topLevel === 'named_user' ? (
          <FormField label={t('routing.topLevelUser')} htmlFor="apr-top-user" required hint={t('routing.topLevelUserHint')} error={errors.topLevelUserId?.message ? t(errors.topLevelUserId.message) : undefined}>
            <Controller control={control} name="topLevelUserId" render={({ field }) => <Combobox id="apr-top-user" value={field.value ?? null} onChange={(v) => field.onChange(v)} options={memberOptions} onSearch={setMemberSearch} loading={members.isFetching} placeholder={t('routing.selectUser')} disabled={readOnly} aria-invalid={!!errors.topLevelUserId} />} />
          </FormField>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('routing.ladder')}</p>
    </SettingsSection>
  );
}

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { organizationSettingsSchema, updateOrganizationSchema, type OrganizationDto, type OrganizationSettings } from '@flowza/contracts';
import { FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { WeeklyOffToggles } from '@/features/organization/components/weekly-off-toggles';
import { toNumber } from '@/features/organization/form-utils';
import { useOrganization, useSettingsGroup, useSettingsMutations, type UpdateOrganizationInput } from '../api';
import { SectionError, SectionSkeleton, SettingsSection } from '../components/settings-section';

const generalSchema = organizationSettingsSchema.shape.general.unwrap();
type GeneralValues = z.input<typeof generalSchema>;
type GeneralOutput = z.output<typeof generalSchema>;
type OrgOutput = z.output<typeof updateOrganizationSchema>;

export default function RegionalSection() {
  const org = useOrganization();
  const general = useSettingsGroup('general');
  if (org.isLoading || general.isLoading) return <SectionSkeleton />;
  if (org.isError || !org.data) return <SectionError error={org.error} onRetry={() => void org.refetch()} />;
  if (general.isError || !general.data) return <SectionError error={general.error} onRetry={() => void general.refetch()} />;
  return (
    <>
      <OrgRegionalForm key={`${org.data.timezone}-${org.data.locale}-${org.data.currencyCode}`} org={org.data} />
      <FormatsForm key={JSON.stringify(general.data)} initial={general.data} />
    </>
  );
}

function OrgRegionalForm({ org }: { org: OrganizationDto }) {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation();
  const readOnly = !useCan()('organization.manage');
  const { updateOrganization } = useSettingsMutations();
  const form = useForm<UpdateOrganizationInput, unknown, OrgOutput>({ resolver: zodResolver(updateOrganizationSchema), defaultValues: { timezone: org.timezone, countryCode: org.countryCode, currencyCode: org.currencyCode, locale: org.locale as 'en' | 'ar', weeklyOffDays: org.weeklyOffDays }, disabled: readOnly });
  const { register, control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await updateOrganization.mutateAsync(values); toast.success(t('saved')); form.reset(values as UpdateOrganizationInput); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('regional.title')} description={t('regional.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tc('common.timezone')} htmlFor="org-tz" required error={errors.timezone?.message} hint={t('regional.timezoneHint')}>
          <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="org-tz" value={field.value} onChange={field.onChange} disabled={readOnly} />} />
        </FormField>
        <FormField label={t('regional.locale')} htmlFor="org-locale" error={errors.locale?.message}>
          <Controller control={control} name="locale" render={({ field }) => (
            <Select value={field.value ?? 'en'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="org-locale"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">English</SelectItem><SelectItem value="ar">العربية</SelectItem></SelectContent></Select>
          )} />
        </FormField>
        <FormField label={t('regional.country')} htmlFor="org-cc" error={errors.countryCode?.message} hint={t('regional.countryHint')}><Input id="org-cc" dir="ltr" maxLength={2} className="uppercase" {...register('countryCode')} aria-invalid={!!errors.countryCode} /></FormField>
        <FormField label={t('regional.currency')} htmlFor="org-cur" error={errors.currencyCode?.message} hint={t('regional.currencyHint')}><Input id="org-cur" dir="ltr" maxLength={3} className="uppercase" {...register('currencyCode')} aria-invalid={!!errors.currencyCode} /></FormField>
        <FormField label={t('regional.weeklyOff')} htmlFor="org-weekly" hint={t('regional.weeklyOffHint')} className="sm:col-span-2">
          <Controller control={control} name="weeklyOffDays" render={({ field }) => <WeeklyOffToggles value={field.value} onChange={field.onChange} disabled={readOnly} ariaLabel={t('regional.weeklyOff')} />} />
        </FormField>
      </div>
    </SettingsSection>
  );
}

function FormatsForm({ initial }: { initial: OrganizationSettings['general'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const form = useForm<GeneralValues, unknown, GeneralOutput>({ resolver: zodResolver(generalSchema), defaultValues: initial, disabled: readOnly });
  const { control, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await putGroup.mutateAsync({ group: 'general', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('regional.formats')} description={t('regional.formatsHint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('regional.dateFormat')} htmlFor="fmt-date" error={errors.dateFormat?.message}>
          <Controller control={control} name="dateFormat" render={({ field }) => (
            <Select value={field.value ?? 'DD/MM/YYYY'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="fmt-date" dir="ltr"><SelectValue /></SelectTrigger><SelectContent>{['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'].map((f) => <SelectItem key={f} value={f} dir="ltr">{f}</SelectItem>)}</SelectContent></Select>
          )} />
        </FormField>
        <FormField label={t('regional.timeFormat')} htmlFor="fmt-time" error={errors.timeFormat?.message}>
          <Controller control={control} name="timeFormat" render={({ field }) => (
            <Select value={field.value ?? '24h'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="fmt-time"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="24h">{t('regional.h24')}</SelectItem><SelectItem value="12h">{t('regional.h12')}</SelectItem></SelectContent></Select>
          )} />
        </FormField>
        <FormField label={t('regional.firstDayOfWeek')} htmlFor="fmt-fdow" error={errors.firstDayOfWeek?.message}>
          <Controller control={control} name="firstDayOfWeek" render={({ field }) => (
            <Select value={String(field.value ?? 0)} onValueChange={(v) => field.onChange(toNumber(v))} disabled={readOnly}><SelectTrigger id="fmt-fdow"><SelectValue /></SelectTrigger><SelectContent>{[0, 1, 6].map((d) => <SelectItem key={d} value={String(d)}>{t(`organization:days.${d}`)}</SelectItem>)}</SelectContent></Select>
          )} />
        </FormField>
        <FormField label={t('regional.calendar')} htmlFor="fmt-cal" error={errors.calendar?.message}>
          <Controller control={control} name="calendar" render={({ field }) => (
            <Select value={field.value ?? 'gregorian'} onValueChange={field.onChange} disabled={readOnly}><SelectTrigger id="fmt-cal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="gregorian">{t('regional.gregorian')}</SelectItem><SelectItem value="hijri_secondary">{t('regional.hijriSecondary')}</SelectItem></SelectContent></Select>
          )} />
        </FormField>
      </div>
    </SettingsSection>
  );
}

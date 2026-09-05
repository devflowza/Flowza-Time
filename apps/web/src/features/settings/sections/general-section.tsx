import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { updateOrganizationSchema, type OrganizationDto } from '@flowza/contracts';
import { Badge, FormField, Input } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { useCan } from '@/features/me/use-me';
import { blankToUndefined } from '@/features/organization/form-utils';
import { useOrganization, useSettingsMutations, type UpdateOrganizationInput } from '../api';
import { SectionError, SectionSkeleton, SettingsSection } from '../components/settings-section';

type Output = z.output<typeof updateOrganizationSchema>;

export default function GeneralSection() {
  const q = useOrganization();
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <GeneralForm key={q.data.id + q.data.displayName + q.data.legalName} org={q.data} />;
}

function GeneralForm({ org }: { org: OrganizationDto }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { updateOrganization } = useSettingsMutations();
  const form = useForm<UpdateOrganizationInput, unknown, Output>({
    resolver: zodResolver(updateOrganizationSchema),
    defaultValues: { legalName: org.legalName, displayName: org.displayName, contact: { name: org.contact.name, email: org.contact.email, phone: org.contact.phone, website: org.contact.website }, address: { line1: org.address.line1, line2: org.address.line2, city: org.address.city, region: org.address.region, postalCode: org.address.postalCode, country: org.address.country } },
    disabled: readOnly,
  });
  const { register, formState: { errors, isSubmitting, isDirty } } = form;
  const onSubmit = form.handleSubmit(async (values) => { try { await updateOrganization.mutateAsync(values); toast.success(t('saved')); form.reset(values as UpdateOrganizationInput); } catch (e) { toastError(e); } });
  return (
    <SettingsSection title={t('general.title')} description={t('general.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t('general.companyCode')}:</span><Badge variant="outline" className="font-mono" dir="ltr">{org.companyCode}</Badge>
        <span className="ms-2">{t('general.status')}:</span><Badge variant={org.status === 'active' ? 'success' : org.status === 'trial' ? 'info' : 'warning'}>{t(`orgStatus.${org.status}`)}</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('general.displayName')} htmlFor="org-display" required error={errors.displayName?.message}><Input id="org-display" {...register('displayName')} aria-invalid={!!errors.displayName} /></FormField>
        <FormField label={t('general.legalName')} htmlFor="org-legal" required error={errors.legalName?.message}><Input id="org-legal" {...register('legalName')} aria-invalid={!!errors.legalName} /></FormField>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('general.contact')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('general.contactName')} htmlFor="org-cname" optional><Input id="org-cname" {...register('contact.name', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.contactEmail')} htmlFor="org-cemail" optional error={errors.contact?.email?.message}><Input id="org-cemail" type="email" dir="ltr" {...register('contact.email', { setValueAs: blankToUndefined })} aria-invalid={!!errors.contact?.email} /></FormField>
          <FormField label={t('general.contactPhone')} htmlFor="org-cphone" optional error={errors.contact?.phone?.message}><Input id="org-cphone" type="tel" dir="ltr" {...register('contact.phone', { setValueAs: blankToUndefined })} aria-invalid={!!errors.contact?.phone} /></FormField>
          <FormField label={t('general.website')} htmlFor="org-web" optional error={errors.contact?.website?.message}><Input id="org-web" type="url" dir="ltr" placeholder="https://" {...register('contact.website', { setValueAs: blankToUndefined })} aria-invalid={!!errors.contact?.website} /></FormField>
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('general.address')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('general.line1')} htmlFor="org-l1" optional className="sm:col-span-2"><Input id="org-l1" {...register('address.line1', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.line2')} htmlFor="org-l2" optional className="sm:col-span-2"><Input id="org-l2" {...register('address.line2', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.city')} htmlFor="org-city" optional><Input id="org-city" {...register('address.city', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.region')} htmlFor="org-region" optional><Input id="org-region" {...register('address.region', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.postalCode')} htmlFor="org-postal" optional><Input id="org-postal" dir="ltr" {...register('address.postalCode', { setValueAs: blankToUndefined })} /></FormField>
          <FormField label={t('general.country')} htmlFor="org-country" optional error={errors.address?.country?.message} hint={t('regional.countryHint')}><Input id="org-country" dir="ltr" maxLength={2} className="uppercase" {...register('address.country', { setValueAs: blankToUndefined })} aria-invalid={!!errors.address?.country} /></FormField>
        </div>
      </fieldset>
    </SettingsSection>
  );
}

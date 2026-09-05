import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Check, Copy, MailCheck } from 'lucide-react';
import { createOrganizationSchema, type CreateOrganizationInput, type CreateOrganizationResult } from '@flowza/contracts';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { usePlans, usePlatformMutations } from '../api';

type Values = z.input<typeof createOrganizationSchema>;
const COUNTRIES = ['OM', 'AE', 'SA', 'QA', 'KW', 'BH'] as const;
const CURRENCIES = ['OMR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'USD'] as const;

function InvitationResult({ result, onClose }: { result: CreateOrganizationResult; onClose: () => void }) {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const [copied, setCopied] = useState(false);
  const inv = result.invitation;
  const copy = async () => { if (!inv) return; try { await navigator.clipboard.writeText(inv.token); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* selectable */ } };
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><MailCheck className="size-5 text-emerald-600" aria-hidden /> {t('orgs.createdTitle', { name: result.organization.displayName })}</DialogTitle>
        <DialogDescription>{inv ? t('orgs.invitationHint', { email: inv.email }) : t('orgs.ownerLinked')}</DialogDescription>
      </DialogHeader>
      {inv ? (
        <div className="space-y-2">
          <Label htmlFor="inv-token">{t('orgs.invitationToken')}</Label>
          <div className="flex items-stretch gap-2">
            <code id="inv-token" dir="ltr" className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-md border bg-muted px-3 py-2 font-mono text-xs scrollbar-thin">{inv.token}</code>
            <Button type="button" variant="outline" size="icon" onClick={() => void copy()} aria-label={copied ? tc('common.copied') : tc('common.copy')}>{copied ? <Check className="text-emerald-600" /> : <Copy />}</Button>
          </div>
          <p className="text-xs text-muted-foreground tnum">{t('orgs.invitationExpires', { when: fmtDateTime(inv.expiresAt, result.organization.timezone) })}</p>
        </div>
      ) : null}
      <DialogFooter><Button type="button" onClick={onClose}>{tc('common.close')}</Button></DialogFooter>
    </>
  );
}

/** Creates a tenant with its owner (createOrganizationSchema — the same schema the API validates). */
export function CreateOrgDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (r: CreateOrganizationResult) => void }) {
  const { t } = useTranslation('platform');
  const { t: tc } = useTranslation();
  const plans = usePlans();
  const { createOrg } = usePlatformMutations();
  const [result, setResult] = useState<CreateOrganizationResult | null>(null);
  const form = useForm<Values, unknown, CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { companyCode: '', legalName: '', displayName: '', countryCode: 'OM', timezone: 'Asia/Muscat', currencyCode: 'OMR', locale: 'en', weeklyOffDays: [5, 6], contact: {}, address: {}, ownerEmail: '', ownerFullName: '', planKey: 'trial' },
  });
  const { register, control, formState: { errors } } = form;
  const submit = form.handleSubmit((values) => createOrg.mutate(values, { onSuccess: (r) => { toast.success(t('orgs.created')); setResult(r); onCreated?.(r); }, onError: toastError }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        {result ? <InvitationResult result={result} onClose={() => onOpenChange(false)} /> : (
          <>
            <DialogHeader><DialogTitle>{t('orgs.create')}</DialogTitle><DialogDescription>{t('orgs.createHint')}</DialogDescription></DialogHeader>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label={t('orgs.companyCode')} htmlFor="org-code" required error={errors.companyCode?.message} hint={t('orgs.companyCodeHint')}><Input id="org-code" dir="ltr" {...register('companyCode')} aria-invalid={!!errors.companyCode} /></FormField>
                <FormField label={t('orgs.displayName')} htmlFor="org-display" required error={errors.displayName?.message}><Input id="org-display" {...register('displayName')} aria-invalid={!!errors.displayName} /></FormField>
                <FormField label={t('orgs.legalName')} htmlFor="org-legal" required error={errors.legalName?.message} className="sm:col-span-2"><Input id="org-legal" {...register('legalName')} aria-invalid={!!errors.legalName} /></FormField>
                <FormField label={t('orgs.country')} htmlFor="org-country" error={errors.countryCode?.message}>
                  <Controller control={control} name="countryCode" render={({ field }) => <Select value={field.value ?? 'OM'} onValueChange={field.onChange}><SelectTrigger id="org-country"><SelectValue /></SelectTrigger><SelectContent>{COUNTRIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>} />
                </FormField>
                <FormField label={tc('common.timezone')} htmlFor="org-tz" error={errors.timezone?.message}>
                  <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="org-tz" value={field.value ?? undefined} onChange={field.onChange} />} />
                </FormField>
                <FormField label={t('orgs.currency')} htmlFor="org-currency" error={errors.currencyCode?.message}>
                  <Controller control={control} name="currencyCode" render={({ field }) => <Select value={field.value ?? 'OMR'} onValueChange={field.onChange}><SelectTrigger id="org-currency"><SelectValue /></SelectTrigger><SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>} />
                </FormField>
                <FormField label={tc('common.language')} htmlFor="org-locale" error={errors.locale?.message}>
                  <Controller control={control} name="locale" render={({ field }) => <Select value={field.value ?? 'en'} onValueChange={field.onChange}><SelectTrigger id="org-locale"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">English</SelectItem><SelectItem value="ar">العربية</SelectItem></SelectContent></Select>} />
                </FormField>
                <FormField label={t('orgs.plan')} htmlFor="org-plan" error={errors.planKey?.message}>
                  <Controller control={control} name="planKey" render={({ field }) => (
                    <Select value={field.value ?? 'trial'} onValueChange={field.onChange}>
                      <SelectTrigger id="org-plan"><SelectValue /></SelectTrigger>
                      <SelectContent>{(plans.data ?? []).filter((p) => p.isActive).map((p) => <SelectItem key={p.key} value={p.key}>{p.name}</SelectItem>)}{!plans.data?.some((p) => p.key === 'trial') ? <SelectItem value="trial">trial</SelectItem> : null}</SelectContent>
                    </Select>
                  )} />
                </FormField>
                <FormField label={t('orgs.ownerFullName')} htmlFor="org-owner-name" required error={errors.ownerFullName?.message}><Input id="org-owner-name" {...register('ownerFullName')} aria-invalid={!!errors.ownerFullName} /></FormField>
                <FormField label={t('orgs.ownerEmail')} htmlFor="org-owner-email" required error={errors.ownerEmail?.message} hint={t('orgs.ownerEmailHint')}><Input id="org-owner-email" type="email" dir="ltr" autoComplete="off" {...register('ownerEmail')} aria-invalid={!!errors.ownerEmail} /></FormField>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{tc('common.cancel')}</Button>
                <Button type="submit" loading={createOrg.isPending}>{tc('common.create')}</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

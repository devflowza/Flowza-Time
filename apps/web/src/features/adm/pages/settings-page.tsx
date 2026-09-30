import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { platformSettingsSchema, type PlatformSettings, type PutPlatformSettingsInput } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { fmtRelative } from '@/lib/format';
import { toast, toastError } from '@/lib/toast';
import { useBillingMutations, usePlatformSettings } from '../billing-api';

/** Changed fields only (PUT /platform/settings merges), so two admins editing different settings do not overwrite each other. */
function changed(before: PlatformSettings, after: PlatformSettings): PutPlatformSettingsInput {
  const out: Record<string, Record<string, unknown>> = {};
  for (const group of ['general', 'billing'] as const) {
    for (const [k, v] of Object.entries(after[group])) {
      if (JSON.stringify(v) !== JSON.stringify((before[group] as Record<string, unknown>)[k])) (out[group] ??= {})[k] = v;
    }
  }
  return out as PutPlatformSettingsInput;
}

function SettingsForm({ initial, updatedAt }: { initial: PlatformSettings; updatedAt: string | null }) {
  const { t } = useTranslation('adm');
  const { t: tc } = useTranslation();
  const { putSettings } = useBillingMutations();
  const form = useForm<PlatformSettings>({ resolver: zodResolver(platformSettingsSchema), defaultValues: initial });
  const { register, formState: { errors, isDirty } } = form;
  const submit = form.handleSubmit((v) => {
    const diff = changed(initial, v);
    if (Object.keys(diff).length === 0) return;
    putSettings.mutate(diff, { onSuccess: (d) => { toast.success(t('settings.saved')); form.reset({ general: d.general, billing: d.billing }); }, onError: toastError });
  });
  const text = (group: 'general' | 'billing', key: string, opts: { ltr?: boolean; type?: string; hint?: string; area?: boolean } = {}) => {
    const name = `${group}.${key}` as const;
    const err = (errors[group] as Record<string, { message?: string }> | undefined)?.[key]?.message;
    return (
      <FormField key={name} label={t(`settings.fields.${key}`)} htmlFor={`set-${key}`} hint={opts.hint} error={err}>
        {opts.area
          ? <Textarea id={`set-${key}`} rows={3} {...register(name as never)} />
          : <Input id={`set-${key}`} type={opts.type ?? 'text'} dir={opts.ltr ? 'ltr' : undefined} step={opts.type === 'number' ? 'any' : undefined} {...register(name as never, opts.type === 'number' ? { valueAsNumber: true } : undefined)} />}
      </FormField>
    );
  };
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card>
        <CardHeader><CardTitle>{t('settings.general')}</CardTitle><CardDescription>{t('settings.generalHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">{text('general', 'platformName')}{text('general', 'supportEmail', { ltr: true, type: 'email' })}</CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('settings.billing')}</CardTitle><CardDescription>{t('settings.billingHint')}</CardDescription></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {text('billing', 'currency', { ltr: true, hint: t('settings.currencyHint') })}
          {text('billing', 'vatRate', { ltr: true, type: 'number', hint: t('settings.vatHint') })}
          {text('billing', 'invoicePrefix', { ltr: true, hint: t('settings.prefixHint') })}
          {text('billing', 'paymentTermsDays', { ltr: true, type: 'number' })}
        </CardContent>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {text('billing', 'sellerName')}{text('billing', 'sellerVatNumber', { ltr: true })}
          {text('billing', 'sellerAddress', { area: true })}{text('billing', 'bankDetails', { area: true, hint: t('settings.bankHint') })}
        </CardContent>
      </Card>
      <div className="flex items-center justify-end gap-3">
        {updatedAt ? <span className="text-xs text-muted-foreground">{t('settings.updated', { when: fmtRelative(updatedAt) })}</span> : null}
        <Button type="button" variant="outline" disabled={!isDirty} onClick={() => form.reset(initial)}>{tc('common.cancel')}</Button>
        <Button type="submit" disabled={!isDirty} loading={putSettings.isPending}>{tc('common.save')}</Button>
      </div>
    </form>
  );
}

/** Platform settings (Flowza Finance /adm/settings parity): the product's name and support contact, and how invoices are issued. */
export default function AdmSettingsPage() {
  const { t } = useTranslation('adm');
  const q = usePlatformSettings();
  return (
    <div className="page-container max-w-5xl">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      {q.isLoading ? <Skeleton className="h-96 w-full" /> : q.isError || !q.data ? <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        : <SettingsForm key={q.data.updatedAt ?? 'initial'} initial={{ general: q.data.general, billing: q.data.billing }} updatedAt={q.data.updatedAt} />}
    </div>
  );
}

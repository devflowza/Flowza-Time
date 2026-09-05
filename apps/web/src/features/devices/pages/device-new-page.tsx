import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Plug, Radio } from 'lucide-react';
import { createDeviceSchema, type CreateDeviceInput, type DeviceModelDto, type TestConnectionResultDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ErrorState, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { Combobox } from '@/components/forms';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useOrgTimezone } from '@/features/me/use-me';
import { useBranchOptions } from '@/features/organization/lookups';
import { TimezoneSelect } from '@/features/organization/components/timezone-select';
import { blankToUndefined } from '@/features/organization/form-utils';
import { toastJobQueued } from '@/features/sync/job-toast';
import { useDeviceMutations, useDeviceModels, useProviders, type DeviceCreatedDto, type ProviderDto } from '../api';
import { CapabilityChips, IntegrationBadge, ProviderStatusBadge, VerificationBadge } from '../components/device-badges';
import { normalizeProviderConfig, ProviderConfigForm, validateProviderConfig, type ConfigValues } from '../components/provider-config-form';
import { PushCredentialsDialog } from '../components/push-credentials-dialog';
import { TestConnectionResult } from '../components/test-connection-result';
import { TagsInput } from '../components/tags-input';

const STEPS = ['provider', 'model', 'details', 'connection', 'test', 'review'] as const;
type Step = (typeof STEPS)[number];

const detailsSchema = createDeviceSchema.pick({ code: true, name: true, branchId: true, timezone: true, tags: true, serialNumber: true, modelName: true, manufacturer: true, notes: true });
type DetailsValues = z.input<typeof detailsSchema>;
type Details = z.output<typeof detailsSchema>;

function Stepper({ current }: { current: Step }) {
  const { t } = useTranslation('devices');
  const idx = STEPS.indexOf(current);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs" aria-label={t('wizard.steps')}>
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === idx ? 'step' : undefined}>
          <span className={cn('flex size-6 items-center justify-center rounded-full border font-semibold tnum', i < idx && 'border-brand-600 bg-brand-600 text-white', i === idx && 'border-brand-600 text-brand-700', i > idx && 'text-muted-foreground')}>{i < idx ? <Check className="size-3.5" /> : i + 1}</span>
          <span className={cn(i === idx ? 'font-medium' : 'text-muted-foreground', 'hidden sm:inline')}>{t(`wizard.step.${s}`)}</span>
          {i < STEPS.length - 1 ? <span className="mx-1 h-px w-4 bg-border" aria-hidden /> : null}
        </li>
      ))}
    </ol>
  );
}

// ---- step 1: provider -------------------------------------------------------------------------------------------------------

function ProviderStep({ value, onSelect }: { value: string | null; onSelect: (p: ProviderDto) => void }) {
  const { t } = useTranslation('devices');
  const q = useProviders();
  const groups = useMemo(() => {
    const map = new Map<string, ProviderDto[]>();
    for (const p of q.data ?? []) map.set(p.vendor, [...(map.get(p.vendor) ?? []), p]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [q.data]);
  if (q.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-6">
      {groups.map(([vendor, providers]) => (
        <section key={vendor}>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{vendor}</h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('wizard.step.provider')}>
            {providers.map((p) => {
              const disabled = p.status === 'placeholder';
              const selected = p.key === value;
              return (
                <button
                  key={p.key} type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={() => onSelect(p)}
                  className={cn('flex h-full flex-col rounded-lg border bg-card p-4 text-start shadow-card transition-colors focus-visible:ring-2 focus-visible:ring-ring', selected ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300', disabled && 'cursor-not-allowed opacity-70 hover:border-border')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1"><IntegrationBadge type={p.integrationType} /><ProviderStatusBadge status={p.status} /><VerificationBadge status={p.verificationStatus} /></div>
                    </div>
                    {p.integrationType === 'DEVICE_PUSH' ? <Radio className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Plug className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  </div>
                  {p.description ? <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{p.description}</p> : null}
                  <CapabilityChips capabilities={p.capabilities} className="mt-3" />
                  {disabled ? <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300">{t('wizard.placeholderNote')}</p> : null}
                  {p.docsUrl ? <a href={p.docsUrl} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{t('wizard.docs')} <ExternalLink className="size-3" /></a> : null}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---- step 2: model ------------------------------------------------------------------------------------------------------------

function ModelStep({ providerKey, value, onChange }: { providerKey: string; value: string | null; onChange: (m: DeviceModelDto | null) => void }) {
  const { t } = useTranslation('devices');
  const q = useDeviceModels(providerKey);
  if (q.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('wizard.modelHint')}</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('wizard.step.model')}>
        <button type="button" role="radio" aria-checked={value === null} onClick={() => onChange(null)} className={cn('rounded-lg border bg-card p-4 text-start shadow-card', value === null ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300')}>
          <p className="font-medium">{t('wizard.noModel')}</p><p className="mt-1 text-xs text-muted-foreground">{t('wizard.noModelHint')}</p>
        </button>
        {(q.data ?? []).map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={value === m.id} onClick={() => onChange(m)} className={cn('rounded-lg border bg-card p-4 text-start shadow-card', value === m.id ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300')}>
            <div className="flex items-start justify-between gap-2"><p className="font-medium">{m.model}</p><VerificationBadge status={m.verification} /></div>
            <p className="text-xs text-muted-foreground">{m.vendor}{m.family ? ` · ${m.family}` : ''}</p>
            <CapabilityChips capabilities={m.capabilities} className="mt-2" />
            {m.notes ? <p className="mt-2 text-xs text-muted-foreground">{m.notes}</p> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- step 3: details --------------------------------------------------------------------------------------------------------------

function DetailsStep({ defaults, provider, onSubmit, onBack }: { defaults: DetailsValues; provider: ProviderDto; onSubmit: (d: Details) => void; onBack: () => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const branches = useBranchOptions();
  const isPush = provider.integrationType === 'DEVICE_PUSH';
  const schema = useMemo(() => (isPush ? detailsSchema.extend({ serialNumber: createDeviceSchema.shape.serialNumber.unwrap().min(1) }) : detailsSchema), [isPush]);
  const form = useForm<DetailsValues, unknown, Details>({ resolver: zodResolver(schema), defaultValues: defaults });
  const { register, control, formState: { errors }, setValue, getValues } = form;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={tc('common.code')} htmlFor="dev-code" required error={errors.code?.message} hint={t('fields.codeHint')}>
          <Input id="dev-code" dir="ltr" {...register('code')} aria-invalid={!!errors.code} />
        </FormField>
        <FormField label={tc('common.name')} htmlFor="dev-name" required error={errors.name?.message}>
          <Input id="dev-name" {...register('name')} aria-invalid={!!errors.name} />
        </FormField>
        <FormField label={tc('common.branch')} htmlFor="dev-branch" required error={errors.branchId?.message}>
          <Controller control={control} name="branchId" render={({ field }) => (
            <Combobox id="dev-branch" value={field.value} options={branches.options} loading={branches.isLoading} placeholder={t('fields.selectBranch')} aria-invalid={!!errors.branchId}
              onChange={(v) => { field.onChange(v ?? ''); const b = v ? branches.byId.get(v) : undefined; if (b && !getValues('timezone')) setValue('timezone', b.timezone); }} />
          )} />
        </FormField>
        <FormField label={tc('common.timezone')} htmlFor="dev-tz" error={errors.timezone?.message} hint={t('fields.timezoneHint')} optional>
          <Controller control={control} name="timezone" render={({ field }) => <TimezoneSelect id="dev-tz" value={field.value ?? undefined} onChange={field.onChange} />} />
        </FormField>
        <FormField label={t('fields.serialNumber')} htmlFor="dev-serial" required={isPush} optional={!isPush} error={errors.serialNumber?.message} hint={isPush ? t('fields.serialPushHint') : undefined}>
          <Input id="dev-serial" dir="ltr" className="font-mono" {...register('serialNumber', { setValueAs: blankToUndefined })} aria-invalid={!!errors.serialNumber} />
        </FormField>
        <FormField label={t('fields.manufacturer')} htmlFor="dev-manufacturer" required error={errors.manufacturer?.message}>
          <Input id="dev-manufacturer" {...register('manufacturer')} aria-invalid={!!errors.manufacturer} />
        </FormField>
        <FormField label={t('fields.modelName')} htmlFor="dev-model" optional error={errors.modelName?.message}>
          <Input id="dev-model" {...register('modelName', { setValueAs: blankToUndefined })} />
        </FormField>
        <FormField label={t('fields.tags')} htmlFor="dev-tags" optional hint={t('fields.tagsHint')}>
          <Controller control={control} name="tags" render={({ field }) => <TagsInput id="dev-tags" value={field.value ?? []} onChange={field.onChange} />} />
        </FormField>
        <FormField label={t('fields.notes')} htmlFor="dev-notes" optional className="sm:col-span-2">
          <Textarea id="dev-notes" rows={2} {...register('notes', { setValueAs: blankToUndefined })} />
        </FormField>
      </div>
      <WizardNav onBack={onBack} nextType="submit" />
    </form>
  );
}

function WizardNav({ onBack, onNext, nextLabel, nextType = 'button', nextDisabled, loading }: { onBack?: () => void; onNext?: () => void; nextLabel?: string; nextType?: 'button' | 'submit'; nextDisabled?: boolean; loading?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-t pt-4">
      {onBack ? <Button type="button" variant="ghost" onClick={onBack}><ArrowLeft className="rtl:rotate-180" /> {t('common.back')}</Button> : <span />}
      <Button type={nextType} onClick={onNext} disabled={nextDisabled} loading={loading}>{nextLabel ?? t('common.next')} {nextType === 'button' && !nextLabel ? <ArrowRight className="rtl:rotate-180" /> : null}</Button>
    </div>
  );
}

// ---- page -----------------------------------------------------------------------------------------------------------------------------

export default function DeviceNewPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const orgTz = useOrgTimezone();
  const { create, testConnection } = useDeviceMutations();
  const [step, setStep] = useState<Step>('provider');
  const [provider, setProvider] = useState<ProviderDto | null>(null);
  const [model, setModel] = useState<DeviceModelDto | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [config, setConfig] = useState<ConfigValues>({});
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestConnectionResultDto | null>(null);
  const [created, setCreated] = useState<DeviceCreatedDto | null>(null);

  const isPush = provider?.integrationType === 'DEVICE_PUSH';
  const fields = provider?.configSchema.fields ?? [];
  const go = (s: Step) => { setStep(s); window.scrollTo({ top: 0 }); };

  const detailDefaults: DetailsValues = details ?? { code: '', name: '', branchId: '', timezone: orgTz, tags: [], manufacturer: provider?.vendor ?? '', modelName: model?.model, serialNumber: undefined, notes: undefined };

  const buildInput = (): CreateDeviceInput | null => {
    if (!provider || !details) return null;
    const cfg = normalizeProviderConfig(fields, config);
    const urlField = fields.find((f) => f.type === 'url');
    const endpointUrl = urlField && typeof cfg[urlField.key] === 'string' ? String(cfg[urlField.key]) : undefined;
    const parsed = createDeviceSchema.safeParse({ ...details, providerKey: provider.key, modelId: model?.id, config: cfg, endpointUrl, serialNumber: details.serialNumber ?? (typeof cfg.serialNumber === 'string' ? cfg.serialNumber : undefined) });
    return parsed.success ? parsed.data : null;
  };

  const validateConnection = () => { const errs = validateProviderConfig(fields, config); setConfigErrors(errs); return Object.keys(errs).length === 0; };

  const runTest = () => {
    if (!provider) return;
    setTestResult(null);
    testConnection.mutate({ providerKey: provider.key, config: normalizeProviderConfig(fields, config) }, { onSuccess: setTestResult, onError: toastError });
  };

  const register = () => {
    const input = buildInput();
    if (!input) { toast.error(t('wizard.invalid')); return; }
    create.mutate(input, {
      onSuccess: (res) => {
        toast.success(t('wizard.created', { name: res.device.name }));
        if (res.credentialsError) toast.error(res.credentialsError);
        if (res.testConnectionJobId) toastJobQueued(res.testConnectionJobId, navigate, t('wizard.testQueued'));
        if (res.pushToken || res.webhookUrl) setCreated(res); else navigate(`/devices/${res.device.id}`);
      },
      onError: toastError,
    });
  };

  return (
    <div className="page-container max-w-5xl">
      <PageHeader title={t('wizard.title')} description={t('wizard.subtitle')} breadcrumbs={<button type="button" className="hover:underline" onClick={() => navigate('/devices')}>{t('title')}</button>} />
      <Stepper current={step} />
      <Card>
        <CardHeader>
          <CardTitle>{t(`wizard.step.${step}`)}</CardTitle>
          <CardDescription>{t(`wizard.stepHint.${step}`)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 'provider' ? (
            <>
              <ProviderStep value={provider?.key ?? null} onSelect={(p) => { setProvider(p); setModel(null); setConfig({}); setTestResult(null); }} />
              <WizardNav nextDisabled={!provider} onNext={() => go('model')} />
            </>
          ) : null}
          {step === 'model' && provider ? (
            <>
              <ModelStep providerKey={provider.key} value={model?.id ?? null} onChange={setModel} />
              <WizardNav onBack={() => go('provider')} onNext={() => go('details')} />
            </>
          ) : null}
          {step === 'details' && provider ? (
            <DetailsStep key={provider.key} defaults={detailDefaults} provider={provider} onBack={() => go('model')} onSubmit={(d) => { setDetails(d); go('connection'); }} />
          ) : null}
          {step === 'connection' && provider ? (
            <>
              {isPush ? (
                <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/30">
                  <p className="font-medium">{t('wizard.pushTitle')}</p>
                  <ol className="mt-2 list-decimal space-y-1 ps-5 text-muted-foreground">
                    <li>{t('wizard.pushStep1')}</li><li>{t('wizard.pushStep2')}</li><li>{t('wizard.pushStep3')}</li>
                  </ol>
                </div>
              ) : null}
              <ProviderConfigForm fields={fields.filter((f) => !(isPush && f.key === 'serialNumber'))} values={config} onChange={(v) => { setConfig(v); setTestResult(null); }} errors={configErrors} />
              {provider.throttling ? <p className="text-xs text-muted-foreground">{t('wizard.throttling', { perMinute: provider.throttling.requestsPerMinute ?? '—', perDevice: provider.throttling.maxConcurrentPerDevice ?? '—' })}</p> : null}
              <WizardNav onBack={() => go('details')} onNext={() => { if (validateConnection()) go('test'); }} />
            </>
          ) : null}
          {step === 'test' && provider ? (
            <>
              {isPush ? (
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">{t('wizard.pushTestHint')}</div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" onClick={runTest} loading={testConnection.isPending}><Plug /> {t('test.run')}</Button>
                    <span className="text-xs text-muted-foreground">{t('test.hint')}</span>
                  </div>
                  {testConnection.isPending ? <Skeleton className="h-24 w-full" /> : null}
                  {testResult ? <TestConnectionResult result={testResult} /> : null}
                </div>
              )}
              <WizardNav onBack={() => go('connection')} onNext={() => go('review')} nextLabel={isPush || testResult?.ok ? undefined : t('test.skip')} />
            </>
          ) : null}
          {step === 'review' && provider && details ? (
            <>
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <Row label={t('fields.provider')}><span className="font-medium">{provider.name}</span> <IntegrationBadge type={provider.integrationType} /></Row>
                <Row label={t('fields.modelName')}>{model?.model ?? details.modelName ?? '—'}</Row>
                <Row label={tc('common.code')}><span className="font-mono">{details.code}</span></Row>
                <Row label={tc('common.name')}>{details.name}</Row>
                <Row label={tc('common.timezone')}><span dir="ltr">{details.timezone ?? '—'}</span></Row>
                <Row label={t('fields.serialNumber')}><span className="font-mono" dir="ltr">{details.serialNumber ?? '—'}</span></Row>
                <Row label={t('fields.tags')}>{details.tags?.length ? details.tags.map((x) => <Badge key={x} variant="secondary" className="me-1 font-normal">{x}</Badge>) : '—'}</Row>
                <Row label={t('wizard.configSummary')}>
                  {fields.length ? fields.map((f) => <span key={f.key} className="me-2 inline-block font-mono text-xs" dir="ltr">{f.key}={f.secret || f.type === 'password' ? (config[f.key] !== undefined ? '••••' : '—') : String(config[f.key] ?? f.default ?? '—')}</span>) : '—'}
                </Row>
              </dl>
              {testResult ? <TestConnectionResult result={testResult} /> : null}
              <WizardNav onBack={() => go('test')} onNext={register} nextLabel={t('wizard.register')} loading={create.isPending} />
            </>
          ) : null}
        </CardContent>
      </Card>
      <PushCredentialsDialog credentials={created} onClose={() => { const id = created?.device.id; setCreated(null); if (id) navigate(`/devices/${id}`); }} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 flex flex-wrap items-center gap-1">{children}</dd></div>;
}

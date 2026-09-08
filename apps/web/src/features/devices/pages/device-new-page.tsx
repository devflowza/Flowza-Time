import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, Controller, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { ArrowLeft, ArrowRight, Check, ExternalLink, Pencil, Plug, Radio, Search, X } from 'lucide-react';
import { createDeviceSchema, type CreateDeviceInput, type DeviceModelDto, type TestConnectionResultDto } from '@flowza/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, Button, Card, CardContent, ErrorState, FormField, Input, Skeleton, Textarea } from '@/components/ui';
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
import { ProviderConfigForm } from '../components/provider-config-form';
import { normalizeProviderConfig, validateProviderConfig, type ConfigValues } from '../components/provider-config';
import { PushCredentialsDialog } from '../components/push-credentials-dialog';
import { TestConnectionResult } from '../components/test-connection-result';
import { TagsInput } from '../components/tags-input';

/**
 * Four steps, not six. Provider and model are one decision about the same object ("what am I connecting?"), and the
 * connection test only ever tests the settings entered on the step before it — splitting either pair bought a screen
 * that held one control and a Next button, and cost a full page transition to cross.
 */
const STEPS = ['device', 'details', 'connection', 'review'] as const;
type Step = (typeof STEPS)[number];

const detailsSchema = createDeviceSchema.pick({ code: true, name: true, branchId: true, timezone: true, tags: true, serialNumber: true, modelName: true, manufacturer: true, notes: true });
type DetailsValues = z.input<typeof detailsSchema>;
type Details = z.output<typeof detailsSchema>;
type DetailsForm = UseFormReturn<DetailsValues, unknown, Details>;

/** Below this a search box is noise; above it, scanning a flat grid stops working. */
const SEARCH_THRESHOLD = 7;

// ---- shell ------------------------------------------------------------------------------------------------------------------

/**
 * Progress rail. On a wide screen it sits beside the step instead of above it: the wizard used to be a single centred
 * column in a 1665px content area, so the horizontal space that could carry the progress state was empty while the
 * page scrolled for two screens.
 *
 * Each entry doubles as a summary of what that step captured, so earlier answers stay visible while you work on the
 * next question — and as a back link, which is faster than pressing Back three times.
 */
function WizardRail({ current, furthest, summaries, onJump }: { current: Step; furthest: number; summaries: Record<Step, string | null>; onJump: (s: Step) => void }) {
  const { t } = useTranslation('devices');
  const idx = STEPS.indexOf(current);
  return (
    <nav aria-label={t('wizard.steps')} className="hidden lg:sticky lg:top-6 lg:block">
      <ol className="space-y-0.5">
        {STEPS.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
          const reachable = i <= furthest;
          const summary = summaries[s];
          return (
            <li key={s} className="relative">
              {i < STEPS.length - 1 ? <span aria-hidden className={cn('absolute top-9 h-[calc(100%-1.25rem)] w-px start-[1.375rem]', i < idx ? 'bg-brand-500' : 'bg-border')} /> : null}
              <button
                type="button" onClick={() => onJump(s)} disabled={!reachable} aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'relative flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-start transition-colors',
                  reachable ? 'hover:bg-muted' : 'cursor-default',
                  state === 'current' && 'bg-muted',
                )}
              >
                <span className={cn(
                  'mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tnum',
                  state === 'done' && 'border-brand-600 bg-brand-600 text-white',
                  state === 'current' && 'border-brand-600 text-brand-700 ring-4 ring-brand-500/15',
                  state === 'todo' && 'text-muted-foreground',
                )}>
                  {state === 'done' ? <Check className="size-3" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', state === 'todo' ? 'text-muted-foreground' : 'font-medium')}>{t(`wizard.step.${s}`)}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary ?? t('wizard.notChosen')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The rail's job on a narrow screen, in one row: where you are, how far there is to go, and nothing else. */
function CompactProgress({ current }: { current: Step }) {
  const { t } = useTranslation('devices');
  const idx = STEPS.indexOf(current);
  return (
    <div className="lg:hidden">
      <p className="text-xs font-medium text-muted-foreground tnum">{t('wizard.stepOf', { current: idx + 1, total: STEPS.length })}</p>
      <ol className="mt-2 flex gap-1.5" aria-label={t('wizard.steps')}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === idx ? 'step' : undefined} className={cn('h-1 flex-1 rounded-full', i <= idx ? 'bg-brand-500' : 'bg-border')}>
            <span className="sr-only">{t(`wizard.step.${s}`)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The step's action bar, pinned to the bottom of the viewport for as long as its step is taller than one screen. The
 * primary action of a wizard should never be something you have to go looking for.
 */
function WizardNav({ onBack, onNext, nextLabel, nextType = 'button', nextDisabled, loading, hint }: { onBack?: () => void; onNext?: () => void; nextLabel?: string; nextType?: 'button' | 'submit'; nextDisabled?: boolean; loading?: boolean; hint?: string }) {
  const { t } = useTranslation();
  return (
    <div className="sticky bottom-0 z-10 -mx-5 -mb-5 mt-6 flex items-center justify-between gap-3 rounded-b-lg border-t bg-card/95 px-5 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/75">
      {onBack ? <Button type="button" variant="ghost" onClick={onBack}><ArrowLeft className="rtl:rotate-180" /> {t('common.back')}</Button> : <span />}
      <div className="flex min-w-0 items-center gap-3">
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
        <Button type={nextType} onClick={onNext} disabled={nextDisabled} loading={loading}>{nextLabel ?? t('common.next')} {nextType === 'button' && !nextLabel ? <ArrowRight className="rtl:rotate-180" /> : null}</Button>
      </div>
    </div>
  );
}

/**
 * Keyboard behaviour for a card `role="radiogroup"` (WAI-ARIA APG): exactly one option sits in the tab order and the
 * arrow keys move between the rest. Without it every card was its own tab stop — four of them to walk past a step that
 * asks for one answer — and the horizontal keys must follow the reading direction, which is not left-to-right in `ar`.
 */
function useRovingRadios(count: number, enabledAt: (i: number) => boolean, select: (i: number) => void, rtl: boolean) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const setRef = useCallback((i: number) => (el: HTMLButtonElement | null) => { refs.current[i] = el; }, []);
  const onKeyDown = useCallback((i: number) => (e: React.KeyboardEvent) => {
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const back = e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    if (!forward && !back) return;
    e.preventDefault();
    const dir = forward ? 1 : -1;
    for (let s = 1; s <= count; s++) {
      const j = (((i + dir * s) % count) + count) % count;
      if (enabledAt(j)) { select(j); refs.current[j]?.focus(); return; }
    }
  }, [count, enabledAt, select, rtl]);
  return { setRef, onKeyDown };
}

// ---- step 1: device (provider + model) --------------------------------------------------------------------------------------

function ProviderGrid({ providers, value, onSelect }: { providers: ProviderDto[]; value: string | null; onSelect: (p: ProviderDto) => void }) {
  const { t, i18n } = useTranslation('devices');
  const enabledAt = useCallback((i: number) => providers[i]?.status !== 'placeholder', [providers]);
  const select = useCallback((i: number) => { const p = providers[i]; if (p) onSelect(p); }, [providers, onSelect]);
  const { setRef, onKeyDown } = useRovingRadios(providers.length, enabledAt, select, i18n.dir() === 'rtl');
  const firstEnabled = providers.findIndex((p) => p.status !== 'placeholder');
  const hasSelection = providers.some((p) => p.key === value);
  return (
    // One grid, not one grid per vendor. Grouping by vendor gave every provider a section of its own — each vendor here
    // ships exactly one integration — so a three-column layout rendered as four single-column rows.
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('wizard.step.device')}>
      {providers.map((p, i) => {
        const disabled = p.status === 'placeholder';
        const selected = p.key === value;
        return (
          <button
            key={p.key} ref={setRef(i)} type="button" role="radio" aria-checked={selected} disabled={disabled}
            tabIndex={disabled ? -1 : selected || (!hasSelection && i === firstEnabled) ? 0 : -1}
            onKeyDown={onKeyDown(i)} onClick={() => onSelect(p)}
            className={cn(
              'flex h-full flex-col gap-2 rounded-lg border bg-card p-3.5 text-start shadow-card transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300',
              disabled && 'cursor-not-allowed opacity-60 hover:border-border',
            )}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{p.vendor}</span>
                <span className="block truncate font-medium">{p.name}</span>
              </span>
              <span aria-hidden className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border', selected ? 'border-brand-500 bg-brand-500 text-white' : 'text-muted-foreground')}>
                {selected ? <Check className="size-3.5" /> : p.integrationType === 'DEVICE_PUSH' ? <Radio className="size-3.5" /> : <Plug className="size-3.5" />}
              </span>
            </span>
            <span className="flex flex-wrap gap-1"><IntegrationBadge type={p.integrationType} /><ProviderStatusBadge status={p.status} /><VerificationBadge status={p.verificationStatus} /></span>
            {p.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{p.description}</span> : null}
            <CapabilityChips capabilities={p.capabilities} max={4} className="mt-auto pt-1" />
            {disabled ? <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{t('wizard.placeholderNote')}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Models as rows rather than cards. The choice is explicitly skippable, so it does not deserve the visual weight of the
 * provider decision — and a row shows the same four facts in a third of the height.
 */
function ModelPicker({ providerKey, value, onChange }: { providerKey: string; value: string | null; onChange: (m: DeviceModelDto | null) => void }) {
  const { t, i18n } = useTranslation('devices');
  const q = useDeviceModels(providerKey);
  const options = useMemo(() => [null, ...(q.data ?? [])], [q.data]);
  const enabledAt = useCallback(() => true, []);
  const select = useCallback((i: number) => onChange(options[i] ?? null), [options, onChange]);
  const { setRef, onKeyDown } = useRovingRadios(options.length, enabledAt, select, i18n.dir() === 'rtl');
  if (q.isLoading) return <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="divide-y rounded-lg border bg-card" role="radiogroup" aria-label={t('wizard.modelTitle')}>
      {options.map((m, i) => {
        const selected = (m?.id ?? null) === value;
        return (
          <button
            key={m?.id ?? '__none'} ref={setRef(i)} type="button" role="radio" aria-checked={selected}
            tabIndex={selected || (value === null && i === 0) ? 0 : -1} onKeyDown={onKeyDown(i)} onClick={() => onChange(m)}
            className={cn('flex w-full items-center gap-3 p-3 text-start transition-colors first:rounded-t-lg last:rounded-b-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', selected ? 'bg-accent' : 'hover:bg-muted')}
          >
            <span aria-hidden className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-brand-600 bg-brand-600 text-white' : 'border-input')}>
              {selected ? <Check className="size-2.5" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{m ? m.model : t('wizard.noModel')}</span>
              <span className="block truncate text-xs text-muted-foreground">{m ? `${m.vendor}${m.family ? ` · ${m.family}` : ''}${m.notes ? ` · ${m.notes}` : ''}` : t('wizard.noModelHint')}</span>
            </span>
            {m ? <span className="hidden shrink-0 items-center gap-1 sm:flex"><CapabilityChips capabilities={m.capabilities} max={3} /><VerificationBadge status={m.verification} /></span> : null}
          </button>
        );
      })}
    </div>
  );
}

function DeviceStep({ provider, model, onProvider, onModel }: { provider: ProviderDto | null; model: DeviceModelDto | null; onProvider: (p: ProviderDto) => void; onModel: (m: DeviceModelDto | null) => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const q = useProviders();
  const [query, setQuery] = useState('');
  const all = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name)), [q.data]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => (needle ? all.filter((p) => `${p.vendor} ${p.name} ${p.description ?? ''}`.toLowerCase().includes(needle)) : all), [all, needle]);

  if (q.isLoading) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-4">
      {all.length >= SEARCH_THRESHOLD ? (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground start-3" aria-hidden />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('wizard.searchProviders')} aria-label={t('wizard.searchProviders')} className="ps-9 pe-9" />
          {query ? (
            <button type="button" onClick={() => setQuery('')} aria-label={tc('common.clearFilters')} className="absolute top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground end-2"><X className="size-3.5" /></button>
          ) : null}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{t('wizard.noProviderMatch', { query: query.trim() })}</p>
      ) : (
        <ProviderGrid providers={shown} value={provider?.key ?? null} onSelect={onProvider} />
      )}

      {provider ? (
        <section className="space-y-3 rounded-lg border bg-muted/40 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div>
              <h3 className="text-sm font-semibold">{t('wizard.modelTitle')} <span className="ms-1 text-xs font-normal text-muted-foreground">{tc('common.optional')}</span></h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('wizard.modelHint')}</p>
            </div>
            {/* Outside the card on purpose: a link nested inside a radio is invalid HTML and a control the arrow keys
                cannot reach. It describes the provider you have chosen, so it lives with the choice. */}
            {provider.docsUrl ? (
              <a href={provider.docsUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">{t('wizard.docs')} <ExternalLink className="size-3" /></a>
            ) : null}
          </div>
          <ModelPicker providerKey={provider.key} value={model?.id ?? null} onChange={onModel} />
        </section>
      ) : null}
    </div>
  );
}

// ---- step 2: details --------------------------------------------------------------------------------------------------------

function DetailsStep({ form, isPush, onSubmit, onBack }: { form: DetailsForm; isPush: boolean; onSubmit: (d: Details) => void; onBack: () => void }) {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const branches = useBranchOptions();
  const { register, control, formState: { errors }, setValue, getValues } = form;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      {/* Three columns of short, independent attributes on a wide screen. One column is the right default for a form
          that is filled in sequence; this is a record of nine mostly one-line facts, and stacking them cost a screen. */}
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
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
        <FormField label={t('fields.tags')} htmlFor="dev-tags" optional hint={t('fields.tagsHint')} className="xl:col-span-2">
          <Controller control={control} name="tags" render={({ field }) => <TagsInput id="dev-tags" value={field.value ?? []} onChange={field.onChange} />} />
        </FormField>
        <FormField label={t('fields.notes')} htmlFor="dev-notes" optional className="sm:col-span-2 xl:col-span-3">
          <Textarea id="dev-notes" rows={2} {...register('notes', { setValueAs: blankToUndefined })} />
        </FormField>
      </div>
      <WizardNav onBack={onBack} nextType="submit" />
    </form>
  );
}

// ---- page -------------------------------------------------------------------------------------------------------------------

export default function DeviceNewPage() {
  const { t } = useTranslation('devices');
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const orgTz = useOrgTimezone();
  const { create, testConnection } = useDeviceMutations();
  const [step, setStep] = useState<Step>('device');
  const [furthest, setFurthest] = useState(0);
  const [provider, setProvider] = useState<ProviderDto | null>(null);
  const [model, setModel] = useState<DeviceModelDto | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [config, setConfig] = useState<ConfigValues>({});
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<TestConnectionResultDto | null>(null);
  const [created, setCreated] = useState<DeviceCreatedDto | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepped = useRef(false);

  const isPush = provider?.integrationType === 'DEVICE_PUSH';
  const fields = provider?.configSchema.fields ?? [];

  // The details form lives here, not inside the step, so stepping back and forward again does not discard what was
  // typed. The resolver widens with the provider: a push terminal is identified by its serial number, so that field is
  // required for one of the two integration shapes only.
  const schema = useMemo(() => (isPush ? detailsSchema.extend({ serialNumber: createDeviceSchema.shape.serialNumber.unwrap().min(1) }) : detailsSchema), [isPush]);
  const detailsForm = useForm<DetailsValues, unknown, Details>({ resolver: zodResolver(schema), defaultValues: { code: '', name: '', branchId: '', timezone: orgTz, tags: [], manufacturer: '', modelName: undefined, serialNumber: undefined, notes: undefined } });

  const go = useCallback((s: Step) => {
    setStep(s);
    setFurthest((f) => Math.max(f, STEPS.indexOf(s)));
    stepped.current = true;
    window.scrollTo({ top: 0 });
  }, []);

  /**
   * Every route out of the details step, in either direction — Back, the rail, Edit on the review step.
   *
   * `details` is a validated snapshot taken on submit, and everything after this step reads that snapshot rather than
   * the live form. So leaving without re-validating is how the review screen ends up showing, and the API ends up
   * storing, a value the user has since changed. Forward is refused while the form is invalid; backward is allowed but
   * drops the snapshot and the progress that depended on it, because there is no longer a valid answer here.
   */
  const leaveDetails = useCallback((to: Step) => {
    void detailsForm.handleSubmit(
      (d) => { setDetails(d); go(to); },
      () => {
        if (STEPS.indexOf(to) > STEPS.indexOf('details')) return;
        setDetails(null);
        setFurthest(STEPS.indexOf('details'));
        setStep(to);
        stepped.current = true;
        window.scrollTo({ top: 0 });
      },
    )();
  }, [detailsForm, go]);

  const jump = useCallback((s: Step) => { if (step === 'details' && s !== 'details') leaveDetails(s); else go(s); }, [step, leaveDetails, go]);

  // Steps swap the whole panel without a route change, so nothing tells a screen reader that the content moved. Focus
  // the new heading — but only after a real step change, never on first render, where it would steal focus.
  useEffect(() => {
    if (!stepped.current) return;
    headingRef.current?.focus();
  }, [step]);

  const selectProvider = (p: ProviderDto) => {
    if (p.key === provider?.key) return;
    setProvider(p);
    setModel(null);
    setConfig({});
    setConfigErrors({});
    setTestResult(null);
    // Changing the provider changes what the hardware is, so the identifiers typed for the previous one no longer
    // describe it — which is what the old remount-on-provider-key did implicitly.
    detailsForm.reset({ code: '', name: '', branchId: '', timezone: orgTz, tags: [], manufacturer: p.vendor, modelName: undefined, serialNumber: undefined, notes: undefined });
    setDetails(null);
  };

  const selectModel = (m: DeviceModelDto | null) => {
    setModel(m);
    if (m && !detailsForm.getValues('modelName')) detailsForm.setValue('modelName', m.model);
  };

  const buildInput = (): CreateDeviceInput | { issue: { field: string; message: string } } | null => {
    if (!provider || !details) return null;
    const cfg = normalizeProviderConfig(fields, config);
    const urlField = fields.find((f) => f.type === 'url');
    const endpointUrl = urlField && typeof cfg[urlField.key] === 'string' ? String(cfg[urlField.key]) : undefined;
    const parsed = createDeviceSchema.safeParse({ ...details, providerKey: provider.key, modelId: model?.id, config: cfg, endpointUrl, serialNumber: details.serialNumber ?? (typeof cfg.serialNumber === 'string' ? cfg.serialNumber : undefined) });
    if (parsed.success) return parsed.data;
    const first = parsed.error.issues[0];
    return { issue: { field: first?.path.join('.') || '—', message: first?.message ?? '' } };
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
    if ('issue' in input) { toast.error(t('wizard.invalid'), { description: t('wizard.invalidField', input.issue) }); return; }
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

  const summaries: Record<Step, string | null> = {
    device: provider ? `${provider.name}${model ? ` · ${model.model}` : ''}` : null,
    details: details ? `${details.code} · ${details.name}` : null,
    connection: isPush ? t('integration.DEVICE_PUSH') : testResult ? t(testResult.ok ? 'test.ok' : 'test.failed') : fields.length === 0 ? t('wizard.noConfig') : null,
    review: null,
  };

  return (
    <div className="page-container max-w-7xl">
      <PageHeader title={t('wizard.title')} description={t('wizard.subtitle')} breadcrumbs={<button type="button" className="hover:underline" onClick={() => navigate('/devices')}>{t('title')}</button>} />
      <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <WizardRail current={step} furthest={furthest} summaries={summaries} onJump={jump} />
        <Card className="min-w-0">
          <CardContent className="p-5">
            <CompactProgress current={step} />
            <div className="mb-5 mt-3 lg:mt-0">
              <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">{t(`wizard.step.${step}`)}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t(`wizard.stepHint.${step}`)}</p>
            </div>

            {step === 'device' ? (
              <>
                <DeviceStep provider={provider} model={model} onProvider={selectProvider} onModel={selectModel} />
                <WizardNav nextDisabled={!provider} onNext={() => go('details')} hint={provider ? undefined : t('wizard.chooseProvider')} />
              </>
            ) : null}

            {step === 'details' && provider ? (
              <DetailsStep form={detailsForm} isPush={isPush} onBack={() => leaveDetails('device')} onSubmit={(d) => { setDetails(d); go('connection'); }} />
            ) : null}

            {step === 'connection' && provider ? (
              <div className="space-y-5">
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

                {/* The test used to be a step of its own holding a single button. It tests the settings directly above
                    it, so it belongs directly below them. */}
                <section className="space-y-3 rounded-lg border bg-muted/40 p-4">
                  <h3 className="text-sm font-semibold">{t('test.title')}</h3>
                  {isPush ? (
                    <p className="text-sm text-muted-foreground">{t('wizard.pushTestHint')}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" variant="outline" onClick={runTest} loading={testConnection.isPending}><Plug /> {t('test.run')}</Button>
                        <span className="text-xs text-muted-foreground">{t('test.hint')}</span>
                      </div>
                      {testConnection.isPending ? <Skeleton className="h-24 w-full" /> : null}
                      {testResult ? <TestConnectionResult result={testResult} /> : null}
                    </>
                  )}
                </section>
                <WizardNav onBack={() => go('details')} onNext={() => { if (validateConnection()) go('review'); }} />
              </div>
            ) : null}

            {step === 'review' && provider && details ? (
              <div className="space-y-4">
                <ReviewGroup title={t('wizard.step.device')} onEdit={() => go('device')}>
                  <Row label={t('fields.provider')}><span className="font-medium">{provider.name}</span> <IntegrationBadge type={provider.integrationType} /></Row>
                  <Row label={t('fields.modelName')}>{model?.model ?? details.modelName ?? '—'}</Row>
                </ReviewGroup>
                <ReviewGroup title={t('wizard.step.details')} onEdit={() => go('details')}>
                  <Row label={tc('common.code')}><span className="font-mono">{details.code}</span></Row>
                  <Row label={tc('common.name')}>{details.name}</Row>
                  <Row label={tc('common.timezone')}><span dir="ltr">{details.timezone ?? '—'}</span></Row>
                  <Row label={t('fields.serialNumber')}><span className="font-mono" dir="ltr">{details.serialNumber ?? '—'}</span></Row>
                  <Row label={t('fields.tags')}>{details.tags?.length ? details.tags.map((x) => <Badge key={x} variant="secondary" className="me-1 font-normal">{x}</Badge>) : '—'}</Row>
                </ReviewGroup>
                <ReviewGroup title={t('wizard.step.connection')} onEdit={() => go('connection')}>
                  <Row label={t('wizard.configSummary')} wide>
                    {fields.length ? fields.map((f) => <span key={f.key} className="me-2 inline-block font-mono text-xs" dir="ltr">{f.key}={f.secret || f.type === 'password' ? (config[f.key] !== undefined ? '••••' : '—') : String(config[f.key] ?? f.default ?? '—')}</span>) : '—'}
                  </Row>
                </ReviewGroup>
                {testResult ? <TestConnectionResult result={testResult} /> : null}
                <WizardNav onBack={() => go('connection')} onNext={register} nextLabel={t('wizard.register')} loading={create.isPending} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <PushCredentialsDialog credentials={created} onClose={() => { const id = created?.device.id; setCreated(null); if (id) navigate(`/devices/${id}`); }} />
    </div>
  );
}

/** A review block that can be corrected where it is read, instead of by pressing Back until the right step appears. */
function ReviewGroup({ title, onEdit, children }: { title: string; onEdit: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onEdit}><Pencil /> {t('common.edit')}<span className="sr-only"> — {title}</span></Button>
      </div>
      <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 xl:grid-cols-3">{children}</dl>
    </section>
  );
}

function Row({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <div className={cn(wide && 'sm:col-span-2 xl:col-span-3')}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 flex flex-wrap items-center gap-1">{children}</dd></div>;
}

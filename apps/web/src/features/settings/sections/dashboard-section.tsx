import { useCallback, useEffect } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Check, Eye, RotateCcw } from 'lucide-react';
import { DASHBOARD_LAYOUTS, DASHBOARD_TREND_RANGES, organizationSettingsSchema, type DashboardLayout, type DashboardTheme, type OrganizationSettings } from '@flowza/contracts';
import { Button, FormField, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from '@/components/ui';
import { toast, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useRovingRadios } from '@/hooks/use-roving-radios';
import { useCan } from '@/features/me/use-me';
import { DASHBOARD_THEME_META, resolveDashboardSettings } from '@/features/dashboard/theme';
import { useUiStore } from '@/stores/ui-store';
import { useSettingsGroup, useSettingsMutations } from '../api';
import { SectionError, SectionSkeleton, SettingsSection, SwitchRow } from '../components/settings-section';

const schema = organizationSettingsSchema.shape.dashboard.unwrap();
type Values = z.input<typeof schema>;
type Output = z.output<typeof schema>;

export default function DashboardSection() {
  const q = useSettingsGroup('dashboard');
  if (q.isLoading) return <SectionSkeleton />;
  if (q.isError || !q.data) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  return <DashboardForm key={JSON.stringify(q.data)} initial={q.data} />;
}

function DashboardForm({ initial }: { initial: OrganizationSettings['dashboard'] }) {
  const { t } = useTranslation('settings');
  const readOnly = !useCan()('organization.manage');
  const { putGroup } = useSettingsMutations();
  const saved = resolveDashboardSettings(initial);
  const form = useForm<Values, unknown, Output>({ resolver: zodResolver(schema), defaultValues: saved, disabled: readOnly });
  const { control, setValue, formState: { isSubmitting, isDirty, errors } } = form;
  const theme = useWatch({ control, name: 'theme' }) ?? saved.theme;
  const setPreview = useUiStore((s) => s.setPreviewDashboardTheme);

  // Live preview: while this form is open the whole app wears the highlighted style, so the choice is judged on the real
  // sidebar and real charts rather than on a thumbnail. Leaving the page — or the form remounting after a save — clears
  // it, and the organisation's saved style (which /me carries) takes over again.
  useEffect(() => { if (!readOnly) setPreview(theme); }, [theme, readOnly, setPreview]);
  useEffect(() => () => setPreview(null), [setPreview]);

  const onSubmit = form.handleSubmit(async (values) => {
    try { await putGroup.mutateAsync({ group: 'dashboard', value: values }); toast.success(t('saved')); form.reset(values); } catch (e) { toastError(e); }
  });
  const previewing = !readOnly && theme !== saved.theme;

  return (
    <SettingsSection title={t('dashboard.title')} description={t('dashboard.hint')} onSubmit={onSubmit} saving={isSubmitting} dirty={isDirty} readOnly={readOnly}>
      {readOnly ? <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{t('dashboard.readOnlyHint')}</p> : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('dashboard.style')}</legend>
        <p className="text-xs text-muted-foreground">{t('dashboard.styleHint')}</p>
        <Controller control={control} name="theme" render={({ field }) => <StyleGallery value={field.value ?? saved.theme} onChange={field.onChange} disabled={readOnly} />} />
        {previewing ? (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-brand-300 bg-accent px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5 text-brand-700 dark:text-brand-300" aria-hidden />{t('dashboard.previewing', { name: t(`dashboard.themes.${theme}.name`) })}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setValue('theme', saved.theme, { shouldDirty: true })}><RotateCcw /> {t('dashboard.resetPreview')}</Button>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('dashboard.layout')}</legend>
        <p className="text-xs text-muted-foreground">{t('dashboard.layoutHint')}</p>
        <Controller control={control} name="layout" render={({ field }) => <LayoutPicker value={field.value ?? saved.layout} onChange={field.onChange} disabled={readOnly} />} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('dashboard.options')}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('dashboard.trendDays')} htmlFor="dash-trend" hint={t('dashboard.trendDaysHint')} error={errors.trendDays?.message}>
            <Controller control={control} name="trendDays" render={({ field }) => (
              <Select value={String(field.value ?? saved.trendDays)} onValueChange={(v) => field.onChange(Number(v))} disabled={readOnly}>
                <SelectTrigger id="dash-trend"><SelectValue /></SelectTrigger>
                <SelectContent>{DASHBOARD_TREND_RANGES.map((d) => <SelectItem key={d} value={String(d)}>{t('dashboard.days', { count: d })}</SelectItem>)}</SelectContent>
              </Select>
            )} />
          </FormField>
        </div>
        <Controller control={control} name="showGreeting" render={({ field }) => <SwitchRow id="dash-greeting" label={t('dashboard.showGreeting')} hint={t('dashboard.showGreetingHint')} control={<Switch id="dash-greeting" checked={field.value ?? true} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
        <Controller control={control} name="showHighlight" render={({ field }) => <SwitchRow id="dash-highlight" label={t('dashboard.showHighlight')} hint={t('dashboard.showHighlightHint')} control={<Switch id="dash-highlight" checked={field.value ?? true} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
        <Controller control={control} name="showQuote" render={({ field }) => <SwitchRow id="dash-quote" label={t('dashboard.showQuote')} hint={t('dashboard.showQuoteHint')} control={<Switch id="dash-quote" checked={field.value ?? true} onCheckedChange={field.onChange} disabled={readOnly} />} />} />
      </fieldset>
    </SettingsSection>
  );
}

// ---- style gallery ---------------------------------------------------------------------------------------------------

const CHART = { present: 'bg-chart-present', late: 'bg-chart-late', absent: 'bg-chart-absent' } as const;
const CHART_TINT = { present: 'bg-chart-present/20', late: 'bg-chart-late/20', absent: 'bg-chart-absent/20' } as const;
const BARS: ReadonlyArray<[number, number, number]> = [[42, 8, 10], [50, 6, 6], [46, 10, 8], [38, 12, 12], [54, 4, 4], [48, 8, 8], [44, 6, 10]];

/**
 * A miniature of the app in a given style. It carries `data-theme` itself, so the very CSS block that will style the
 * real shell styles this preview — there is no second copy of any colour to drift out of date.
 */
function StyleThumbnail({ theme }: { theme: DashboardTheme }) {
  const { t } = useTranslation('settings');
  return (
    <span data-theme={theme} className="flex h-[108px] w-full overflow-hidden rounded-md border bg-background text-[7px] leading-none text-foreground" aria-hidden>
      <span className="flex w-[31%] shrink-0 flex-col gap-[3px] border-e border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground">
        <span className="mb-1 flex items-center gap-1"><span className="size-2.5 shrink-0 rounded-[3px] bg-brand-500" /><span className="h-1.5 w-7 rounded-sm bg-sidebar-strong/80" /></span>
        <span className="flex items-center gap-1 rounded-sm bg-sidebar-active px-1 py-[3px] text-sidebar-active-foreground"><span className="size-1.5 shrink-0 rounded-full bg-sidebar-active-icon" /><span className="truncate">{t('dashboard.preview.dashboard')}</span></span>
        <span className="flex items-center gap-1 px-1 py-[3px]"><span className="size-1.5 shrink-0 rounded-full bg-sidebar-foreground/60" /><span className="truncate">{t('dashboard.preview.employees')}</span></span>
        <span className="flex items-center gap-1 px-1 py-[3px]"><span className="size-1.5 shrink-0 rounded-full bg-sidebar-foreground/60" /><span className="truncate">{t('dashboard.preview.attendance')}</span></span>
        <span className="flex items-center gap-1 px-1 py-[3px]"><span className="size-1.5 shrink-0 rounded-full bg-sidebar-foreground/60" /><span className="truncate">{t('dashboard.preview.devices')}</span></span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <span className="flex gap-1.5">
          {(['present', 'late', 'absent'] as const).map((k) => (
            <span key={k} className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm border bg-card p-1">
              <span className="flex items-center gap-1"><span className={cn('size-2 shrink-0 rounded-sm', CHART_TINT[k])} /><span className="truncate text-muted-foreground">{t(`dashboard.preview.${k}`)}</span></span>
              <span className="h-1.5 w-3/5 rounded-sm bg-foreground/70" />
              <span className="h-1 w-full overflow-hidden rounded-full bg-muted"><span className={cn('block h-full w-2/3 rounded-full', CHART[k])} /></span>
            </span>
          ))}
        </span>
        <span className="flex min-h-0 flex-1 gap-1.5">
          <span className="flex min-w-0 flex-[3] flex-col rounded-sm border bg-card p-1">
            <span className="mb-1 flex items-center gap-1"><span className="h-1.5 w-8 rounded-sm bg-foreground/70" /><span className="ms-auto size-1.5 rounded-full bg-chart-present" /><span className="size-1.5 rounded-full bg-chart-late" /><span className="size-1.5 rounded-full bg-chart-absent" /></span>
            <span className="flex flex-1 items-end gap-[3px]">
              {BARS.map(([p, l, a], i) => (
                <span key={i} className="flex flex-1 flex-col justify-end gap-px" style={{ height: '100%' }}>
                  <span className="w-full rounded-t-[2px] bg-chart-absent" style={{ height: `${a}%` }} />
                  <span className="w-full bg-chart-late" style={{ height: `${l}%` }} />
                  <span className="w-full rounded-b-[2px] bg-chart-present" style={{ height: `${p}%` }} />
                </span>
              ))}
            </span>
          </span>
          <span className="flex min-w-0 flex-[2] flex-col gap-1 rounded-sm border bg-card p-1">
            <span className="hero-gradient h-4 w-full rounded-sm" />
            <span className="h-1 w-full rounded-sm bg-muted" />
            <span className="h-1 w-4/5 rounded-sm bg-muted" />
            <span className="mt-auto h-2.5 w-2/3 rounded-sm bg-primary" />
          </span>
        </span>
      </span>
    </span>
  );
}

function StyleGallery({ value, onChange, disabled }: { value: DashboardTheme; onChange: (t: DashboardTheme) => void; disabled: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const enabledAt = useCallback(() => !disabled, [disabled]);
  const select = useCallback((i: number) => { const th = DASHBOARD_THEME_META[i]; if (th) onChange(th.key); }, [onChange]);
  const { setRef, onKeyDown } = useRovingRadios(DASHBOARD_THEME_META.length, enabledAt, select, i18n.dir() === 'rtl');
  return (
    <div role="radiogroup" aria-label={t('dashboard.style')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {DASHBOARD_THEME_META.map(({ key, icon: Icon }, i) => {
        const selected = key === value;
        return (
          <button
            key={key} ref={setRef(i)} type="button" role="radio" aria-checked={selected} disabled={disabled} tabIndex={selected ? 0 : -1} onKeyDown={onKeyDown(i)} onClick={() => onChange(key)}
            className={cn(
              'flex flex-col gap-2.5 rounded-lg border bg-card p-3 text-start shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300',
              disabled && 'cursor-not-allowed opacity-70 hover:border-border',
            )}
          >
            <StyleThumbnail theme={key} />
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium"><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />{t(`dashboard.themes.${key}.name`)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(`dashboard.themes.${key}.hint`)}</span>
              </span>
              <span aria-hidden className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-input text-transparent')}><Check className="size-3" /></span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---- layout picker ---------------------------------------------------------------------------------------------------

/** Wireframe of each layout: grey blocks where the widgets go, the accent marking what the layout leads with. */
function LayoutThumbnail({ layout }: { layout: DashboardLayout }) {
  const block = 'rounded-[3px] bg-muted-foreground/20';
  const lead = 'rounded-[3px] bg-brand-500/60';
  if (layout === 'executive') {
    return (
      <span className="flex h-[76px] w-full flex-col gap-1 rounded-md border bg-background p-1.5" aria-hidden>
        <span className="flex gap-1">{[0, 1, 2, 3].map((i) => <span key={i} className={cn('h-4 flex-1', lead)} />)}</span>
        <span className={cn('h-6 w-full', block)} />
        <span className="flex flex-1 gap-1"><span className={cn('flex-[3]', block)} /><span className={cn('flex-[2]', block)} /></span>
      </span>
    );
  }
  const operations = layout === 'operations';
  return (
    <span className="flex h-[76px] w-full gap-1 rounded-md border bg-background p-1.5" aria-hidden>
      <span className="flex flex-[3] flex-col gap-1">
        <span className="flex gap-1">{Array.from({ length: operations ? 4 : 3 }).map((_, i) => <span key={i} className={cn('h-3 flex-1', operations && i >= 2 ? lead : block)} />)}</span>
        <span className="flex flex-1 gap-1"><span className={cn('flex-[3]', block)} /><span className={cn('flex-[2]', operations ? lead : block)} /></span>
        <span className="flex flex-1 gap-1"><span className={cn('flex-1', block)} /><span className={cn('flex-1', operations ? lead : block)} /></span>
      </span>
      <span className="flex flex-1 flex-col gap-1"><span className={cn('h-4', operations ? block : lead)} /><span className={cn('flex-1', block)} /><span className={cn('flex-1', block)} /></span>
    </span>
  );
}

function LayoutPicker({ value, onChange, disabled }: { value: DashboardLayout; onChange: (l: DashboardLayout) => void; disabled: boolean }) {
  const { t, i18n } = useTranslation('settings');
  const enabledAt = useCallback(() => !disabled, [disabled]);
  const select = useCallback((i: number) => { const l = DASHBOARD_LAYOUTS[i]; if (l) onChange(l); }, [onChange]);
  const { setRef, onKeyDown } = useRovingRadios(DASHBOARD_LAYOUTS.length, enabledAt, select, i18n.dir() === 'rtl');
  return (
    <div role="radiogroup" aria-label={t('dashboard.layout')} className="grid gap-3 sm:grid-cols-3">
      {DASHBOARD_LAYOUTS.map((key, i) => {
        const selected = key === value;
        return (
          <button
            key={key} ref={setRef(i)} type="button" role="radio" aria-checked={selected} disabled={disabled} tabIndex={selected ? 0 : -1} onKeyDown={onKeyDown(i)} onClick={() => onChange(key)}
            className={cn(
              'flex flex-col gap-2 rounded-lg border bg-card p-3 text-start shadow-card transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected ? 'border-brand-500 ring-1 ring-brand-500' : 'hover:border-brand-300',
              disabled && 'cursor-not-allowed opacity-70 hover:border-border',
            )}
          >
            <LayoutThumbnail layout={key} />
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><span className="block text-sm font-medium">{t(`dashboard.layouts.${key}.name`)}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t(`dashboard.layouts.${key}.hint`)}</span></span>
              <span aria-hidden className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-input text-transparent')}><Check className="size-3" /></span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
